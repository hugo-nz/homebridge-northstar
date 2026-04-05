import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
  HAP,
} from 'homebridge';
import { PolestarPlatform } from './platform';
import { PolestarApi } from './api/api';
import { ActionCommand, ChargingStatus } from './api/models';
import { DEFAULT_REFRESH_INTERVAL_SECONDS, LOW_BATTERY_THRESHOLD } from './settings';

/**
 * A single Polestar vehicle exposed as a HomeKit accessory.
 *
 * Services:
 *   - AccessoryInformation  (manufacturer, model, serial/VIN, odometer in HardwareRevision)
 *   - Battery               (level, charging state, low-battery alert)
 *   - Outlet                (On = actively charging, OutletInUse = charger connected)
 *   - Switch "Climate"      (On = climate running; toggle starts/stops climate)
 *   - LockMechanism "Doors" (LockCurrentState / LockTargetState)
 */
export class PolestarAccessory {
  private readonly log: Logger;
  private readonly hap: HAP;

  private readonly infoService: Service;
  private readonly batteryService: Service;
  /** Outlet service – represents the active charging connection. */
  private readonly outletService: Service;
  /** Switch service – starts/stops climate pre-conditioning. */
  private readonly climateService: Service;
  /** LockMechanism service – locks/unlocks the doors. */
  private readonly lockService: Service;

