export interface PrimitiveSnapshot {
  sampledAt: string;
  sensorController: {
    status: "idle" | "starting" | "running" | "error" | "stopped";
    pollIntervalMs: number;
    lastLoopDurationMs: number | null;
  };
  imu: {
    status: "idle" | "starting" | "running" | "error";
    error: string | null;
    headingDeg: number | null;
    pitchDeg: number | null;
    rollDeg: number | null;
  };
  gnss: {
    status: "idle" | "running" | "error";
    error: string | null;
    xMeters: number | null;
    yMeters: number | null;
    headingDeg: number | null;
    positionAccuracyMeters: number | null;
    headingAccuracyDeg: number | null;
    fixType: "unknown" | "none" | "single" | "float" | "fixed";
    satellitesInUse: number | null;
    sampleAgeMillis: number | null;
  };
  poseFusion: {
    status: "idle" | "ok";
    error: string | null;
    xMeters: number | null;
    yMeters: number | null;
    headingDeg: number | null;
    quality: "gnss" | "dead-reckoning" | "unknown";
    speedMetersPerSecond: number | null;
    usingGnssHeading: boolean;
  };
  motors: {
    status: "idle" | "running" | "error";
    error: string | null;
    commandedLeftWheelOutputPercent: number | null;
    commandedRightWheelOutputPercent: number | null;
    leftWheelSpeedMetersPerSecond: number | null;
    rightWheelSpeedMetersPerSecond: number | null;
    leftRpm: number | null;
    rightRpm: number | null;
    leftEncoderDelta: number | null;
    rightEncoderDelta: number | null;
    leftPwmAppliedPercent: number | null;
    rightPwmAppliedPercent: number | null;
    leftMotorCurrentAmps: number | null;
    rightMotorCurrentAmps: number | null;
    watchdogHealthy: boolean | null;
    faultFlags: number | null;
  };
}

export class PrimitivesStore {
  private snapshotValue: PrimitiveSnapshot;

  constructor() {
    this.snapshotValue = this.buildDefaultSnapshot();
  }

  snapshot(): PrimitiveSnapshot {
    return {
      ...this.snapshotValue,
      imu: { ...this.snapshotValue.imu },
      gnss: { ...this.snapshotValue.gnss },
      poseFusion: { ...this.snapshotValue.poseFusion },
      motors: { ...this.snapshotValue.motors },
    };
  }

  update(partial: Partial<PrimitiveSnapshot>): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      ...partial,
      imu: {
        ...this.snapshotValue.imu,
        ...(partial.imu ?? {}),
      },
      gnss: {
        ...this.snapshotValue.gnss,
        ...(partial.gnss ?? {}),
      },
      poseFusion: {
        ...this.snapshotValue.poseFusion,
        ...(partial.poseFusion ?? {}),
      },
      motors: {
        ...this.snapshotValue.motors,
        ...(partial.motors ?? {}),
      },
      sampledAt: new Date().toISOString(),
    };
  }

  private buildDefaultSnapshot(): PrimitiveSnapshot {
    return {
      sampledAt: new Date().toISOString(),
      sensorController: {
        status: "idle",
        pollIntervalMs: 33,
        lastLoopDurationMs: null,
      },
      imu: {
        status: "idle",
        error: null,
        headingDeg: null,
        pitchDeg: null,
        rollDeg: null,
      },
      gnss: {
        status: "idle",
        error: null,
        xMeters: null,
        yMeters: null,
        headingDeg: null,
        positionAccuracyMeters: null,
        headingAccuracyDeg: null,
        fixType: "unknown",
        satellitesInUse: null,
        sampleAgeMillis: null,
      },
      poseFusion: {
        status: "idle",
        error: null,
        xMeters: null,
        yMeters: null,
        headingDeg: null,
        quality: "unknown",
        speedMetersPerSecond: null,
        usingGnssHeading: false,
      },
      motors: {
        status: "idle",
        error: null,
        commandedLeftWheelOutputPercent: null,
        commandedRightWheelOutputPercent: null,
        leftWheelSpeedMetersPerSecond: null,
        rightWheelSpeedMetersPerSecond: null,
        leftRpm: null,
        rightRpm: null,
        leftEncoderDelta: null,
        rightEncoderDelta: null,
        leftPwmAppliedPercent: null,
        rightPwmAppliedPercent: null,
        leftMotorCurrentAmps: null,
        rightMotorCurrentAmps: null,
        watchdogHealthy: null,
        faultFlags: null,
      },
    };
  }
}
