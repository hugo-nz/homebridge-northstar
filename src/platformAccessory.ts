import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
  HAP,
} from 'homebridge';
import { PolestarPlatform } from './platform';
import { PolestarApi } from './api/api';
import { ChargingStatus } from './api/models';
import { DEFAULT_REFRESH_INTERVAL_SECONDS, LOW_BATTERY_THRESHOLD } from './settings';

/**
 * A single Polestar vehicle exposed as a HomeKit accessory.
 *
 * Services:
 *   - AccessoryInformation  (manufacturer, model, serial/VIN)
 *   - Battery               (level, charging state, low-battery alert)
 *   - Outlet                (On = actively charging, OutletInUse = charger connected)
 */
export class PolestarAccessory {
  private readonly log: Logger;
  private readonly hap: HAP;

  private readonly infoService: Service;
  private readonly batteryService: Service;
  private readonly outletService: Service;

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
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
