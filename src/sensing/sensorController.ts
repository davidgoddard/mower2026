import { EventEmitter } from "node:events";
import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { PrimitivesStore } from "../server/primitivesStore.js";
import { SensorHardwareGateway } from "./sensorHardwareGateway.js";
import { systemStop } from "../control/systemStop.js";
import { ImuCalibration } from "../config/imuCalibration.js";
import { PoseCalibration } from "../config/poseCalibration.js";
import { GeometryCalibration } from "../config/geometryCalibration.js";
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
import {
  Position,
  createPosition,
  distanceBetween,
  unwrapMeters,
  translatePositionByHeading,
  createBodyFrameOffset,
} from "../geometry/positionTypes.js";
import {
  ENCODER_METERS_PER_TICK_DEFAULT,
  SENSOR_CONTROLLER_POLL_INTERVAL_MS,
  MOTOR_STALL_COMMAND_THRESHOLD_PERCENT,
  MOTOR_STALL_ENCODER_DELTA_THRESHOLD,
  MOTOR_STALL_GNSS_ACCURACY_MAX_METERS,
  MOTOR_STALL_POSITION_DELTA_THRESHOLD_METERS,
  MOTOR_STALL_OBSERVATION_WINDOW_MS,
  MOTOR_STALL_CONSECUTIVE_SAMPLES,
  MOTOR_STALL_CURRENT_THRESHOLD_AMPS,
  MOTOR_STALL_STARTUP_GRACE_MS,
  MOTOR_OUTPUT_DEADBAND_PERCENT,
  MOTOR_MIN_ACTIVE_OUTPUT_PERCENT,
} from "../constants.js";
import {
  SensorControllerEvents,
  SENSOR_EVENTS,
} from "./sensorEvents.js";

// Time conversion constant (implementation detail)
const MS_PER_SECOND = 1000;
const DEG_TO_RAD = Math.PI / 180;
const IMU_DIAGNOSTIC_WINDOW_MS = 5_000;
const IMU_DIAGNOSTIC_MAX_SAMPLES = 1_000;
const IMU_DIAGNOSTIC_RECENT_SAMPLE_LIMIT = 20;
const HEADING_REBASE_MAX_YAW_RATE_DEG_PER_SEC = 1;

interface SensorControllerOptions {
  logger: SessionLogger;
  primitivesStore: PrimitivesStore;
  gateway: SensorHardwareGateway;
  imuCalibration?: ImuCalibration;
  poseCalibration?: PoseCalibration;
  geometryCalibration?: GeometryCalibration;
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

interface ImuDiagnosticSample {
  readonly timestampMillis: number;
  readonly sampleDeltaMs: number | null;
  readonly headingBeforeDeg: number;
  readonly headingAfterDeg: number;
  readonly pitchDeg: number;
  readonly rollDeg: number;
  readonly rawYawRateDegPerSec: number;
  readonly tiltCompensatedYawRateDegPerSec: number;
  readonly yawDeltaDeg: number;
}

export interface ImuDiagnosticSummary {
  readonly windowMs: number;
  readonly sampleCount: number;
  readonly startTimestampMillis: number;
  readonly endTimestampMillis: number;
  readonly durationMs: number;
  readonly headingBeforeDeg: number;
  readonly headingAfterDeg: number;
  readonly headingChangeDeg: number;
  readonly integratedYawDeltaDeg: number;
  readonly averageYawRateDegPerSec: number | null;
  readonly averageRawYawRateDegPerSec: number | null;
  readonly minYawRateDegPerSec: number | null;
  readonly maxYawRateDegPerSec: number | null;
  readonly averageSampleDeltaMs: number | null;
  readonly minSampleDeltaMs: number | null;
  readonly maxSampleDeltaMs: number | null;
  readonly recentSamples: ImuDiagnosticSample[];
}

export interface HeadingRebaseReadiness {
  readonly safe: boolean;
  readonly motorCommandActive: boolean;
  readonly yawRateDegPerSec: number | null;
  readonly maxYawRateDegPerSec: number;
}

export class SensorController extends EventEmitter {
  private readonly logger: LoggerScope;
  private readonly primitivesStore: PrimitivesStore;
  private readonly gateway: SensorHardwareGateway;
  private readonly imuCalibration: ImuCalibration | null;
  private readonly poseCalibration: PoseCalibration | null;
  private readonly geometryCalibration: GeometryCalibration | null;
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
  private motorZeroCommandSinceMillis: number | null = null;
  private latestGnssPosition: Position | null = null;
  private latestGnssAccuracyMeters: number | null = null;
  private stallMotionAnchorPosition: Position | null = null;
  private stallMotionAnchorSinceMillis: number | null = null;
  private stallDetectionSamples = 0;
  private stallDetectionLatched = false;

