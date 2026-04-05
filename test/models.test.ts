import {
  ChargingStatus,
  parseCarInformation,
  parseBatteryData,
  parseOdometerData,
  parseHealthData,
  parseLocationData,
  findByVin,
  ActionCommand,
} from '../src/api/models';

// ---------------------------------------------------------------------------
// parseCarInformation
// ---------------------------------------------------------------------------

describe('parseCarInformation', () => {
  it('parses a standard vehicle record', () => {
    const raw = {
      vin: 'YV1ABCDEF12345678',
      internalVehicleIdentifier: 'internal-id',
      registrationNo: 'ABC123',
      modelYear: '2023',
      content: { model: { name: 'Polestar 2' } },
    };

    const result = parseCarInformation(raw);

    expect(result.vin).toBe('YV1ABCDEF12345678');
    expect(result.modelName).toBe('Polestar 2');
    expect(result.modelYear).toBe('2023');
    expect(result.registrationNo).toBe('ABC123');
    expect(result.internalVehicleIdentifier).toBe('internal-id');
  });

  it('expands a compact model name like "Polestar4" to "Polestar 4"', () => {
    const raw = {
      vin: 'VIN1',
      content: { model: { name: 'Polestar4' } },
    };
    const result = parseCarInformation(raw);
    expect(result.modelName).toBe('Polestar 4');
  });

  it('falls back to "Unknown" when model name is absent', () => {
    const raw = { vin: 'VIN1', content: {} };
    const result = parseCarInformation(raw);
    expect(result.modelName).toBe('Unknown');
  });

  it('handles missing content gracefully', () => {
    const raw = { vin: 'VIN1' };
    const result = parseCarInformation(raw);
    expect(result.modelName).toBe('Unknown');
    expect(result.modelYear).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseBatteryData
// ---------------------------------------------------------------------------

describe('parseBatteryData', () => {
  it('parses a fully populated battery record', () => {
    const raw = {
      batteryChargeLevelPercentage: 75,
      chargingStatus: 'CHARGING_STATUS_CHARGING',
      estimatedChargingTimeToFullMinutes: 30,
      estimatedDistanceToEmptyKm: 250,
      timestamp: { seconds: 1700000000, nanos: 0 },
    };

    const result = parseBatteryData(raw);

    expect(result.batteryChargeLevelPercentage).toBe(75);
    expect(result.chargingStatus).toBe(ChargingStatus.CHARGING_STATUS_CHARGING);
    expect(result.estimatedChargingTimeToFullMinutes).toBe(30);
    expect(result.estimatedDistanceToEmptyKm).toBe(250);
    expect(result.eventUpdatedTimestamp).toEqual(new Date(1700000000 * 1000));
  });

  it('falls back to UNSPECIFIED for an unknown chargingStatus', () => {
    const raw = { chargingStatus: 'SOME_UNKNOWN_VALUE' };
    const result = parseBatteryData(raw);
    expect(result.chargingStatus).toBe(ChargingStatus.CHARGING_STATUS_UNSPECIFIED);
  });

  it('handles null numeric fields', () => {
    const raw = {
      batteryChargeLevelPercentage: null,
      estimatedDistanceToEmptyKm: null,
    };
    const result = parseBatteryData(raw);
    expect(result.batteryChargeLevelPercentage).toBeNull();
    expect(result.estimatedDistanceToEmptyKm).toBeNull();
  });

  it('returns null timestamp when timestamp is missing', () => {
    const raw = { batteryChargeLevelPercentage: 50 };
    const result = parseBatteryData(raw);
    expect(result.eventUpdatedTimestamp).toBeNull();
  });

  it('identifies each known ChargingStatus value', () => {
    for (const status of Object.values(ChargingStatus)) {
      const raw = { chargingStatus: status };
      expect(parseBatteryData(raw).chargingStatus).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// parseOdometerData
// ---------------------------------------------------------------------------

describe('parseOdometerData', () => {
  it('parses odometer data', () => {
    const raw = {
      odometerMeters: 42000,
      timestamp: { seconds: 1700000000 },
    };
    const result = parseOdometerData(raw);
    expect(result.odometerMeters).toBe(42000);
    expect(result.eventUpdatedTimestamp).toEqual(new Date(1700000000 * 1000));
  });

  it('handles null odometer', () => {
    const result = parseOdometerData({ odometerMeters: null });
    expect(result.odometerMeters).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseHealthData
// ---------------------------------------------------------------------------

describe('parseHealthData', () => {
  it('parses health data', () => {
    const raw = {
      brakeFluidLevelWarning: 'BRAKE_FLUID_LEVEL_WARNING_NO_WARNING',
      daysToService: 365,
      distanceToServiceKm: 10000,
      engineCoolantLevelWarning: 'ENGINE_COOLANT_LEVEL_WARNING_NO_WARNING',
      oilLevelWarning: 'OIL_LEVEL_WARNING_NO_WARNING',
      serviceWarning: 'SERVICE_WARNING_NO_WARNING',
      timestamp: { seconds: 1700000000 },
    };

    const result = parseHealthData(raw);
    expect(result.daysToService).toBe(365);
    expect(result.distanceToServiceKm).toBe(10000);
    expect(result.brakeFluidLevelWarning).toBe('BRAKE_FLUID_LEVEL_WARNING_NO_WARNING');
  });

  it('defaults warning fields to "UNSPECIFIED" when absent', () => {
    const result = parseHealthData({});
    expect(result.brakeFluidLevelWarning).toBe('UNSPECIFIED');
    expect(result.engineCoolantLevelWarning).toBe('UNSPECIFIED');
    expect(result.oilLevelWarning).toBe('UNSPECIFIED');
    expect(result.serviceWarning).toBe('UNSPECIFIED');
  });
});

// ---------------------------------------------------------------------------
// findByVin
// ---------------------------------------------------------------------------

describe('findByVin', () => {
  const items = [
    { vin: 'VIN001', value: 'a' },
    { vin: 'VIN002', value: 'b' },
  ];

  it('finds the correct record', () => {
    expect(findByVin(items, 'VIN001')).toEqual({ vin: 'VIN001', value: 'a' });
    expect(findByVin(items, 'VIN002')).toEqual({ vin: 'VIN002', value: 'b' });
  });

  it('returns null when VIN is not found', () => {
    expect(findByVin(items, 'VINXXX')).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(findByVin([], 'VIN001')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseLocationData
// ---------------------------------------------------------------------------

describe('parseLocationData', () => {
  it('parses latitude, longitude and timestamp', () => {
    const raw = {
      latitude: 59.334591,
      longitude: 18.063240,
      timestamp: { seconds: 1700000000, nanos: 0 },
    };

    const result = parseLocationData(raw);

    expect(result.latitude).toBeCloseTo(59.334591, 5);
    expect(result.longitude).toBeCloseTo(18.06324, 5);
    expect(result.eventUpdatedTimestamp).toEqual(new Date(1700000000 * 1000));
  });

  it('handles null/missing coordinate fields gracefully', () => {
    const raw = { latitude: null, longitude: null };
    const result = parseLocationData(raw);
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
    expect(result.eventUpdatedTimestamp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ActionCommand enum
// ---------------------------------------------------------------------------

describe('ActionCommand', () => {
  it('has the expected string values', () => {
    expect(ActionCommand.CLIMATE_START).toBe('CLIMATE_START');
    expect(ActionCommand.CLIMATE_STOP).toBe('CLIMATE_STOP');
    expect(ActionCommand.LOCK).toBe('LOCK');
    expect(ActionCommand.UNLOCK).toBe('UNLOCK');
  });
});
