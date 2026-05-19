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
  Meters,
  createPosition,
  createPose,
  createMeters,
  unwrapMeters,
} from "../geometry/positionTypes.js";
import { ENCODER_METERS_PER_TICK_DEFAULT } from "../constants.js";
import { PoseCalibration } from "../config/poseCalibration.js";

export interface PoseFusionOptions {
  sensorController: SensorController;
  logger: SessionLogger;
  poseCalibration?: PoseCalibration;
}

export interface PoseFusionEvents {
  poseUpdate: Pose;
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

  // Encoder calibration
  private encoderMetersPerTick: number;

  // GNSS heading stability tracking
  private lastGnssHeading: InternalHeading | null = null;
  private lastGnssHeadingTime: number | null = null;

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
    const isGoodAccuracy = event.positionAccuracyMeters !== null && event.positionAccuracyMeters < 0.1;

    if (isGoodFix && isGoodAccuracy) {
      // Update position from GNSS
      this.currentPosition = createPosition(event.xMeters, event.yMeters);
      this.currentQuality = "gnss";

      // Update heading if available and stable
      if (event.heading !== null) {
        this.updateHeadingFromGnss(event.heading, event.timestampMillis);
      }

      // Emit pose update
      this.emit("poseUpdate", this.getCurrentPose());
    } else {
      // Poor quality - continue dead-reckoning
      if (this.currentQuality === "gnss") {
        this.currentQuality = "dead-reckoning";
        this.logger.warn("pose_fusion.gnss_quality_degraded", {
          fixType: event.fixType,
          accuracy: event.positionAccuracyMeters,
        });
      }
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

  private updateHeadingFromGnss(gnssHeading: InternalHeading, timestampMillis: number): void {
    // Check if heading is stable (not changing too fast)
    if (this.lastGnssHeading !== null && this.lastGnssHeadingTime !== null) {
      const timeDeltaMs = timestampMillis - this.lastGnssHeadingTime;
      if (timeDeltaMs > 0) {
        const headingChange = headingDifference(this.lastGnssHeading, gnssHeading);
        const headingChangeDeg = Math.abs(unwrapRelativeAngle(headingChange));
        const headingRateDegPerSec = (headingChangeDeg / timeDeltaMs) * 1000;

        // If heading changing faster than 30 deg/sec, it's probably noise/error
        if (headingRateDegPerSec > 30) {
          this.logger.warn("pose_fusion.gnss_heading_unstable", {
            headingChangeDeg,
            timeDeltaMs,
            rateDegPerSec: headingRateDegPerSec,
          });
          return;
        }
      }
    }

    // Heading is stable - update IMU base heading
    this.sensorController.setHeading(gnssHeading);
    this.currentHeading = gnssHeading;

    this.lastGnssHeading = gnssHeading;
    this.lastGnssHeadingTime = timestampMillis;

    this.logger.info("pose_fusion.heading_updated_from_gnss", {
      headingDeg: unwrapInternalHeading(gnssHeading),
    });
  }
}