  private imuHeading: InternalHeading = createInternalHeading(0);
  private previousImuSampleMillis: number | null = null;
  private readonly imuDiagnosticSamples: Array<ImuDiagnosticSample | null> = new Array(IMU_DIAGNOSTIC_MAX_SAMPLES).fill(null);
  private imuDiagnosticNextIndex = 0;
  private imuDiagnosticSampleCount = 0;
  private imuDiagnosticLatestTimestampMillis: number | null = null;
  private latestTiltCompensatedYawRateDegPerSec: number | null = null;
  private lastImuMotionStopSummary: ImuDiagnosticSummary | null = null;

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
    this.imuCalibration = options.imuCalibration ?? null;
    this.poseCalibration = options.poseCalibration ?? null;
    this.geometryCalibration = options.geometryCalibration ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? SENSOR_CONTROLLER_POLL_INTERVAL_MS;
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
    this.motorZeroCommandSinceMillis = null;
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

  getCurrentTimeMillis(): number {
    return this.nowMillis();
  }

  setHeading(heading: InternalHeading, timestampMillis: number | null = null): void {
    this.imuHeading = heading;
    this.previousImuSampleMillis = timestampMillis ?? this.nowMillis();
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

    const deadbandedLeftWheelOutputPercent = this.applyMotorOutputDeadband(leftWheelOutputPercent);
    const deadbandedRightWheelOutputPercent = this.applyMotorOutputDeadband(rightWheelOutputPercent);
    const {
      leftWheelOutputPercent: normalizedLeftWheelOutputPercent,
      rightWheelOutputPercent: normalizedRightWheelOutputPercent,
    } = this.applyMinimumActiveMotorOutputs(
      deadbandedLeftWheelOutputPercent,
      deadbandedRightWheelOutputPercent,
    );
    const isActiveCommand =
      Math.max(
        Math.abs(normalizedLeftWheelOutputPercent),
        Math.abs(normalizedRightWheelOutputPercent),
      ) >=
      MOTOR_STALL_COMMAND_THRESHOLD_PERCENT;
    const wasActiveCommand =
      this.lastMotorCommand?.kind === "output" &&
      Math.max(
        Math.abs(this.lastMotorCommand.leftWheelOutputPercent),
        Math.abs(this.lastMotorCommand.rightWheelOutputPercent),
      ) >= MOTOR_STALL_COMMAND_THRESHOLD_PERCENT;
    const wasZeroCommand =
      this.lastMotorCommand?.kind === "output" &&
      this.lastMotorCommand.leftWheelOutputPercent === 0 &&
      this.lastMotorCommand.rightWheelOutputPercent === 0;
    const wasMotionCommand = this.isMotorCommandMotion(this.lastMotorCommand);
    const isZeroCommand = normalizedLeftWheelOutputPercent === 0 && normalizedRightWheelOutputPercent === 0;

    // Log only on a meaningful transition — motion start, stop, or sign change.
    // Per-tick PWM is captured by the drive heartbeat so this avoids drowning the log.
    const previousLeft = this.lastMotorCommand?.kind === "output" ? this.lastMotorCommand.leftWheelOutputPercent : null;
    const previousRight = this.lastMotorCommand?.kind === "output" ? this.lastMotorCommand.rightWheelOutputPercent : null;
    const motionChanged =
      previousLeft === null ||
      previousRight === null ||
      Math.sign(previousLeft) !== Math.sign(normalizedLeftWheelOutputPercent) ||
      Math.sign(previousRight) !== Math.sign(normalizedRightWheelOutputPercent) ||
      isZeroCommand !== wasZeroCommand ||
      isActiveCommand !== wasActiveCommand;
    if (motionChanged) {
      this.logger.info("motors.commanded", {
        leftWheelOutputPercent: normalizedLeftWheelOutputPercent,
        rightWheelOutputPercent: normalizedRightWheelOutputPercent,
      });
    }
    this.stopRequestLogged = false;
    this.lastMotorCommand = {
      kind: "output",
      leftWheelOutputPercent: normalizedLeftWheelOutputPercent,
      rightWheelOutputPercent: normalizedRightWheelOutputPercent,
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
    if (isZeroCommand && !wasZeroCommand) {
      this.motorZeroCommandSinceMillis = this.nowMillis();
      if (wasMotionCommand) {
        this.recordImuMotionStopSummary("zero_output_command");
      }
    } else if (!isZeroCommand) {
      this.motorZeroCommandSinceMillis = null;
      this.lastImuMotionStopSummary = null;
    }
    await this.gateway.setMotorWheelOutputs(normalizedLeftWheelOutputPercent, normalizedRightWheelOutputPercent);
    const current = this.primitivesStore.snapshot().motors;
    this.primitivesStore.update({
      motors: {
        ...current,
        commandedLeftWheelOutputPercent: normalizedLeftWheelOutputPercent,
        commandedRightWheelOutputPercent: normalizedRightWheelOutputPercent,
      },
    });
  }

  private applyMinimumActiveMotorOutputs(
    leftWheelOutputPercent: number,
    rightWheelOutputPercent: number,
  ): { leftWheelOutputPercent: number; rightWheelOutputPercent: number } {
    if (leftWheelOutputPercent === 0 && rightWheelOutputPercent === 0) {
      return { leftWheelOutputPercent: 0, rightWheelOutputPercent: 0 };
    }

    if (leftWheelOutputPercent === 0) {
      return {
        leftWheelOutputPercent: Math.sign(rightWheelOutputPercent) * MOTOR_MIN_ACTIVE_OUTPUT_PERCENT,
        rightWheelOutputPercent: this.applyMinimumActiveMagnitude(rightWheelOutputPercent),
      };
    }

    if (rightWheelOutputPercent === 0) {
      return {
        leftWheelOutputPercent: this.applyMinimumActiveMagnitude(leftWheelOutputPercent),
        rightWheelOutputPercent: Math.sign(leftWheelOutputPercent) * MOTOR_MIN_ACTIVE_OUTPUT_PERCENT,
      };
    }

    return {
      leftWheelOutputPercent: this.applyMinimumActiveMagnitude(leftWheelOutputPercent),
      rightWheelOutputPercent: this.applyMinimumActiveMagnitude(rightWheelOutputPercent),
    };
  }

  private applyMinimumActiveMagnitude(value: number): number {
    if (value === 0 || Math.abs(value) >= MOTOR_MIN_ACTIVE_OUTPUT_PERCENT) {
      return value;
    }

    return Math.sign(value) * MOTOR_MIN_ACTIVE_OUTPUT_PERCENT;
  }

  beginMotorOperation(): void {
    this.motorOperationDepth += 1;
  }

  async endMotorOperation(): Promise<void> {
    if (this.motorOperationDepth === 0) {
      this.logger.warn("motors.operation_end_without_start", {});
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
      });
      this.stopRequestLogged = true;
    }

