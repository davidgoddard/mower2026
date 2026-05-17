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
  motors: {
    status: "idle" | "running" | "error";
    error: string | null;
    leftRpm: number | null;
    rightRpm: number | null;
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
      motors: {
        status: "idle",
        error: null,
        leftRpm: null,
        rightRpm: null,
      },
    };
  }
}
