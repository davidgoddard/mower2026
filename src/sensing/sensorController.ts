import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { PrimitivesStore } from "../server/primitivesStore.js";
import { SensorHardwareGateway } from "./sensorHardwareGateway.js";

interface SensorControllerOptions {
  logger: SessionLogger;
  primitivesStore: PrimitivesStore;
  gateway: SensorHardwareGateway;
  pollIntervalMs?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  maxLoopCount?: number;
}

function normalizeHeadingDegrees(heading: number): number {
  let normalized = heading;
  while (normalized <= -180) {
    normalized += 360;
  }
  while (normalized > 180) {
    normalized -= 360;
  }
  return normalized;
}

function convertFieldHeadingToInternalDegrees(fieldHeadingDegrees: number): number {
  return normalizeHeadingDegrees(90 - fieldHeadingDegrees);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class SensorController {
  private readonly logger: LoggerScope;
  private readonly primitivesStore: PrimitivesStore;
  private readonly gateway: SensorHardwareGateway;
  private readonly pollIntervalMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly maxLoopCount: number | null;

  private running = false;
  private loopPromise: Promise<void> | null = null;

  private imuHeadingDegrees = 0;
  private previousImuSampleMillis: number | null = null;

  constructor(options: SensorControllerOptions) {
    this.logger = options.logger.child({ context: "sensors", source: "SensorController" });
    this.primitivesStore = options.primitivesStore;
    this.gateway = options.gateway;
    this.pollIntervalMs = options.pollIntervalMs ?? 33;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.maxLoopCount = options.maxLoopCount ?? null;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.primitivesStore.update({
      sensorController: {
        status: "starting",
        pollIntervalMs: this.pollIntervalMs,
        lastLoopDurationMs: null,
      },
      imu: {
        status: "starting",
        error: null,
        headingDeg: this.imuHeadingDegrees,
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
    });

    this.logger.transition("idle", "running", { pollIntervalMs: this.pollIntervalMs });
    this.primitivesStore.update({
      sensorController: {
        status: "running",
        pollIntervalMs: this.pollIntervalMs,
        lastLoopDurationMs: null,
      },
    });

    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }

    this.primitivesStore.update({
      sensorController: {
        status: "stopped",
        pollIntervalMs: this.pollIntervalMs,
        lastLoopDurationMs: null,
      },
    });
  }

  getHeadingDegrees(): number {
    return this.imuHeadingDegrees;
  }

  setHeadingDegrees(headingDegrees: number): void {
    this.imuHeadingDegrees = normalizeHeadingDegrees(headingDegrees);
    this.previousImuSampleMillis = null;
    const currentImu = this.primitivesStore.snapshot().imu;
    this.primitivesStore.update({
      imu: {
        ...currentImu,
        headingDeg: this.imuHeadingDegrees,
      },
    });
  }

  private async runLoop(): Promise<void> {
    let nextTickMillis = this.nowMillis();
    let loopCount = 0;

    while (this.running) {
      const loopStartedMillis = this.nowMillis();
      await this.pollAllSensors();
      const loopDurationMs = this.nowMillis() - loopStartedMillis;

      this.primitivesStore.update({
        sensorController: {
          status: "running",
          pollIntervalMs: this.pollIntervalMs,
          lastLoopDurationMs: loopDurationMs,
        },
      });

      nextTickMillis += this.pollIntervalMs;
      const waitMillis = Math.max(0, nextTickMillis - this.nowMillis());
      await this.sleep(waitMillis);

      loopCount += 1;
      if (this.maxLoopCount !== null && loopCount >= this.maxLoopCount) {
        this.running = false;
      }
    }
  }

  private async pollAllSensors(): Promise<void> {
    await this.pollImu();
    await this.pollGnss();
  }

  private async pollImu(): Promise<void> {
    try {
      const sample = await this.gateway.readImu();
      if (this.previousImuSampleMillis != null) {
        const deltaSeconds = Math.max(0, sample.timestampMillis - this.previousImuSampleMillis) / 1000;
        this.imuHeadingDegrees = normalizeHeadingDegrees(
          this.imuHeadingDegrees + (sample.angularVelocity.zDegreesPerSecond * deltaSeconds),
        );
      }
      this.previousImuSampleMillis = sample.timestampMillis;

      this.primitivesStore.update({
        imu: {
          status: "running",
          error: null,
          headingDeg: this.imuHeadingDegrees,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.primitivesStore.update({
        imu: {
          status: "error",
          error: message,
          headingDeg: this.imuHeadingDegrees,
        },
      });
      this.logger.error("sensor.imu.poll_failed", { error: message });
    }
  }

  private async pollGnss(): Promise<void> {
    try {
      const sample = await this.gateway.readGnss();
      this.primitivesStore.update({
        gnss: {
          status: "running",
          error: null,
          xMeters: sample.xMeters,
          yMeters: sample.yMeters,
          headingDeg: sample.headingDegrees == null
            ? null
            : convertFieldHeadingToInternalDegrees(sample.headingDegrees),
          positionAccuracyMeters: sample.positionAccuracyMeters,
          headingAccuracyDeg: sample.headingAccuracyDegrees ?? null,
          fixType: sample.fixType,
          satellitesInUse: sample.satellitesInUse,
          sampleAgeMillis: sample.sampleAgeMillis,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.primitivesStore.snapshot().gnss;
      this.primitivesStore.update({
        gnss: {
          ...current,
          status: "error",
          error: message,
        },
      });
      this.logger.error("sensor.gnss.poll_failed", { error: message });
    }
  }
}
