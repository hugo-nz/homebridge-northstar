import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME, DEFAULT_REFRESH_INTERVAL_SECONDS } from './settings';
import { PolestarApi } from './api/api';
import { PolestarAccessory } from './platformAccessory';

export interface PolestarPlatformConfig extends PlatformConfig {
  email: string;
  password: string;
  /** Optional VIN filter — if omitted all cars in the account are added. */
  vin?: string;
  /** How often (seconds) to poll the Polestar API. Default: 60. */
  refreshInterval?: number;
}

/**
 * Homebridge dynamic platform for Polestar vehicles.
 *
 * One accessory is created per vehicle found in the account (or per
 * configured VIN if the `vin` config option is set).
 */
export class PolestarPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Accessories restored from the Homebridge cache. */
  public readonly cachedAccessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PolestarPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('PolestarPlatform initialised');

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err) =>
        this.log.error('Device discovery failed: %s', String(err)),
      );
    });
  }

  // --------------------------------------------------------------------------
  // DynamicPlatformPlugin
  // --------------------------------------------------------------------------

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory: %s', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  // --------------------------------------------------------------------------
  // Discovery
  // --------------------------------------------------------------------------

  private async discoverDevices(): Promise<void> {
    if (!this.config.email || !this.config.password) {
      this.log.error(
        'homebridge-polestar: "email" and "password" are required in the plugin config',
      );
      return;
    }

    const vins = this.config.vin ? [this.config.vin] : undefined;
    const polestarApi = new PolestarApi(
      this.config.email,
      this.config.password,
      this.log,
      vins,
    );

    try {
      await polestarApi.init();
    } catch (err) {
      this.log.error('Failed to initialise Polestar API: %s', String(err));
      return;
    }

    const refreshInterval = this.config.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS;

    for (const vin of polestarApi.availableVins) {
      const carInfo = polestarApi.getCarInformation(vin);
      const displayName = carInfo
        ? `${carInfo.modelName} (${vin.slice(-4)})`
        : `Polestar (${vin.slice(-4)})`;

      const uuid = this.api.hap.uuid.generate(vin);
      const existing = this.cachedAccessories.find((a) => a.UUID === uuid);

      let platformAccessory: PlatformAccessory;

      if (existing) {
        this.log.info('Restoring existing accessory: %s', displayName);
        platformAccessory = existing;
      } else {
        this.log.info('Adding new accessory: %s', displayName);
        platformAccessory = new this.api.platformAccessory(displayName, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          platformAccessory,
        ]);
      }

      // Initialise the accessory handler (this also starts the refresh timer).
      new PolestarAccessory(this, platformAccessory, polestarApi, vin, refreshInterval);
    }

    // Remove stale cached accessories that are no longer in the account.
    const activeUuids = new Set(
      polestarApi.availableVins.map((v) => this.api.hap.uuid.generate(v)),
    );
    const stale = this.cachedAccessories.filter((a) => !activeUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(
        'Removing %d stale accessory(ies)',
        stale.length,
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
