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
  SENSOR_CONTROLLER_POLL_INTERVAL_MS,
  SENSOR_CONTROLLER_GNSS_POLL_INTERVAL_MS,
  SENSOR_CONTROLLER_MOTOR_POLL_INTERVAL_MS,
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
import type { MotorCommandOptions } from "./sensorHardwareGateway.js";
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
// Encoder-delta magnitude (ticks per motor poll) at or below which a wheel
// is considered stationary for heading-rebase / stop-detection purposes.
// Zero ticks is the most honest signal; a tolerance of one tick absorbs
// single-count counter jitter without admitting genuine motion. We do not
// derive m/s here because the encoder-to-metres calibration is not yet
// available and the rest of the system avoids absolute speeds on principle.
const WHEELS_STATIONARY_TICK_THRESHOLD = 1;
const IMU_BIAS_RECALIBRATION_WINDOW_MS = 2_000;
const IMU_BIAS_RECALIBRATION_MIN_SAMPLES = 20;
const IMU_BIAS_RECALIBRATION_MAX_ABS_BIAS_DEG_PER_SEC = 3;
const IMU_BIAS_RECALIBRATION_MAX_STEP_DEG_PER_SEC = 1;
const IMU_BIAS_AUTO_RECALIBRATION_SETTLE_MS = 2_000;
const IMU_BIAS_AUTO_RECALIBRATION_IDLE_MS = 30 * 60 * 1000;

interface SensorControllerOptions {
  logger: SessionLogger;
  primitivesStore: PrimitivesStore;
  gateway: SensorHardwareGateway;
  imuCalibration?: ImuCalibration;
  poseCalibration?: PoseCalibration;
  geometryCalibration?: GeometryCalibration;
  pollIntervalMs?: number;
  nowMillis?: () => number;
  /**
   * Monotonic millisecond clock used for time-delta integration (IMU yaw `dt`).
   * Defaults to `performance.now()`, which is unaffected by NTP wallclock steps.
   * Tests can inject a mock; production should leave this unset.
   */
  monotonicMillis?: () => number;
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
  readonly leftEncoderDelta: number | null;
  readonly rightEncoderDelta: number | null;
  readonly wheelsStationary: boolean;
  readonly maxStationaryTickDelta: number;
}

export class SensorController extends EventEmitter {
  private readonly logger: LoggerScope;
  private readonly primitivesStore: PrimitivesStore;
  private readonly gateway: SensorHardwareGateway;
  private readonly imuCalibration: ImuCalibration | null;
  private readonly poseCalibration: PoseCalibration | null;
  private readonly geometryCalibration: GeometryCalibration | null;
  private readonly pollIntervalMs: number;
  private readonly gnssPollIntervalMs: number;
  private readonly motorPollIntervalMs: number;
  private readonly nowMillis: () => number;
  private readonly monotonicMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly maxLoopCount: number | null;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private lastMotorCommand: MotorCommand | null = null;
  private stopRequestLogged = false;
  private motorCommandActiveSinceMillis: number | null = null;
  private motorZeroCommandSinceMillis: number | null = null;
  private motorStoppedSinceMillis: number | null = null;
  private motionSessionDepth = 0;
  private motionSessionIdleSinceMillis: number | null = null;
  private lastGnssPollStartedMillis: number | null = null;
  private lastMotorPollStartedMillis: number | null = null;
  private latestGnssPosition: Position | null = null;
  private latestGnssAccuracyMeters: number | null = null;
  private stallMotionAnchorPosition: Position | null = null;
  private stallMotionAnchorSinceMillis: number | null = null;
  private stallDetectionSamples = 0;
  private stallDetectionLatched = false;

