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
 *  Phase 2 – Arc right (left wheel full, right wheel arcInnerSpeed)
 *    Drive a timed arc. IMU heading change + GNSS chord give arc geometry:
 *      arcRadius    = chord / (2 × sin(Δheading/2))
 *      arcLength    = arcRadius × |Δheading_rad|
 *      wheelbase    = (leftArcLen - rightArcLen) / |Δheading_rad|   (outer - inner)
 *      leftMPerTick  = leftArcLen  / leftTicks
 *      rightMPerTick = rightArcLen / rightTicks
 *    For steady-state samples: integrate DR position using IMU heading + encoder
 *    ticks and measure endpoint error vs GNSS anchor.
 *
 *  Phase 3 – Arc left (right=full, left=arcInnerSpeed)
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
import {
  SENSOR_EVENTS,
  GnssPositionUpdateEvent,
  ImuHeadingUpdateEvent,
  MotorFeedbackUpdateEvent,
} from "../sensing/sensorEvents.js";
import { unwrapInternalHeading } from "../geometry/headingTypes.js";
import { systemStop } from "./systemStop.js";

const DEG_TO_RAD = Math.PI / 180;

export type CalibratorPhase =
  | "idle"
  | "waiting-for-fix"
  | "straight"
  | "arc-right"
  | "arc-left"
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
  sleep?: (ms: number) => Promise<void>;
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
  private readonly driveDurationMs: number;
  private readonly steadyStateStartMs: number;
  private readonly steadyStateEndMs: number;
  private readonly poseSteadyDwellMs: number;
  private readonly poseSettleTimeoutMs: number;
  private readonly maxAnchorAccuracyMeters: number;
  private readonly fullSpeed: number;
  private readonly arcInnerSpeed: number;
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
  private driveStartMs = 0;
  private motorOperationActive = false;

  constructor(options: DeadReckoningCalibratorOptions) {
    this.logger = options.logger.child({ context: "control", source: "DeadReckoningCalibrator" });
    this.sensorController = options.sensorController;
    this.poseFusion = options.poseFusion;
    this.poseCalibration = options.poseCalibration;
    this.motorCalibration = options.motorCalibration ?? null;
    this.driveDurationMs = options.driveDurationMs ?? 3000;
    this.steadyStateStartMs = options.steadyStateStartMs ?? 1000;
    this.steadyStateEndMs = options.steadyStateEndMs ?? 2000;
    this.poseSteadyDwellMs = options.poseSteadyDwellMs ?? 2000;
    this.poseSettleTimeoutMs = options.poseSettleTimeoutMs ?? 30_000;
    this.maxAnchorAccuracyMeters = options.maxAnchorAccuracyMeters ?? 0.10;
    this.fullSpeed = options.fullSpeed ?? 1.0;
    this.arcInnerSpeed = options.arcInnerSpeed ?? 0.4;
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

  async run(): Promise<DeadReckoningCalibrationResult> {
    if (this.running) {
      throw new Error("calibration_already_running");
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

      // ------------------------------------------------------------------
      // Phase 1 – straight line
      // ------------------------------------------------------------------
      this.setPhase("straight", "Phase 1: Driving straight forward…");
      straightPhase = await this.runDrivePhase(this.fullSpeed, this.fullSpeed);
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped after straight phase.");
        return this.buildResult(straightPhase, null, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }
      straightPhase = this.analyseStraightPhase(straightPhase, warnings);

      // Wait for pose to settle again before arc phases
      this.setPhase("waiting-for-fix", "Settling between phases…");
      await this.waitForSettledPose();
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped during settle.");
        return this.buildResult(straightPhase, null, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }

      // ------------------------------------------------------------------
      // Phase 2 – arc right (left=full, right=inner)
      // ------------------------------------------------------------------
      this.setPhase("arc-right", "Phase 2: Arc right (left=100%, right=40%)…");
      arcRightPhase = await this.runDrivePhase(this.fullSpeed, this.arcInnerSpeed);
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped after arc-right phase.");
        return this.buildResult(straightPhase, arcRightPhase, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }
      arcRightPhase = this.analyseArcPhase(arcRightPhase, "right", warnings);

      this.setPhase("waiting-for-fix", "Settling between phases…");
      await this.waitForSettledPose();
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped during settle.");
        return this.buildResult(straightPhase, arcRightPhase, null, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }

      // ------------------------------------------------------------------
      // Phase 3 – arc left (right=full, left=inner)
      // ------------------------------------------------------------------
      this.setPhase("arc-left", "Phase 3: Arc left (right=100%, left=40%)…");
      arcLeftPhase = await this.runDrivePhase(this.arcInnerSpeed, this.fullSpeed);
      if (this.stopRequested) {
        this.setPhase("stopped", "Stopped after arc-left phase.");
        return this.buildResult(straightPhase, arcRightPhase, arcLeftPhase, prevShared, prevLeft, prevRight, prevWheelbase, warnings);
      }
      arcLeftPhase = this.analyseArcPhase(arcLeftPhase, "left", warnings);

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
  // Drive phase execution
  // ---------------------------------------------------------------------------

  private async runDrivePhase(leftPercent: number, rightPercent: number): Promise<RunPhaseResult> {
    this.gnssAnchors = [];
    this.arcSamples = [];
    this.leftTicksAccum = 0;
    this.rightTicksAccum = 0;

    this.sensorController.on(SENSOR_EVENTS.GNSS_POSITION_UPDATE, this.onGnssUpdate);
    this.sensorController.on(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onImuUpdate);
    this.sensorController.on(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedback);

    // Snapshot settled anchor before drive starts
    const preDriveAnchor = this.buildCurrentAnchor();

    try {
      this.driveStartMs = Date.now();

      await this.sensorController.setMotorWheelOutputs(leftPercent, rightPercent);
      await this.sleep(this.driveDurationMs);

      // Ramp to zero — let the motor node ramp-down naturally, do not cut power
      await this.sensorController.setMotorWheelOutputs(0, 0);
      const rampDownMs = this.motorCalibration?.getRampDownTime() ?? 1000;
      await this.sleep(rampDownMs * 2);

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

  private analyseArcPhase(
    phase: RunPhaseResult,
    direction: "left" | "right",
    warnings: string[],
  ): RunPhaseResult {
    const steady = phase.steadyStateSamples;
    const { leftTotalTicks, rightTotalTicks, gnssDistanceMeters } = phase;

    // ---- IMU heading change over the full phase ----
    // Use the first and last arc samples (entire drive, not just steady)
    const allSamples = phase.arcSamples;
    if (allSamples.length < 2) {
      warnings.push(`Arc-${direction}: too few IMU samples for geometry derivation.`);
      return phase;
    }
    const imuHeadingChangeDeg = Math.abs(
      normalizeAngle180(allSamples[allSamples.length - 1].imuHeadingDeg - allSamples[0].imuHeadingDeg)
    );

    const goodFix = (f: string) => f === "fixed" || f === "float" || f === "rtk-fixed" || f === "rtk-float";
    if (!goodFix(phase.startAnchor.fixType) || !goodFix(phase.endAnchor.fixType)) {
      warnings.push(`Arc-${direction}: GNSS fix not available at start or end anchor — geometry skipped. Ensure a good RTK fix before running calibration.`);
      return phase;
    }

    if (imuHeadingChangeDeg < 5 || gnssDistanceMeters < 0.05 || leftTotalTicks < 1 || rightTotalTicks < 1) {
      warnings.push(`Arc-${direction}: insufficient motion for geometry — phase skipped.`);
      return phase;
    }

    const chordMeters = gnssDistanceMeters;
    const headingRad = imuHeadingChangeDeg * DEG_TO_RAD;

    // Arc length of the centre path: chord = 2R sin(Δθ/2), so R = chord / (2 sin(Δθ/2))
    // then centre arc length = R × Δθ
    const arcRadiusMeters = chordMeters / (2 * Math.sin(headingRad / 2));
    const centreArcLengthMeters = arcRadiusMeters * headingRad;

    // For arc-right: left wheel is outer (larger radius), right is inner.
    // The speed ratio outer/inner = fullSpeed / arcInnerSpeed.
    // outerArc / innerArc = speedRatio (same time, different speeds ≈ different distances).
    // We use measured ticks directly which is more accurate than the speed ratio.
    const totalTicks = leftTotalTicks + rightTotalTicks;
    const leftFraction  = leftTotalTicks  / totalTicks;
    const rightFraction = rightTotalTicks / totalTicks;

    let outerTicks: number, innerTicks: number;
    let outerArcLen: number, innerArcLen: number;

    if (direction === "right") {
      // left=outer, right=inner
      outerTicks = leftTotalTicks;
      innerTicks = rightTotalTicks;
    } else {
      // right=outer, left=inner
      outerTicks = rightTotalTicks;
      innerTicks = leftTotalTicks;
    }

    // Total arc length ∝ total ticks; distribute proportionally
    const outerFrac = outerTicks / totalTicks;
    const innerFrac = innerTicks / totalTicks;
    // Total arc = centre × 2 (outer + inner = 2 × centre for equal-radius arc is wrong;
    // more precisely: outer = centreArc × (R+w/2)/R, inner = centreArc × (R-w/2)/R.
    // But we don't know w yet, so bootstrap: totalArc ≈ outerArc + innerArc,
    // and outerArc/innerArc ≈ outerTicks/innerTicks.
    const outerArcLengthEstimate = 2 * outerFrac * centreArcLengthMeters;
    const innerArcLengthEstimate = 2 * innerFrac * centreArcLengthMeters;

    // Wheelbase = (outerArc - innerArc) / Δθ_rad
    const wheelbaseMeters = Math.abs(outerArcLengthEstimate - innerArcLengthEstimate) / headingRad;

    // Per-wheel m/tick
    const outerMetersPerTick = outerArcLengthEstimate / outerTicks;
    const innerMetersPerTick = innerArcLengthEstimate / innerTicks;

    let leftMetersPerTick: number, rightMetersPerTick: number;
    if (direction === "right") {
      leftMetersPerTick  = outerMetersPerTick;
      rightMetersPerTick = innerMetersPerTick;
      outerArcLen = outerArcLengthEstimate;
      innerArcLen = innerArcLengthEstimate;
    } else {
      rightMetersPerTick = outerMetersPerTick;
      leftMetersPerTick  = innerMetersPerTick;
      outerArcLen = outerArcLengthEstimate;
      innerArcLen = innerArcLengthEstimate;
    }

    // ---- DR position integration over steady-state samples ----
    const drError = this.computeDrPositionError(
      phase, leftMetersPerTick, rightMetersPerTick,
    );

    // ---- Arc-tracking RMS (encoder fraction vs IMU fraction) ----
    const rmsError = this.computeArcTrackingRms(steady, leftTotalTicks, rightTotalTicks, imuHeadingChangeDeg);

    const arcGeometry: DerivedArcGeometry = {
      wheelbaseMeters,
      outerArcLengthMeters: outerArcLen,
      innerArcLengthMeters: innerArcLen,
      leftMetersPerTick,
      rightMetersPerTick,
      drEndpointErrorMeters: drError,
      gnssChordMeters: chordMeters,
      imuHeadingChangeDeg,
    };

    return { ...phase, arcTrackingRmsErrorFraction: rmsError, arcGeometry };
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
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildCurrentAnchor(): GnssAnchor {
    const goodAnchors = this.gnssAnchors.filter(
      (a) =>
        (a.fixType === "fixed" || a.fixType === "float" || a.fixType === "rtk-fixed" || a.fixType === "rtk-float") &&
        (a.positionAccuracyMeters === null || a.positionAccuracyMeters <= this.maxAnchorAccuracyMeters),
    );
    if (goodAnchors.length > 0) return goodAnchors[goodAnchors.length - 1];
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
   * Returns the current fused pose as a GNSS anchor, or null on timeout/stop.
   */
  private async waitForSettledPose(): Promise<GnssAnchor | null> {
    const deadline = Date.now() + this.poseSettleTimeoutMs;
    let dwellStartMs: number | null = null;

    this.logger.info("dead_reckoning.waiting_for_settled_pose", {
      dwellMs: this.poseSteadyDwellMs,
      timeoutMs: this.poseSettleTimeoutMs,
    });

    while (Date.now() < deadline) {
      if (this.stopRequested) return null;

      const state = this.poseFusion.getPrimitiveState();
      const isSettled =
        state.usingGnssHeading &&
        state.quality === "gnss" &&
        state.xMeters !== null &&
        state.yMeters !== null;

      if (isSettled) {
        if (dwellStartMs === null) {
          dwellStartMs = Date.now();
        } else if (Date.now() - dwellStartMs >= this.poseSteadyDwellMs) {
          // Sustained agreement — snapshot the current fused pose as the anchor
          const pose = this.poseFusion.getCurrentPose();
          const anchor: GnssAnchor = {
            xMeters: state.xMeters!,
            yMeters: state.yMeters!,
            headingDeg: state.headingDeg,
            positionAccuracyMeters: null,
            fixType: "fixed",
            timestampMillis: Date.now(),
          };
          this.logger.info("dead_reckoning.pose_settled", {
            xMeters: anchor.xMeters,
            yMeters: anchor.yMeters,
            headingDeg: anchor.headingDeg,
            dwellMs: Date.now() - dwellStartMs,
          });
          return anchor;
        }
      } else {
        // Any interruption resets the dwell clock
        dwellStartMs = null;
      }

      await this.sleep(100);
    }

    this.logger.warn("dead_reckoning.pose_settle_timeout", {
      timeoutMs: this.poseSettleTimeoutMs,
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
