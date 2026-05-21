import { EventEmitter } from "node:events";
import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { PrimitivesStore } from "../server/primitivesStore.js";
import { SensorHardwareGateway } from "./sensorHardwareGateway.js";
import { systemStop } from "../control/systemStop.js";
import { PoseCalibration } from "../config/poseCalibration.js";
import {
  InternalHeading,
  FieldHeading,
  createInternalHeading,
  fieldToInternal,
  addRelativeAngle,
  createRelativeAngle,
  headingDifference,
  unwrapInternalHeading,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
import { Position, createPosition, distanceBetween } from "../geometry/positionTypes.js";
import {
  ENCODER_METERS_PER_TICK_DEFAULT,
  SENSOR_POLL_INTERVAL_MS,
  MOTOR_STALL_COMMAND_THRESHOLD_PERCENT,
  MOTOR_STALL_ENCODER_DELTA_THRESHOLD,
  MOTOR_STALL_GNSS_ACCURACY_MAX_METERS,
  MOTOR_STALL_POSITION_DELTA_THRESHOLD_METERS,
  MOTOR_STALL_OBSERVATION_WINDOW_MS,
  MOTOR_STALL_CONSECUTIVE_SAMPLES,
  MOTOR_STALL_CURRENT_THRESHOLD_AMPS,
  MOTOR_STALL_STARTUP_GRACE_MS,
} from "../constants.js";
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
  poseCalibration?: PoseCalibration;
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
      kind: "output";
      leftWheelOutputPercent: number;
      rightWheelOutputPercent: number;
    }
  | {
      kind: "stop";
    };

export class SensorController extends EventEmitter {
  private readonly logger: LoggerScope;
  private readonly primitivesStore: PrimitivesStore;
  private readonly gateway: SensorHardwareGateway;
  private readonly poseCalibration: PoseCalibration | null;
  private readonly pollIntervalMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly maxLoopCount: number | null;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private lastMotorCommand: MotorCommand | null = null;
  private stopRequestLogged = false;
  private motorOperationDepth = 0;
  private previousMotorFeedbackTimestampMillis: number | null = null;
  private motorCommandActiveSinceMillis: number | null = null;
  private latestGnssPosition: Position | null = null;
  private latestGnssAccuracyMeters: number | null = null;
  private stallMotionAnchorPosition: Position | null = null;
  private stallMotionAnchorSinceMillis: number | null = null;
  private stallDetectionSamples = 0;
  private stallDetectionLatched = false;

  private imuHeading: InternalHeading = createInternalHeading(0);
  private previousImuSampleMillis: number | null = null;
  private lastImuHeadingLogMillis: number | null = null;
  private lastImuHeadingLogValue: InternalHeading | null = null;

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
    this.poseCalibration = options.poseCalibration ?? null;
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
    this.previousMotorFeedbackTimestampMillis = null;
    this.motorCommandActiveSinceMillis = null;
    this.latestGnssPosition = null;
    this.latestGnssAccuracyMeters = null;
    this.stallMotionAnchorPosition = null;
    this.stallMotionAnchorSinceMillis = null;
    this.stallDetectionSamples = 0;
    this.stallDetectionLatched = false;
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