    await this.sendGentleStopMotorsCommand();
  }

  getMotorZeroCommandSinceMillis(): number | null {
    return this.motorZeroCommandSinceMillis;
  }

  getHeadingRebaseReadiness(): HeadingRebaseReadiness {
    const motorCommandActive = this.isMotorCommandMotion(this.lastMotorCommand);
    const yawRateDegPerSec = this.latestTiltCompensatedYawRateDegPerSec;
    const yawRateActive =
      yawRateDegPerSec !== null &&
      Math.abs(yawRateDegPerSec) > HEADING_REBASE_MAX_YAW_RATE_DEG_PER_SEC;

    return {
      safe: !motorCommandActive && !yawRateActive,
      motorCommandActive,
      yawRateDegPerSec,
      maxYawRateDegPerSec: HEADING_REBASE_MAX_YAW_RATE_DEG_PER_SEC,
    };
  }

  getLastImuMotionStopSummary(): ImuDiagnosticSummary | null {
    return this.lastImuMotionStopSummary;
  }

  getRecentImuDiagnosticSummary(
    windowMs: number = IMU_DIAGNOSTIC_WINDOW_MS,
    recentSampleLimit: number = IMU_DIAGNOSTIC_RECENT_SAMPLE_LIMIT,
  ): ImuDiagnosticSummary | null {
    if (this.imuDiagnosticSampleCount === 0 || this.imuDiagnosticLatestTimestampMillis === null) {
      return null;
    }

    const boundedWindowMs = Math.max(0, windowMs);
    const cutoffTimestampMillis = this.imuDiagnosticLatestTimestampMillis - boundedWindowMs;
    const orderedSamples: ImuDiagnosticSample[] = [];
    const oldestIndex = this.imuDiagnosticSampleCount < IMU_DIAGNOSTIC_MAX_SAMPLES
      ? 0
      : this.imuDiagnosticNextIndex;

    for (let offset = 0; offset < this.imuDiagnosticSampleCount; offset += 1) {
      const index = (oldestIndex + offset) % IMU_DIAGNOSTIC_MAX_SAMPLES;
      const sample = this.imuDiagnosticSamples[index];
      if (sample !== null && sample.timestampMillis >= cutoffTimestampMillis) {
        orderedSamples.push(sample);
      }
    }

    if (orderedSamples.length === 0) {
      return null;
    }

    const firstSample = orderedSamples[0];
    const lastSample = orderedSamples[orderedSamples.length - 1];
    const durationMs = Math.max(0, lastSample.timestampMillis - firstSample.timestampMillis);
    const integratedYawDeltaDeg = orderedSamples.reduce((total, sample) => total + sample.yawDeltaDeg, 0);
    const yawRates = orderedSamples.map((sample) => sample.tiltCompensatedYawRateDegPerSec);
    const rawYawRates = orderedSamples.map((sample) => sample.rawYawRateDegPerSec);
    const sampleDeltas = orderedSamples.flatMap((sample) => (sample.sampleDeltaMs === null ? [] : [sample.sampleDeltaMs]));
    const recentSamples = orderedSamples.slice(Math.max(0, orderedSamples.length - recentSampleLimit));

    return {
      windowMs: boundedWindowMs,
      sampleCount: orderedSamples.length,
      startTimestampMillis: firstSample.timestampMillis,
      endTimestampMillis: lastSample.timestampMillis,
      durationMs,
      headingBeforeDeg: firstSample.headingBeforeDeg,
      headingAfterDeg: lastSample.headingAfterDeg,
      headingChangeDeg: unwrapRelativeAngle(headingDifference(
        createInternalHeading(firstSample.headingBeforeDeg),
        createInternalHeading(lastSample.headingAfterDeg),
      )),
      integratedYawDeltaDeg,
      averageYawRateDegPerSec: yawRates.length === 0 ? null : yawRates.reduce((total, value) => total + value, 0) / yawRates.length,
      averageRawYawRateDegPerSec: rawYawRates.length === 0 ? null : rawYawRates.reduce((total, value) => total + value, 0) / rawYawRates.length,
      minYawRateDegPerSec: yawRates.length === 0 ? null : Math.min(...yawRates),
      maxYawRateDegPerSec: yawRates.length === 0 ? null : Math.max(...yawRates),
      averageSampleDeltaMs: sampleDeltas.length === 0 ? null : sampleDeltas.reduce((total, value) => total + value, 0) / sampleDeltas.length,
      minSampleDeltaMs: sampleDeltas.length === 0 ? null : Math.min(...sampleDeltas),
      maxSampleDeltaMs: sampleDeltas.length === 0 ? null : Math.max(...sampleDeltas),
      recentSamples,
    };
  }

