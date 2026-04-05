/**
 * Data models mirroring the pypolestar Python library models.
 */

// ----- Enums ---------------------------------------------------------------

/**
 * Charging status values as returned by the Polestar API.
 * The API sends keys such as "CHARGING_STATUS_CHARGING".
 */
export enum ChargingStatus {
  CHARGING_STATUS_DONE = 'CHARGING_STATUS_DONE',
  CHARGING_STATUS_IDLE = 'CHARGING_STATUS_IDLE',
  CHARGING_STATUS_CHARGING = 'CHARGING_STATUS_CHARGING',
  CHARGING_STATUS_FAULT = 'CHARGING_STATUS_FAULT',
  CHARGING_STATUS_UNSPECIFIED = 'CHARGING_STATUS_UNSPECIFIED',
  CHARGING_STATUS_SCHEDULED = 'CHARGING_STATUS_SCHEDULED',
  CHARGING_STATUS_DISCHARGING = 'CHARGING_STATUS_DISCHARGING',
  CHARGING_STATUS_ERROR = 'CHARGING_STATUS_ERROR',
  CHARGING_STATUS_SMART_CHARGING = 'CHARGING_STATUS_SMART_CHARGING',
}

// ----- Interfaces ----------------------------------------------------------

export interface CarInformationData {
  vin: string;
  internalVehicleIdentifier: string | undefined;
  registrationNo: string | undefined;
  /** Human-readable model name, e.g. "Polestar 2". */
  modelName: string;
  modelYear: string | undefined;
}

export interface CarBatteryData {
  batteryChargeLevelPercentage: number | null;
  /** Raw API key, e.g. "CHARGING_STATUS_CHARGING". */
  chargingStatus: ChargingStatus;
  estimatedChargingTimeToFullMinutes: number | null;
  estimatedDistanceToEmptyKm: number | null;
  eventUpdatedTimestamp: Date | null;
}

export interface CarOdometerData {
  odometerMeters: number | null;
  eventUpdatedTimestamp: Date | null;
}

export interface CarHealthData {
  brakeFluidLevelWarning: string;
  daysToService: number | null;
  distanceToServiceKm: number | null;
  engineCoolantLevelWarning: string;
  oilLevelWarning: string;
  serviceWarning: string;
  eventUpdatedTimestamp: Date | null;
}

export interface CarTelematicsData {
  battery: CarBatteryData | null;
  odometer: CarOdometerData | null;
  health: CarHealthData | null;
}

// ----- Helper types --------------------------------------------------------

type GqlRecord = Record<string, unknown>;

// ----- Parsing helpers -----------------------------------------------------

function parseTimestamp(seconds: unknown): Date | null {
  if (seconds === null || seconds === undefined) {
    return null;
  }
  const secs = Number(seconds);
  return isNaN(secs) ? null : new Date(secs * 1000);
}

function parseChargingStatus(value: unknown): ChargingStatus {
  if (typeof value === 'string' && value in ChargingStatus) {
    return value as ChargingStatus;
  }
  return ChargingStatus.CHARGING_STATUS_UNSPECIFIED;
}

function getTimestampField(data: GqlRecord): Date | null {
  const ts = data['timestamp'] as GqlRecord | undefined;
  return parseTimestamp(ts?.['seconds']);
}

// ----- Public parsers ------------------------------------------------------

export function parseCarInformation(data: GqlRecord): CarInformationData {
  const content = data['content'] as GqlRecord | undefined;
  const model = content?.['model'] as GqlRecord | undefined;
  let modelName = (model?.['name'] as string | undefined) ?? 'Unknown';

  // API sometimes returns "Polestar4" instead of "Polestar 2" etc.
  const compact = modelName.match(/^([A-Za-z]+)(\d+)$/);
  if (compact) {
    modelName = `${compact[1]} ${compact[2]}`;
  }

  return {
    vin: data['vin'] as string,
    internalVehicleIdentifier: data['internalVehicleIdentifier'] as string | undefined,
    registrationNo: data['registrationNo'] as string | undefined,
    modelName,
    modelYear: data['modelYear'] as string | undefined,
  };
}

export function parseBatteryData(data: GqlRecord): CarBatteryData {
  return {
    batteryChargeLevelPercentage:
      data['batteryChargeLevelPercentage'] !== undefined && data['batteryChargeLevelPercentage'] !== null
        ? Number(data['batteryChargeLevelPercentage'])
        : null,
    chargingStatus: parseChargingStatus(data['chargingStatus']),
    estimatedChargingTimeToFullMinutes:
      data['estimatedChargingTimeToFullMinutes'] !== undefined && data['estimatedChargingTimeToFullMinutes'] !== null
        ? Number(data['estimatedChargingTimeToFullMinutes'])
        : null,
    estimatedDistanceToEmptyKm:
      data['estimatedDistanceToEmptyKm'] !== undefined && data['estimatedDistanceToEmptyKm'] !== null
        ? Number(data['estimatedDistanceToEmptyKm'])
        : null,
    eventUpdatedTimestamp: getTimestampField(data),
  };
}

export function parseOdometerData(data: GqlRecord): CarOdometerData {
  return {
    odometerMeters:
      data['odometerMeters'] !== undefined && data['odometerMeters'] !== null
        ? Number(data['odometerMeters'])
        : null,
    eventUpdatedTimestamp: getTimestampField(data),
  };
}

export function parseHealthData(data: GqlRecord): CarHealthData {
  return {
    brakeFluidLevelWarning: (data['brakeFluidLevelWarning'] as string | undefined) ?? 'UNSPECIFIED',
    daysToService:
      data['daysToService'] !== undefined && data['daysToService'] !== null
        ? Number(data['daysToService'])
        : null,
    distanceToServiceKm:
      data['distanceToServiceKm'] !== undefined && data['distanceToServiceKm'] !== null
        ? Number(data['distanceToServiceKm'])
        : null,
    engineCoolantLevelWarning:
      (data['engineCoolantLevelWarning'] as string | undefined) ?? 'UNSPECIFIED',
    oilLevelWarning: (data['oilLevelWarning'] as string | undefined) ?? 'UNSPECIFIED',
    serviceWarning: (data['serviceWarning'] as string | undefined) ?? 'UNSPECIFIED',
    eventUpdatedTimestamp: getTimestampField(data),
  };
}

/** Find the first record in a list whose vin matches (or any if vin is null). */
export function findByVin(items: GqlRecord[], vin: string): GqlRecord | null {
  return items.find((item) => item['vin'] === vin) ?? null;
}
