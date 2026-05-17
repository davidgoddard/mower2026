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
  const fullTurn = 360;
  return ((heading % fullTurn) + fullTurn) % fullTurn;
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
        latitude: null,
        longitude: null,
        fixQuality: "unknown",
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
    // GNSS and motor polling are intentionally staged for the next controlled integration step.
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
}