  private applyMotorOutputDeadband(outputPercent: number): number {
    return Math.abs(outputPercent) <= MOTOR_OUTPUT_DEADBAND_PERCENT ? 0 : outputPercent;
  }

  private isMotorCommandMotion(command: MotorCommand | null): boolean {
    return (
      command?.kind === "output" &&
      (command.leftWheelOutputPercent !== 0 || command.rightWheelOutputPercent !== 0)
    );
  }

  private recordImuMotionStopSummary(reason: string): void {
    const summary = this.getRecentImuDiagnosticSummary();
    this.lastImuMotionStopSummary = summary;
    if (summary !== null) {
      this.logger.info("sensor.imu.motion_stop_summary", {
        reason,
        imuDiagnostics: summary,
      });
    }
  }

  private calculateTiltCompensatedYawRateDegPerSec(
    angularVelocity: {
      xDegreesPerSecond: number;
      yDegreesPerSecond: number;
      zDegreesPerSecond: number;
    },
    pitchDeg: number,
    rollDeg: number,
  ): number {
    const pitchRad = pitchDeg * DEG_TO_RAD;
    const rollRad = rollDeg * DEG_TO_RAD;
    const gravityX = -Math.sin(pitchRad);
    const gravityY = Math.sin(rollRad) * Math.cos(pitchRad);
    const gravityZ = Math.cos(rollRad) * Math.cos(pitchRad);

    return (
      angularVelocity.xDegreesPerSecond * gravityX +
      angularVelocity.yDegreesPerSecond * gravityY +
      angularVelocity.zDegreesPerSecond * gravityZ
    );
  }

