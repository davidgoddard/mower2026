import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { PrimitivesStore } from "../server/primitivesStore.js";
import { SensorHardwareGateway } from "./sensorHardwareGateway.js";
import {
  InternalHeading,
  FieldHeading,
  createInternalHeading,
  fieldToInternal,
  addRelativeAngle,
  createRelativeAngle,
  unwrapInternalHeading,
} from "../geometry/headingTypes.js";
import { SENSOR_POLL_INTERVAL_MS } from "../constants.js";

// Time conversion constant (implementation detail)
const MS_PER_SECOND = 1000;

interface SensorControllerOptions {
  logger: SessionLogger;
  primitivesStore: PrimitivesStore;
  gateway: SensorHardwareGateway;
  pollIntervalMs?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  maxLoopCount?: number;
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

  private imuHeading: InternalHeading = createInternalHeading(0);
  private previousImuSampleMillis: number | null = null;

  constructor(options: SensorControllerOptions) {
    this.logger = options.logger.child({ context: "sensors", source: "SensorController" });
    this.primitivesStore = options.primitivesStore;
    this.gateway = options.gateway;
    this.pollIntervalMs = options.pollIntervalMs ?? SENSOR_POLL_INTERVAL_MS;
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
        headingDeg: unwrapInternalHeading(this.imuHeading),
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
        commandedLeftWheelSpeedMetersPerSecond: null,
        commandedRightWheelSpeedMetersPerSecond: null,
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

  getHeading(): InternalHeading {
    return this.imuHeading;
  }

  setHeading(heading: InternalHeading): void {
    this.imuHeading = heading;
    this.previousImuSampleMillis = null;
    const currentImu = this.primitivesStore.snapshot().imu;
    this.primitivesStore.update({
      imu: {
        ...currentImu,
        headingDeg: unwrapInternalHeading(this.imuHeading),
      },
    });
  }

  async setMotorWheelSpeeds(leftWheelTargetMetersPerSecond: number, rightWheelTargetMetersPerSecond: number): Promise<void> {
    await this.gateway.setMotorWheelSpeeds(leftWheelTargetMetersPerSecond, rightWheelTargetMetersPerSecond);
    const current = this.primitivesStore.snapshot().motors;
    this.primitivesStore.update({
      motors: {
        ...current,
        commandedLeftWheelSpeedMetersPerSecond: leftWheelTargetMetersPerSecond,
        commandedRightWheelSpeedMetersPerSecond: rightWheelTargetMetersPerSecond,
      },
    });
  }

  async stopMotors(): Promise<void> {
    await this.gateway.stopMotors();
    const current = this.primitivesStore.snapshot().motors;
    this.primitivesStore.update({
      motors: {
        ...current,
        commandedLeftWheelSpeedMetersPerSecond: 0,
        commandedRightWheelSpeedMetersPerSecond: 0,
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
    await this.pollMotors();
  }

  private async pollImu(): Promise<void> {
    try {
      const sample = await this.gateway.readImu();
      if (this.previousImuSampleMillis != null) {
        const deltaSeconds = Math.max(0, sample.timestampMillis - this.previousImuSampleMillis) / MS_PER_SECOND;
        const yawDelta = createRelativeAngle(sample.angularVelocity.zDegreesPerSecond * deltaSeconds);
        this.imuHeading = addRelativeAngle(this.imuHeading, yawDelta);
      }
      this.previousImuSampleMillis = sample.timestampMillis;

      this.primitivesStore.update({
        imu: {
          status: "running",
          error: null,
          headingDeg: unwrapInternalHeading(this.imuHeading),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.primitivesStore.update({
        imu: {
          status: "error",
          error: message,
          headingDeg: unwrapInternalHeading(this.imuHeading),
        },
      });
      this.logger.error("sensor.imu.poll_failed", { error: message });
    }
  }

  private async pollGnss(): Promise<void> {
    try {
      const sample = await this.gateway.readGnss();

      let internalHeadingDeg: number | null = null;
      if (sample.headingDegrees != null) {
        const fieldHeading = sample.headingDegrees as FieldHeading;
        const internalHeading = fieldToInternal(fieldHeading);
        internalHeadingDeg = unwrapInternalHeading(internalHeading);
      }

      this.primitivesStore.update({
        gnss: {
          status: "running",
          error: null,
          xMeters: sample.xMeters,
          yMeters: sample.yMeters,
          headingDeg: internalHeadingDeg,
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

  private async pollMotors(): Promise<void> {
    try {
      const sample = await this.gateway.readMotorFeedback();
      const current = this.primitivesStore.snapshot().motors;
      this.primitivesStore.update({
        motors: {
          ...current,
          status: "running",
          error: null,
          leftWheelSpeedMetersPerSecond: sample.leftWheelActualMetersPerSecond,
          rightWheelSpeedMetersPerSecond: sample.rightWheelActualMetersPerSecond,
          leftRpm: null,
          rightRpm: null,
          leftEncoderDelta: sample.leftEncoderDelta,
          rightEncoderDelta: sample.rightEncoderDelta,
          leftPwmAppliedPercent: sample.leftPwmApplied,
          rightPwmAppliedPercent: sample.rightPwmApplied,
          leftMotorCurrentAmps: sample.leftMotorCurrentAmps ?? null,
          rightMotorCurrentAmps: sample.rightMotorCurrentAmps ?? null,
          watchdogHealthy: sample.watchdogHealthy,
          faultFlags: sample.faultFlags,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.primitivesStore.snapshot().motors;
      this.primitivesStore.update({
        motors: {
          ...current,
          status: "error",
          error: message,
        },
      });
      this.logger.error("sensor.motors.poll_failed", { error: message });
    }
  }
}
