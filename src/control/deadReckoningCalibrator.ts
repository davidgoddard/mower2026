/**
 * Dead-reckoning calibrator.
 *
 * Three-phase procedure:
 *
 *  Phase 1 – Straight line
 *    Drive forward to derive first-pass per-wheel metres-per-tick from the
 *    GNSS chord and encoder totals.
 *
 *  Phase 2 – Forward arc right / CW
 *    Drive a constant-speed forward arc until the IMU reports the requested
 *    heading sweep. Encoder distance difference divided by IMU heading change
 *    yields an effective moving-turn wheelbase for line-tracing DR.
 *
 *  Phase 3 – Forward arc left / CCW
 *    Mirror of phase 2.
 *
 * The straight phase establishes independent left/right metres-per-tick.
 * The arcs then use those scales and IMU heading change to establish the
 * effective moving-turn track width. In-place pivots are intentionally excluded.
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { PoseCalibration } from "../config/poseCalibration.js";
import { MotorCalibration } from "../config/motorCalibration.js";
import { DriveLineController } from "./driveLineController.js";
import { TurnController } from "./turnController.js";
import {
  SENSOR_EVENTS,
  GnssPositionUpdateEvent,
  ImuHeadingUpdateEvent,
  MotorFeedbackUpdateEvent,
} from "../sensing/sensorEvents.js";
import { unwrapInternalHeading } from "../geometry/headingTypes.js";
import { translatePositionByHeading, createBodyFrameOffset } from "../geometry/positionTypes.js";
import { systemStop } from "./systemStop.js";

const DEG_TO_RAD = Math.PI / 180;
const DEAD_RECKONING_ARC_SWEEP_MIN_DEG = 20;
const DEAD_RECKONING_ARC_SWEEP_MAX_DEG = 180;
const DEAD_RECKONING_ARC_SWEEP_DEFAULT_DEG = 180;
const ARC_DIRECTION_POLL_INTERVAL_MS = 50;
const ARC_HEADING_STEADY_MARGIN_DEG = 5;
const ARC_OUTER_WHEEL_OUTPUT_DEFAULT = 0.60;
const ARC_INNER_WHEEL_OUTPUT_DEFAULT = 0.45;

export type CalibratorPhase =
  | "idle"
  | "waiting-for-fix"
  | "straight"
  | "arc-cw"
  | "arc-ccw"
  | "analysing"
  | "done"
  | "stopped"
  | "error";

export interface GnssAnchor {
  readonly xMeters: number;
  readonly yMeters: number;
  readonly headingDeg: number | null;
  readonly positionAccuracyMeters: number | null;
  readonly fixType: string;
  readonly timestampMillis: number;
}

export interface ArcSample {
  readonly timestampMillis: number;
  readonly imuHeadingDeg: number;
  readonly leftTicksTotal: number;
  readonly rightTicksTotal: number;
  readonly leftSignedTicksTotal: number;
  readonly rightSignedTicksTotal: number;
  readonly inSteadyState: boolean;
}

export interface DerivedArcGeometry {
  /** Centre-to-centre wheelbase derived from this arc (metres) */
  readonly wheelbaseMeters: number;
  /** Arc length of the outer wheel path (metres) */
  readonly outerArcLengthMeters: number;
  /** Arc length of the inner wheel path (metres) */
  readonly innerArcLengthMeters: number;
  /** m/tick for left wheel */
  readonly leftMetersPerTick: number;
  /** m/tick for right wheel */
  readonly rightMetersPerTick: number;
  /** Chord from GNSS start→end anchors (metres) */
  readonly gnssChordMeters: number;
  /** IMU heading change over the full phase (degrees) */
  readonly imuHeadingChangeDeg: number;
}

export interface RunPhaseResult {
  readonly startAnchor: GnssAnchor;
  readonly endAnchor: GnssAnchor;
  readonly gnssDistanceMeters: number;
  readonly gnssHeadingChangeDeg: number;
  readonly leftTotalTicks: number;
  readonly rightTotalTicks: number;
  readonly leftSignedTicks: number;
  readonly rightSignedTicks: number;
  readonly arcSamples: ArcSample[];
  readonly steadyStateSamples: ArcSample[];
  /** Derived from straight phase only */
  readonly derivedEncoderMetersPerTick: number | null;
  /** Independent left-wheel scale derived from the straight phase only */
  readonly derivedLeftMetersPerTick: number | null;
  /** Independent right-wheel scale derived from the straight phase only */
  readonly derivedRightMetersPerTick: number | null;
  /** RMS error between encoder arc-fraction and IMU arc-fraction (steady-state) */
  readonly arcTrackingRmsErrorFraction: number | null;
  /** Full arc geometry (arc phases only) */
  readonly arcGeometry: DerivedArcGeometry | null;
}

export interface DeadReckoningCalibrationResult {
  readonly straightPhase: RunPhaseResult | null;
  readonly arcRightPhase: RunPhaseResult | null;
  readonly arcLeftPhase: RunPhaseResult | null;
  /** Best-estimate per-wheel calibration averaged across both arc phases */
  readonly suggestedLeftMetersPerTick: number | null;
  readonly suggestedRightMetersPerTick: number | null;
  readonly suggestedWheelbaseMeters: number | null;
  /** Shared scalar (average of left+right) for callers that need one value */
  readonly suggestedEncoderMetersPerTick: number | null;
  readonly previousEncoderMetersPerTick: number;
  readonly previousLeftMetersPerTick: number;
  readonly previousRightMetersPerTick: number;
  readonly previousWheelbaseMeters: number;
  readonly completedAt: string;
  readonly warnings: string[];
}

