/**
 * Pose Fusion — DR-primary sensor fusion.
 *
 * Architecture:
 *
 *   IMU owns heading — always. The IMU heading drives all position integration
 *   and is never overridden by GNSS unilaterally. GNSS heading is used only
 *   to slowly rebase the IMU when both sensors have been stable for long enough
 *   (existing logic preserved below).
 *
 *   Encoders own distance magnitude — always. Every motor feedback event
 *   advances the DR position regardless of GNSS quality.
 *
 *   Per-wheel odometry with slip detection:
 *     avgDistance = (leftTicks × leftMPerTick + rightTicks × rightMPerTick) / 2
 *     impliedTurnRateDeg = (rightDist - leftDist) / wheelbase × (180/π)
 *     If |impliedTurnRate - imuHeadingDelta| > slipThreshold → wheel slip suspected.
 *     On slip: direction still comes from IMU (correct), but distance confidence
 *     is flagged. Position still advances using IMU heading + avg encoder distance
 *     (second-order error only).
 *
 *   GNSS correction — two gates:
 *     Gate 1 (quality): fixType fixed/float AND posAccuracy ≤ maxGnssAccuracyMeters
 *     Gate 2 (agreement): |gnssPos - drPos| ≤ gnssAgreementThresholdMeters
 *     Both must pass to blend DR toward GNSS.
 *     Gate 1 pass + Gate 2 fail → outlier logged, GNSS ignored.
 *     After a long GNSS outage (quality was never good), Gate 2 is bypassed once
 *     to re-anchor.
 */

