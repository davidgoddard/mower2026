/**
 * Pose Fusion - Combines GNSS, IMU, and encoder feedback for best-estimate pose
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
import { ENCODER_METERS_PER_TICK_DEFAULT } from "../constants.js";
import { PoseCalibration } from "../config/poseCalibration.js";

const MAX_GNSS_POSITION_ACCURACY_METERS = 0.05;
const MAX_GNSS_HEADING_ACCURACY_DEGREES = 5;
const MAX_GNSS_IMU_ALIGNMENT_DEGREES = 3;
const GNSS_STATIONARY_REBASE_TIMEOUT_MS = 10_000;
const GNSS_OFFSET_REBASE_MIN_DURATION_MS = 1_500;
const GNSS_OFFSET_REBASE_MIN_SAMPLES = 6;
const GNSS_OFFSET_REBASE_MAX_SAMPLE_GAP_MS = 500;
const GNSS_OFFSET_REBASE_MAX_OFFSET_DRIFT_DEGREES = 4;
const GNSS_OFFSET_REBASE_MAX_DELTA_MISMATCH_DEGREES = 2.5;
const GNSS_OFFSET_REBASE_MIN_SIGNIFICANT_DELTA_DEGREES = 0.2;

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
}

export class PoseFusion extends EventEmitter {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly poseCalibration: PoseCalibration | null;

  private running = false;

  // Current pose estimate
  private currentPosition: Position = createPosition(0, 0);
  private currentHeading: InternalHeading = createInternalHeading(0);
  private currentQuality: "gnss" | "dead-reckoning" | "unknown" = "unknown";
  private hasGnssHeadingBaseline = false;
  private isUsingGnssHeading = false;

  // Encoder calibration
  private encoderMetersPerTick: number;

  // GNSS heading stability tracking
  private lastGnssHeading: InternalHeading | null = null;
  private lastGnssHeadingTime: number | null = null;

  // When GNSS and IMU track the same heading changes with a stable offset,
  // allow GNSS to re-anchor the IMU even if the absolute offset is still large.
  private offsetTrackingStartTime: number | null = null;
  private offsetTrackingSampleCount = 0;
  private offsetTrackingReferenceDeltaDeg: number | null = null;
  private offsetTrackingLastImuHeading: InternalHeading | null = null;
  private offsetTrackingLastGnssHeading: InternalHeading | null = null;
  private offsetTrackingLastTimestampMs: number | null = null;

  // Type-safe event subscription methods
  declare on: <K extends keyof PoseFusionEvents>(
    event: K,
    listener: (data: PoseFusionEvents[K]) => void
  ) => this;

  declare off: <K extends keyof PoseFusionEvents>(
    event: K,
    listener: (data: PoseFusionEvents[K]) => void
  ) => this;

  declare emit: <K extends keyof PoseFusionEvents>(
    event: K,
    data: PoseFusionEvents[K]
  ) => boolean;

  constructor(options: PoseFusionOptions) {
    super();
    this.logger = options.logger.child({ context: "sensing", source: "PoseFusion" });
    this.sensorController = options.sensorController;
    this.poseCalibration = options.poseCalibration ?? null;
    this.encoderMetersPerTick = options.poseCalibration?.getEncoderCalibration() ?? ENCODER_METERS_PER_TICK_DEFAULT;

    // Bind event handlers to maintain 'this' context
    this.onGnssPositionUpdate = this.onGnssPositionUpdate.bind(this);
    this.onImuHeadingUpdate = this.onImuHeadingUpdate.bind(this);
    this.onMotorFeedbackUpdate = this.onMotorFeedbackUpdate.bind(this);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info("pose_fusion.starting", {});

    // Subscribe to sensor events (not scoped - always running when started)
    this.sensorController.on(SENSOR_EVENTS.GNSS_POSITION_UPDATE, this.onGnssPositionUpdate);
    this.sensorController.on(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onImuHeadingUpdate);
    this.sensorController.on(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedbackUpdate);

    this.logger.info("pose_fusion.started", {});
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    // Unsubscribe from sensor events
    this.sensorController.off(SENSOR_EVENTS.GNSS_POSITION_UPDATE, this.onGnssPositionUpdate);
    this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onImuHeadingUpdate);
    this.sensorController.off(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedbackUpdate);

    this.logger.info("pose_fusion.stopped", {});
  }

  getCurrentPose(): Pose {
    return createPose(
      unwrapMeters(this.currentPosition.xMeters),
      unwrapMeters(this.currentPosition.yMeters),
      this.currentHeading,
      this.currentQuality
    );
  }

  getPrimitiveState(): PoseFusionPrimitiveState {
    const pose = this.getCurrentPose();
    return {
      status: this.running ? "ok" : "idle",
      error: null,
      xMeters: unwrapMeters(pose.position.xMeters),
      yMeters: unwrapMeters(pose.position.yMeters),
      headingDeg: unwrapInternalHeading(pose.heading),
      quality: pose.quality,
      speedMetersPerSecond: null,
      usingGnssHeading: this.isUsingGnssHeading,
    };
  }

  setPosition(position: Position): void {
    this.currentPosition = position;
    this.currentQuality = "unknown"; // User-set position, not from sensors
    this.logger.info("pose_fusion.position_set", {
      x: unwrapMeters(position.xMeters),
      y: unwrapMeters(position.yMeters),
    });
  }

  async setEncoderCalibration(metersPerTick: number): Promise<void> {
    this.encoderMetersPerTick = metersPerTick;
    if (this.poseCalibration) {
      this.poseCalibration.setEncoderCalibration(metersPerTick);
      await this.poseCalibration.saveParameters();
    }
    this.logger.info("pose_fusion.encoder_calibration_set", { metersPerTick });
  }

  getEncoderCalibration(): number {
    return this.encoderMetersPerTick;
  }

  private onGnssPositionUpdate(event: GnssPositionUpdateEvent): void {
    if (!this.running) {
      return;
    }

    // Check GNSS quality
    // The live GNSS protocol publishes `fixed` / `float` / `single` / `none`.
    // Keep a small compatibility window for older RTK-labelled fixtures too.
    const isGoodFix =
      event.fixType === "fixed" ||
      event.fixType === "float" ||
      event.fixType === "rtk-fixed" ||
      event.fixType === "rtk-float";
    const isGoodPositionAccuracy =
      event.positionAccuracyMeters !== null &&
      event.positionAccuracyMeters <= MAX_GNSS_POSITION_ACCURACY_METERS;
    const isGoodHeadingAccuracy =
      event.heading !== null &&
      event.headingAccuracyDeg !== null &&
      event.headingAccuracyDeg <= MAX_GNSS_HEADING_ACCURACY_DEGREES;

    // Position quality gates x/y updates.
    const canTrustPosition = isGoodFix && isGoodPositionAccuracy;
    const canTrustHeading = isGoodFix && isGoodHeadingAccuracy && event.heading !== null;

    if (canTrustPosition) {
      this.currentPosition = createPosition(event.xMeters, event.yMeters);
      this.currentQuality = "gnss";
    } else if (this.currentQuality === "gnss") {
      // Position quality has degraded, so keep the heading sync but fall back to
      // dead-reckoning until position quality recovers.
      this.currentQuality = "dead-reckoning";
      this.logger.warn("pose_fusion.gnss_quality_degraded", {
        fixType: event.fixType,
        positionAccuracyMeters: event.positionAccuracyMeters,
        headingAccuracyDeg: event.headingAccuracyDeg,
        hasHeading: event.heading !== null,
      });
    }

    // Heading quality is what lets us rebase the IMU.
    // We intentionally do not require the position accuracy gate here so a fresh
    // start can still pick up a trusted GNSS heading even if x/y accuracy is not
    // yet in the tighter range.
    this.isUsingGnssHeading = false;
    if (canTrustHeading) {
      this.updateHeadingFromGnss(event.heading, event.timestampMillis);
    }

    if (canTrustPosition || canTrustHeading) {
      this.emit("poseUpdate", this.getCurrentPose());
    }
  }

  private onImuHeadingUpdate(event: ImuHeadingUpdateEvent): void {
    if (!this.running) {
      return;
    }

    // IMU heading is maintained by SensorController
    // We just track it here for pose
    this.currentHeading = event.heading;

    // Emit pose update (even if position unchanged)
    this.emit("poseUpdate", this.getCurrentPose());
  }

  private onMotorFeedbackUpdate(event: MotorFeedbackUpdateEvent): void {
    if (!this.running) {
      return;
    }

    // Only use encoder feedback for dead-reckoning when GNSS quality poor
    if (this.currentQuality !== "dead-reckoning") {
      return;
    }

    // Calculate distance traveled from encoder deltas
    const leftDistance = event.leftEncoderDelta * this.encoderMetersPerTick;
    const rightDistance = event.rightEncoderDelta * this.encoderMetersPerTick;
    const avgDistance = (leftDistance + rightDistance) / 2;

    if (Math.abs(avgDistance) < 0.0001) {
      // No movement
      return;
    }

    // Update position using current heading
    const headingRad = (unwrapInternalHeading(this.currentHeading) * Math.PI) / 180;
    const dx = avgDistance * Math.cos(headingRad);
    const dy = avgDistance * Math.sin(headingRad);

    const newX = unwrapMeters(this.currentPosition.xMeters) + dx;
    const newY = unwrapMeters(this.currentPosition.yMeters) + dy;
    this.currentPosition = createPosition(newX, newY);

    // Emit pose update
    this.emit("poseUpdate", this.getCurrentPose());
  }

  private updateHeadingFromGnss(
    gnssHeading: InternalHeading,
    timestampMillis: number,
  ): void {
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

    // Check if GNSS heading itself is stable before using it as any kind of anchor.
    if (this.lastGnssHeading !== null && this.lastGnssHeadingTime !== null) {
      const timeDeltaMs = timestampMillis - this.lastGnssHeadingTime;
      if (timeDeltaMs > 0) {
        const headingChange = headingDifference(this.lastGnssHeading, gnssHeading);
        const headingChangeDeg = Math.abs(unwrapRelativeAngle(headingChange));
        const headingRateDegPerSec = (headingChangeDeg / timeDeltaMs) * 1000;

        if (headingRateDegPerSec > 30) {
          this.logger.warn("pose_fusion.gnss_heading_unstable", {
            headingChangeDeg,
            timeDeltaMs,
            rateDegPerSec: headingRateDegPerSec,
          });
          this.resetOffsetTracking();
          return;
        }
      }
    }

    const consistentOffset = this.updateOffsetTracking(gnssHeading, timestampMillis, alignmentDeltaDeg);

    if (alignmentDeltaDeg > MAX_GNSS_IMU_ALIGNMENT_DEGREES && !stationaryTimeoutReached && !consistentOffset.consistent) {
      this.logger.info("pose_fusion.gnss_heading_not_aligned", {
        alignmentDeltaDeg,
        currentHeadingDeg: unwrapInternalHeading(this.currentHeading),
        gnssHeadingDeg: unwrapInternalHeading(gnssHeading),
        stationaryZeroCommandAgeMs,
        consistentOffsetDurationMs: consistentOffset.durationMs,
        consistentOffsetSamples: consistentOffset.sampleCount,
      });
      this.isUsingGnssHeading = false;
      return;
    }

    const imuDiagnostics =
      this.sensorController.getLastImuMotionStopSummary?.() ??
      this.sensorController.getRecentImuDiagnosticSummary?.();

    if (alignmentDeltaDeg > MAX_GNSS_IMU_ALIGNMENT_DEGREES && stationaryTimeoutReached) {
      this.logger.info("pose_fusion.gnss_heading_rebased_after_stop", {
        alignmentDeltaDeg,
        currentHeadingDeg: unwrapInternalHeading(this.currentHeading),
        gnssHeadingDeg: unwrapInternalHeading(gnssHeading),
        stationaryZeroCommandAgeMs,
        imuDiagnostics,
      });
    }

    if (alignmentDeltaDeg > MAX_GNSS_IMU_ALIGNMENT_DEGREES && consistentOffset.consistent) {
      this.logger.info("pose_fusion.gnss_heading_rebased_after_consistent_offset", {
        alignmentDeltaDeg,
        currentHeadingDeg: unwrapInternalHeading(this.currentHeading),
        gnssHeadingDeg: unwrapInternalHeading(gnssHeading),
        consistentOffsetDurationMs: consistentOffset.durationMs,
        consistentOffsetSamples: consistentOffset.sampleCount,
        imuDiagnostics,
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

    const imuDeltaDeg = unwrapRelativeAngle(headingDifference(this.offsetTrackingLastImuHeading, this.currentHeading));
    const gnssDeltaDeg = unwrapRelativeAngle(headingDifference(this.offsetTrackingLastGnssHeading, gnssHeading));
    const absImuDeltaDeg = Math.abs(imuDeltaDeg);
    const absGnssDeltaDeg = Math.abs(gnssDeltaDeg);
    const bothNearlyStill =
      absImuDeltaDeg <= GNSS_OFFSET_REBASE_MIN_SIGNIFICANT_DELTA_DEGREES &&
      absGnssDeltaDeg <= GNSS_OFFSET_REBASE_MIN_SIGNIFICANT_DELTA_DEGREES;
    const sameTurnDirection = bothNearlyStill || Math.sign(imuDeltaDeg) === Math.sign(gnssDeltaDeg);
    const deltaMismatchDeg = Math.abs(absImuDeltaDeg - absGnssDeltaDeg);
    const offsetDriftDeg = Math.abs(alignmentDeltaDeg - this.offsetTrackingReferenceDeltaDeg);

    if (
      !sameTurnDirection ||
      deltaMismatchDeg > GNSS_OFFSET_REBASE_MAX_DELTA_MISMATCH_DEGREES ||
      offsetDriftDeg > GNSS_OFFSET_REBASE_MAX_OFFSET_DRIFT_DEGREES
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
