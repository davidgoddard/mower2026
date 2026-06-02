/**
 * Dead-reckoning calibrator.
 *
 * Three-phase procedure:
 *
 *  Phase 1 – Straight line
 *    Drive forward ~3 s. The middle second is steady-state. GNSS chord length
 *    divided by average ticks gives a first-pass encoderMetersPerTick.
 *    Per-wheel values are derived from the left/right tick ratio and the chord.
 *
 *  Phase 2 – Pivot right / CW
 *    Drive a controlled in-place pivot. IMU heading change + encoder travel
 *    give a wheelbase estimate from the signed wheel distance difference.
 *    The pivot is only accepted when the DR endpoint error remains small.
 *
 *  Phase 3 – Pivot left / CCW
 *    Mirror of phase 2.
 *
 * Results include suggested per-wheel m/tick, wheelbase, and DR endpoint error.
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
import { createRelativeAngle } from "../geometry/headingTypes.js";
import { translatePositionByHeading, createBodyFrameOffset } from "../geometry/positionTypes.js";
import { systemStop } from "./systemStop.js";

const DEG_TO_RAD = Math.PI / 180;
const MAX_PIVOT_DR_ENDPOINT_ERROR_METERS = 0.25;
const MAX_PIVOT_TRACKING_RMS_ERROR_FRACTION = 0.15;

export type CalibratorPhase =
  | "idle"
  | "waiting-for-fix"
  | "straight"
  | "pivot-cw"
  | "pivot-ccw"
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
  /** DR-integrated endpoint error vs GNSS end anchor (metres) */
  readonly drEndpointErrorMeters: number;
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
  /** RMS error between encoder arc-fraction and IMU arc-fraction (steady-state) */
  readonly arcTrackingRmsErrorFraction: number | null;
  /** Full arc geometry + DR position error (arc phases only) */
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
  /** DR endpoint error averaged across both arc phases (metres) */
  readonly averageDrEndpointErrorMeters: number | null;
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
  sleep?: (ms: number) => Promise<void>;
}

export interface DeadReckoningRunOptions {
  readonly lineDistanceMeters?: number;
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
  private motorOperationActive = false;

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
    this.fullSpeed = options.fullSpeed ?? 1.0;
    this.arcInnerSpeed = options.arcInnerSpeed ?? 0.4;
    this.lineDistanceMeters = options.lineDistanceMeters ?? 5.0;
    this.spinsPerDirection = Math.max(1, options.spinsPerDirection ?? 1);
    this.pivotTurnTimeoutMs = Math.max(5_000, options.pivotTurnTimeoutMs ?? 20_000);
    this.drPivotSpeedScale = Math.max(0.1, Math.min(1, options.drPivotSpeedScale ?? 0.5));
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
    if (!Number.isFinite(lineDistanceMeters) || lineDistanceMeters <= 0) {
      throw new Error("invalid_line_distance_meters");
    }

    this.running = true;
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

    // Open a single motor operation that spans the entire calibration run.
    // Motors are never disabled mid-run — zero-speed commands ramp down naturally.
    this.sensorController.beginMotorOperation();
    this.motorOperationActive = true;

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

      if (!this.driveLineController || !this.turnController) {
        throw new Error("dead_reckoning_controllers_unavailable");
      }

      // ------------------------------------------------------------------
      // Phase 1 – 5m straight line using the line driver (no pivot pre-turn)
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
      // Phase 2 – pure in-place CW pivots, 180° each
      // ------------------------------------------------------------------
      this.setPhase("pivot-cw", `Phase 2: ${this.spinsPerDirection} × 180° CW pivot…`);
      arcRightPhase = await this.runPivotPhase("cw", preArcRightAnchor);
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped after CW pivot phase.");
        return this.buildResult(straightPhase, arcRightPhase, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }
      arcRightPhase = this.analysePivotPhase(arcRightPhase, "cw", straightPhase, warnings);