  private imuHeading: InternalHeading = createInternalHeading(0);
  /**
   * Monotonic wallclock-independent millisecond timestamp of the previous IMU
   * sample. Used purely for `dt` integration; `imuHeading` updates remain
   * keyed off `sample.timestampMillis` for downstream events.
   */
  private previousImuMonotonicMillis: number | null = null;
  private readonly imuDiagnosticSamples: Array<ImuDiagnosticSample | null> = new Array(IMU_DIAGNOSTIC_MAX_SAMPLES).fill(null);
  private imuDiagnosticNextIndex = 0;
  private imuDiagnosticSampleCount = 0;
  private imuDiagnosticLatestTimestampMillis: number | null = null;
  private imuYawRateBiasDegPerSec = 0;
  private lastImuMotionStopSummary: ImuDiagnosticSummary | null = null;
  private imuBiasAutoRecalibratedForCurrentStop = false;

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
    this.gnssPollIntervalMs = Math.max(this.pollIntervalMs, SENSOR_CONTROLLER_GNSS_POLL_INTERVAL_MS);
    this.motorPollIntervalMs = Math.max(this.pollIntervalMs, SENSOR_CONTROLLER_MOTOR_POLL_INTERVAL_MS);
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    // Tests injecting `nowMillis` get deterministic dt by reusing it; production
    // (no injection) uses `performance.now()` which is monotonic and immune to
    // NTP wallclock steps.
    this.monotonicMillis = options.monotonicMillis
      ?? (options.nowMillis !== undefined ? options.nowMillis : (() => performance.now()));
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
    this.motorCommandActiveSinceMillis = null;
    this.motorZeroCommandSinceMillis = null;
    this.motorStoppedSinceMillis = null;
    this.motionSessionDepth = 0;
    this.motionSessionIdleSinceMillis = this.nowMillis();
    this.lastGnssPollStartedMillis = null;
    this.lastMotorPollStartedMillis = null;
    this.latestGnssPosition = null;
    this.latestGnssAccuracyMeters = null;
    this.stallMotionAnchorPosition = null;
    this.stallMotionAnchorSinceMillis = null;
    this.stallDetectionSamples = 0;
    this.stallDetectionLatched = false;
    this.imuBiasAutoRecalibratedForCurrentStop = false;
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
      // Process shutdown is a legitimate H-bridge disable: there will be no
      // further command for the watchdog to honour, so the motors must be
      // explicitly off.
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
    // Reset the integration anchor. When the caller provides a timestamp it
    // names the moment the new heading was sampled — the next IMU integration
    // window starts there. Otherwise anchor on the current monotonic clock.
    this.previousImuMonotonicMillis = timestampMillis ?? this.monotonicMillis();
    const currentImu = this.primitivesStore.snapshot().imu;
    this.primitivesStore.update({
      imu: {
        ...currentImu,
        headingDeg: unwrapInternalHeading(this.imuHeading),
      },
    });
  }

  async setMotorWheelOutputs(
    leftWheelOutputPercent: number,
    rightWheelOutputPercent: number,
    options?: MotorCommandOptions,
  ): Promise<void> {
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
    // While systemStop is latched, swallow the speed command rather than
    // sending an enableDrive=false equivalent. The sensor loop is
    // simultaneously re-asserting the dedicated disable command on every
    // tick, so the H-bridges stay off and any in-flight wheel-target value
    // reaching the ESP32 here would just race that disable.
    if (systemStop.isStopped()) {
      const current = this.primitivesStore.snapshot().motors;
      this.primitivesStore.update({
        motors: {
          ...current,
          commandedLeftWheelOutputPercent: normalizedLeftWheelOutputPercent,
          commandedRightWheelOutputPercent: normalizedRightWheelOutputPercent,
        },
      });
      return;
    }
    await this.gateway.setMotorWheelOutputs(
      normalizedLeftWheelOutputPercent,
      normalizedRightWheelOutputPercent,
      options,
    );
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

  async requestNeutralMotorOutputs(): Promise<void> {
    if (!this.stopRequestLogged) {
      this.logger.warn("motors.stop_requested", {
        currentCommandedLeftWheelOutputPercent: this.primitivesStore.snapshot().motors.commandedLeftWheelOutputPercent,
        currentCommandedRightWheelOutputPercent: this.primitivesStore.snapshot().motors.commandedRightWheelOutputPercent,
      });
      this.stopRequestLogged = true;
    }

    // Always send a ramped target=0 with the drive enabled. The motor ESP32
    // honours the configured deceleration profile only while enableDrive is
    // true, so a "hard kill" stop would slam the H-bridges off and shock
    // the drivetrain. Only the emergency stop path (systemStop latched +
    // emergencyStopMotors()) is permitted to disable the drive.
    await this.sendGentleStopMotorsCommand();
  }

  async stopMotors(): Promise<void> {
    await this.requestNeutralMotorOutputs();
  }

  /**
   * Genuine emergency: kill the H-bridges immediately. Reserved for the
   * operator stop button, a confirmed stall, the I2C watchdog, and other
   * fatal-fault paths. Every other code site that wants to bring the
   * mower to rest uses {@link stopMotors} so the deceleration profile is
   * honoured and the drivetrain is not shocked.
   */
  async emergencyStopMotors(): Promise<void> {
    this.logger.warn("motors.emergency_stop", {
      currentCommandedLeftWheelOutputPercent: this.primitivesStore.snapshot().motors.commandedLeftWheelOutputPercent,
      currentCommandedRightWheelOutputPercent: this.primitivesStore.snapshot().motors.commandedRightWheelOutputPercent,
    });
    await this.sendDisableMotorsCommand();
  }

  getMotorZeroCommandSinceMillis(): number | null {
    return this.motorZeroCommandSinceMillis;
  }

  getHeadingRebaseReadiness(): HeadingRebaseReadiness {
    const motorCommandActive = this.isMotorCommandMotion(this.lastMotorCommand);
    const motors = this.primitivesStore.snapshot().motors;
    const leftEncoderDelta = motors.leftEncoderDelta;
    const rightEncoderDelta = motors.rightEncoderDelta;
    // Treat unknown encoder delta (no feedback yet) as stationary so the
    // bootstrap rebase can fire before the first motor-feedback sample.
    const leftStationary =
      leftEncoderDelta === null ||
      Math.abs(leftEncoderDelta) <= WHEELS_STATIONARY_TICK_THRESHOLD;
    const rightStationary =
      rightEncoderDelta === null ||
      Math.abs(rightEncoderDelta) <= WHEELS_STATIONARY_TICK_THRESHOLD;
    const wheelsStationary = leftStationary && rightStationary;

    return {
      safe: !motorCommandActive && wheelsStationary,
      motorCommandActive,
      leftEncoderDelta,
      rightEncoderDelta,
      wheelsStationary,
      maxStationaryTickDelta: WHEELS_STATIONARY_TICK_THRESHOLD,
    };
  }

  beginMotionSession(): void {
    if (this.motionSessionDepth === 0) {
      this.motionSessionIdleSinceMillis = null;
    }
    this.motionSessionDepth += 1;
  }

  endMotionSession(): void {
    this.motionSessionDepth = Math.max(0, this.motionSessionDepth - 1);
    if (this.motionSessionDepth === 0) {
      this.motionSessionIdleSinceMillis = this.nowMillis();
    }
  }

  getLastImuMotionStopSummary(): ImuDiagnosticSummary | null {
    return this.lastImuMotionStopSummary;
  }

  /**
   * Re-estimate IMU yaw-rate bias from recent stationary samples.
   * Returns true when a new bias was applied.
   */
  recalibrateImuYawBias(): boolean {
    const summary = this.getRecentImuDiagnosticSummary(IMU_BIAS_RECALIBRATION_WINDOW_MS, IMU_BIAS_RECALIBRATION_MIN_SAMPLES);
    if (!summary || summary.sampleCount < IMU_BIAS_RECALIBRATION_MIN_SAMPLES || summary.averageYawRateDegPerSec === null) {
      this.logger.warn("sensor.imu.bias_recalibration_skipped", {
        reason: "insufficient_samples",
        minSamples: IMU_BIAS_RECALIBRATION_MIN_SAMPLES,
        windowMs: IMU_BIAS_RECALIBRATION_WINDOW_MS,
        sampleCount: summary?.sampleCount ?? 0,
      });
      return false;
    }

    const proposedBias = summary.averageYawRateDegPerSec;
    if (Math.abs(proposedBias) > IMU_BIAS_RECALIBRATION_MAX_ABS_BIAS_DEG_PER_SEC) {
      this.logger.warn("sensor.imu.bias_recalibration_skipped", {
        reason: "proposed_bias_out_of_range",
        proposedBiasDegPerSec: proposedBias,
        maxAbsBiasDegPerSec: IMU_BIAS_RECALIBRATION_MAX_ABS_BIAS_DEG_PER_SEC,
        sampleCount: summary.sampleCount,
        windowMs: summary.windowMs,
      });
      return false;
    }

    const previousBias = this.imuYawRateBiasDegPerSec;
    const biasStep = proposedBias - previousBias;
    if (Math.abs(biasStep) > IMU_BIAS_RECALIBRATION_MAX_STEP_DEG_PER_SEC) {
      this.logger.warn("sensor.imu.bias_recalibration_skipped", {
        reason: "bias_step_too_large",
        previousBiasDegPerSec: previousBias,
        proposedBiasDegPerSec: proposedBias,
        maxStepDegPerSec: IMU_BIAS_RECALIBRATION_MAX_STEP_DEG_PER_SEC,
        sampleCount: summary.sampleCount,
        windowMs: summary.windowMs,
      });
      return false;
    }

    this.imuYawRateBiasDegPerSec = proposedBias;
    this.logger.info("sensor.imu.bias_recalibrated", {
      previousBiasDegPerSec: previousBias,
      newBiasDegPerSec: this.imuYawRateBiasDegPerSec,
      sampleCount: summary.sampleCount,
      windowMs: summary.windowMs,
    });
    return true;
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

    try {
      while (this.running) {
        const loopStartedMillis = this.nowMillis();
        await this.pollAllSensors(loopStartedMillis);
        this.maybeAutoRecalibrateImuYawBias();
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
    } finally {
      if (systemStop.isStopped()) {
        try {
          await this.emergencyStopMotors();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn("sensor.motors.stop_during_global_stop_failed", { error: message });
        }
      }
    }
  }

  private maybeAutoRecalibrateImuYawBias(): void {
    if (this.motionSessionDepth > 0) {
      this.imuBiasAutoRecalibratedForCurrentStop = false;
      return;
    }

    const idleSinceMillis = this.motionSessionIdleSinceMillis;
    if (idleSinceMillis === null) {
      this.imuBiasAutoRecalibratedForCurrentStop = false;
      return;
    }

    const idleDurationMs = this.nowMillis() - idleSinceMillis;
    if (idleDurationMs < IMU_BIAS_AUTO_RECALIBRATION_IDLE_MS) {
      return;
    }

    const stoppedSinceMillis = this.motorStoppedSinceMillis;
    const rebaseReadiness = this.getHeadingRebaseReadiness();
    const stationary = stoppedSinceMillis !== null && rebaseReadiness.safe;

    if (!stationary) {
      // Re-arm once movement resumes, so a subsequent settle can calibrate again.
      this.imuBiasAutoRecalibratedForCurrentStop = false;
      return;
    }

    if (this.imuBiasAutoRecalibratedForCurrentStop) {
      return;
    }

    const stationaryDurationMs = this.nowMillis() - stoppedSinceMillis;
    if (stationaryDurationMs < IMU_BIAS_AUTO_RECALIBRATION_SETTLE_MS) {
      return;
    }

    this.imuBiasAutoRecalibratedForCurrentStop = true;
    const applied = this.recalibrateImuYawBias();
    this.logger.info("sensor.imu.bias_recalibration_auto_attempt", {
      applied,
      stationaryDurationMs,
      idleDurationMs,
      settleMs: IMU_BIAS_AUTO_RECALIBRATION_SETTLE_MS,
      idleThresholdMs: IMU_BIAS_AUTO_RECALIBRATION_IDLE_MS,
      zeroCommandSinceMillis: this.motorZeroCommandSinceMillis,
      stoppedSinceMillis,
      leftEncoderDelta: rebaseReadiness.leftEncoderDelta,
      rightEncoderDelta: rebaseReadiness.rightEncoderDelta,
    });
  }

  private async pollAllSensors(loopStartedMillis: number): Promise<void> {
    // While systemStop is latched the H-bridges must be off.  Re-asserting
    // the disable on every loop tick is what defeats a stuck-on motor that
    // was already commanded just before the latch took effect.
    if (systemStop.isStopped()) {
      await this.sendDisableMotorsCommand();
    }
    await this.pollImu();
    if (this.shouldPoll(loopStartedMillis, this.lastGnssPollStartedMillis, this.gnssPollIntervalMs)) {
      this.lastGnssPollStartedMillis = loopStartedMillis;
      await this.pollGnss();
    }
    if (this.shouldPoll(loopStartedMillis, this.lastMotorPollStartedMillis, this.motorPollIntervalMs)) {
      this.lastMotorPollStartedMillis = loopStartedMillis;
      await this.pollMotors();
    }
  }

  private shouldPoll(
    nowMillis: number,
    lastPollStartedMillis: number | null,
    intervalMs: number,
  ): boolean {
    return lastPollStartedMillis === null || nowMillis - lastPollStartedMillis >= intervalMs;
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
      const monotonicNowMs = this.monotonicMillis();
      const sampleDeltaMs = this.previousImuMonotonicMillis === null
        ? null
        : Math.max(0, monotonicNowMs - this.previousImuMonotonicMillis);
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
      const biasCorrectedYawRateDegPerSec = tiltCompensatedYawRateDegPerSec - this.imuYawRateBiasDegPerSec;
      let yawDeltaDeg = 0;
      if (sampleDeltaMs !== null) {
        const safeDeltaSeconds = sampleDeltaMs / MS_PER_SECOND;
        const yawScaleFactor = this.imuCalibration?.getYawScaleFactor() ?? 1;
        const yawDelta = createRelativeAngle(biasCorrectedYawRateDegPerSec * safeDeltaSeconds * yawScaleFactor);
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
        tiltCompensatedYawRateDegPerSec: biasCorrectedYawRateDegPerSec,
        yawDeltaDeg,
      });
      this.previousImuMonotonicMillis = monotonicNowMs;

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
        rawSample: sample,
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
      this.updateMotorStoppedState(sample.leftEncoderDelta, sample.rightEncoderDelta);
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
      leftEncoderDelta: current.leftEncoderDelta ?? 0,
      rightEncoderDelta: current.rightEncoderDelta ?? 0,
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
    const current = this.primitivesStore.snapshot().motors;
    this.primitivesStore.update({
      motors: {
        ...current,
        commandedLeftWheelOutputPercent: 0,
        commandedRightWheelOutputPercent: 0,
      },
    });

    await this.gateway.setMotorWheelOutputs(0, 0);
  }

  private async sendDisableMotorsCommand(): Promise<void> {
    const wasMotionCommand = this.isMotorCommandMotion(this.lastMotorCommand);

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

  private updateMotorStoppedState(
    leftEncoderDelta: number,
    rightEncoderDelta: number,
  ): void {
    const command = this.lastMotorCommand;
    const stopCommandIssued = command !== null && !this.isMotorCommandMotion(command);
    const wheelsStationary =
      Math.abs(leftEncoderDelta) <= WHEELS_STATIONARY_TICK_THRESHOLD &&
      Math.abs(rightEncoderDelta) <= WHEELS_STATIONARY_TICK_THRESHOLD;

    if (!stopCommandIssued || !wheelsStationary) {
      this.motorStoppedSinceMillis = null;
      this.imuBiasAutoRecalibratedForCurrentStop = false;
      return;
    }

    if (this.motorStoppedSinceMillis === null) {
      this.motorStoppedSinceMillis = this.nowMillis();
    }
  }

}