import { EventEmitter } from "node:events";
import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "./sensorController.js";
import {
  SENSOR_EVENTS,
  GnssPositionUpdateEvent,
  ImuHeadingUpdateEvent,
  MotorFeedbackUpdateEvent,
} from "./sensorEvents.js";
import {
  InternalHeading,
  createInternalHeading,
  unwrapInternalHeading,
  headingDifference,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
import {
  Position,
  Pose,
  createPosition,
  createPose,
  unwrapMeters,
} from "../geometry/positionTypes.js";
import {
  ENCODER_METERS_PER_TICK_DEFAULT,
  WHEEL_BASE_METERS_DEFAULT,
} from "../constants.js";
import { PoseCalibration } from "../config/poseCalibration.js";

// GNSS quality thresholds
const MAX_GNSS_POSITION_ACCURACY_METERS = 0.05;
const MAX_GNSS_HEADING_ACCURACY_DEGREES = 5;
const MAX_GNSS_IMU_ALIGNMENT_DEGREES = 3;

// Blend reference for proportional GNSS correction.
// A fix at this accuracy level is applied at full weight; fixes at
// MAX_GNSS_POSITION_ACCURACY_METERS get proportionally less.
const GNSS_BLEND_REFERENCE_ACCURACY_METERS = 0.02;

// Maximum DR drift before bypassing the agreement gate on GNSS re-anchor.
// After a long GNSS outage, if the first returning good fix is within this
// distance we still trust it. Beyond this we log an implausible-separation
// warning and keep DR as-is.
const GNSS_REANCHOR_MAX_SEPARATION_METERS = 2.0;

// Sanity-check threshold — a separation larger than this between a good-quality
// GNSS fix and the DR estimate is implausible and indicates a corrupted message
// or a coordinate system problem, not normal DR drift.  At this scale we skip
// the reading and log it rather than making a huge position jump.
const GNSS_IMPLAUSIBLE_SEPARATION_METERS = 5.0;

// Slip detection — encoder-implied turn rate vs IMU heading rate disagreement threshold.
// Units: degrees. If the two sources disagree by more than this over a single feedback
// sample, slip is suspected on at least one wheel.
const WHEEL_SLIP_THRESHOLD_DEG = 10;

// Minimum average distance moved per encoder sample before slip check fires
// (below this the numbers are noise, not signal).
const SLIP_CHECK_MIN_DISTANCE_METERS = 0.001;

// DR confidence decay/recovery per motor feedback sample.
// On a slip event the confidence drops by DECAY; on agreement it recovers by RECOVER.
// With 200 Hz polling: DECAY 0.05 → confidence hits zero in ~1 s of sustained slip;
// RECOVER 0.005 → full recovery takes ~100 s of clean movement (~20 000 samples).
const DR_CONFIDENCE_DECAY = 0.05;
const DR_CONFIDENCE_RECOVER = 0.005;

// Heading agreement threshold for the synced highlight on the widget (degrees).
// If encoder-DR heading vs IMU heading differ by more than this, show amber.
const DR_HEADING_SYNC_THRESHOLD_DEG = 15;
// Position agreement threshold for the synced highlight (metres).
const DR_POSITION_SYNC_THRESHOLD_METERS = 0.5;

// GNSS heading rebase — preserve the existing stability-based logic.
const GNSS_STATIONARY_REBASE_TIMEOUT_MS = 10_000;
const GNSS_OFFSET_REBASE_MIN_DURATION_MS = 1_500;
const GNSS_OFFSET_REBASE_MIN_SAMPLES = 6;
const GNSS_OFFSET_REBASE_MAX_SAMPLE_GAP_MS = 500;
const GNSS_OFFSET_REBASE_MAX_OFFSET_DRIFT_DEGREES = 4;
const GNSS_OFFSET_REBASE_MAX_DELTA_MISMATCH_DEGREES = 2.5;
const GNSS_OFFSET_REBASE_MIN_SIGNIFICANT_DELTA_DEGREES = 0.2;

const DEG_TO_RAD = Math.PI / 180;

export interface PoseFusionOptions {
  sensorController: SensorController;
  logger: SessionLogger;
  poseCalibration?: PoseCalibration;
}

export interface PoseFusionEvents {
  poseUpdate: Pose;
}

export interface PoseFusionPrimitiveState {
  readonly status: "idle" | "ok";
  readonly error: string | null;
  readonly xMeters: number | null;
  readonly yMeters: number | null;
  readonly headingDeg: number | null;
  readonly quality: "gnss" | "dead-reckoning" | "unknown";
  readonly speedMetersPerSecond: number | null;
  readonly usingGnssHeading: boolean;
  readonly wheelSlipSuspected: boolean;
  /** Encoder-only dead-reckoning position, never corrected by GNSS or IMU */
  readonly encoderOnlyXMeters: number | null;
  readonly encoderOnlyYMeters: number | null;
  /** Encoder-only dead-reckoning heading derived from differential wheel counts */
  readonly encoderOnlyHeadingDeg: number | null;
  /**
   * Confidence [0..1] in the encoder dead-reckoning estimate.
   * Decays toward 0 each time encoder-implied turn disagrees with IMU;
   * recovers toward 1 on each sample where they agree.
   */
  readonly drConfidence: number;
  /** True when encoder heading is close to IMU heading and DR position is close to fused position */
  readonly encoderSynced: boolean;
}

export class PoseFusion extends EventEmitter {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly poseCalibration: PoseCalibration | null;

  private running = false;

  // Current pose — DR-primary, always maintained by encoders + IMU
  private currentPosition: Position = createPosition(0, 0);
  private currentHeading: InternalHeading = createInternalHeading(0);
  // DR is always the working quality; GNSS merely corrects it
  private currentQuality: "gnss" | "dead-reckoning" | "unknown" = "unknown";

  // Per-wheel calibration
  private leftEncoderMetersPerTick: number;
  private rightEncoderMetersPerTick: number;
  private wheelbaseMeters: number;

  // GNSS synchronisation state
  private hasGnssPositionBaseline = false;
  private lastGnssSyncTimeMs: number | null = null;
  private gnssQualityLostTimeMs: number | null = null;
  private hasGnssHeadingBaseline = false;
  private isUsingGnssHeading = false;

  // Slip detection
  private wheelSlipSuspected = false;
  private lastImuHeadingForSlip: InternalHeading | null = null;

  // Encoder-only odometry — independent track, never nudged by GNSS or IMU
  private encoderOnlyX: number | null = null;
  private encoderOnlyY: number | null = null;
  private encoderOnlyHeadingDeg: number | null = null;
  private drConfidence = 1.0;

  // GNSS heading stability tracking (unchanged from previous implementation)
  private lastGnssHeading: InternalHeading | null = null;
  private lastGnssHeadingTime: number | null = null;
  private offsetTrackingStartTime: number | null = null;
  private offsetTrackingSampleCount = 0;
  private offsetTrackingReferenceDeltaDeg: number | null = null;
  private offsetTrackingLastImuHeading: InternalHeading | null = null;
  private offsetTrackingLastGnssHeading: InternalHeading | null = null;
  private offsetTrackingLastTimestampMs: number | null = null;

  declare on: <K extends keyof PoseFusionEvents>(event: K, listener: (data: PoseFusionEvents[K]) => void) => this;
  declare off: <K extends keyof PoseFusionEvents>(event: K, listener: (data: PoseFusionEvents[K]) => void) => this;
  declare emit: <K extends keyof PoseFusionEvents>(event: K, data: PoseFusionEvents[K]) => boolean;

  constructor(options: PoseFusionOptions) {
    super();
    this.logger = options.logger.child({ context: "sensing", source: "PoseFusion" });
    this.sensorController = options.sensorController;
    this.poseCalibration = options.poseCalibration ?? null;

    const cal = options.poseCalibration;
    this.leftEncoderMetersPerTick  = cal?.getLeftEncoderMetersPerTick()  ?? ENCODER_METERS_PER_TICK_DEFAULT;
    this.rightEncoderMetersPerTick = cal?.getRightEncoderMetersPerTick() ?? ENCODER_METERS_PER_TICK_DEFAULT;
    this.wheelbaseMeters           = cal?.getWheelbaseMeters()           ?? WHEEL_BASE_METERS_DEFAULT;

    this.onGnssPositionUpdate  = this.onGnssPositionUpdate.bind(this);
    this.onImuHeadingUpdate    = this.onImuHeadingUpdate.bind(this);
    this.onMotorFeedbackUpdate = this.onMotorFeedbackUpdate.bind(this);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info("pose_fusion.starting", {
      leftEncoderMetersPerTick: this.leftEncoderMetersPerTick,
      rightEncoderMetersPerTick: this.rightEncoderMetersPerTick,
      wheelbaseMeters: this.wheelbaseMeters,
    });
    this.sensorController.on(SENSOR_EVENTS.GNSS_POSITION_UPDATE, this.onGnssPositionUpdate);
    this.sensorController.on(SENSOR_EVENTS.IMU_HEADING_UPDATE,    this.onImuHeadingUpdate);
    this.sensorController.on(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedbackUpdate);
    this.logger.info("pose_fusion.started", {});
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.sensorController.off(SENSOR_EVENTS.GNSS_POSITION_UPDATE, this.onGnssPositionUpdate);
    this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE,    this.onImuHeadingUpdate);
    this.sensorController.off(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedbackUpdate);
    this.logger.info("pose_fusion.stopped", {});
  }

  getCurrentPose(): Pose {
    return createPose(
      unwrapMeters(this.currentPosition.xMeters),
      unwrapMeters(this.currentPosition.yMeters),
      this.currentHeading,
      this.currentQuality,
    );
  }

  getPrimitiveState(): PoseFusionPrimitiveState {
    const pose = this.getCurrentPose();
    const fusedX = unwrapMeters(pose.position.xMeters);
    const fusedY = unwrapMeters(pose.position.yMeters);
    const fusedHeadingDeg = unwrapInternalHeading(pose.heading);

    const encoderHeadingDeg = this.encoderOnlyHeadingDeg;
    const headingAgreement =
      encoderHeadingDeg !== null
        ? Math.abs(this.normalizeAngle180(encoderHeadingDeg - fusedHeadingDeg)) <= DR_HEADING_SYNC_THRESHOLD_DEG
        : false;
    const positionAgreement =
      this.encoderOnlyX !== null && this.encoderOnlyY !== null
        ? Math.hypot(this.encoderOnlyX - fusedX, this.encoderOnlyY - fusedY) <= DR_POSITION_SYNC_THRESHOLD_METERS
        : false;

    return {
      status: this.running ? "ok" : "idle",
      error: null,
      xMeters: fusedX,
      yMeters: fusedY,
      headingDeg: fusedHeadingDeg,
      quality: pose.quality,
      speedMetersPerSecond: null,
      usingGnssHeading: this.isUsingGnssHeading,
      wheelSlipSuspected: this.wheelSlipSuspected,
      encoderOnlyXMeters: this.encoderOnlyX,
      encoderOnlyYMeters: this.encoderOnlyY,
      encoderOnlyHeadingDeg: encoderHeadingDeg,
      drConfidence: this.drConfidence,
      encoderSynced: headingAgreement && positionAgreement,
    };
  }

  private normalizeAngle180(deg: number): number {
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  setPosition(position: Position): void {
    this.currentPosition = position;
    this.currentQuality = "dead-reckoning";
    this.logger.info("pose_fusion.position_set", {
      x: unwrapMeters(position.xMeters),
      y: unwrapMeters(position.yMeters),
    });
  }

  // Shared scalar accessor — used by external callers and the API
  getEncoderCalibration(): number {
    return (this.leftEncoderMetersPerTick + this.rightEncoderMetersPerTick) / 2;
  }

  async setEncoderCalibration(metersPerTick: number): Promise<void> {
    const hadAsymmetricCalibration =
      this.leftEncoderMetersPerTick !== this.rightEncoderMetersPerTick;
    if (hadAsymmetricCalibration) {
      this.logger.warn("pose_fusion.encoder_calibration_overwrites_per_wheel", {
        leftBefore: this.leftEncoderMetersPerTick,
        rightBefore: this.rightEncoderMetersPerTick,
        newSharedValue: metersPerTick,
      });
    }
    this.leftEncoderMetersPerTick  = metersPerTick;
    this.rightEncoderMetersPerTick = metersPerTick;
    if (this.poseCalibration) {
      this.poseCalibration.setEncoderCalibration(metersPerTick);
      await this.poseCalibration.saveParameters();
    }
    this.logger.info("pose_fusion.encoder_calibration_set", { metersPerTick });
  }

  async setPerWheelCalibration(
    leftMetersPerTick: number,
    rightMetersPerTick: number,
    wheelbaseMeters: number,
  ): Promise<void> {
    this.leftEncoderMetersPerTick  = leftMetersPerTick;
    this.rightEncoderMetersPerTick = rightMetersPerTick;
    this.wheelbaseMeters           = wheelbaseMeters;
    if (this.poseCalibration) {
      this.poseCalibration.setPerWheelCalibration(leftMetersPerTick, rightMetersPerTick, wheelbaseMeters);
      await this.poseCalibration.saveParameters();
    }
    this.logger.info("pose_fusion.per_wheel_calibration_set", {
      leftMetersPerTick,
      rightMetersPerTick,
      wheelbaseMeters,
    });
  }

  // ---------------------------------------------------------------------------
  // Motor feedback — DR position update (always active)
  // ---------------------------------------------------------------------------

  private onMotorFeedbackUpdate(event: MotorFeedbackUpdateEvent): void {
    if (!this.running) return;

    const dLeft  = event.leftEncoderDelta  * this.leftEncoderMetersPerTick;
    const dRight = event.rightEncoderDelta * this.rightEncoderMetersPerTick;
    const avgDist = (dLeft + dRight) / 2;

    if (Math.abs(avgDist) < 0.00005) return;  // sub-0.05 mm — ignore noise

    // --- Slip detection ---
    // Compare encoder-implied heading change with what the IMU reported since
    // the last feedback sample.
    // --- Encoder-only odometry ---
    // Seed heading from IMU on the first encoder sample so the encoder track
    // starts aligned; after that it integrates purely from wheel differentials.
    if (this.encoderOnlyHeadingDeg === null) {
      this.encoderOnlyHeadingDeg = unwrapInternalHeading(this.currentHeading);
      this.encoderOnlyX = unwrapMeters(this.currentPosition.xMeters);
      this.encoderOnlyY = unwrapMeters(this.currentPosition.yMeters);
    }

    let encoderImpliedTurnDeg = 0;
    if (this.wheelbaseMeters > 0) {
      encoderImpliedTurnDeg = ((dRight - dLeft) / this.wheelbaseMeters) / DEG_TO_RAD;
    }

    // Advance encoder-only position using encoder-only heading
    this.encoderOnlyHeadingDeg = this.normalizeAngle180(this.encoderOnlyHeadingDeg + encoderImpliedTurnDeg);
    const encHeadingRad = this.encoderOnlyHeadingDeg * DEG_TO_RAD;
    this.encoderOnlyX = (this.encoderOnlyX ?? 0) + avgDist * Math.cos(encHeadingRad);
    this.encoderOnlyY = (this.encoderOnlyY ?? 0) + avgDist * Math.sin(encHeadingRad);

    // --- Slip detection and confidence ---
    if (Math.abs(avgDist) >= SLIP_CHECK_MIN_DISTANCE_METERS && this.wheelbaseMeters > 0) {
      if (this.lastImuHeadingForSlip !== null) {
        // Use the signed IMU delta so opposite-direction disagreements (encoder
        // implies +5° but IMU shows -5°) are counted as a 10° mismatch, not 0.
        const imuTurnDeg = unwrapRelativeAngle(headingDifference(this.lastImuHeadingForSlip, this.currentHeading));
        const slipErr = Math.abs(encoderImpliedTurnDeg - imuTurnDeg);

        if (slipErr > WHEEL_SLIP_THRESHOLD_DEG) {
          if (!this.wheelSlipSuspected) {
            this.logger.warn("pose_fusion.wheel_slip_suspected", {
              encoderImpliedTurnDeg,
              imuTurnDeg,
              slipErr,
              dLeft,
              dRight,
            });
          }
          this.wheelSlipSuspected = true;
          this.drConfidence = Math.max(0, this.drConfidence - DR_CONFIDENCE_DECAY);
        } else {
          this.wheelSlipSuspected = false;
          this.drConfidence = Math.min(1, this.drConfidence + DR_CONFIDENCE_RECOVER);
        }
      }
      this.lastImuHeadingForSlip = this.currentHeading;
    }

    // --- Advance DR position using IMU heading ---
    const headingRad = unwrapInternalHeading(this.currentHeading) * DEG_TO_RAD;
    const newX = unwrapMeters(this.currentPosition.xMeters) + avgDist * Math.cos(headingRad);
    const newY = unwrapMeters(this.currentPosition.yMeters) + avgDist * Math.sin(headingRad);
    this.currentPosition = createPosition(newX, newY);

    if (this.currentQuality === "unknown") {
      this.currentQuality = "dead-reckoning";
    }

    this.emit("poseUpdate", this.getCurrentPose());
  }

  // ---------------------------------------------------------------------------
  // IMU heading update — heading is always the IMU value
  // ---------------------------------------------------------------------------

  private onImuHeadingUpdate(event: ImuHeadingUpdateEvent): void {
    if (!this.running) return;
    this.currentHeading = event.heading;
    this.emit("poseUpdate", this.getCurrentPose());
  }

  // ---------------------------------------------------------------------------
  // GNSS position update — two-gate correction of DR position
  // ---------------------------------------------------------------------------

  private onGnssPositionUpdate(event: GnssPositionUpdateEvent): void {
    if (!this.running) return;

    const isGoodFix =
      event.fixType === "fixed" || event.fixType === "float" ||
      event.fixType === "rtk-fixed" || event.fixType === "rtk-float";
    const isGoodPositionAccuracy =
      event.positionAccuracyMeters !== null &&
      event.positionAccuracyMeters <= MAX_GNSS_POSITION_ACCURACY_METERS;
    const isGoodHeadingAccuracy =
      event.heading !== null &&
      event.headingAccuracyDeg !== null &&
      event.headingAccuracyDeg <= MAX_GNSS_HEADING_ACCURACY_DEGREES;

    const passesGate1 = isGoodFix && isGoodPositionAccuracy;

    if (passesGate1) {
      this.applyGnssPositionCorrection(event);
    } else {
      // Quality insufficient — DR continues unaided; quality stays as-is
      if (this.currentQuality === "gnss") {
        this.currentQuality = "dead-reckoning";
        this.gnssQualityLostTimeMs = Date.now();
        this.logger.warn("pose_fusion.gnss_quality_degraded", {
          fixType: event.fixType,
          positionAccuracyMeters: event.positionAccuracyMeters,
        });
      }
    }

    // Heading rebase logic (unchanged — slow, stability-gated)
    this.isUsingGnssHeading = false;
    const canTrustHeading = isGoodFix && isGoodHeadingAccuracy && event.heading !== null;
    if (canTrustHeading) {
      this.updateHeadingFromGnss(event.heading!, event.timestampMillis);
    }

    this.emit("poseUpdate", this.getCurrentPose());
  }

  private applyGnssPositionCorrection(event: GnssPositionUpdateEvent): void {
    const gnssX = event.xMeters;
    const gnssY = event.yMeters;
    const drX = unwrapMeters(this.currentPosition.xMeters);
    const drY = unwrapMeters(this.currentPosition.yMeters);
    const separation = Math.hypot(gnssX - drX, gnssY - drY);

    if (!this.hasGnssPositionBaseline) {
      // First good fix — hard anchor. DR has no reliable origin yet.
      this.logger.info("pose_fusion.gnss_position_anchored", { gnssX, gnssY });
      this.currentPosition = createPosition(gnssX, gnssY);
      this.hasGnssPositionBaseline = true;
      this.gnssQualityLostTimeMs = null;
      this.currentQuality = "gnss";
      this.lastGnssSyncTimeMs = Date.now();
      return;
    }

    // After a GNSS outage, the first returning fix may be further from DR than
    // normal because DR has drifted. Allow re-anchor up to GNSS_REANCHOR_MAX_SEPARATION_METERS
    // so we recover quickly. Beyond that the separation is more likely a corrupt
    // message than accumulated DR drift, so skip and wait for confirmation.
    const wasInOutage = this.gnssQualityLostTimeMs !== null;
    if (separation > GNSS_IMPLAUSIBLE_SEPARATION_METERS) {
      this.logger.warn("pose_fusion.gnss_position_implausible", {
        separation,
        threshold: GNSS_IMPLAUSIBLE_SEPARATION_METERS,
        gnssX, gnssY, drX, drY,
      });
      return;
    }

    if (wasInOutage && separation > GNSS_REANCHOR_MAX_SEPARATION_METERS) {
      this.logger.warn("pose_fusion.gnss_reanchor_separation_too_large", {
        separation,
        threshold: GNSS_REANCHOR_MAX_SEPARATION_METERS,
        gnssX, gnssY, drX, drY,
      });
      return;
    }

    if (wasInOutage) {
      // Re-anchor after outage — jump to GNSS to eliminate accumulated DR drift.
      this.logger.info("pose_fusion.gnss_position_reanchored_after_outage", {
        separation,
        gnssX, gnssY, drX, drY,
        outageDurationMs: Date.now() - this.gnssQualityLostTimeMs!,
      });
      this.currentPosition = createPosition(gnssX, gnssY);
      this.gnssQualityLostTimeMs = null;
      this.currentQuality = "gnss";
      this.lastGnssSyncTimeMs = Date.now();
      return;
    }

    // Steady-state: blend proportional to accuracy.
    // GNSS_BLEND_REFERENCE_ACCURACY_METERS (2 cm) → blendFactor 1.0 (full snap).
    // Fixes near MAX_GNSS_POSITION_ACCURACY_METERS (5 cm) → proportionally less.
    const accuracy = event.positionAccuracyMeters ?? MAX_GNSS_POSITION_ACCURACY_METERS;
    const blendFactor = Math.min(1, GNSS_BLEND_REFERENCE_ACCURACY_METERS / Math.max(accuracy, 0.001));
    const blendedX = drX + blendFactor * (gnssX - drX);
    const blendedY = drY + blendFactor * (gnssY - drY);
    this.currentPosition = createPosition(blendedX, blendedY);

    this.currentQuality = "gnss";
    this.lastGnssSyncTimeMs = Date.now();
  }

  // ---------------------------------------------------------------------------
  // GNSS heading rebase (unchanged logic from original implementation)
  // ---------------------------------------------------------------------------

  private updateHeadingFromGnss(gnssHeading: InternalHeading, timestampMillis: number): void {
    const alignmentDeltaDeg = Math.abs(
      unwrapRelativeAngle(headingDifference(this.currentHeading, gnssHeading))
    );
    const motorZeroCommandSinceMillis = this.sensorController.getMotorZeroCommandSinceMillis?.() ?? null;
    const currentTimeMillis = this.sensorController.getCurrentTimeMillis?.() ?? timestampMillis;
    const stationaryZeroCommandAgeMs =
      motorZeroCommandSinceMillis === null ? null : Math.max(0, currentTimeMillis - motorZeroCommandSinceMillis);
    const stationaryTimeoutReached =
      stationaryZeroCommandAgeMs !== null &&
      stationaryZeroCommandAgeMs >= GNSS_STATIONARY_REBASE_TIMEOUT_MS;
    const rebaseReadiness = this.sensorController.getHeadingRebaseReadiness?.() ?? null;

    if (rebaseReadiness !== null && !rebaseReadiness.safe) {
      this.lastGnssHeading = gnssHeading;
      this.lastGnssHeadingTime = timestampMillis;
      this.resetOffsetTracking();
      this.isUsingGnssHeading = false;
      return;
    }

    if (!this.hasGnssHeadingBaseline) {
      this.logger.info("pose_fusion.gnss_heading_primed", {
        alignmentDeltaDeg,
        currentHeadingDeg: unwrapInternalHeading(this.currentHeading),
        gnssHeadingDeg: unwrapInternalHeading(gnssHeading),
      });
      this.applyGnssHeadingRebase(gnssHeading, timestampMillis);
      this.hasGnssHeadingBaseline = true;
      this.isUsingGnssHeading = true;
      return;
    }

    if (this.lastGnssHeading !== null && this.lastGnssHeadingTime !== null) {
      const timeDeltaMs = timestampMillis - this.lastGnssHeadingTime;
      if (timeDeltaMs > 0) {
        const headingChangeDeg = Math.abs(unwrapRelativeAngle(headingDifference(this.lastGnssHeading, gnssHeading)));
        if ((headingChangeDeg / timeDeltaMs) * 1000 > 30) {
          this.logger.warn("pose_fusion.gnss_heading_unstable", { headingChangeDeg, timeDeltaMs });
          this.resetOffsetTracking();
          return;
        }
      }
    }

    const consistentOffset = this.updateOffsetTracking(gnssHeading, timestampMillis, alignmentDeltaDeg);

    if (alignmentDeltaDeg > MAX_GNSS_IMU_ALIGNMENT_DEGREES && !stationaryTimeoutReached && !consistentOffset.consistent) {
      this.isUsingGnssHeading = false;
      return;
    }

    if (alignmentDeltaDeg > MAX_GNSS_IMU_ALIGNMENT_DEGREES && stationaryTimeoutReached) {
      this.logger.info("pose_fusion.gnss_heading_rebased_after_stop", {
        alignmentDeltaDeg,
        stationaryZeroCommandAgeMs,
      });
    }
    if (alignmentDeltaDeg > MAX_GNSS_IMU_ALIGNMENT_DEGREES && consistentOffset.consistent) {
      this.logger.info("pose_fusion.gnss_heading_rebased_after_consistent_offset", {
        alignmentDeltaDeg,
        consistentOffsetDurationMs: consistentOffset.durationMs,
      });
    }

    this.applyGnssHeadingRebase(gnssHeading, timestampMillis);
    this.isUsingGnssHeading = true;
  }

  private applyGnssHeadingRebase(gnssHeading: InternalHeading, timestampMillis: number): void {
    const rebaseTimestampMillis = this.sensorController.getCurrentTimeMillis?.() ?? timestampMillis;
    this.sensorController.setHeading(gnssHeading, rebaseTimestampMillis);
    this.currentHeading = gnssHeading;
    this.lastGnssHeading = gnssHeading;
    this.lastGnssHeadingTime = timestampMillis;
    this.resetOffsetTracking();
  }

  private resetOffsetTracking(): void {
    this.offsetTrackingStartTime = null;
    this.offsetTrackingSampleCount = 0;
    this.offsetTrackingReferenceDeltaDeg = null;
    this.offsetTrackingLastImuHeading = null;
    this.offsetTrackingLastGnssHeading = null;
    this.offsetTrackingLastTimestampMs = null;
  }

  private updateOffsetTracking(
    gnssHeading: InternalHeading,
    timestampMillis: number,
    alignmentDeltaDeg: number,
  ): { consistent: boolean; durationMs: number; sampleCount: number } {
    if (
      this.offsetTrackingLastImuHeading === null ||
      this.offsetTrackingLastGnssHeading === null ||
      this.offsetTrackingLastTimestampMs === null ||
      this.offsetTrackingReferenceDeltaDeg === null ||
      this.offsetTrackingStartTime === null
    ) {
      this.offsetTrackingStartTime = timestampMillis;
      this.offsetTrackingSampleCount = 1;
      this.offsetTrackingReferenceDeltaDeg = alignmentDeltaDeg;
      this.offsetTrackingLastImuHeading = this.currentHeading;
      this.offsetTrackingLastGnssHeading = gnssHeading;
      this.offsetTrackingLastTimestampMs = timestampMillis;
      return { consistent: false, durationMs: 0, sampleCount: 1 };
    }

    const timeDeltaMs = timestampMillis - this.offsetTrackingLastTimestampMs;
    if (timeDeltaMs <= 0 || timeDeltaMs > GNSS_OFFSET_REBASE_MAX_SAMPLE_GAP_MS) {
      this.resetOffsetTracking();
      this.offsetTrackingStartTime = timestampMillis;
      this.offsetTrackingSampleCount = 1;
      this.offsetTrackingReferenceDeltaDeg = alignmentDeltaDeg;
      this.offsetTrackingLastImuHeading = this.currentHeading;
      this.offsetTrackingLastGnssHeading = gnssHeading;
      this.offsetTrackingLastTimestampMs = timestampMillis;
      return { consistent: false, durationMs: 0, sampleCount: 1 };
    }

    const imuDeltaDeg  = unwrapRelativeAngle(headingDifference(this.offsetTrackingLastImuHeading,  this.currentHeading));
    const gnssDeltaDeg = unwrapRelativeAngle(headingDifference(this.offsetTrackingLastGnssHeading, gnssHeading));
    const absImuDelta  = Math.abs(imuDeltaDeg);
    const absGnssDelta = Math.abs(gnssDeltaDeg);
    const bothNearlyStill =
      absImuDelta  <= GNSS_OFFSET_REBASE_MIN_SIGNIFICANT_DELTA_DEGREES &&
      absGnssDelta <= GNSS_OFFSET_REBASE_MIN_SIGNIFICANT_DELTA_DEGREES;
    const sameTurnDirection = bothNearlyStill || Math.sign(imuDeltaDeg) === Math.sign(gnssDeltaDeg);
    const deltaMismatch = Math.abs(absImuDelta - absGnssDelta);
    const offsetDrift   = Math.abs(alignmentDeltaDeg - this.offsetTrackingReferenceDeltaDeg);

    if (
      !sameTurnDirection ||
      deltaMismatch > GNSS_OFFSET_REBASE_MAX_DELTA_MISMATCH_DEGREES ||
      offsetDrift   > GNSS_OFFSET_REBASE_MAX_OFFSET_DRIFT_DEGREES
    ) {
      this.resetOffsetTracking();
      this.offsetTrackingStartTime = timestampMillis;
      this.offsetTrackingSampleCount = 1;
      this.offsetTrackingReferenceDeltaDeg = alignmentDeltaDeg;
      this.offsetTrackingLastImuHeading = this.currentHeading;
      this.offsetTrackingLastGnssHeading = gnssHeading;
      this.offsetTrackingLastTimestampMs = timestampMillis;
      return { consistent: false, durationMs: 0, sampleCount: 1 };
    }

    this.offsetTrackingSampleCount += 1;
    this.offsetTrackingLastImuHeading = this.currentHeading;
    this.offsetTrackingLastGnssHeading = gnssHeading;
    this.offsetTrackingLastTimestampMs = timestampMillis;

    const durationMs = timestampMillis - this.offsetTrackingStartTime;
    const consistent =
      durationMs >= GNSS_OFFSET_REBASE_MIN_DURATION_MS &&
      this.offsetTrackingSampleCount >= GNSS_OFFSET_REBASE_MIN_SAMPLES;

    return { consistent, durationMs, sampleCount: this.offsetTrackingSampleCount };
  }
}