export interface DeadReckoningCalibratorState {
  readonly running: boolean;
  readonly phase: CalibratorPhase;
  readonly phaseMessage: string;
  readonly gnssWarning: string | null;
  readonly result: DeadReckoningCalibrationResult | null;
  readonly lastUpdated: string | null;
}

export interface DeadReckoningCalibratorOptions {
  sensorController: SensorController;
  poseFusion: PoseFusion;
  poseCalibration: PoseCalibration;
  motorCalibration?: MotorCalibration;
  driveLineController?: DriveLineController;
  turnController?: TurnController;
  logger: SessionLogger;
  driveDurationMs?: number;
  steadyStateStartMs?: number;
  steadyStateEndMs?: number;
  /** How long usingGnssHeading must be continuously true before a pose is trusted (ms) */
  poseSteadyDwellMs?: number;
  /** Timeout waiting for a settled pose before each phase (ms) */
  poseSettleTimeoutMs?: number;
  maxAnchorAccuracyMeters?: number;
  fullSpeed?: number;
  arcInnerSpeed?: number;
  lineDistanceMeters?: number;
  spinsPerDirection?: number;
  pivotTurnTimeoutMs?: number;
  drPivotSpeedScale?: number;
  arcSweepDegrees?: number;
  arcDriveTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeadReckoningRunOptions {
  readonly lineDistanceMeters?: number;
  readonly arcSweepDegrees?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAngle180(deg: number): number {
  while (deg > 180) deg -= 360;
  while (deg <= -180) deg += 360;
  return deg;
}

export class DeadReckoningCalibrator {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly poseFusion: PoseFusion;
  private readonly poseCalibration: PoseCalibration;
  private readonly motorCalibration: MotorCalibration | null;
  private readonly driveLineController: DriveLineController | null;
  private readonly turnController: TurnController | null;
  private readonly driveDurationMs: number;
  private readonly steadyStateStartMs: number;
  private readonly steadyStateEndMs: number;
  private readonly poseSteadyDwellMs: number;
  private readonly poseSettleTimeoutMs: number;
  private readonly maxAnchorAccuracyMeters: number;
  private readonly fullSpeed: number;
  private readonly arcInnerSpeed: number;
  private readonly lineDistanceMeters: number;
  private readonly spinsPerDirection: number;
  private readonly pivotTurnTimeoutMs: number;
  private readonly drPivotSpeedScale: number;
  private readonly arcSweepDegrees: number;
  private readonly arcDriveTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private running = false;
  private phase: CalibratorPhase = "idle";
  private phaseMessage = "";
  private gnssWarning: string | null = null;
  private stopRequested = false;
  private result: DeadReckoningCalibrationResult | null = null;
  private lastUpdated: string | null = null;

  private gnssAnchors: GnssAnchor[] = [];
  private arcSamples: ArcSample[] = [];
  private leftTicksAccum = 0;
  private rightTicksAccum = 0;
  private leftTicksSignedAccum = 0;
  private rightTicksSignedAccum = 0;
  private driveStartMs = 0;

  constructor(options: DeadReckoningCalibratorOptions) {
    this.logger = options.logger.child({ context: "control", source: "DeadReckoningCalibrator" });
    this.sensorController = options.sensorController;
    this.poseFusion = options.poseFusion;
    this.poseCalibration = options.poseCalibration;
    this.motorCalibration = options.motorCalibration ?? null;
    this.driveLineController = options.driveLineController ?? null;
    this.turnController = options.turnController ?? null;
    this.driveDurationMs = options.driveDurationMs ?? 3000;
    this.steadyStateStartMs = options.steadyStateStartMs ?? 1000;
    this.steadyStateEndMs = options.steadyStateEndMs ?? 2000;
    this.poseSteadyDwellMs = options.poseSteadyDwellMs ?? 2000;
    this.poseSettleTimeoutMs = options.poseSettleTimeoutMs ?? 30_000;
    this.maxAnchorAccuracyMeters = options.maxAnchorAccuracyMeters ?? 0.10;
    this.fullSpeed = options.fullSpeed ?? ARC_OUTER_WHEEL_OUTPUT_DEFAULT;
    this.arcInnerSpeed = options.arcInnerSpeed ?? ARC_INNER_WHEEL_OUTPUT_DEFAULT;
    this.lineDistanceMeters = options.lineDistanceMeters ?? 10.0;
    this.spinsPerDirection = Math.max(1, options.spinsPerDirection ?? 1);
    this.pivotTurnTimeoutMs = Math.max(5_000, options.pivotTurnTimeoutMs ?? 20_000);
    this.drPivotSpeedScale = Math.max(0.1, Math.min(1, options.drPivotSpeedScale ?? 0.5));
    this.arcSweepDegrees = Math.max(
      DEAD_RECKONING_ARC_SWEEP_MIN_DEG,
      Math.min(DEAD_RECKONING_ARC_SWEEP_MAX_DEG, options.arcSweepDegrees ?? DEAD_RECKONING_ARC_SWEEP_DEFAULT_DEG),
    );
    this.arcDriveTimeoutMs = Math.max(5_000, options.arcDriveTimeoutMs ?? 60_000);
    this.sleep = options.sleep ?? defaultSleep;

    this.onGnssUpdate = this.onGnssUpdate.bind(this);
    this.onImuUpdate = this.onImuUpdate.bind(this);
    this.onMotorFeedback = this.onMotorFeedback.bind(this);
  }

  getState(): DeadReckoningCalibratorState {
    return {
      running: this.running,
      phase: this.phase,
      phaseMessage: this.phaseMessage,
      gnssWarning: this.gnssWarning,
      result: this.result,
      lastUpdated: this.lastUpdated,
    };
  }

  requestStop(): void {
    this.stopRequested = true;
    systemStop.requestStop("api", "dead_reckoning_stop");
    this.logger.info("dead_reckoning.stop_requested", {});
  }

  async run(options: DeadReckoningRunOptions = {}): Promise<DeadReckoningCalibrationResult> {
    if (this.running) {
      throw new Error("calibration_already_running");
    }

    const lineDistanceMeters = options.lineDistanceMeters ?? this.lineDistanceMeters;
    const arcSweepDegrees = options.arcSweepDegrees ?? this.arcSweepDegrees;
    if (!Number.isFinite(lineDistanceMeters) || lineDistanceMeters <= 0) {
      throw new Error("invalid_line_distance_meters");
    }
    if (
      !Number.isFinite(arcSweepDegrees) ||
      arcSweepDegrees < DEAD_RECKONING_ARC_SWEEP_MIN_DEG ||
      arcSweepDegrees > DEAD_RECKONING_ARC_SWEEP_MAX_DEG
    ) {
      throw new Error("invalid_arc_sweep_degrees");
    }

    this.running = true;
    this.sensorController.beginMotionSession();
    this.stopRequested = false;
    this.result = null;
    this.gnssWarning = null;
    systemStop.clearStop("dead-reckoning-run");

    const prevShared = this.poseCalibration.getEncoderCalibration();
    const prevLeft   = this.poseCalibration.getLeftEncoderMetersPerTick();
    const prevRight  = this.poseCalibration.getRightEncoderMetersPerTick();
    const prevWheelbase = this.poseCalibration.getWheelbaseMeters();
    const warnings: string[] = [];

    let straightPhase: RunPhaseResult | null = null;
    let arcRightPhase: RunPhaseResult | null = null;
    let arcLeftPhase: RunPhaseResult | null = null;

    try {
      // ------------------------------------------------------------------
      // Wait for a settled pose (GNSS rebasing IMU, sustained for dwell period)
      // before taking any measurement.
      // ------------------------------------------------------------------
      this.setPhase("waiting-for-fix", "Waiting for settled pose (GNSS and IMU in agreement)…");
      const preRunAnchor = await this.waitForSettledPose();
      if (!preRunAnchor) {
        warnings.push(`Could not obtain a settled pose within ${this.poseSettleTimeoutMs / 1000} s. Ensure a good RTK fix and stationary mower before starting.`);
        this.gnssWarning = "Pose not settled. Calibration aborted.";
        this.setPhase("error", "Pose not settled — start again once GNSS and IMU widgets show green.");
        return this.buildResult(null, null, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }

      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped by user.");
        return this.buildResult(null, null, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }

      if (!this.driveLineController) {
        throw new Error("dead_reckoning_drive_line_controller_unavailable");
      }

      // ------------------------------------------------------------------
      // Phase 1 – GNSS-measured straight line using the line driver (no pivot pre-turn)
      // ------------------------------------------------------------------
      this.setPhase("straight", `Phase 1: Line-drive ${lineDistanceMeters.toFixed(1)} m…`);
      straightPhase = await this.runLinePhase(preRunAnchor, lineDistanceMeters);
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped after straight phase.");
        return this.buildResult(straightPhase, null, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }
      straightPhase = this.analyseStraightPhase(straightPhase, warnings);

      // Wait for pose to settle — anchor is used as start of next phase
      this.setPhase("waiting-for-fix", "Settling between phases…");
      const preArcRightAnchor = await this.waitForSettledPose();
      if (!preArcRightAnchor || this.stopRequested) {
        this.setPhase("stopped", "Stopped during settle.");
        return this.buildResult(straightPhase, null, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }

      // ------------------------------------------------------------------
      // Phase 2 – forward CW arcs
      // ------------------------------------------------------------------
      this.setPhase("arc-cw", `Phase 2: ${this.spinsPerDirection} × ${arcSweepDegrees.toFixed(0)}° CW forward arc…`);
      arcRightPhase = await this.runArcPhase("cw", preArcRightAnchor, arcSweepDegrees);
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped after CW arc phase.");
        return this.buildResult(straightPhase, arcRightPhase, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }
      arcRightPhase = this.analyseArcPhase(arcRightPhase, "cw", straightPhase, warnings);

      this.setPhase("waiting-for-fix", "Settling between phases…");
      const preArcLeftAnchor = await this.waitForSettledPose();
      if (!preArcLeftAnchor || this.stopRequested) {
        this.setPhase("stopped", "Stopped during settle.");
        return this.buildResult(straightPhase, arcRightPhase, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }

      // ------------------------------------------------------------------
      // Phase 3 – forward CCW arcs
      // ------------------------------------------------------------------
      this.setPhase("arc-ccw", `Phase 3: ${this.spinsPerDirection} × ${arcSweepDegrees.toFixed(0)}° CCW forward arc…`);
      arcLeftPhase = await this.runArcPhase("ccw", preArcLeftAnchor, arcSweepDegrees);
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped after CCW arc phase.");
        return this.buildResult(straightPhase, arcRightPhase, arcLeftPhase, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }
      arcLeftPhase = this.analyseArcPhase(arcLeftPhase, "ccw", straightPhase, warnings);

      this.setPhase("analysing", "Analysing results…");

      const finalResult = this.buildResult(
        straightPhase, arcRightPhase, arcLeftPhase,
        prevShared, prevLeft, prevRight, prevWheelbase,
        warnings,
      );
      this.setPhase("done", "Calibration complete.");
      return finalResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPhase("error", `Error: ${message}`);
      this.logger.error("dead_reckoning.error", { error: message });
      throw error;
    } finally {
      this.running = false;
      this.lastUpdated = new Date().toISOString();
      this.sensorController.endMotionSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Line phase (uses line driver)
  // ---------------------------------------------------------------------------

  private async runLinePhase(preDriveAnchor: GnssAnchor, lineDistanceMeters: number): Promise<RunPhaseResult> {
    if (!this.driveLineController) {
      throw new Error("drive_line_controller_unavailable");
    }
    this.gnssAnchors = [];
    this.arcSamples = [];
    this.leftTicksAccum = 0;
    this.rightTicksAccum = 0;
    this.leftTicksSignedAccum = 0;
    this.rightTicksSignedAccum = 0;

    this.sensorController.on(SENSOR_EVENTS.GNSS_POSITION_UPDATE, this.onGnssUpdate);
    this.sensorController.on(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onImuUpdate);
    this.sensorController.on(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedback);

    try {
      this.driveStartMs = Date.now();
      const startPose = this.poseFusion.getCurrentPose();
      const target = translatePositionByHeading(
        startPose.position,
        startPose.heading,
        createBodyFrameOffset(lineDistanceMeters, 0),
      );
      await this.driveLineController.executeLineDrive({
        targetPosition: target,
        learningEnabled: false,
        driveDirectionSign: 1,
      });

      // Wait for pose to settle (GNSS rebasing IMU) before snapping end anchor
      const endAnchor = await this.waitForSettledPose() ?? this.buildCurrentAnchor();

      const dx = endAnchor.xMeters - preDriveAnchor.xMeters;
      const dy = endAnchor.yMeters - preDriveAnchor.yMeters;
      const gnssDistanceMeters = Math.hypot(dx, dy);
      const gnssHeadingChangeDeg = normalizeAngle180(
        (endAnchor.headingDeg ?? 0) - (preDriveAnchor.headingDeg ?? 0)
      );

      const steadySamples = this.arcSamples.filter((s) => s.inSteadyState);

      return {
        startAnchor: preDriveAnchor,
        endAnchor,
        gnssDistanceMeters,
        gnssHeadingChangeDeg,
        leftTotalTicks: this.leftTicksAccum,
        rightTotalTicks: this.rightTicksAccum,
        leftSignedTicks: this.leftTicksSignedAccum,
        rightSignedTicks: this.rightTicksSignedAccum,
        arcSamples: [...this.arcSamples],
        steadyStateSamples: steadySamples,
        derivedEncoderMetersPerTick: null,
        derivedLeftMetersPerTick: null,
        derivedRightMetersPerTick: null,
        arcTrackingRmsErrorFraction: null,
        arcGeometry: null,
      };
    } finally {
      this.sensorController.off(SENSOR_EVENTS.GNSS_POSITION_UPDATE, this.onGnssUpdate);
      this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onImuUpdate);
      this.sensorController.off(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedback);
    }
  }

  // ---------------------------------------------------------------------------
  // Arc phase (direct wheel outputs)
  // ---------------------------------------------------------------------------

  private async runArcPhase(
    direction: "cw" | "ccw",
    preDriveAnchor: GnssAnchor,
    arcSweepDegrees: number,
  ): Promise<RunPhaseResult> {
    this.gnssAnchors = [];
    this.arcSamples = [];
    this.leftTicksAccum = 0;
    this.rightTicksAccum = 0;
    this.leftTicksSignedAccum = 0;
    this.rightTicksSignedAccum = 0;

    this.sensorController.on(SENSOR_EVENTS.GNSS_POSITION_UPDATE, this.onGnssUpdate);
    this.sensorController.on(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onImuUpdate);
    this.sensorController.on(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedback);

    try {
      this.driveStartMs = Date.now();
      for (let index = 0; index < this.spinsPerDirection; index += 1) {
        this.phaseMessage = `Phase ${direction === "cw" ? "2" : "3"}: ${index + 1}/${this.spinsPerDirection} × ${arcSweepDegrees.toFixed(0)}° ${direction.toUpperCase()} forward arc…`;
        this.lastUpdated = new Date().toISOString();

        const outerWheelOutput = Math.max(0.1, Math.min(1, this.fullSpeed));
        const innerWheelOutput = Math.max(0.05, Math.min(outerWheelOutput - 0.05, this.arcInnerSpeed));
        const leftWheelOutputPercent = direction === "cw" ? outerWheelOutput : innerWheelOutput;
        const rightWheelOutputPercent = direction === "cw" ? innerWheelOutput : outerWheelOutput;
        const sweepStartMillis = Date.now();
        const targetProgressDeg = arcSweepDegrees * (index + 1);

        await this.sensorController.setMotorWheelOutputs(leftWheelOutputPercent, rightWheelOutputPercent);
        while (!this.stopRequested) {
          const headingProgressDeg = this.getAbsoluteCumulativeImuHeadingChangeDeg(this.arcSamples);
          if (headingProgressDeg >= targetProgressDeg) {
            break;
          }
          if (Date.now() - sweepStartMillis > this.arcDriveTimeoutMs) {
            throw new Error(`arc_drive_timeout_${direction}_${index + 1}`);
          }
          await this.sleep(ARC_DIRECTION_POLL_INTERVAL_MS);
        }
        await this.sensorController.stopMotors();
        if (this.stopRequested) {
          break;
        }
        await this.sleep(250);
      }

      const endAnchor = await this.waitForSettledPose() ?? this.buildCurrentAnchor();
      const dx = endAnchor.xMeters - preDriveAnchor.xMeters;
      const dy = endAnchor.yMeters - preDriveAnchor.yMeters;
      const gnssDistanceMeters = Math.hypot(dx, dy);
      const gnssHeadingChangeDeg = this.getAbsoluteCumulativeImuHeadingChangeDeg(this.arcSamples);
      const steadySamples = this.selectArcSteadyStateSamples(this.arcSamples);

      return {
        startAnchor: preDriveAnchor,
        endAnchor,
        gnssDistanceMeters,
        gnssHeadingChangeDeg,
        leftTotalTicks: this.leftTicksAccum,
        rightTotalTicks: this.rightTicksAccum,
        leftSignedTicks: this.leftTicksSignedAccum,
        rightSignedTicks: this.rightTicksSignedAccum,
        arcSamples: [...this.arcSamples],
        steadyStateSamples: steadySamples,
        derivedEncoderMetersPerTick: null,
        derivedLeftMetersPerTick: null,
        derivedRightMetersPerTick: null,
        arcTrackingRmsErrorFraction: null,
        arcGeometry: null,
      };
    } finally {
      try {
        await this.sensorController.stopMotors();
      } catch {
      }
      this.sensorController.off(SENSOR_EVENTS.GNSS_POSITION_UPDATE, this.onGnssUpdate);
      this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onImuUpdate);
      this.sensorController.off(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedback);
    }
  }

  // ---------------------------------------------------------------------------
  // Straight-phase analysis
  // ---------------------------------------------------------------------------

  private analyseStraightPhase(phase: RunPhaseResult, warnings: string[]): RunPhaseResult {
    const { leftTotalTicks, rightTotalTicks, gnssDistanceMeters } = phase;
    const goodFix = (f: string) => f === "fixed" || f === "float" || f === "rtk-fixed" || f === "rtk-float";
    if (!goodFix(phase.startAnchor.fixType) || !goodFix(phase.endAnchor.fixType)) {
      warnings.push("Straight phase: GNSS fix not available at start or end anchor — encoder calibration skipped. Ensure a good RTK fix before running calibration.");
      return phase;
    }
    const avgTicks = (leftTotalTicks + rightTotalTicks) / 2;
    if (avgTicks < 1 || gnssDistanceMeters < 0.01) {
      warnings.push("Straight phase: insufficient ticks or GNSS distance — encoder calibration skipped.");
      return phase;
    }
    if (phase.startAnchor.positionAccuracyMeters !== null && phase.startAnchor.positionAccuracyMeters > 0.10) {
      warnings.push(`Straight phase GNSS accuracy was ${(phase.startAnchor.positionAccuracyMeters * 100).toFixed(1)} cm (>10 cm). Calibration may be inaccurate.`);
    }
    const derivedLeftMetersPerTick = gnssDistanceMeters / leftTotalTicks;
    const derivedRightMetersPerTick = gnssDistanceMeters / rightTotalTicks;
    const derivedEncoderMetersPerTick = (derivedLeftMetersPerTick + derivedRightMetersPerTick) / 2;
    return {
      ...phase,
      derivedEncoderMetersPerTick,
      derivedLeftMetersPerTick,
      derivedRightMetersPerTick,
    };
  }

  // ---------------------------------------------------------------------------
  // Arc-phase analysis
  // ---------------------------------------------------------------------------

  analyseArcPhase(
    phase: RunPhaseResult,
    direction: "cw" | "ccw",
    straightPhase: RunPhaseResult | null,
    warnings: string[],
  ): RunPhaseResult {
    const allSamples = phase.arcSamples;
    if (allSamples.length < 2) {
      warnings.push(`Arc-${direction}: too few IMU samples for wheelbase derivation.`);
      return phase;
    }
    const imuHeadingChangeDeg = this.getAbsoluteCumulativeImuHeadingChangeDeg(allSamples);
    if (imuHeadingChangeDeg < DEAD_RECKONING_ARC_SWEEP_MIN_DEG) {
      warnings.push(`Arc-${direction}: heading change too small (${imuHeadingChangeDeg.toFixed(1)}°).`);
      return phase;
    }

    const leftTicks = phase.leftTotalTicks;
    const rightTicks = phase.rightTotalTicks;
    if (leftTicks < 1 || rightTicks < 1) {
      warnings.push(`Arc-${direction}: insufficient encoder ticks.`);
      return phase;
    }

    const leftMpt = straightPhase?.derivedLeftMetersPerTick ?? null;
    const rightMpt = straightPhase?.derivedRightMetersPerTick ?? null;
    if (!leftMpt || !rightMpt) {
      warnings.push(`Arc-${direction}: no valid straight-line m/tick estimate.`);
      return phase;
    }

    const leftDistance = phase.leftTotalTicks * leftMpt;
    const rightDistance = phase.rightTotalTicks * rightMpt;
    const headingRad = imuHeadingChangeDeg * DEG_TO_RAD;
    const wheelbaseMeters = Math.abs(rightDistance - leftDistance) / headingRad;
    const arcTrackingRmsErrorFraction = this.computeArcTrackingRms(
      phase.steadyStateSamples,
      leftTicks,
      rightTicks,
      imuHeadingChangeDeg,
    );

    const arcGeometry: DerivedArcGeometry = {
      wheelbaseMeters,
      outerArcLengthMeters: Math.max(leftDistance, rightDistance),
      innerArcLengthMeters: Math.min(leftDistance, rightDistance),
      leftMetersPerTick: leftMpt,
      rightMetersPerTick: rightMpt,
      gnssChordMeters: phase.gnssDistanceMeters,
      imuHeadingChangeDeg,
    };

    return { ...phase, arcTrackingRmsErrorFraction, arcGeometry };
  }

  // ---------------------------------------------------------------------------
  // Arc-tracking RMS error
  // ---------------------------------------------------------------------------

  private computeArcTrackingRms(
    steady: ArcSample[],
    totalLeftTicks: number,
    totalRightTicks: number,
    totalImuHeadingChangeDeg: number,
  ): number | null {
    if (steady.length < 2 || totalImuHeadingChangeDeg < 1) {
      return null;
    }

    const first = steady[0];
    const last  = steady[steady.length - 1];
    const headingProgressDeg = this.getCumulativeImuHeadingProgressDeg(steady);
    const totalAvgTicks = ((last.leftTicksTotal - first.leftTicksTotal) + (last.rightTicksTotal - first.rightTicksTotal)) / 2;
    const totalSteadyImu = Math.abs(headingProgressDeg[headingProgressDeg.length - 1] ?? 0);

    if (totalAvgTicks < 1 || totalSteadyImu < 0.5) {
      return null;
    }

    let sumSqError = 0;
    let count = 0;
    for (let index = 0; index < steady.length; index += 1) {
      const s = steady[index];
      const encFraction = ((s.leftTicksTotal - first.leftTicksTotal + s.rightTicksTotal - first.rightTicksTotal) / 2) / totalAvgTicks;
      const imuFraction = Math.abs(headingProgressDeg[index] ?? 0) / totalSteadyImu;
      const error = encFraction - imuFraction;
      sumSqError += error * error;
      count++;
    }
    return count > 0 ? Math.sqrt(sumSqError / count) : null;
  }

  private getAbsoluteCumulativeImuHeadingChangeDeg(samples: ArcSample[]): number {
    if (samples.length < 2) {
      return 0;
    }
    const progress = this.getCumulativeImuHeadingProgressDeg(samples);
    return Math.abs(progress[progress.length - 1] ?? 0);
  }

  private getCumulativeImuHeadingProgressDeg(samples: ArcSample[]): number[] {
    if (samples.length === 0) {
      return [];
    }

    const progressDeg: number[] = [0];
    let cumulativeDeg = 0;

    for (let index = 1; index < samples.length; index += 1) {
      const deltaDeg = normalizeAngle180(samples[index].imuHeadingDeg - samples[index - 1].imuHeadingDeg);
      cumulativeDeg += deltaDeg;
      progressDeg.push(cumulativeDeg);
    }

    return progressDeg;
  }

  private selectArcSteadyStateSamples(samples: ArcSample[]): ArcSample[] {
    if (samples.length <= 2) {
      return [...samples];
    }

    const progressDeg = this.getCumulativeImuHeadingProgressDeg(samples);
    const totalProgressDeg = Math.abs(progressDeg[progressDeg.length - 1] ?? 0);
    if (totalProgressDeg < ARC_HEADING_STEADY_MARGIN_DEG * 2) {
      return [...samples];
    }

    const selected = samples.filter((_, index) => {
      const progress = Math.abs(progressDeg[index] ?? 0);
      return progress >= ARC_HEADING_STEADY_MARGIN_DEG && progress <= totalProgressDeg - ARC_HEADING_STEADY_MARGIN_DEG;
    });
    return selected.length >= 2 ? selected : [...samples];
  }

  // ---------------------------------------------------------------------------
  // Build final result
  // ---------------------------------------------------------------------------

  private buildResult(
    straight: RunPhaseResult | null,
    arcRight: RunPhaseResult | null,
    arcLeft: RunPhaseResult | null,
    prevShared: number,
    prevLeft: number,
    prevRight: number,
    prevWheelbase: number,
    warnings: string[],
  ): DeadReckoningCalibrationResult {
    // Collect arc geometry from both arc phases
    const arcGeometries: DerivedArcGeometry[] = [];
    if (arcRight?.arcGeometry) arcGeometries.push(arcRight.arcGeometry);
    if (arcLeft?.arcGeometry)  arcGeometries.push(arcLeft.arcGeometry);

    let suggestedLeft: number | null = null;
    let suggestedRight: number | null = null;
    let suggestedWheelbase: number | null = null;
    let suggestedShared: number | null = null;

    if (straight?.derivedLeftMetersPerTick && straight.derivedRightMetersPerTick) {
      suggestedLeft = straight.derivedLeftMetersPerTick;
      suggestedRight = straight.derivedRightMetersPerTick;
      suggestedShared = (suggestedLeft + suggestedRight) / 2;
    }

    if (arcGeometries.length > 0) {
      suggestedWheelbase = arcGeometries.reduce((s, g) => s + g.wheelbaseMeters,   0) / arcGeometries.length;
      if (arcGeometries.length === 2) {
        const [first, second] = arcGeometries;
        const mean = (first.wheelbaseMeters + second.wheelbaseMeters) / 2;
        const spreadFraction = mean > 0 ? Math.abs(first.wheelbaseMeters - second.wheelbaseMeters) / mean : 0;
        if (spreadFraction > 0.20) {
          warnings.push(`CW and CCW effective track widths differ by ${(spreadFraction * 100).toFixed(1)}%. Review the raw counts before applying.`);
        }
      }
    } else if (straight?.derivedEncoderMetersPerTick !== null && straight?.derivedEncoderMetersPerTick !== undefined) {
      suggestedShared = straight.derivedEncoderMetersPerTick;
      suggestedLeft ??= suggestedShared;
      suggestedRight ??= suggestedShared;
    }

    const result: DeadReckoningCalibrationResult = {
      straightPhase: this.withoutTelemetrySamples(straight),
      arcRightPhase: this.withoutTelemetrySamples(arcRight),
      arcLeftPhase: this.withoutTelemetrySamples(arcLeft),
      suggestedLeftMetersPerTick: suggestedLeft,
      suggestedRightMetersPerTick: suggestedRight,
      suggestedWheelbaseMeters: suggestedWheelbase,
      suggestedEncoderMetersPerTick: suggestedShared,
      previousEncoderMetersPerTick: prevShared,
      previousLeftMetersPerTick: prevLeft,
      previousRightMetersPerTick: prevRight,
      previousWheelbaseMeters: prevWheelbase,
      completedAt: new Date().toISOString(),
      warnings,
    };

    this.result = result;
    this.lastUpdated = new Date().toISOString();
    return result;
  }

  /** Status polling needs the calibration totals, not tens of thousands of raw 100 Hz samples. */
  private withoutTelemetrySamples(phase: RunPhaseResult | null): RunPhaseResult | null {
    return phase === null
      ? null
      : { ...phase, arcSamples: [], steadyStateSamples: [] };
  }

  // ---------------------------------------------------------------------------
  // Sensor event handlers (active only during runDrivePhase)
  // ---------------------------------------------------------------------------

  private onGnssUpdate(event: GnssPositionUpdateEvent): void {
    this.gnssAnchors.push({
      xMeters: event.xMeters,
      yMeters: event.yMeters,
      headingDeg: event.heading !== null ? unwrapInternalHeading(event.heading) : null,
      positionAccuracyMeters: event.positionAccuracyMeters,
      fixType: event.fixType,
      timestampMillis: event.timestampMillis,
    });
  }

  private onImuUpdate(event: ImuHeadingUpdateEvent): void {
    const elapsedMs = event.timestampMillis - this.driveStartMs;
    const inSteady = elapsedMs >= this.steadyStateStartMs && elapsedMs <= this.steadyStateEndMs;
    this.arcSamples.push({
      timestampMillis: event.timestampMillis,
      imuHeadingDeg: unwrapInternalHeading(event.heading),
      leftTicksTotal: this.leftTicksAccum,
      rightTicksTotal: this.rightTicksAccum,
      leftSignedTicksTotal: this.leftTicksSignedAccum,
      rightSignedTicksTotal: this.rightTicksSignedAccum,
      inSteadyState: inSteady,
    });
  }

  private onMotorFeedback(event: MotorFeedbackUpdateEvent): void {
    this.leftTicksAccum  += Math.abs(event.leftEncoderDelta);
    this.rightTicksAccum += Math.abs(event.rightEncoderDelta);
    this.leftTicksSignedAccum += event.leftEncoderDelta;
    this.rightTicksSignedAccum += event.rightEncoderDelta;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildCurrentAnchor(
    diagnostics?: ReturnType<PoseFusion["getDiagnosticSnapshot"]>,
  ): GnssAnchor {
    const goodAnchors = this.gnssAnchors.filter(
      (a) =>
        (a.fixType === "fixed" || a.fixType === "float" || a.fixType === "rtk-fixed" || a.fixType === "rtk-float") &&
        (a.positionAccuracyMeters === null || a.positionAccuracyMeters <= this.maxAnchorAccuracyMeters),
    );
    if (goodAnchors.length > 0) return goodAnchors[goodAnchors.length - 1];

    const rawGnss = diagnostics?.gnss.raw ?? null;
    if (
      rawGnss !== null &&
      rawGnss.positionAccuracyMeters !== null &&
      rawGnss.positionAccuracyMeters <= this.maxAnchorAccuracyMeters &&
      (rawGnss.fixType === "fixed" || rawGnss.fixType === "float" || rawGnss.fixType === "rtk-fixed" || rawGnss.fixType === "rtk-float")
    ) {
      return {
        xMeters: rawGnss.x,
        yMeters: rawGnss.y,
        headingDeg: rawGnss.headingDeg,
        positionAccuracyMeters: rawGnss.positionAccuracyMeters,
        fixType: rawGnss.fixType,
        timestampMillis: rawGnss.timestampMillis,
      };
    }

    // No good fix available — return a sentinel with fixType "none".
    // Callers that use the anchor for geometry must check fixType before trusting the coordinates.
    return {
      xMeters: 0,
      yMeters: 0,
      headingDeg: null,
      positionAccuracyMeters: null,
      fixType: "none",
      timestampMillis: Date.now(),
    };
  }

  /**
   * Wait until poseFusion is actively rebasing the IMU from GNSS
   * (usingGnssHeading === true) and that condition has held continuously
   * for poseSteadyDwellMs. This guarantees the pose is settled and both
   * sensors agree before taking any calibration anchor.
   *
   * Returns the current settled GNSS anchor, or null on timeout/stop.
   */
  private async waitForSettledPose(): Promise<GnssAnchor | null> {
    const deadline = Date.now() + this.poseSettleTimeoutMs;
    let dwellStartMs: number | null = null;
    let lastSettleBlocker: string | null = null;

    this.logger.info("dead_reckoning.waiting_for_settled_pose", {
      dwellMs: this.poseSteadyDwellMs,
      timeoutMs: this.poseSettleTimeoutMs,
    });

    while (Date.now() < deadline) {
      if (this.stopRequested) return null;

      const state = this.poseFusion.getPrimitiveState();
      const diagnostics = this.poseFusion.getDiagnosticSnapshot();
      const isSettled =
        state.usingGnssHeading &&
        state.quality === "gnss" &&
        state.xMeters !== null &&
        state.yMeters !== null;

      if (isSettled) {
        if (dwellStartMs === null) {
          dwellStartMs = Date.now();
        } else if (Date.now() - dwellStartMs >= this.poseSteadyDwellMs) {
          // Sustained agreement — snapshot the latest raw GNSS anchor so the
          // calibration uses the actual GNSS reading, not the fused pose.
          const anchor = this.buildCurrentAnchor(diagnostics);
          if (anchor.fixType === "none" || anchor.headingDeg === null) {
            this.logger.info("dead_reckoning.pose_settled_anchor_rejected", {
              reason: anchor.fixType === "none"
                ? "no_good_gnss_anchor"
                : "missing_heading",
              dwellMs: Date.now() - dwellStartMs,
              fixType: anchor.fixType,
              hasHeading: anchor.headingDeg !== null,
            });
            dwellStartMs = null;
            await this.sleep(100);
            continue;
          }
          this.logger.info("dead_reckoning.pose_settled", {
            xMeters: anchor.xMeters,
            yMeters: anchor.yMeters,
            headingDeg: anchor.headingDeg,
            dwellMs: Date.now() - dwellStartMs,
          });
          return anchor;
        }
      } else {
        const blocker =
          !state.usingGnssHeading
            ? "usingGnssHeading=false"
            : state.quality !== "gnss"
              ? `quality=${state.quality}`
              : state.xMeters === null || state.yMeters === null
                ? "fused_position_missing"
                : "unknown";

        if (blocker !== lastSettleBlocker) {
          this.logger.info("dead_reckoning.pose_not_settled", {
            blocker,
            usingGnssHeading: state.usingGnssHeading,
            quality: state.quality,
            gnssPositionAgeMs: state.gnssPositionAgeMs,
          });
          lastSettleBlocker = blocker;
        }
        // Any interruption resets the dwell clock
        dwellStartMs = null;
      }

      await this.sleep(100);
    }

    this.logger.warn("dead_reckoning.pose_settle_timeout", {
      timeoutMs: this.poseSettleTimeoutMs,
      lastSettleBlocker,
      poseFusion: this.poseFusion.getPrimitiveState(),
    });
    return null;
  }

  private setPhase(phase: CalibratorPhase, message: string): void {
    this.phase = phase;
    this.phaseMessage = message;
    this.lastUpdated = new Date().toISOString();
    this.logger.info("dead_reckoning.phase", { phase, message });
  }
}