  /** Optimistic climate state — updated on toggle and cleared on next data refresh. */
  private climateActive = false;
  /** Optimistic lock target state. */
  private lockTargetSecured = true;

  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    platform: PolestarPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly api: PolestarApi,
    private readonly vin: string,
    refreshInterval: number = DEFAULT_REFRESH_INTERVAL_SECONDS,
  ) {
    this.log = platform.log;
    this.hap = platform.api.hap;

    const { Service: Svc, Characteristic: C } = this.hap;

    // ------------------------------------------------------------------
    // AccessoryInformation
    // ------------------------------------------------------------------
    this.infoService =
      this.accessory.getService(Svc.AccessoryInformation) ||
      this.accessory.addService(Svc.AccessoryInformation);

    const carInfo = this.api.getCarInformation(vin);
    this.infoService
      .setCharacteristic(C.Manufacturer, 'Polestar')
      .setCharacteristic(C.Model, carInfo?.modelName ?? 'Polestar')
      .setCharacteristic(C.SerialNumber, vin)
      .setCharacteristic(C.FirmwareRevision, carInfo?.modelYear ?? '');

    // ------------------------------------------------------------------
    // Battery service
    // ------------------------------------------------------------------
    this.batteryService =
      this.accessory.getService(Svc.Battery) ||
      this.accessory.addService(Svc.Battery, 'Battery');

    this.batteryService
      .getCharacteristic(C.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this));

    this.batteryService
      .getCharacteristic(C.ChargingState)
      .onGet(this.getChargingState.bind(this));

    this.batteryService
      .getCharacteristic(C.StatusLowBattery)
      .onGet(this.getStatusLowBattery.bind(this));

    // ------------------------------------------------------------------
    // Outlet service — represents the charging connection
    // ------------------------------------------------------------------
    this.outletService =
      this.accessory.getService(Svc.Outlet) ||
      this.accessory.addService(Svc.Outlet, 'Charging');

    this.outletService
      .getCharacteristic(C.On)
      .onGet(this.getIsCharging.bind(this));

    this.outletService
      .getCharacteristic(C.OutletInUse)
      .onGet(this.getIsCharging.bind(this));

    // ------------------------------------------------------------------
    // Climate switch — toggle to start / stop climate pre-conditioning
    // ------------------------------------------------------------------
    this.climateService =
      this.accessory.getService('Climate') ||
      this.accessory.addService(Svc.Switch, 'Climate', `${vin}-climate`);

    this.climateService
      .getCharacteristic(C.On)
      .onGet(this.getClimateActive.bind(this))
      .onSet(this.setClimateActive.bind(this));

    // ------------------------------------------------------------------
    // Lock mechanism — lock / unlock doors
    // ------------------------------------------------------------------
    this.lockService =
      this.accessory.getService('Doors') ||
      this.accessory.addService(Svc.LockMechanism, 'Doors', `${vin}-lock`);

    this.lockService
      .getCharacteristic(C.LockCurrentState)
      .onGet(this.getLockCurrentState.bind(this));

    this.lockService
      .getCharacteristic(C.LockTargetState)
      .onGet(this.getLockTargetState.bind(this))
      .onSet(this.setLockTargetState.bind(this));

    // ------------------------------------------------------------------
    // Periodic refresh
    // ------------------------------------------------------------------
    this.scheduleRefresh(refreshInterval);
  }

  // --------------------------------------------------------------------------
  // Characteristic handlers
  // --------------------------------------------------------------------------

  private getBatteryLevel(): CharacteristicValue {
    const data = this.api.getCarBattery(this.vin);
    return data?.batteryChargeLevelPercentage ?? 0;
  }

  private getChargingState(): CharacteristicValue {
    const { C } = this;
    const data = this.api.getCarBattery(this.vin);
    if (!data) {
      return C.ChargingState.NOT_CHARGING;
    }
    if (this.isActivelyCharging(data.chargingStatus)) {
      return C.ChargingState.CHARGING;
    }
    return C.ChargingState.NOT_CHARGING;
  }

  private getStatusLowBattery(): CharacteristicValue {
    const { C } = this;
    const data = this.api.getCarBattery(this.vin);
    const level = data?.batteryChargeLevelPercentage ?? 100;
    return level <= LOW_BATTERY_THRESHOLD
      ? C.StatusLowBattery.BATTERY_LEVEL_LOW
      : C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private getIsCharging(): CharacteristicValue {
    const data = this.api.getCarBattery(this.vin);
    return this.isActivelyCharging(data?.chargingStatus);
  }

  // --------------------------------------------------------------------------
  // Climate switch handlers
  // --------------------------------------------------------------------------

  private getClimateActive(): CharacteristicValue {
    return this.climateActive;
  }

  private async setClimateActive(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    const command = on ? ActionCommand.CLIMATE_START : ActionCommand.CLIMATE_STOP;
    this.log.info('VIN %s — climate %s requested', this.vin, on ? 'START' : 'STOP');
    try {
      await this.api.performAction(this.vin, command);
      this.climateActive = on;
    } catch (err) {
      this.log.error('VIN %s — climate action failed: %s', this.vin, String(err));
      // Revert the optimistic state so HomeKit shows the real state.
      this.climateService.updateCharacteristic(this.C.On, this.climateActive);
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Lock mechanism handlers
  // --------------------------------------------------------------------------

  private getLockCurrentState(): CharacteristicValue {
    const { C } = this;
    return this.lockTargetSecured
      ? C.LockCurrentState.SECURED
      : C.LockCurrentState.UNSECURED;
  }

  private getLockTargetState(): CharacteristicValue {
    const { C } = this;
    return this.lockTargetSecured
      ? C.LockTargetState.SECURED
      : C.LockTargetState.UNSECURED;
  }

  private async setLockTargetState(value: CharacteristicValue): Promise<void> {
    const { C } = this;
    const secured = value === C.LockTargetState.SECURED;
    const command = secured ? ActionCommand.LOCK : ActionCommand.UNLOCK;
    this.log.info('VIN %s — door %s requested', this.vin, secured ? 'LOCK' : 'UNLOCK');
    try {
      await this.api.performAction(this.vin, command);
      this.lockTargetSecured = secured;
      this.lockService.updateCharacteristic(
        C.LockCurrentState,
        secured ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED,
      );
    } catch (err) {
      this.log.error('VIN %s — lock action failed: %s', this.vin, String(err));
      // Revert target state to match current.
      this.lockService.updateCharacteristic(
        C.LockTargetState,
        this.lockTargetSecured ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED,
      );
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private get C() {
    return this.hap.Characteristic;
  }

  private isActivelyCharging(status: ChargingStatus | undefined): boolean {
    return (
      status === ChargingStatus.CHARGING_STATUS_CHARGING ||
      status === ChargingStatus.CHARGING_STATUS_SMART_CHARGING
    );
  }

  private scheduleRefresh(intervalSeconds: number): void {
    this.refreshTimer = setInterval(
      () => this.refresh(),
      intervalSeconds * 1000,
    );
  }

  private async refresh(): Promise<void> {
    try {
      await this.api.updateLatestData(this.vin);
      this.pushUpdates();
    } catch (err) {
      this.log.error('Failed to refresh data for VIN %s: %s', this.vin, String(err));
    }
  }

  /** Push the latest cached values to HomeKit. */
  private pushUpdates(): void {
    const { C } = this;
    const battery = this.api.getCarBattery(this.vin);

    if (battery) {
      const level = battery.batteryChargeLevelPercentage ?? 0;
      const isCharging = this.isActivelyCharging(battery.chargingStatus);
      const isLow = level <= LOW_BATTERY_THRESHOLD;

      this.batteryService
        .updateCharacteristic(C.BatteryLevel, level)
        .updateCharacteristic(
          C.ChargingState,
          isCharging ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING,
        )
        .updateCharacteristic(
          C.StatusLowBattery,
          isLow ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );

      this.outletService
        .updateCharacteristic(C.On, isCharging)
        .updateCharacteristic(C.OutletInUse, isCharging);

      this.log.debug(
        'VIN %s — battery: %d%%, charging: %s',
        this.vin,
        level,
        battery.chargingStatus,
      );
    }

    // Odometer — stored in HardwareRevision as "XXXXX km".
    const odometer = this.api.getCarOdometer(this.vin);
    if (odometer?.odometerMeters != null) {
      const km = Math.round(odometer.odometerMeters / 1000);
      this.infoService.updateCharacteristic(C.HardwareRevision, `${km} km`);
      this.log.debug('VIN %s — odometer: %d km', this.vin, km);
    }

    // Location — best-effort, logged only.
    const location = this.api.getCarLocation(this.vin);
    if (location && location.latitude !== null && location.longitude !== null) {
      this.log.debug(
        'VIN %s — location: %.6f, %.6f',
        this.vin,
        location.latitude,
        location.longitude,
      );
    }
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
