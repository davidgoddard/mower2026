import { EventEmitter } from "node:events";
import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { PrimitivesStore } from "../server/primitivesStore.js";
import { SensorHardwareGateway } from "./sensorHardwareGateway.js";
import { systemStop } from "../control/systemStop.js";
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
import {
  SensorControllerEvents,
  SENSOR_EVENTS,
} from "./sensorEvents.js";

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

type MotorCommand =
  | {
      kind: "speed";
      leftWheelTargetMetersPerSecond: number;
      rightWheelTargetMetersPerSecond: number;
    }
  | {
      kind: "stop";
    };

export class SensorController extends EventEmitter {
  private readonly logger: LoggerScope;
  private readonly primitivesStore: PrimitivesStore;
  private readonly gateway: SensorHardwareGateway;
  private readonly pollIntervalMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly maxLoopCount: number | null;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private lastMotorCommand: MotorCommand | null = null;
  private motorOperationDepth = 0;

  private imuHeading: InternalHeading = createInternalHeading(0);
  private previousImuSampleMillis: number | null = null;

  // Type-safe event subscription methods
  declare on: <K extends keyof SensorControllerEvents>(
    event: K,
    listener: (data: SensorControllerEvents[K]) => void
  ) => this;

  declare off: <K extends keyof SensorControllerEvents>(
    event: K,
    listener: (data: SensorControllerEvents[K]) => void
  ) => this;

  declare emit: <K extends keyof SensorControllerEvents>(
    event: K,
    data: SensorControllerEvents[K]
  ) => boolean;