  private recordImuDiagnosticSample(sample: ImuDiagnosticSample): void {
    this.imuDiagnosticSamples[this.imuDiagnosticNextIndex] = sample;
    this.imuDiagnosticNextIndex = (this.imuDiagnosticNextIndex + 1) % IMU_DIAGNOSTIC_MAX_SAMPLES;
    if (this.imuDiagnosticSampleCount < IMU_DIAGNOSTIC_MAX_SAMPLES) {
      this.imuDiagnosticSampleCount += 1;
    }
    this.imuDiagnosticLatestTimestampMillis = sample.timestampMillis;
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
      const sourceAngularVelocity = sample.angularVelocity ?? {
        xDegreesPerSecond: 0,
        yDegreesPerSecond: 0,
        zDegreesPerSecond: 0,
      };
      const angularVelocity = {
        xDegreesPerSecond: sourceAngularVelocity.xDegreesPerSecond ?? 0,
        yDegreesPerSecond: sourceAngularVelocity.yDegreesPerSecond ?? 0,
        zDegreesPerSecond: sourceAngularVelocity.zDegreesPerSecond ?? 0,
      };
      const acceleration = sample.acceleration ?? {
        xMetersPerSecondSquared: 0,
        yMetersPerSecondSquared: 0,
        zMetersPerSecondSquared: 0,
      };
      const sampleDeltaMs = this.previousImuSampleMillis === null
        ? null
        : Math.max(0, sample.timestampMillis - this.previousImuSampleMillis);
      const headingBeforeDeg = unwrapInternalHeading(this.imuHeading);
      // Gravity terms cancel inside atan2 ratios so we work directly in m/s².
      const ax = acceleration.xMetersPerSecondSquared;
      const ay = acceleration.yMetersPerSecondSquared;
      const az = acceleration.zMetersPerSecondSquared;
      const computedPitchDeg = Math.atan2(-ax, Math.sqrt(ay * ay + az * az)) * (180 / Math.PI);
      const computedRollDeg  = Math.atan2(ay, az) * (180 / Math.PI);
      const pitchDeg = sample.pitchDeg ?? computedPitchDeg;
      const rollDeg = sample.rollDeg ?? computedRollDeg;
      const rawYawRateDegPerSec = angularVelocity.zDegreesPerSecond;
      const tiltCompensatedYawRateDegPerSec = this.calculateTiltCompensatedYawRateDegPerSec(
        angularVelocity,
        pitchDeg,
        rollDeg,
      );
      this.latestTiltCompensatedYawRateDegPerSec = tiltCompensatedYawRateDegPerSec;
      let yawDeltaDeg = 0;
      if (sampleDeltaMs !== null) {
        const safeDeltaSeconds = sampleDeltaMs / MS_PER_SECOND;
        const yawScaleFactor = this.imuCalibration?.getYawScaleFactor() ?? 1;
        const yawDelta = createRelativeAngle(tiltCompensatedYawRateDegPerSec * safeDeltaSeconds * yawScaleFactor);
        yawDeltaDeg = unwrapRelativeAngle(yawDelta);
        this.imuHeading = addRelativeAngle(this.imuHeading, yawDelta);
      }
      const headingAfterDeg = unwrapInternalHeading(this.imuHeading);
      this.recordImuDiagnosticSample({
        timestampMillis: sample.timestampMillis,
        sampleDeltaMs,
        headingBeforeDeg,
        headingAfterDeg,
        pitchDeg,
        rollDeg,
        rawYawRateDegPerSec,
        tiltCompensatedYawRateDegPerSec,
        yawDeltaDeg,
      });
      this.previousImuSampleMillis = sample.timestampMillis;

      this.primitivesStore.update({
        imu: {
          status: "running",
          error: null,
          headingDeg: unwrapInternalHeading(this.imuHeading),
          pitchDeg,
          rollDeg,
        },
      });

      // IMU heading sampling no longer logged here — the drive heartbeat
      // captures heading at higher signal-to-noise during active drives, and
      // the periodic 1 Hz emission was drowning the failure window.

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

      const geometryOffset = createBodyFrameOffset(
        this.geometryCalibration?.getPositionOffsetForwardMeters() ?? 0,
        this.geometryCalibration?.getPositionOffsetRightMeters() ?? 0,
      );
      const adjustedPosition = translatePositionByHeading(
        createPosition(sample.xMeters, sample.yMeters),
        this.imuHeading,
        geometryOffset,
      );
      const adjustedXMeters = unwrapMeters(adjustedPosition.xMeters);
      const adjustedYMeters = unwrapMeters(adjustedPosition.yMeters);

      this.primitivesStore.update({
        gnss: {
          status: "running",
          error: null,
          xMeters: adjustedXMeters,
          yMeters: adjustedYMeters,
          headingDeg: internalHeadingDeg,
          positionAccuracyMeters: sample.positionAccuracyMeters,
          headingAccuracyDeg: sample.headingAccuracyDegrees ?? null,
          fixType: sample.fixType,
          satellitesInUse: sample.satellitesInUse,
          sampleAgeMillis: sample.sampleAgeMillis,
        },
      });

      this.latestGnssPosition = adjustedPosition;
      this.latestGnssAccuracyMeters = sample.positionAccuracyMeters;

      if (this.motorCommandActiveSinceMillis !== null && this.stallMotionAnchorPosition === null) {
        this.stallMotionAnchorPosition = this.latestGnssPosition;
        this.stallMotionAnchorSinceMillis = this.nowMillis();
      }

      // Emit GNSS position update event
      this.emit(SENSOR_EVENTS.GNSS_POSITION_UPDATE, {
        xMeters: adjustedXMeters,
        yMeters: adjustedYMeters,
        heading: internalHeading,
        positionAccuracyMeters: sample.positionAccuracyMeters,
        headingAccuracyDeg: sample.headingAccuracyDegrees ?? null,
        fixType: sample.fixType,
        satellitesInUse: sample.satellitesInUse,
        timestampMillis: sample.timestampMillis,
        sampleAgeMillis: sample.sampleAgeMillis,
        ...(sample.gpsTimeMillis !== undefined ? { gpsTimeMillis: sample.gpsTimeMillis } : {}),
        ...(sample.headingBaselineMeters !== undefined ? { headingBaselineMeters: sample.headingBaselineMeters } : {}),
        ...(sample.headingValid !== undefined ? { headingValid: sample.headingValid } : {}),
        ...(sample.groundSpeedMetersPerSecond !== undefined ? { groundSpeedMetersPerSecond: sample.groundSpeedMetersPerSecond } : {}),
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
      const leftMetersPerTick  = this.poseCalibration?.getLeftEncoderMetersPerTick()  ?? ENCODER_METERS_PER_TICK_DEFAULT;
      const rightMetersPerTick = this.poseCalibration?.getRightEncoderMetersPerTick() ?? ENCODER_METERS_PER_TICK_DEFAULT;
      const wheelSpeed      = this.computeWheelSpeedMetersPerSecond(sample.timestampMillis, sample.leftEncoderDelta,  leftMetersPerTick);
      const rightWheelSpeed = this.computeWheelSpeedMetersPerSecond(sample.timestampMillis, sample.rightEncoderDelta, rightMetersPerTick);
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
    const leftCommandActive = leftCommand >= MOTOR_STALL_COMMAND_THRESHOLD_PERCENT;
    const rightCommandActive = rightCommand >= MOTOR_STALL_COMMAND_THRESHOLD_PERCENT;
    const commandActive = leftCommandActive || rightCommandActive;

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

    const strongEvidence = currentHigh || faultFlags !== 0;
    this.stallDetectionSamples += strongEvidence ? 2 : 1;
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
      leftCommandActive,
      rightCommandActive,
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
    const wasMotionCommand = this.isMotorCommandMotion(this.lastMotorCommand);
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
    if (this.motorZeroCommandSinceMillis === null) {
      this.motorZeroCommandSinceMillis = this.nowMillis();
    }
    if (wasMotionCommand) {
      this.recordImuMotionStopSummary("gentle_stop_command");
    }
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
    const wasMotionCommand = this.isMotorCommandMotion(this.lastMotorCommand);
    if (this.lastMotorCommand?.kind === "stop") {
      return;
    }

    this.lastMotorCommand = {
      kind: "stop",
    };
    if (this.motorZeroCommandSinceMillis === null) {
      this.motorZeroCommandSinceMillis = this.nowMillis();
    }
    if (wasMotionCommand) {
      this.recordImuMotionStopSummary("disable_motors_command");
    }
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