      this.setPhase("waiting-for-fix", "Settling between phases…");
      const preArcLeftAnchor = await this.waitForSettledPose();
      if (!preArcLeftAnchor || this.stopRequested) {
        this.setPhase("stopped", "Stopped during settle.");
        return this.buildResult(straightPhase, arcRightPhase, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }

      // ------------------------------------------------------------------
      // Phase 3 – pure in-place CCW pivots, 180° each
      // ------------------------------------------------------------------
      this.setPhase("pivot-ccw", `Phase 3: ${this.spinsPerDirection} × 180° CCW pivot…`);
      arcLeftPhase = await this.runPivotPhase("ccw", preArcLeftAnchor);
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped after CCW pivot phase.");
        return this.buildResult(straightPhase, arcRightPhase, arcLeftPhase, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }
      arcLeftPhase = this.analysePivotPhase(arcLeftPhase, "ccw", straightPhase, warnings);

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
      if (this.motorOperationActive) {
        await this.sensorController.endMotorOperation();
        this.motorOperationActive = false;
      }
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
  // Pivot phase (uses turn controller)
  // ---------------------------------------------------------------------------

  private async runPivotPhase(direction: "cw" | "ccw", preDriveAnchor: GnssAnchor): Promise<RunPhaseResult> {
    if (!this.turnController) {
      throw new Error("turn_controller_unavailable");
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
      for (let index = 0; index < this.spinsPerDirection; index += 1) {
        this.phaseMessage = `Phase ${direction === "cw" ? "2" : "3"}: ${index + 1}/${this.spinsPerDirection} × 180° ${direction.toUpperCase()} pivot…`;
        this.lastUpdated = new Date().toISOString();
        const turnPromise = this.turnController.executeTurn({
          targetAngle: createRelativeAngle(direction === "cw" ? -180 : 180),
          direction,
          learningEnabled: false,
          wheelOutputScale: this.drPivotSpeedScale,
        });
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`pivot_turn_timeout_${direction}_${index + 1}`)), this.pivotTurnTimeoutMs);
        });

        let result: Awaited<typeof turnPromise>;
        try {
          result = await Promise.race([turnPromise, timeoutPromise]);
        } catch (error) {
          if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle);
          }
          await this.turnController.stopCurrentTurn();
          throw error;
        }
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
        if (result.status !== "success") {
          await this.turnController.stopCurrentTurn();
          throw new Error(`pivot_turn_failed_${direction}_${index + 1}_${result.status}`);
        }

        if (this.stopRequested) break;
      }

      const endAnchor = await this.waitForSettledPose() ?? this.buildCurrentAnchor();
      const dx = endAnchor.xMeters - preDriveAnchor.xMeters;
      const dy = endAnchor.yMeters - preDriveAnchor.yMeters;
      const gnssDistanceMeters = Math.hypot(dx, dy);
      const gnssHeadingChangeDeg = normalizeAngle180(
        (endAnchor.headingDeg ?? 0) - (preDriveAnchor.headingDeg ?? 0)
      );

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
        steadyStateSamples: [...this.arcSamples],
        derivedEncoderMetersPerTick: null,
        arcTrackingRmsErrorFraction: null,
        arcGeometry: null,
      };
    } finally {
      if (this.stopRequested) {
        void this.turnController.stopCurrentTurn();
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
    const derivedEncoderMetersPerTick = gnssDistanceMeters / avgTicks;
    return { ...phase, derivedEncoderMetersPerTick };
  }

  // ---------------------------------------------------------------------------
  // Arc-phase analysis
  // ---------------------------------------------------------------------------

  private analysePivotPhase(
    phase: RunPhaseResult,
    direction: "cw" | "ccw",
    straightPhase: RunPhaseResult | null,
    warnings: string[],
  ): RunPhaseResult {
    const allSamples = phase.arcSamples;
    if (allSamples.length < 2) {
      warnings.push(`Pivot-${direction}: too few IMU samples for wheelbase derivation.`);
      return phase;
    }
    const imuHeadingChangeDeg = Math.abs(
      normalizeAngle180(allSamples[allSamples.length - 1].imuHeadingDeg - allSamples[0].imuHeadingDeg)
    );
    if (imuHeadingChangeDeg < 90) {
      warnings.push(`Pivot-${direction}: heading change too small (${imuHeadingChangeDeg.toFixed(1)}°).`);
      return phase;
    }

    const leftTicks = phase.leftTotalTicks;
    const rightTicks = phase.rightTotalTicks;
    if (leftTicks < 1 || rightTicks < 1) {
      warnings.push(`Pivot-${direction}: insufficient encoder ticks.`);
      return phase;
    }

    const leftMpt = straightPhase?.leftTotalTicks && straightPhase.leftTotalTicks > 0
      ? straightPhase.gnssDistanceMeters / straightPhase.leftTotalTicks
      : null;
    const rightMpt = straightPhase?.rightTotalTicks && straightPhase.rightTotalTicks > 0
      ? straightPhase.gnssDistanceMeters / straightPhase.rightTotalTicks
      : null;
    if (!leftMpt || !rightMpt) {
      warnings.push(`Pivot-${direction}: no valid straight-line m/tick estimate.`);
      return phase;
    }

    const leftDistanceSigned = phase.leftSignedTicks * leftMpt;
    const rightDistanceSigned = phase.rightSignedTicks * rightMpt;
    const leftDistance = Math.abs(leftDistanceSigned);
    const rightDistance = Math.abs(rightDistanceSigned);
    const headingRad = imuHeadingChangeDeg * DEG_TO_RAD;
    const wheelbaseMeters = Math.abs(rightDistanceSigned - leftDistanceSigned) / headingRad;
    const drError = this.computeDrPositionError(phase, leftMpt, rightMpt);
    const arcTrackingRmsErrorFraction = this.computeArcTrackingRms(
      phase.steadyStateSamples,
      leftTicks,
      rightTicks,
      imuHeadingChangeDeg,
    );

    if (drError > MAX_PIVOT_DR_ENDPOINT_ERROR_METERS) {
      warnings.push(
        `Pivot-${direction}: DR endpoint error too large (${(drError * 100).toFixed(1)} cm); wheelbase rejected as likely slip.`,
      );
      this.logger.warn("dead_reckoning.pivot_geometry_rejected", {
        direction,
        imuHeadingChangeDeg,
        leftDistanceMeters: leftDistance,
        rightDistanceMeters: rightDistance,
        wheelbaseMeters,
        drEndpointErrorMeters: drError,
        maxDrEndpointErrorMeters: MAX_PIVOT_DR_ENDPOINT_ERROR_METERS,
      });
      return {
        ...phase,
        arcTrackingRmsErrorFraction,
        arcGeometry: null,
      };
    }

    if (arcTrackingRmsErrorFraction !== null && arcTrackingRmsErrorFraction > MAX_PIVOT_TRACKING_RMS_ERROR_FRACTION) {
      warnings.push(
        `Pivot-${direction}: arc tracking error too large (${(arcTrackingRmsErrorFraction * 100).toFixed(1)}%); wheelbase rejected as unreliable.`,
      );
      this.logger.warn("dead_reckoning.pivot_geometry_rejected", {
        direction,
        imuHeadingChangeDeg,
        leftDistanceMeters: leftDistance,
        rightDistanceMeters: rightDistance,
        wheelbaseMeters,
        arcTrackingRmsErrorFraction,
        maxArcTrackingRmsErrorFraction: MAX_PIVOT_TRACKING_RMS_ERROR_FRACTION,
      });
      return {
        ...phase,
        arcTrackingRmsErrorFraction,
        arcGeometry: null,
      };
    }

    const arcGeometry: DerivedArcGeometry = {
      wheelbaseMeters,
      outerArcLengthMeters: Math.max(leftDistance, rightDistance),
      innerArcLengthMeters: Math.min(leftDistance, rightDistance),
      leftMetersPerTick: leftMpt,
      rightMetersPerTick: rightMpt,
      drEndpointErrorMeters: drError,
      gnssChordMeters: phase.gnssDistanceMeters,
      imuHeadingChangeDeg,
    };

    return { ...phase, arcTrackingRmsErrorFraction, arcGeometry };
  }

  // ---------------------------------------------------------------------------
  // DR position integration — integrate steady-state samples and compare
  // endpoint against GNSS end anchor.
  // ---------------------------------------------------------------------------

  private computeDrPositionError(
    phase: RunPhaseResult,
    leftMetersPerTick: number,
    rightMetersPerTick: number,
  ): number {
    const steady = phase.steadyStateSamples;
    if (steady.length < 2) {
      return 0;
    }

    const first = steady[0];
    let x = phase.startAnchor.xMeters;
    let y = phase.startAnchor.yMeters;
    let prevLeft  = first.leftTicksTotal;
    let prevRight = first.rightTicksTotal;

    for (let i = 1; i < steady.length; i++) {
      const s = steady[i];
      const dLeft  = (s.leftTicksTotal  - prevLeft)  * leftMetersPerTick;
      const dRight = (s.rightTicksTotal - prevRight) * rightMetersPerTick;
      const dDist  = (dLeft + dRight) / 2;

      // IMU heading at this sample owns direction
      const headingRad = s.imuHeadingDeg * DEG_TO_RAD;
      x += dDist * Math.cos(headingRad);
      y += dDist * Math.sin(headingRad);

      prevLeft  = s.leftTicksTotal;
      prevRight = s.rightTicksTotal;
    }

    const ex = phase.endAnchor.xMeters - x;
    const ey = phase.endAnchor.yMeters - y;
    return Math.hypot(ex, ey);
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
    const totalAvgTicks = ((last.leftTicksTotal - first.leftTicksTotal) + (last.rightTicksTotal - first.rightTicksTotal)) / 2;
    const totalSteadyImu = Math.abs(normalizeAngle180(last.imuHeadingDeg - first.imuHeadingDeg));

    if (totalAvgTicks < 1 || totalSteadyImu < 0.5) {
      return null;
    }

    let sumSqError = 0;
    let count = 0;
    for (const s of steady) {
      const encFraction = ((s.leftTicksTotal - first.leftTicksTotal + s.rightTicksTotal - first.rightTicksTotal) / 2) / totalAvgTicks;
      const imuFraction = Math.abs(normalizeAngle180(s.imuHeadingDeg - first.imuHeadingDeg)) / totalSteadyImu;
      const error = encFraction - imuFraction;
      sumSqError += error * error;
      count++;
    }
    return count > 0 ? Math.sqrt(sumSqError / count) : null;
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
    let avgDrError: number | null = null;

    if (arcGeometries.length > 0) {
      suggestedLeft     = arcGeometries.reduce((s, g) => s + g.leftMetersPerTick,  0) / arcGeometries.length;
      suggestedRight    = arcGeometries.reduce((s, g) => s + g.rightMetersPerTick, 0) / arcGeometries.length;
      suggestedWheelbase = arcGeometries.reduce((s, g) => s + g.wheelbaseMeters,   0) / arcGeometries.length;
      suggestedShared   = (suggestedLeft + suggestedRight) / 2;
      avgDrError        = arcGeometries.reduce((s, g) => s + g.drEndpointErrorMeters, 0) / arcGeometries.length;
    } else if (straight?.derivedEncoderMetersPerTick !== null && straight?.derivedEncoderMetersPerTick !== undefined) {
      // Fall back to straight-phase scalar if arcs failed
      suggestedShared = straight.derivedEncoderMetersPerTick;
      suggestedLeft   = suggestedShared;
      suggestedRight  = suggestedShared;
    }

    const result: DeadReckoningCalibrationResult = {
      straightPhase: straight,
      arcRightPhase: arcRight,
      arcLeftPhase: arcLeft,
      suggestedLeftMetersPerTick: suggestedLeft,
      suggestedRightMetersPerTick: suggestedRight,
      suggestedWheelbaseMeters: suggestedWheelbase,
      suggestedEncoderMetersPerTick: suggestedShared,
      averageDrEndpointErrorMeters: avgDrError,
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
              anchor,
              diagnostics,
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
            xMeters: state.xMeters,
            yMeters: state.yMeters,
            headingDeg: state.headingDeg,
            gnssPositionAgeMs: state.gnssPositionAgeMs,
            gnss: diagnostics.gnss,
            fused: diagnostics.fused,
            encoder: diagnostics.encoder,
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
      poseFusion: this.poseFusion.getPrimitiveState(),
      diagnostics: this.poseFusion.getDiagnosticSnapshot(),
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