  constructor(options: SensorControllerOptions) {
    super();
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
    systemStop.clearStop("sensor-controller-start");
    this.lastMotorCommand = null;
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
    if (this.motorOperationDepth === 0) {
      throw new Error("motor operation not active");
    }

    this.logger.info("motors.commanded", {
      leftWheelTargetMetersPerSecond,
      rightWheelTargetMetersPerSecond,
      callStack: this.captureCallStack(),
    });
    this.lastMotorCommand = {
      kind: "speed",
      leftWheelTargetMetersPerSecond,
      rightWheelTargetMetersPerSecond,
    };
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

  beginMotorOperation(): void {
    this.motorOperationDepth += 1;
  }

  async endMotorOperation(): Promise<void> {
    if (this.motorOperationDepth === 0) {
      this.logger.warn("motors.operation_end_without_start", {
        callStack: this.captureCallStack(),
      });
      return;
    }

    this.motorOperationDepth -= 1;
    if (this.motorOperationDepth === 0 && this.lastMotorCommand?.kind !== "stop") {
      try {
        await this.stopMotors();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("motors.operation_stop_failed", { error: message });
      }
    }
  }

  async stopMotors(): Promise<void> {
    this.logger.warn("motors.stop_requested", {
      currentCommandedLeftWheelSpeedMetersPerSecond: this.primitivesStore.snapshot().motors.commandedLeftWheelSpeedMetersPerSecond,
      currentCommandedRightWheelSpeedMetersPerSecond: this.primitivesStore.snapshot().motors.commandedRightWheelSpeedMetersPerSecond,
      callStack: this.captureCallStack(),
    });
    this.lastMotorCommand = {
      kind: "stop",
    };
    let stopError: unknown = null;
    try {
      await this.gateway.stopMotors();
    } catch (error) {
      stopError = error;
    }
    const current = this.primitivesStore.snapshot().motors;
    this.primitivesStore.update({
      motors: {
        ...current,
        commandedLeftWheelSpeedMetersPerSecond: 0,
        commandedRightWheelSpeedMetersPerSecond: 0,
      },
    });
    if (stopError) {
      throw stopError instanceof Error ? stopError : new Error(String(stopError));
    }
  }

  /**
   * Capture a short stack trace for motor control diagnostics.
   */
  private captureCallStack(): string {
    const stack = new Error().stack;
    if (!stack) {
      return "stack_unavailable";
    }

    return stack
      .split("\n")
      .slice(2, 8)
      .map((line) => line.trim())
      .join("\n");
  }

  private async runLoop(): Promise<void> {
    let nextTickMillis = this.nowMillis();
    let loopCount = 0;

    while (this.running) {
      const loopStartedMillis = this.nowMillis();
      await this.pollAllSensors();
      if (systemStop.isStopped()) {
        try {
          await this.stopMotors();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn("sensor.motors.stop_during_global_stop_failed", { error: message });
        }
      } else {
        await this.replayLastMotorCommand();
      }
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

      // Calculate pitch and roll from accelerometer
      const { xMetersPerSecondSquared: ax, yMetersPerSecondSquared: ay, zMetersPerSecondSquared: az } = sample.acceleration;
      const g = 9.80665;
      const pitchDeg = Math.atan2(-ax / g, Math.sqrt((ay * ay + az * az) / (g * g))) * (180 / Math.PI);
      const rollDeg = Math.atan2(ay / g, az / g) * (180 / Math.PI);

      this.primitivesStore.update({
        imu: {
          status: "running",
          error: null,
          headingDeg: unwrapInternalHeading(this.imuHeading),
          pitchDeg,
          rollDeg,
        },
      });

      // Emit heading update event
      this.emit(SENSOR_EVENTS.IMU_HEADING_UPDATE, {
        heading: this.imuHeading,
        pitchDeg,
        rollDeg,
        timestampMillis: sample.timestampMillis,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.primitivesStore.update({
        imu: {
          status: "error",
          error: message,
          headingDeg: unwrapInternalHeading(this.imuHeading),
          pitchDeg: null,
          rollDeg: null,
        },
      });
      this.logger.error("sensor.imu.poll_failed", { error: message });
    }
  }

  private async pollGnss(): Promise<void> {
    try {
      const sample = await this.gateway.readGnss();

      let internalHeadingDeg: number | null = null;
      let internalHeading: InternalHeading | null = null;
      if (sample.headingDegrees != null) {
        const fieldHeading = sample.headingDegrees as FieldHeading;
        internalHeading = fieldToInternal(fieldHeading);
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

      // Emit GNSS position update event
      this.emit(SENSOR_EVENTS.GNSS_POSITION_UPDATE, {
        xMeters: sample.xMeters,
        yMeters: sample.yMeters,
        heading: internalHeading,
        positionAccuracyMeters: sample.positionAccuracyMeters,
        headingAccuracyDeg: sample.headingAccuracyDegrees ?? null,
        fixType: sample.fixType,
        satellitesInUse: sample.satellitesInUse,
        timestampMillis: sample.timestampMillis,
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

      // Emit motor feedback update event
      this.emit(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, {
        leftWheelSpeedMetersPerSecond: sample.leftWheelActualMetersPerSecond,
        rightWheelSpeedMetersPerSecond: sample.rightWheelActualMetersPerSecond,
        leftEncoderDelta: sample.leftEncoderDelta,
        rightEncoderDelta: sample.rightEncoderDelta,
        leftPwmAppliedPercent: sample.leftPwmApplied,
        rightPwmAppliedPercent: sample.rightPwmApplied,
        leftMotorCurrentAmps: sample.leftMotorCurrentAmps ?? null,
        rightMotorCurrentAmps: sample.rightMotorCurrentAmps ?? null,
        watchdogHealthy: sample.watchdogHealthy,
        faultFlags: sample.faultFlags,
        timestampMillis: this.nowMillis(),
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

  /**
   * Re-send the last motor instruction so the motor node keeps receiving it
   * until some newer command supersedes it.
   */
  private async replayLastMotorCommand(): Promise<void> {
    const command = this.lastMotorCommand;
    if (!command) {
      return;
    }

    try {
      if (command.kind === "speed") {
        await this.gateway.setMotorWheelSpeeds(
          command.leftWheelTargetMetersPerSecond,
          command.rightWheelTargetMetersPerSecond,
        );
      } else {
        await this.gateway.stopMotors();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("sensor.motors.replay_failed", {
        error: message,
        commandKind: command.kind,
      });
    }
  }
}
