/**
 * Polestar GraphQL API client — a TypeScript port of pypolestar's api.py.
 */

import axios, { AxiosInstance } from 'axios';
import type { Logger } from 'homebridge';
import { PolestarAuth } from './auth';
import {
  CarBatteryData,
  CarHealthData,
  CarInformationData,
  CarOdometerData,
  CarTelematicsData,
  findByVin,
  parseBatteryData,
  parseCarInformation,
  parseHealthData,
  parseOdometerData,
} from './models';
import { API_URL, REQUEST_TIMEOUT_MS } from '../settings';

// ---------------------------------------------------------------------------
// GraphQL query strings (matching pypolestar/graphql.py)
// ---------------------------------------------------------------------------

const QUERY_GET_CONSUMER_CARS_V2 = `
  query GetConsumerCarsV2 {
    getConsumerCarsV2 {
      vin
      internalVehicleIdentifier
      registrationNo
      modelYear
      content {
        model { name }
      }
    }
  }
`;

const QUERY_TELEMATICS_V2 = `
  query CarTelematicsV2($vins: [String!]!) {
    carTelematicsV2(vins: $vins) {
      battery {
        vin
        batteryChargeLevelPercentage
        chargingStatus
        estimatedChargingTimeToFullMinutes
        estimatedDistanceToEmptyKm
        timestamp { seconds nanos }
      }
      odometer {
        vin
        odometerMeters
        timestamp { seconds nanos }
      }
      health {
        vin
        brakeFluidLevelWarning
        daysToService
        distanceToServiceKm
        engineCoolantLevelWarning
        oilLevelWarning
        serviceWarning
        timestamp { seconds nanos }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export class PolestarApiException extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'PolestarApiException';
  }
}

export class PolestarNoDataException extends PolestarApiException {
  constructor(message: string) {
    super(message);
    this.name = 'PolestarNoDataException';
  }
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export class PolestarApi {
  public readonly auth: PolestarAuth;
  public latestCallCode: number | null = null;

  /** VINs for cars in this account, populated after init(). */
  public availableVins: string[] = [];

  private readonly client: AxiosInstance;
  private carInfoByVin: Map<string, CarInformationData> = new Map();
  private telematicsByVin: Map<string, CarTelematicsData> = new Map();
  private readonly configuredVins: Set<string> | null;

  constructor(
    username: string,
    password: string,
    private readonly log: Logger,
    vins?: string[],
  ) {
    this.auth = new PolestarAuth(username, password, log);
    this.configuredVins = vins && vins.length > 0 ? new Set(vins.map((v) => v.toUpperCase())) : null;
    this.client = axios.create({ timeout: REQUEST_TIMEOUT_MS });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    await this.auth.init();
    await this.auth.getToken();

    if (!this.auth.accessToken) {
      throw new PolestarApiException('No access token after authentication');
    }

    const cars = await this.getAllVehicles();
    for (const car of cars) {
      const vin = car.vin.toUpperCase();
      if (this.configuredVins && !this.configuredVins.has(vin)) {
        continue;
      }
      this.carInfoByVin.set(vin, car);
      this.availableVins.push(vin);
      this.log.debug('API ready for VIN %s (%s)', vin, car.modelName);
    }

    if (
      this.configuredVins &&
      this.configuredVins.size > 0 &&
      this.availableVins.length === 0
    ) {
      this.log.warn(
        'None of the configured VINs %s were found in the Polestar account',
        [...this.configuredVins].join(', '),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Data access
  // -------------------------------------------------------------------------

  getCarInformation(vin: string): CarInformationData | null {
    return this.carInfoByVin.get(vin.toUpperCase()) ?? null;
  }

  getCarBattery(vin: string): CarBatteryData | null {
    return this.telematicsByVin.get(vin.toUpperCase())?.battery ?? null;
  }

  getCarOdometer(vin: string): CarOdometerData | null {
    return this.telematicsByVin.get(vin.toUpperCase())?.odometer ?? null;
  }

  getCarHealth(vin: string): CarHealthData | null {
    return this.telematicsByVin.get(vin.toUpperCase())?.health ?? null;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateLatestData(vin: string): Promise<void> {
    await this.auth.getToken();

    const upperVin = vin.toUpperCase();

    try {
      await this.updateTelematicsData(upperVin);
    } catch (err) {
      this.latestCallCode = 500;
      this.log.error('Failed to update telematics for VIN %s: %s', upperVin, String(err));
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Private — GraphQL queries
  // -------------------------------------------------------------------------

  private async getAllVehicles(): Promise<CarInformationData[]> {
    const result = await this.queryGraphQL<{
      getConsumerCarsV2: Record<string, unknown>[];
    }>(QUERY_GET_CONSUMER_CARS_V2);

    const cars = result.getConsumerCarsV2;
    if (!cars || cars.length === 0) {
      throw new PolestarNoDataException('No vehicles found in Polestar account');
    }

    return cars.map(parseCarInformation);
  }

  private async updateTelematicsData(vin: string): Promise<void> {
    type TelematicsResult = {
      carTelematicsV2: {
        battery: Record<string, unknown>[];
        odometer: Record<string, unknown>[];
        health: Record<string, unknown>[];
      };
    };

    const result = await this.queryGraphQL<TelematicsResult>(QUERY_TELEMATICS_V2, {
      vins: [vin],
    });

    const raw = result.carTelematicsV2;

    const batteryRaw = findByVin(raw.battery ?? [], vin);
    const odometerRaw = findByVin(raw.odometer ?? [], vin);
    const healthRaw = findByVin(raw.health ?? [], vin);

    this.telematicsByVin.set(vin, {
      battery: batteryRaw ? parseBatteryData(batteryRaw) : null,
      odometer: odometerRaw ? parseOdometerData(odometerRaw) : null,
      health: healthRaw ? parseHealthData(healthRaw) : null,
    });

    this.log.debug('Telematics updated for VIN %s', vin);
  }

  private async queryGraphQL<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.auth.accessToken) {
      throw new PolestarApiException('No access token — call auth.getToken() first');
    }

    const response = await this.client.post<{ data: T; errors?: unknown[] }>(
      API_URL,
      { query, ...(variables ? { variables } : {}) },
      {
        headers: {
          Authorization: `Bearer ${this.auth.accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    this.latestCallCode = response.status;

    if (response.status !== 200) {
      throw new PolestarApiException(
        `GraphQL request failed with HTTP ${response.status}`,
        response.status,
      );
    }

    if (response.data.errors && response.data.errors.length > 0) {
      const firstError = response.data.errors[0] as Record<string, unknown>;
      const code = (firstError['extensions'] as Record<string, unknown> | undefined)?.[
        'code'
      ];
      if (code === 'UNAUTHENTICATED') {
        this.latestCallCode = 401;
        throw new PolestarApiException('GraphQL UNAUTHENTICATED', 401);
      }
      throw new PolestarApiException(`GraphQL error: ${JSON.stringify(firstError)}`);
    }

    return response.data.data;
  }
}