    try {
      await this.sendDisableMotorsCommand();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("sensor.motors.shutdown_disable_failed", { error: message });
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

  async setMotorWheelOutputs(leftWheelOutputPercent: number, rightWheelOutputPercent: number): Promise<void> {
    if (this.motorOperationDepth === 0) {
      throw new Error("motor operation not active");
    }

    const isActiveCommand =
      Math.max(Math.abs(leftWheelOutputPercent), Math.abs(rightWheelOutputPercent)) >=
      MOTOR_STALL_COMMAND_THRESHOLD_PERCENT;
    const wasActiveCommand =
      this.lastMotorCommand?.kind === "output" &&
      Math.max(
        Math.abs(this.lastMotorCommand.leftWheelOutputPercent),
        Math.abs(this.lastMotorCommand.rightWheelOutputPercent),
      ) >= MOTOR_STALL_COMMAND_THRESHOLD_PERCENT;

    this.logger.info("motors.commanded", {
      leftWheelOutputPercent,
      rightWheelOutputPercent,
      callStack: this.captureCallStack(),
    });
    this.stopRequestLogged = false;
    this.lastMotorCommand = {
      kind: "output",
      leftWheelOutputPercent,
      rightWheelOutputPercent,
    };
    if (isActiveCommand && !wasActiveCommand) {
      this.motorCommandActiveSinceMillis = this.nowMillis();
      this.stallMotionAnchorPosition = this.latestGnssPosition;
      this.stallMotionAnchorSinceMillis = this.stallMotionAnchorPosition !== null ? this.nowMillis() : null;
      this.stallDetectionSamples = 0;
      this.stallDetectionLatched = false;
    } else if (!isActiveCommand) {
      this.motorCommandActiveSinceMillis = null;
      this.stallMotionAnchorPosition = null;
      this.stallMotionAnchorSinceMillis = null;
      this.stallDetectionSamples = 0;
      this.stallDetectionLatched = false;
    }
    await this.gateway.setMotorWheelOutputs(leftWheelOutputPercent, rightWheelOutputPercent);
    const current = this.primitivesStore.snapshot().motors;
    this.primitivesStore.update({
      motors: {
        ...current,
        commandedLeftWheelOutputPercent: leftWheelOutputPercent,
        commandedRightWheelOutputPercent: rightWheelOutputPercent,
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
    if (this.motorOperationDepth === 0) {
      try {
        await this.sendDisableMotorsCommand();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("motors.operation_stop_failed", { error: message });
      }
    }
  }

  async stopMotors(): Promise<void> {
    if (!this.stopRequestLogged) {
      this.logger.warn("motors.stop_requested", {
        currentCommandedLeftWheelOutputPercent: this.primitivesStore.snapshot().motors.commandedLeftWheelOutputPercent,
        currentCommandedRightWheelOutputPercent: this.primitivesStore.snapshot().motors.commandedRightWheelOutputPercent,
        callStack: this.captureCallStack(),
      });
      this.stopRequestLogged = true;
    }

    await this.sendGentleStopMotorsCommand();
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
          await this.sendGentleStopMotorsCommand();
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
      const acceleration = sample.acceleration ?? {
        xMetersPerSecondSquared: 0,
        yMetersPerSecondSquared: 0,
        zMetersPerSecondSquared: 0,
      };
      if (this.previousImuSampleMillis != null) {
        const deltaSeconds = Math.max(0, sample.timestampMillis - this.previousImuSampleMillis) / MS_PER_SECOND;
        const yawDelta = createRelativeAngle(sample.angularVelocity.zDegreesPerSecond * deltaSeconds);
        this.imuHeading = addRelativeAngle(this.imuHeading, yawDelta);
      }
      this.previousImuSampleMillis = sample.timestampMillis;

      // Calculate pitch and roll from accelerometer
      const { xMetersPerSecondSquared: ax, yMetersPerSecondSquared: ay, zMetersPerSecondSquared: az } = acceleration;
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

      const shouldLogImuHeading =
        this.lastImuHeadingLogMillis === null ||
        sample.timestampMillis - this.lastImuHeadingLogMillis >= 1000;
      if (shouldLogImuHeading) {
        const currentHeadingDeg = unwrapInternalHeading(this.imuHeading);
        const headingChangeDeg = this.lastImuHeadingLogValue === null
          ? 0
          : Math.abs(unwrapRelativeAngle(headingDifference(this.lastImuHeadingLogValue, this.imuHeading)));
        this.logger.info("sensor.imu.heading_sample", {
          headingDeg: currentHeadingDeg,
          headingChangeSinceLastLogDeg: headingChangeDeg,
          yawRateDegPerSec: sample.angularVelocity.zDegreesPerSecond,
          sampleDeltaMs: this.previousImuSampleMillis !== null ? sample.timestampMillis - this.previousImuSampleMillis : null,
        });
        this.lastImuHeadingLogMillis = sample.timestampMillis;
        this.lastImuHeadingLogValue = this.imuHeading;
      }

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

      this.latestGnssPosition = createPosition(sample.xMeters, sample.yMeters);
      this.latestGnssAccuracyMeters = sample.positionAccuracyMeters;

      if (this.motorCommandActiveSinceMillis !== null && this.stallMotionAnchorPosition === null) {
        this.stallMotionAnchorPosition = this.latestGnssPosition;
        this.stallMotionAnchorSinceMillis = this.nowMillis();
      }

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
      const metersPerTick = this.poseCalibration?.getEncoderCalibration() ?? ENCODER_METERS_PER_TICK_DEFAULT;
      const wheelSpeed = this.computeWheelSpeedMetersPerSecond(sample.timestampMillis, sample.leftEncoderDelta, metersPerTick);
      const rightWheelSpeed = this.computeWheelSpeedMetersPerSecond(sample.timestampMillis, sample.rightEncoderDelta, metersPerTick);
      this.previousMotorFeedbackTimestampMillis = sample.timestampMillis;
      const current = this.primitivesStore.snapshot().motors;
      this.primitivesStore.update({
        motors: {
          ...current,
          status: "running",
          error: null,
          leftWheelSpeedMetersPerSecond: wheelSpeed,
          rightWheelSpeedMetersPerSecond: rightWheelSpeed,
          leftRpm: null,
          rightRpm: null,
          leftEncoderDelta: sample.leftEncoderDelta,
          rightEncoderDelta: sample.rightEncoderDelta,
          leftPwmAppliedPercent: sample.leftPwmAppliedPercent,
          rightPwmAppliedPercent: sample.rightPwmAppliedPercent,
          leftMotorCurrentAmps: sample.leftMotorCurrentAmps ?? null,
          rightMotorCurrentAmps: sample.rightMotorCurrentAmps ?? null,
          watchdogHealthy: sample.watchdogHealthy,
          faultFlags: sample.faultFlags,
        },
      });

      // Emit motor feedback update event
      this.emit(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, {
        leftWheelSpeedMetersPerSecond: wheelSpeed,
        rightWheelSpeedMetersPerSecond: rightWheelSpeed,
        leftEncoderDelta: sample.leftEncoderDelta,
        rightEncoderDelta: sample.rightEncoderDelta,
        leftPwmAppliedPercent: sample.leftPwmAppliedPercent,
        rightPwmAppliedPercent: sample.rightPwmAppliedPercent,
        leftMotorCurrentAmps: sample.leftMotorCurrentAmps ?? null,
        rightMotorCurrentAmps: sample.rightMotorCurrentAmps ?? null,
        watchdogHealthy: sample.watchdogHealthy,
        faultFlags: sample.faultFlags,
        timestampMillis: sample.timestampMillis,
      });

      this.evaluateStallDetection(
        sample.leftEncoderDelta,
        sample.rightEncoderDelta,
        sample.leftMotorCurrentAmps ?? null,
        sample.rightMotorCurrentAmps ?? null,
        sample.faultFlags,
      );
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

  private evaluateStallDetection(
    leftEncoderDelta: number,
    rightEncoderDelta: number,
    leftMotorCurrentAmps: number | null,
    rightMotorCurrentAmps: number | null,
    faultFlags: number,
  ): void {
    if (systemStop.isStopped()) {
      this.stallDetectionSamples = 0;
      this.stallDetectionLatched = false;
      return;
    }

    if (
      this.motorCommandActiveSinceMillis !== null &&
      this.nowMillis() - this.motorCommandActiveSinceMillis < MOTOR_STALL_STARTUP_GRACE_MS
    ) {
      this.stallDetectionSamples = 0;
      this.stallDetectionLatched = false;
      return;
    }

    const motors = this.primitivesStore.snapshot().motors;
    const leftCommand = Math.abs(motors.commandedLeftWheelOutputPercent ?? 0);
    const rightCommand = Math.abs(motors.commandedRightWheelOutputPercent ?? 0);
    const commandActive =
      leftCommand >= MOTOR_STALL_COMMAND_THRESHOLD_PERCENT &&
      rightCommand >= MOTOR_STALL_COMMAND_THRESHOLD_PERCENT;

    let positionStationary = false;
    if (
      this.latestGnssPosition !== null &&
      this.stallMotionAnchorPosition !== null &&
      this.stallMotionAnchorSinceMillis !== null &&
      this.latestGnssAccuracyMeters !== null &&
      this.latestGnssAccuracyMeters <= MOTOR_STALL_GNSS_ACCURACY_MAX_METERS
    ) {
      const movementSinceAnchor = distanceBetween(this.stallMotionAnchorPosition, this.latestGnssPosition);
      if (movementSinceAnchor >= MOTOR_STALL_POSITION_DELTA_THRESHOLD_METERS) {
        this.stallMotionAnchorPosition = this.latestGnssPosition;
        this.stallMotionAnchorSinceMillis = this.nowMillis();
        this.stallDetectionSamples = 0;
        this.stallDetectionLatched = false;
        return;
      }

      if (this.nowMillis() - this.stallMotionAnchorSinceMillis < MOTOR_STALL_OBSERVATION_WINDOW_MS) {
        return;
      }

      positionStationary = true;
    }

    const encoderStationaryFallback =
      Math.abs(leftEncoderDelta) <= MOTOR_STALL_ENCODER_DELTA_THRESHOLD &&
      Math.abs(rightEncoderDelta) <= MOTOR_STALL_ENCODER_DELTA_THRESHOLD;

    const currentHigh =
      (leftMotorCurrentAmps !== null && leftMotorCurrentAmps >= MOTOR_STALL_CURRENT_THRESHOLD_AMPS) ||
      (rightMotorCurrentAmps !== null && rightMotorCurrentAmps >= MOTOR_STALL_CURRENT_THRESHOLD_AMPS) ||
      faultFlags !== 0;

    const stationary = commandActive && (positionStationary || encoderStationaryFallback);

    if (!stationary) {
      this.stallDetectionSamples = 0;
      this.stallDetectionLatched = false;
      if (commandActive && this.stallMotionAnchorPosition === null && this.latestGnssPosition !== null) {
        this.stallMotionAnchorPosition = this.latestGnssPosition;
        this.stallMotionAnchorSinceMillis = this.nowMillis();
      }
      return;
    }

    this.stallDetectionSamples += currentHigh ? 2 : 1;
    if (this.stallDetectionLatched || this.stallDetectionSamples < MOTOR_STALL_CONSECUTIVE_SAMPLES) {
      return;
    }

    this.stallDetectionLatched = true;
    const current = this.primitivesStore.snapshot().motors;
    this.primitivesStore.update({
      motors: {
        ...current,
        status: "error",
        error: "motor_stall_detected",
      },
    });

    this.logger.warn("sensor.motors.stall_detected", {
      leftCommandPercent: leftCommand,
      rightCommandPercent: rightCommand,
      leftEncoderDelta,
      rightEncoderDelta,
      leftMotorCurrentAmps,
      rightMotorCurrentAmps,
      faultFlags,
      consecutiveSamples: this.stallDetectionSamples,
    });

    this.emit(SENSOR_EVENTS.OBSTRUCTION_DETECTED, {
      type: "stall",
      timestampMillis: this.nowMillis(),
      leftMotorCurrentAmps: leftMotorCurrentAmps ?? 0,
      rightMotorCurrentAmps: rightMotorCurrentAmps ?? 0,
      leftWheelSpeedMetersPerSecond: 0,
      rightWheelSpeedMetersPerSecond: 0,
    });
    systemStop.requestStop("sensors", "motor_stall_detected");
  }

  private async sendGentleStopMotorsCommand(): Promise<void> {
    if (
      this.lastMotorCommand?.kind === "output" &&
      this.lastMotorCommand.leftWheelOutputPercent === 0 &&
      this.lastMotorCommand.rightWheelOutputPercent === 0
    ) {
      return;
    }

    if (this.lastMotorCommand?.kind === "stop") {
      return;
    }

    this.lastMotorCommand = {
      kind: "output",
      leftWheelOutputPercent: 0,
      rightWheelOutputPercent: 0,
    };
    this.motorCommandActiveSinceMillis = null;
    this.stallMotionAnchorPosition = null;
    this.stallMotionAnchorSinceMillis = null;
    this.stallDetectionSamples = 0;
    this.stallDetectionLatched = false;
    try {
      await this.gateway.setMotorWheelOutputs(0, 0);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    const current = this.primitivesStore.snapshot().motors;
    this.primitivesStore.update({
      motors: {
        ...current,
        commandedLeftWheelOutputPercent: 0,
        commandedRightWheelOutputPercent: 0,
      },
    });
  }

  private async sendDisableMotorsCommand(): Promise<void> {
    if (this.lastMotorCommand?.kind === "stop") {
      return;
    }

    this.lastMotorCommand = {
      kind: "stop",
    };
    this.motorCommandActiveSinceMillis = null;
    this.stallMotionAnchorPosition = null;
    this.stallMotionAnchorSinceMillis = null;
    this.stallDetectionSamples = 0;
    this.stallDetectionLatched = false;

    await this.gateway.stopMotors();
    const current = this.primitivesStore.snapshot().motors;
    this.primitivesStore.update({
      motors: {
        ...current,
        commandedLeftWheelOutputPercent: 0,
        commandedRightWheelOutputPercent: 0,
      },
    });
  }

  private computeWheelSpeedMetersPerSecond(
    timestampMillis: number,
    encoderDelta: number,
    metersPerTick: number,
  ): number {
    if (this.previousMotorFeedbackTimestampMillis === null) {
      return 0;
    }

    const elapsedMillis = timestampMillis - this.previousMotorFeedbackTimestampMillis;
    if (elapsedMillis <= 0) {
      return 0;
    }

    const elapsedSeconds = elapsedMillis / 1000;
    return (encoderDelta * metersPerTick) / elapsedSeconds;
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
      if (command.kind === "output") {
        await this.gateway.setMotorWheelOutputs(
          command.leftWheelOutputPercent,
          command.rightWheelOutputPercent,
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
