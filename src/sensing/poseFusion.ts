/**
 * Pose Fusion — GNSS-primary sensor fusion with IMU/encoder fallback.
 *
 * Coordinate frame: ENU (X=East, Y=North). Internal headings are Cartesian —
 * 0° points along +X (East) and 90° along +Y (North), so position integration
 * uses dx = d·cos(h), dy = d·sin(h).
 *
 * Trust hierarchy:
 *
 *   GNSS is the source of truth when validated.  The GnssValidator state
 *   machine encapsulates the UM982 acceptance rules — fix type, RTK
 *   reliability, satellites, HDOP, accuracy, baseline, IMU consistency —
 *   and only promotes a sample to TRUSTED after the required number of
 *   consecutive valid epochs.  When position is TRUSTED the fused position
 *   snaps to GNSS; when heading is TRUSTED the IMU is rebased from GNSS.
 *
 *   IMU owns heading between TRUSTED GNSS epochs.  It integrates yaw
 *   continuously and is the live heading source consumers see.  GNSS does
 *   not write the IMU heading directly except on rebase events.
 *
 *   Encoders integrate position between TRUSTED GNSS epochs.  When GNSS is
 *   TRUSTED the fused position snaps to GNSS and the encoder-only track is
 *   re-anchored to that snap, so the dead-reckoning origin is always fresh
 *   for an eventual GNSS dropout.  When GNSS is REJECTED the encoder track
 *   keeps the position estimate alive using IMU heading and the per-wheel
 *   distance values from poseCalibration.  No DR-vs-GNSS agreement gate
 *   exists — the validator is the only authority on whether GNSS is good
 *   enough.
 *
 *   Quality reporting:
 *     "gnss"            — last GNSS sample was TRUSTED within GNSS_STALE_TIMEOUT_MS
 *     "dead-reckoning"  — no recent TRUSTED GNSS, pose is being integrated
 *                         from encoders/IMU
 *     "unknown"         — no GNSS baseline ever established
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
  POSE_FUSION_EMIT_INTERVAL_MS,
  WHEEL_BASE_METERS_DEFAULT,
} from "../constants.js";
import { PoseCalibration } from "../config/poseCalibration.js";
import { GnssValidator, GnssValidationResult } from "./gnssValidator.js";

// Slip detection — encoder-implied turn rate vs IMU heading rate disagreement threshold.
// Units: degrees. If the two sources disagree by more than this over a single feedback
// sample, slip is suspected on at least one wheel.
const WHEEL_SLIP_THRESHOLD_DEG = 10;

// Minimum average distance moved per encoder sample before slip check fires
// (below this the numbers are noise, not signal).
const SLIP_CHECK_MIN_DISTANCE_METERS = 0.001;

// Encoder-only DR confidence decay/recovery per motor feedback sample.
// On a slip event the confidence drops by DECAY; on agreement it recovers by RECOVER.
const DR_CONFIDENCE_DECAY = 0.05;
const DR_CONFIDENCE_RECOVER = 0.005;

// Heading/position agreement thresholds for the encoder-synced widget highlight.
const DR_HEADING_SYNC_THRESHOLD_DEG = 15;
const DR_POSITION_SYNC_THRESHOLD_METERS = 0.5;

// Maximum sample-to-sample staleness on the Pi clock.  Reaching this means
// the GNSS link is effectively dead.  This is wallclock arrival, not the
// receiver-claimed sample age (which the validator handles via
// sampleAgeMillis when present).
const GNSS_STALE_TIMEOUT_MS = 2_000;
const STATIONARY_HEADING_REBASE_OVERRIDE_MAX_DISAGREEMENT_DEG = 30;

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
  readonly usingGnssHeading: boolean;
  readonly wheelSlipSuspected: boolean;
  /** Milliseconds since the last accepted good-quality GNSS position fix, or null if never received */
  readonly gnssPositionAgeMs: number | null;
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
  private readonly gnssValidator: GnssValidator;

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

  // GNSS gate diagnostics — populated on every accept/reject so the heartbeat
  // can show the most-recent reason without spamming per-sample logs.
  private lastGnssAcceptedAtMs: number | null = null;
  private lastGnssRejectionReason: string | null = null;
  private lastGnssRejectionAtMs: number | null = null;
  private lastGnssRejectionLogAtMs: Map<string, number> = new Map();
  // Stationary heading-rebase log throttle. The override path fires on
  // every GNSS sample (~20 Hz) while the mower is parked but the
  // validator hasn't yet promoted the heading to TRUSTED. Logging each
  // sample drowns the disk and can starve the Pi.  Limit to one log per
  // second per stationary window.
  private lastStationaryOverrideLogAtMs: number | null = null;
  /**
   * Distance between the most recent accepted GNSS sample and the fused
   * position at that moment.  Diagnostic only — no longer used for gating.
   */
  private lastGnssBlendSeparation: number | null = null;
  private lastGnssBlendFactor: number | null = null;
  // Most recent raw GNSS event seen by the fusion layer — surfaced via the
  // diagnostic snapshot so the drive heartbeat can compare what GNSS reported
  // against what reached fused pose.
  private lastGnssEvent: GnssPositionUpdateEvent | null = null;
  // Most recent encoder feedback delta — surfaced for the heartbeat so we can
  // see the per-wheel ticks that drove the latest DR step.
  private lastMotorFeedback: { leftEncoderDelta: number; rightEncoderDelta: number } | null = null;
  private lastPoseEmitMillis: number | null = null;

  declare on: <K extends keyof PoseFusionEvents>(event: K, listener: (data: PoseFusionEvents[K]) => void) => this;
  declare off: <K extends keyof PoseFusionEvents>(event: K, listener: (data: PoseFusionEvents[K]) => void) => this;
  declare emit: <K extends keyof PoseFusionEvents>(event: K, data: PoseFusionEvents[K]) => boolean;

  constructor(options: PoseFusionOptions) {
    super();
    this.logger = options.logger.child({ context: "sensing", source: "PoseFusion" });
    this.sensorController = options.sensorController;
    this.poseCalibration = options.poseCalibration ?? null;
    this.gnssValidator = new GnssValidator({ logger: this.logger });

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

  private emitPoseUpdate(force = false): void {
    const nowMs = this.sensorController.getCurrentTimeMillis?.() ?? Date.now();
    if (!force && this.lastPoseEmitMillis !== null && nowMs - this.lastPoseEmitMillis < POSE_FUSION_EMIT_INTERVAL_MS) {
      return;
    }

    this.lastPoseEmitMillis = nowMs;
    this.emit("poseUpdate", this.getCurrentPose());
  }

  /**
   * Demote `currentQuality` to "dead-reckoning" when the last accepted GNSS
   * fix has aged past the staleness threshold. Called once per motor-feedback
   * event so quality is refreshed at the motor poll cadence — readers
   * (`getCurrentPose`/`getPrimitiveState`/`getDiagnosticSnapshot`) stay free of
   * side effects.
   */
  private tickQualityStalenessCheck(nowMs: number): void {
    if (
      this.currentQuality === "gnss" &&
      this.lastGnssSyncTimeMs !== null &&
      nowMs - this.lastGnssSyncTimeMs > GNSS_STALE_TIMEOUT_MS
    ) {
      this.currentQuality = "dead-reckoning";
      if (this.gnssQualityLostTimeMs === null) {
        this.gnssQualityLostTimeMs = this.lastGnssSyncTimeMs + GNSS_STALE_TIMEOUT_MS;
        this.logger.warn("pose_fusion.gnss_position_silent", {
          ageMs: nowMs - this.lastGnssSyncTimeMs,
          threshold: GNSS_STALE_TIMEOUT_MS,
        });
      }
    }
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

    const nowMs = this.sensorController.getCurrentTimeMillis?.() ?? Date.now();
    const gnssPositionAgeMs = this.lastGnssSyncTimeMs !== null ? nowMs - this.lastGnssSyncTimeMs : null;

    return {
      status: this.running ? "ok" : "idle",
      error: null,
      xMeters: fusedX,
      yMeters: fusedY,
      headingDeg: fusedHeadingDeg,
      quality: this.currentQuality,
      usingGnssHeading: this.isUsingGnssHeading,
      wheelSlipSuspected: this.wheelSlipSuspected,
      gnssPositionAgeMs,
      encoderOnlyXMeters: this.encoderOnlyX,
      encoderOnlyYMeters: this.encoderOnlyY,
      encoderOnlyHeadingDeg: encoderHeadingDeg,
      drConfidence: this.drConfidence,
      encoderSynced: headingAgreement && positionAgreement,
    };
  }

  /**
   * Diagnostic snapshot for the drive heartbeat.  Captures the contributions of
   * each sensor source so a single log record per heartbeat answers
   * "what is each subsystem feeding fused pose right now, and is GNSS reaching
   * the fused state?"  Designed to be called at ~5 Hz during an active drive.
   */
  getDiagnosticSnapshot(): {
    fused: { x: number; y: number; headingDeg: number; quality: "gnss" | "dead-reckoning" | "unknown"; usingGnssHeading: boolean };
    encoder: { onlyX: number | null; onlyY: number | null; onlyHeadingDeg: number | null; drConfidence: number; encoderSynced: boolean; wheelSlipSuspected: boolean; lastLeftDelta: number | null; lastRightDelta: number | null };
    calibration: { leftMetersPerTick: number; rightMetersPerTick: number; wheelbaseMeters: number };
    gnss: {
      gnssToFusedSeparationMeters: number | null;
      lastAcceptedAgoMs: number | null;
      lastRejectionReason: string | null;
      lastRejectionAgoMs: number | null;
      lastBlendSeparation: number | null;
      lastBlendFactor: number | null;
      raw: {
        x: number;
        y: number;
        fixType: string;
        positionAccuracyMeters: number | null;
        headingDeg: number | null;
        headingAccuracyDeg: number | null;
        sampleAgeMs: number | null;
        timestampMillis: number;
      } | null;
    };
  } {
    const nowMs = this.sensorController.getCurrentTimeMillis?.() ?? Date.now();
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
      fused: {
        x: fusedX,
        y: fusedY,
        headingDeg: fusedHeadingDeg,
        quality: this.currentQuality,
        usingGnssHeading: this.isUsingGnssHeading,
      },
      encoder: {
        onlyX: this.encoderOnlyX,
        onlyY: this.encoderOnlyY,
        onlyHeadingDeg: encoderHeadingDeg,
        drConfidence: this.drConfidence,
        encoderSynced: headingAgreement && positionAgreement,
        wheelSlipSuspected: this.wheelSlipSuspected,
        lastLeftDelta: this.lastMotorFeedback?.leftEncoderDelta ?? null,
        lastRightDelta: this.lastMotorFeedback?.rightEncoderDelta ?? null,
      },
      calibration: {
        leftMetersPerTick: this.leftEncoderMetersPerTick,
        rightMetersPerTick: this.rightEncoderMetersPerTick,
        wheelbaseMeters: this.wheelbaseMeters,
      },
      gnss: {
        gnssToFusedSeparationMeters: this.lastGnssEvent === null
          ? null
          : Math.hypot(this.lastGnssEvent.xMeters - fusedX, this.lastGnssEvent.yMeters - fusedY),
        lastAcceptedAgoMs: this.lastGnssAcceptedAtMs === null ? null : nowMs - this.lastGnssAcceptedAtMs,
        lastRejectionReason: this.lastGnssRejectionReason,
        lastRejectionAgoMs: this.lastGnssRejectionAtMs === null ? null : nowMs - this.lastGnssRejectionAtMs,
        lastBlendSeparation: this.lastGnssBlendSeparation,
        lastBlendFactor: this.lastGnssBlendFactor,
        raw: this.lastGnssEvent === null ? null : {
          x: this.lastGnssEvent.xMeters,
          y: this.lastGnssEvent.yMeters,
          fixType: this.lastGnssEvent.fixType,
          positionAccuracyMeters: this.lastGnssEvent.positionAccuracyMeters,
          headingDeg: this.lastGnssEvent.heading === null ? null : unwrapInternalHeading(this.lastGnssEvent.heading),
          headingAccuracyDeg: this.lastGnssEvent.headingAccuracyDeg,
          sampleAgeMs: nowMs - this.lastGnssEvent.timestampMillis,
          timestampMillis: this.lastGnssEvent.timestampMillis,
        },
      },
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

  /**
   * Live wheelbase used for encoder differential odometry. Updated at the
   * end of a dead-reckoning calibration run so future encoder integrations
   * use the measured value without a session restart.
   */
  getWheelbaseMeters(): number {
    return this.wheelbaseMeters;
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

  /**
   * Phase-4 helper: select forward or reverse per-wheel m/tick based on the
   * sign of the summed encoder deltas. Falls back to the symmetric values
   * when per-direction calibration is absent (v1 file or never measured).
   */
  private selectEncoderCalibration(directionSign: 1 | -1): { leftMpt: number; rightMpt: number } {
    if (this.poseCalibration === null) {
      return { leftMpt: this.leftEncoderMetersPerTick, rightMpt: this.rightEncoderMetersPerTick };
    }
    if (directionSign > 0) {
      return {
        leftMpt: this.poseCalibration.getForwardLeftEncoderMetersPerTick(),
        rightMpt: this.poseCalibration.getForwardRightEncoderMetersPerTick(),
      };
    }
    return {
      leftMpt: this.poseCalibration.getReverseLeftEncoderMetersPerTick(),
      rightMpt: this.poseCalibration.getReverseRightEncoderMetersPerTick(),
    };
  }

  // ---------------------------------------------------------------------------
  // Motor feedback — DR position update (always active)
  // ---------------------------------------------------------------------------

  private onMotorFeedbackUpdate(event: MotorFeedbackUpdateEvent): void {
    if (!this.running) return;

    // Drive the GNSS staleness check from the motor poll cadence so getters
    // stay side-effect free.
    this.tickQualityStalenessCheck(this.sensorController.getCurrentTimeMillis?.() ?? Date.now());

    this.lastMotorFeedback = {
      leftEncoderDelta: event.leftEncoderDelta,
      rightEncoderDelta: event.rightEncoderDelta,
    };

    // Phase-4: pick per-direction encoder calibration when both forward and
    // reverse values are present in pose-calibration.json.  Sign of the
    // summed deltas decides which set applies for this sample.  When the
    // calibration is symmetric (the common case until a reverse straight
    // phase has run), the symmetric values are used.
    const directionSign = (event.leftEncoderDelta + event.rightEncoderDelta) >= 0 ? 1 : -1;
    const { leftMpt, rightMpt } = this.selectEncoderCalibration(directionSign);
    const dLeft  = event.leftEncoderDelta  * leftMpt;
    const dRight = event.rightEncoderDelta * rightMpt;
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

    this.emitPoseUpdate();
  }

  // ---------------------------------------------------------------------------
  // IMU heading update — heading is always the IMU value
  // ---------------------------------------------------------------------------

  private onImuHeadingUpdate(event: ImuHeadingUpdateEvent): void {
    if (!this.running) return;
    this.currentHeading = event.heading;
    this.emitPoseUpdate();
  }

  // ---------------------------------------------------------------------------
  // GNSS position update — validator-driven, no DR-based gating
  // ---------------------------------------------------------------------------

  private onGnssPositionUpdate(event: GnssPositionUpdateEvent): void {
    if (!this.running) return;
    this.lastGnssEvent = event;

    const validation = this.gnssValidator.validate(event, this.currentHeading);
    const nowMs = this.sensorController.getCurrentTimeMillis?.() ?? Date.now();

    if (validation.position === "TRUSTED") {
      // Position is trusted — snap fused pose to GNSS.  No blending against
      // DR, no agreement gate.  GNSS is the truth.
      const preSnapX = unwrapMeters(this.currentPosition.xMeters);
      const preSnapY = unwrapMeters(this.currentPosition.yMeters);
      this.lastGnssBlendSeparation = Math.hypot(event.xMeters - preSnapX, event.yMeters - preSnapY);
      this.lastGnssBlendFactor = 1.0;
      this.currentPosition = createPosition(event.xMeters, event.yMeters);
      if (!this.hasGnssPositionBaseline) {
        this.hasGnssPositionBaseline = true;
        this.logger.info("pose_fusion.gnss_position_anchored", {
          gnssX: event.xMeters,
          gnssY: event.yMeters,
        });
      }
      this.currentQuality = "gnss";
      this.lastGnssSyncTimeMs = nowMs;
      this.lastGnssAcceptedAtMs = nowMs;
      this.lastGnssRejectionReason = null;
      this.gnssQualityLostTimeMs = null;
      // Re-anchor the encoder-only track to the freshly-snapped fused
      // position on every TRUSTED-position update so that, when GNSS later
      // drops out and the system switches to dead-reckoning, the encoder
      // track is already starting from a known-good origin rather than from
      // wherever it had drifted to. Heading re-anchor still happens inside
      // applyGnssHeadingRebase whenever the heading itself is being
      // rebased; in between, encoder heading continues to integrate from
      // wheel differentials.
      this.encoderOnlyX = event.xMeters;
      this.encoderOnlyY = event.yMeters;
      if (this.encoderOnlyHeadingDeg === null) {
        this.encoderOnlyHeadingDeg = unwrapInternalHeading(this.currentHeading);
      }
    } else {
      // Validator rejected this sample.  Pose continues from IMU+encoder
      // integration.  Surface the most-recent rejection reason for the
      // diagnostic snapshot — the validator already logs promotion/demotion
      // events for the state machine itself.
      this.recordValidationRejection(validation, nowMs);
      if (this.currentQuality === "gnss" && this.gnssQualityLostTimeMs === null) {
        this.gnssQualityLostTimeMs = nowMs;
      }
    }

    const canBootstrapHeadingFromGnss =
      !this.hasGnssHeadingBaseline &&
      validation.position === "TRUSTED" &&
      event.heading !== null;

    const headingDisagreementDeg = event.heading === null
      ? null
      : Math.abs(unwrapRelativeAngle(headingDifference(this.currentHeading, event.heading)));
    const rebaseReadiness = this.sensorController.getHeadingRebaseReadiness();
    const canStationaryOverrideRebase =
      event.heading !== null &&
      validation.position === "TRUSTED" &&
      rebaseReadiness.safe &&
      headingDisagreementDeg !== null &&
      headingDisagreementDeg <= STATIONARY_HEADING_REBASE_OVERRIDE_MAX_DISAGREEMENT_DEG;

    if (canBootstrapHeadingFromGnss) {
      // Bootstrap: on first trusted GNSS epoch, seed IMU heading from GNSS so
      // later IMU-agreement checks don't deadlock due to initial offset.
      this.applyGnssHeadingRebase(event.heading, event.timestampMillis);
      this.isUsingGnssHeading = true;
    } else if (validation.heading === "TRUSTED" && event.heading !== null) {
      // Heading is trusted — rebase the IMU.  The validator already verified
      // |GNSS - IMU| ≤ disagreement threshold so this is a small step.
      this.applyGnssHeadingRebase(event.heading, event.timestampMillis);
      this.isUsingGnssHeading = true;
    } else if (canStationaryOverrideRebase) {
      // Throttle to one log per second; this branch fires per GNSS sample
      // (~20 Hz) while parked.
      if (this.lastStationaryOverrideLogAtMs === null || nowMs - this.lastStationaryOverrideLogAtMs >= 1000) {
        this.logger.info("pose_fusion.gnss_heading_rebase_stationary_override", {
          disagreementDeg: headingDisagreementDeg,
          maxOverrideDisagreementDeg: STATIONARY_HEADING_REBASE_OVERRIDE_MAX_DISAGREEMENT_DEG,
          leftEncoderDelta: rebaseReadiness.leftEncoderDelta,
          rightEncoderDelta: rebaseReadiness.rightEncoderDelta,
        });
        this.lastStationaryOverrideLogAtMs = nowMs;
      }
      this.applyGnssHeadingRebase(event.heading!, event.timestampMillis);
      this.isUsingGnssHeading = true;
    } else {
      this.isUsingGnssHeading = false;
      this.lastStationaryOverrideLogAtMs = null;
    }

    this.emitPoseUpdate(true);
  }

  private recordValidationRejection(validation: GnssValidationResult, nowMs: number): void {
    const reasons = validation.position === "TRUSTED"
      ? validation.headingRejections
      : validation.positionRejections;
    if (reasons.length === 0) return;

    // Use the first reason as the canonical "why" for the heartbeat snapshot.
    const reason = reasons[0];
    this.lastGnssRejectionReason = reason;
    this.lastGnssRejectionAtMs = nowMs;
    const lastLogged = this.lastGnssRejectionLogAtMs.get(reason);
    if (lastLogged === undefined || nowMs - lastLogged >= 1000) {
      this.logger.warn(`pose_fusion.gnss_rejected.${reason}`, {
        positionState: validation.position,
        headingState: validation.heading,
        positionRejections: validation.positionRejections,
        headingRejections: validation.headingRejections,
        gnssEvent: this.lastGnssEvent === null
          ? null
          : {
            xMeters: this.lastGnssEvent.xMeters,
            yMeters: this.lastGnssEvent.yMeters,
            fixType: this.lastGnssEvent.fixType,
            satellitesInUse: this.lastGnssEvent.satellitesInUse,
            positionAccuracyMeters: this.lastGnssEvent.positionAccuracyMeters,
            headingAccuracyDeg: this.lastGnssEvent.headingAccuracyDeg,
            headingDeg: this.lastGnssEvent.heading === null ? null : unwrapInternalHeading(this.lastGnssEvent.heading),
            sampleAgeMillis: this.lastGnssEvent.sampleAgeMillis,
            timestampMillis: this.lastGnssEvent.timestampMillis,
          },
        gnssRawSample: this.lastGnssEvent?.rawSample ?? null,
      });
      this.lastGnssRejectionLogAtMs.set(reason, nowMs);
    }
  }

  private applyGnssHeadingRebase(gnssHeading: InternalHeading, timestampMillis: number): void {
    void timestampMillis;
    // Pass null so the controller anchors integration on its monotonic clock —
    // immune to NTP wallclock steps mid-session.
    this.sensorController.setHeading(gnssHeading, null);
    this.currentHeading = gnssHeading;

    // Re-anchor encoder-only track to the freshly rebased heading and current
    // fused position.  This closes the previous DR segment cleanly and starts
    // a new one from a known-good origin, preventing unbounded drift.
    this.encoderOnlyX = unwrapMeters(this.currentPosition.xMeters);
    this.encoderOnlyY = unwrapMeters(this.currentPosition.yMeters);
    this.encoderOnlyHeadingDeg = unwrapInternalHeading(gnssHeading);
    this.drConfidence = Math.min(1, this.drConfidence + 0.5);

    if (!this.hasGnssHeadingBaseline) {
      this.hasGnssHeadingBaseline = true;
      this.logger.info("pose_fusion.gnss_heading_primed", {
        headingDeg: unwrapInternalHeading(gnssHeading),
      });
    }
  }
}
