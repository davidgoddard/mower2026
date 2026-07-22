/**
 * Drive controller - executes segment drives by turning to face the target and
 * then delegating the straight-line drive to DriveLineController.
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { TurnController } from "./turnController.js";
import { DriveLearningModel } from "./driveLearningModel.js";
import { DriveLineController } from "./driveLineController.js";
import { MotorCalibration } from "../config/motorCalibration.js";
import {
  InternalHeading,
  addRelativeAngle,
  createRelativeAngle,
  headingDifference,
  unwrapRelativeAngle,
  unwrapInternalHeading,
} from "../geometry/headingTypes.js";
import {
  Position,
  Pose,
  createPosition,
  createMeters,
  unwrapMeters,
  distanceBetween,
  angleTo,
} from "../geometry/positionTypes.js";
import {
  DriveRequest,
  DriveResult,
  DriveTrainingProgress,
  DriveTrainingProgressReporter,
  SegmentTrainingProgress,
  SegmentTrainingProgressReporter,
  SegmentTrainingResult,
  DriveControllerState,
  DriveStatus,
} from "./driveControllerTypes.js";
import {
  DRIVE_SETTLE_TIME_MS,
  DRIVE_INITIAL_TURN_THRESHOLD_DEG,
  DRIVE_HISTORY_MAX_SIZE,
  DRIVE_FULL_SPEED_COMMAND_DEFAULT,
  MOTOR_RAMP_DOWN_TIME_MS,
  DRIVE_SHORT_BUCKET_STEP_METERS,
  DRIVE_SHORT_BUCKET_MAX_METERS,
  DRIVE_SHORT_BUCKET_DISTANCES_METERS,
  DRIVE_LONG_SAMPLE_DISTANCES_METERS,
  DRIVE_SHORT_TARGET_X_ERROR_METERS,
  DRIVE_SHORT_TARGET_Y_ERROR_METERS,
  DRIVE_SEGMENT_MIN_DISTANCE_METERS,
  DRIVE_SEGMENT_MAX_DISTANCE_METERS,
  DRIVE_SEGMENT_STEP_METERS,
} from "../constants.js";
import { systemStop } from "./systemStop.js";
import { defaultSleep, sleepWithStopChecks } from "./sleep.js";

export interface DriveControllerOptions {
  sensorController: SensorController;
  poseFusion: PoseFusion;
  turnController: TurnController;
  logger: SessionLogger;
  learningModel: DriveLearningModel;
  lineDriveController?: DriveLineController;
  motorCalibration?: MotorCalibration;
  fullSpeedCommand?: number;
  settleTimeMs?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export class DriveController {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly poseFusion: PoseFusion;
  private readonly turnController: TurnController;
  private readonly learningModel: DriveLearningModel;
  private readonly lineDriveController: DriveLineController;
  private readonly motorCalibration: MotorCalibration | null;
  private readonly fullSpeedCommand: number;
  private readonly settleTimeMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private status: DriveStatus = "idle";
  private currentDrive: DriveRequest | null = null;
  private stopRequested = false;
  private shortTrainingProgress: DriveTrainingProgress | null = null;
  private shortTrainingProgressFeed: DriveTrainingProgress[] = [];
  private shortTrainingResults: DriveResult[] = [];
  private segmentTrainingProgress: SegmentTrainingProgress | null = null;
  private segmentTrainingProgressFeed: SegmentTrainingProgress[] = [];
  private segmentTrainingResults: SegmentTrainingResult[] = [];
  private driveHistory: DriveResult[] = [];
  private drivesCompleted = 0;
  private totalErrorXMeters = 0;
  private totalErrorYMeters = 0;

  private driveStartPosition: Position | null = null;
  private driveStartHeading: InternalHeading | null = null;
  private driveStartTime: number = 0;

  constructor(options: DriveControllerOptions) {
    this.logger = options.logger.child({ context: "control", source: "DriveController" });
    this.sensorController = options.sensorController;
    this.poseFusion = options.poseFusion;
    this.turnController = options.turnController;
    this.learningModel = options.learningModel;
    this.lineDriveController = options.lineDriveController ?? new DriveLineController({
      sensorController: this.sensorController,
      poseFusion: this.poseFusion,
      logger: options.logger,
      learningModel: this.learningModel,
      motorCalibration: options.motorCalibration,
      fullSpeedCommand: options.fullSpeedCommand,
      settleTimeMs: options.settleTimeMs,
      nowMillis: options.nowMillis,
      sleep: options.sleep,
    });
    this.motorCalibration = options.motorCalibration ?? null;
    this.fullSpeedCommand = options.fullSpeedCommand ?? DRIVE_FULL_SPEED_COMMAND_DEFAULT;
    this.settleTimeMs = options.settleTimeMs ?? DRIVE_SETTLE_TIME_MS;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Execute a segment drive maneuver.
   */
  async executeDrive(request: DriveRequest): Promise<DriveResult> {
    this.sensorController.beginMotionSession();
    return new Promise<DriveResult>(async (resolve) => {
      const preserveLearningState = this.status === "learning";
      try {
        this.stopRequested = false;
        systemStop.clearStop("drive-execute");
        if (!preserveLearningState) {
          this.shortTrainingProgress = null;
          this.segmentTrainingProgress = null;
          this.shortTrainingResults = [];
        }

        // 1. Get current pose
        this.currentDrive = request;
        this.driveStartTime = this.nowMillis();

        const startPose = this.poseFusion.getCurrentPose();
        this.driveStartPosition = startPose.position;
        this.driveStartHeading = startPose.heading;

        this.logger.info("drive.started", {
          startPosition: {
            x: unwrapMeters(this.driveStartPosition.xMeters),
            y: unwrapMeters(this.driveStartPosition.yMeters),
          },
          targetPosition: {
            x: unwrapMeters(request.targetPosition.xMeters),
            y: unwrapMeters(request.targetPosition.yMeters),
          },
          startHeading: unwrapInternalHeading(this.driveStartHeading),
        });

        // 2. Calculate angle to target. For reverse drives the mower's body should
        //    point 180° away from the target so its rear travels toward it along the
        //    line — useful when retracing recent targets after a grass jam without
        //    pivoting through the obstruction.
        const driveDirectionSign: 1 | -1 = request.driveDirectionSign ?? 1;
        const targetDistanceMeters = unwrapMeters(distanceBetween(
          this.driveStartPosition,
          request.targetPosition,
        ));
        const angleToTarget = angleTo(this.driveStartPosition, request.targetPosition);
        const desiredHeading: InternalHeading = driveDirectionSign === 1
          ? angleToTarget
          : addRelativeAngle(angleToTarget, createRelativeAngle(180));
        const headingError = headingDifference(this.driveStartHeading, desiredHeading);
        const headingErrorDeg = Math.abs(unwrapRelativeAngle(headingError));
        // Segment drives are deliberately turn-then-drive operations, including
        // short hops. Curved motion belongs to the continuous perimeter/path
        // follower; skipping a large alignment turn here can send a short drive
        // a long way in the wrong direction before position error converges.
        const shouldSkipInitialTurn = request.skipInitialTurn === true;

        if (shouldSkipInitialTurn) {
          this.logger.info("drive.initial_turn_skipped", {
            targetDistanceMeters,
            headingErrorDeg,
            driveDirectionSign,
          });
        }

        // 3. Turn to face the desired heading — always when alwaysTurnToFaceTarget
        //    is set (e.g. short boundary segments), otherwise only when error
        //    exceeds the threshold.
        if (!shouldSkipInitialTurn
          && (request.alwaysTurnToFaceTarget || headingErrorDeg > DRIVE_INITIAL_TURN_THRESHOLD_DEG)) {
          this.status = "turning";
          this.logger.info("drive.turning", {
            headingError: unwrapRelativeAngle(headingError),
            driveDirectionSign,
          });

          await this.turnController.executeTurn({
            targetAngle: headingError,
            direction: unwrapRelativeAngle(headingError) > 0 ? "ccw" : "cw",
            learningEnabled: true,
          });
        }

        // 4. Delegate straight-line driving immediately after the turn.
        this.status = "driving";
        const lineResult = await this.lineDriveController.executeLineDrive({
          targetPosition: request.targetPosition,
          learningEnabled: request.learningEnabled,
          driveDirectionSign,
          maxCrossTrackErrorMeters: request.maxCrossTrackErrorMeters,
          allowRotateToHeading: request.skipInitialTurn !== true,
        });

        if (lineResult.status === "success") {
          this.addToHistory(lineResult);
        }

        this.stopRequested = false;
        this.status = preserveLearningState ? "learning" : "idle";
        this.currentDrive = null;
        resolve(lineResult);
        return;
      } catch (error) {
        // Cleanup on error: status only. The line driver's own catch
        // brings the wheels to rest under the ramp profile; we do not
        // raise systemStop here because that would force a hard disable
        // which would slam the drivetrain.
        this.status = preserveLearningState ? "learning" : "idle";
        this.currentDrive = null;

        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("drive.error", { error: errorMessage });

        resolve({
          startPosition: this.driveStartPosition ?? createPosition(0, 0),
          targetPosition: request.targetPosition,
          finalPosition: this.driveStartPosition ?? createPosition(0, 0),
          errorX: createMeters(0),
          errorY: createMeters(0),
          maxCteMeters: createMeters(0),
          avgCteMeters: createMeters(0),
          durationMs: this.nowMillis() - this.driveStartTime,
          brakeDistanceUsed: createMeters(0),
          status: "error",
          errorMessage,
          timestamp: new Date().toISOString(),
        });
      }
      finally {
        this.sensorController.endMotionSession();
      }
    });
  }

  /**
   * Cancel the in-flight drive and bring the wheels to rest under the
   * deceleration profile.  This does NOT raise systemStop — the H-bridge
   * disable is reserved for the operator stop button, stall detection,
   * and other genuine emergencies.
   */
  async stopCurrentDrive(): Promise<void> {
    this.stopRequested = true;
    const turnController = this.turnController as unknown as {
      stopCurrentTurn?: () => Promise<void>;
    };
    if (typeof turnController.stopCurrentTurn === "function") {
      await turnController.stopCurrentTurn();
    }
    await this.lineDriveController.stopCurrentDrive();
  }

  /**
   * Drive a single segment to a target position. Used by the obstruction-recovery
   * path to retrace recently completed targets in reverse.
   */
  async driveSegment(target: { xMeters: number; yMeters: number }, driveDirectionSign: 1 | -1): Promise<DriveResult> {
    systemStop.clearStop("drive-segment-recovery");
    return this.executeDrive({
      targetPosition: createPosition(target.xMeters, target.yMeters),
      driveDirectionSign,
      alwaysTurnToFaceTarget: driveDirectionSign === 1,
      skipInitialTurn: driveDirectionSign === -1,
      learningEnabled: false,
    });
  }

  getCurrentPose(): Pose {
    return this.poseFusion.getCurrentPose();
  }

  /**
   * Drive in reverse for a fixed duration. Used by the path-context retry
   * fallback when no recent targets are available, to back the mower out of a
   * grass jam before the boundary follow restarts.
   */
  async reverseForDuration(durationMs: number): Promise<{
    readonly completed: boolean;
    readonly startPosition: Position;
    readonly finalPosition: Position;
  }> {
    systemStop.clearStop("drive-retry-reverse");
    const reverseSpeed = -this.fullSpeedCommand;
    const startPosition = this.poseFusion.getCurrentPose().position;
    let completed = false;
    this.sensorController.beginMotionSession();
    try {
      await this.sensorController.setMotorWheelOutputs(reverseSpeed, reverseSpeed);
      completed = await this.sleepWithStopChecks(durationMs);
      await this.sensorController.requestNeutralMotorOutputs();
      if (completed) {
        const rampDownTime = this.motorCalibration?.getRampDownTime() ?? MOTOR_RAMP_DOWN_TIME_MS;
        completed = await this.sleepWithStopChecks(2 * rampDownTime + this.settleTimeMs);
      }
    } finally {
      this.sensorController.endMotionSession();
    }
    return {
      completed,
      startPosition,
      finalPosition: this.poseFusion.getCurrentPose().position,
    };
  }

  /**
   * Run test pattern: collect waypoints by driving forward, then test random drives
   *
   * Pattern:
   * 1. Collect 7 waypoints by driving forward 2-3 seconds each
   * 2. Pick random non-nearest waypoint
   * 3. Drive to it and measure performance
   * 4. Repeat step 2-3 for multiple test drives
   */
  async runTestPattern(options?: { waypointCount?: number; testDrives?: number }): Promise<DriveResult[]> {
    const waypointCount = options?.waypointCount ?? 7;
    const testDriveCount = options?.testDrives ?? 5;
    const driveTimeMs = 2500; // 2.5 seconds per waypoint collection
    const results: DriveResult[] = [];

    this.shortTrainingProgress = null;
    this.stopRequested = false;

    this.logger.info("drive.test_pattern.started", {
      waypointCount,
      testDriveCount,
      phase: "collecting_waypoints"
    });

    this.sensorController.beginMotionSession();
    try {
      // Phase 1: Collect waypoints by driving forward
      const waypoints: Position[] = [];

    for (let i = 0; i < waypointCount; i++) {
      if (systemStop.isStopped()) {
        this.logger.warn("drive.test_pattern.stopped", { phase: "waypoint_collection", reason: "system_stop", waypoints: waypoints.length });
        return results;
      }
      if (this.stopRequested) {
        this.logger.warn("drive.test_pattern.stopped", { phase: "waypoint_collection", waypoints: waypoints.length });
        this.stopRequested = false;
        return results;
      }

      // Get current pose
      const currentPose = this.poseFusion.getCurrentPose();
      waypoints.push(currentPose.position);

      this.logger.info("drive.test_pattern.waypoint_collected", {
        waypoint: i + 1,
        position: {
          x: unwrapMeters(currentPose.position.xMeters),
          y: unwrapMeters(currentPose.position.yMeters),
        },
        heading: unwrapInternalHeading(currentPose.heading),
      });

      // Drive forward for 2-3 seconds (except on last waypoint)
      if (i < waypointCount - 1) {
        await this.sensorController.setMotorWheelOutputs(this.fullSpeedCommand, this.fullSpeedCommand);
        const driveCompleted = await this.sleepWithStopChecks(driveTimeMs);
        if (!driveCompleted || this.stopRequested || systemStop.isStopped()) {
          await this.sensorController.requestNeutralMotorOutputs();
          return results;
        }
        await this.sensorController.requestNeutralMotorOutputs();

        // Wait for motors to settle
        const rampDownTime = this.motorCalibration?.getRampDownTime() ?? MOTOR_RAMP_DOWN_TIME_MS;
        const settleCompleted = await this.sleepWithStopChecks(2 * rampDownTime + this.settleTimeMs);
        if (!settleCompleted || systemStop.isStopped()) {
          return results;
        }
      }
    }

    this.logger.info("drive.test_pattern.waypoints_complete", {
      totalWaypoints: waypoints.length,
      phase: "test_drives"
    });

    // Phase 2: Pick random waypoints and drive to them
    for (let testNum = 0; testNum < testDriveCount; testNum++) {
      if (systemStop.isStopped()) {
        this.logger.warn("drive.test_pattern.stopped", { phase: "test_drives", completed: results.length, reason: "system_stop" });
        return results;
      }
      if (this.stopRequested) {
        this.logger.warn("drive.test_pattern.stopped", {
          phase: "test_drives",
          completed: results.length
        });
        this.stopRequested = false;
        return results;
      }

      // Get current position
      const currentPose = this.poseFusion.getCurrentPose();
      const currentPos = currentPose.position;

      // Find waypoints that aren't the nearest (must be further than nearest + 1 meter)
      const waypointsWithDistance = waypoints.map(wp => ({
        position: wp,
        distance: distanceBetween(currentPos, wp),
      }));

      waypointsWithDistance.sort((a, b) => unwrapMeters(a.distance) - unwrapMeters(b.distance));

      // Filter out nearest waypoint and any within 1m of it
      const minDistance = unwrapMeters(waypointsWithDistance[0].distance) + 1.0;
      const eligibleWaypoints = waypointsWithDistance.filter(
        wp => unwrapMeters(wp.distance) > minDistance
      );

      if (eligibleWaypoints.length === 0) {
        this.logger.warn("drive.test_pattern.no_eligible_waypoints", { testNum: testNum + 1 });
        break;
      }

      // Pick random eligible waypoint
      const randomIndex = Math.floor(Math.random() * eligibleWaypoints.length);
      const targetWaypoint = eligibleWaypoints[randomIndex];

      this.logger.info("drive.test_pattern.test_drive_starting", {
        testNum: testNum + 1,
        of: testDriveCount,
        targetDistance: unwrapMeters(targetWaypoint.distance),
        eligibleWaypoints: eligibleWaypoints.length,
      });

      // Execute test drive
      const result = await this.executeDrive({
        targetPosition: targetWaypoint.position,
        learningEnabled: true,
      });

      results.push(result);

      // Small pause between test drives
      const pauseCompleted = await this.sleepWithStopChecks(1000);
      if (!pauseCompleted || systemStop.isStopped()) {
        return results;
      }
    }

      this.logger.info("drive.test_pattern.completed", {
        totalWaypoints: waypoints.length,
        testDrives: results.length
      });

      return results;
    } finally {
      this.sensorController.endMotionSession();
    }
  }

  /**
   * Run short-drive training across 10cm buckets up to 1m in both X directions.
   */
  async runShortDistanceTraining(options?: {
    targetXErrorMeters?: number;
    targetYErrorMeters?: number;
    includeReverseLegs?: boolean;
    startDistanceMeters?: number;
    maxDistanceMeters?: number;
  }): Promise<DriveResult[]> {
    const targetXErrorMeters = options?.targetXErrorMeters ?? DRIVE_SHORT_TARGET_X_ERROR_METERS;
    const targetYErrorMeters = options?.targetYErrorMeters ?? DRIVE_SHORT_TARGET_Y_ERROR_METERS;
    const includeReverseLegs = options?.includeReverseLegs ?? true;
    const startDistanceMeters = options?.startDistanceMeters;
    const maxDistanceMeters = options?.maxDistanceMeters;
    this.shortTrainingProgress = null;
    this.shortTrainingProgressFeed = [];
    this.shortTrainingResults = [];
    this.segmentTrainingProgress = null;
    this.segmentTrainingProgressFeed = [];
    this.segmentTrainingResults = [];
    this.stopRequested = false;
    const progressReporter: DriveTrainingProgressReporter = (progress) => {
      this.shortTrainingProgress = progress;
      this.shortTrainingProgressFeed = [progress, ...this.shortTrainingProgressFeed].slice(0, 12);
    };

    this.logger.info("drive.short_training.started", {
      stepMeters: DRIVE_SHORT_BUCKET_STEP_METERS,
      maxDistanceMeters: DRIVE_SHORT_BUCKET_MAX_METERS,
      targetXErrorMeters,
      includeReverseLegs,
    });

    this.sensorController.beginMotionSession();
    try {
      this.status = "learning";
      const results = await this.lineDriveController.runShortDistanceTraining({
        targetXErrorMeters,
        targetYErrorMeters,
        includeReverseLegs,
        startDistanceMeters,
        maxDistanceMeters,
        progressReporter,
      });

      for (const result of results) {
        this.shortTrainingResults.push(result);
        if (result.status === "success") {
          this.addToHistory(result);
        }
      }

      this.stopRequested = false;
      this.status = "idle";
      if (!this.shortTrainingProgress) {
        this.shortTrainingProgress = {
          mode: "short-distance",
          phase: "completed",
          distanceMeters: DRIVE_SHORT_BUCKET_MAX_METERS,
          pairAttempt: 0,
          legAttempt: 0,
          directionSign: null,
          targetXErrorMeters,
          completedDrives: results.length,
          totalPlannedDrives: (DRIVE_SHORT_BUCKET_DISTANCES_METERS.length + DRIVE_LONG_SAMPLE_DISTANCES_METERS.length) * (includeReverseLegs ? 2 : 1),
          message: `Short-distance training complete. Ran ${results.length} learning drive${results.length === 1 ? "" : "s"}.`,
          timestamp: new Date().toISOString(),
          resultStatus: "success",
        };
      }
      this.logger.info("drive.short_training.completed", { totalDrives: results.length });
      return results;
    } finally {
      this.sensorController.endMotionSession();
    }
  }

  async runLongHeadingTraining(options: {
    stage: "bias" | "gain";
    targetXErrorMeters?: number;
    targetYErrorMeters?: number;
    includeReverseLegs?: boolean;
    startDistanceMeters?: number;
    maxDistanceMeters?: number;
  }): Promise<DriveResult[]> {
    const targetXErrorMeters = options.targetXErrorMeters ?? DRIVE_SHORT_TARGET_X_ERROR_METERS;
    const targetYErrorMeters = options.targetYErrorMeters ?? DRIVE_SHORT_TARGET_Y_ERROR_METERS;
    const includeReverseLegs = options.includeReverseLegs ?? true;
    const startDistanceMeters = options.startDistanceMeters ?? DRIVE_LONG_SAMPLE_DISTANCES_METERS[0];
    const maxDistanceMeters = options.maxDistanceMeters ?? (DRIVE_LONG_SAMPLE_DISTANCES_METERS.at(-1) ?? DRIVE_LONG_SAMPLE_DISTANCES_METERS[0]);
    const distancePlan = [...DRIVE_LONG_SAMPLE_DISTANCES_METERS].filter(
      (distance) => distance >= startDistanceMeters - 1e-9 && distance <= maxDistanceMeters + 1e-9,
    );
    const effectiveDistancePlan = distancePlan.length > 0 ? distancePlan : [DRIVE_LONG_SAMPLE_DISTANCES_METERS[0]];
    const finalDistanceMeters = effectiveDistancePlan[effectiveDistancePlan.length - 1] ?? DRIVE_LONG_SAMPLE_DISTANCES_METERS[0];

    this.shortTrainingProgress = null;
    this.shortTrainingProgressFeed = [];
    this.shortTrainingResults = [];
    this.segmentTrainingProgress = null;
    this.segmentTrainingProgressFeed = [];
    this.segmentTrainingResults = [];
    this.stopRequested = false;
    const progressReporter: DriveTrainingProgressReporter = (progress) => {
      this.shortTrainingProgress = progress;
      this.shortTrainingProgressFeed = [progress, ...this.shortTrainingProgressFeed].slice(0, 12);
    };

    this.logger.info("drive.long_heading_training.started", {
      stage: options.stage,
      distancePlan: effectiveDistancePlan,
      targetXErrorMeters,
      targetYErrorMeters,
      includeReverseLegs,
    });

    this.sensorController.beginMotionSession();
    try {
      this.status = "learning";
      const results = await this.lineDriveController.runShortDistanceTraining({
        targetXErrorMeters,
        targetYErrorMeters,
        includeReverseLegs,
        progressReporter,
        distancePlan: effectiveDistancePlan,
        progressMode: options.stage === "bias" ? "long-heading-bias" : "long-heading-gain",
        runLabel: options.stage === "bias" ? "long heading bias" : "long heading gain",
        longHeadingLearningMode: options.stage === "bias" ? "bias-only" : "gain-only",
      });

      for (const result of results) {
        this.shortTrainingResults.push(result);
        if (result.status === "success") {
          this.addToHistory(result);
        }
      }

      this.stopRequested = false;
      this.status = "idle";
      if (!this.shortTrainingProgress) {
        this.shortTrainingProgress = {
          mode: options.stage === "bias" ? "long-heading-bias" : "long-heading-gain",
          phase: "completed",
          distanceMeters: finalDistanceMeters,
          pairAttempt: 0,
          legAttempt: 0,
          directionSign: null,
          targetXErrorMeters,
          completedDrives: results.length,
          totalPlannedDrives: effectiveDistancePlan.length * (includeReverseLegs ? 2 : 1),
          message: `Long heading ${options.stage} training complete. Ran ${results.length} learning drive${results.length === 1 ? "" : "s"}.`,
          timestamp: new Date().toISOString(),
          resultStatus: "success",
        };
      }
      this.logger.info("drive.long_heading_training.completed", {
        stage: options.stage,
        totalDrives: results.length,
      });
      return results;
    } finally {
      this.sensorController.endMotionSession();
    }
  }

  /**
   * Run segment-drive training across 105cm to 6m segments in 20cm steps.
   * The mower uses the current pose and heading at the start of the run to
   * define a fixed line, then trains forward/reverse segment pairs on that line.
   */
  async runSegmentTraining(options?: {
    targetXErrorMeters?: number;
    targetYErrorMeters?: number;
    includeReverseLegs?: boolean;
    progressReporter?: SegmentTrainingProgressReporter;
  }): Promise<SegmentTrainingResult[]> {
    const targetXErrorMeters = options?.targetXErrorMeters ?? DRIVE_SHORT_TARGET_X_ERROR_METERS;
    const targetYErrorMeters = options?.targetYErrorMeters ?? DRIVE_SHORT_TARGET_Y_ERROR_METERS;
    const includeReverseLegs = options?.includeReverseLegs ?? true;
    const externalProgressReporter = options?.progressReporter;
    const results: SegmentTrainingResult[] = [];
    const totalPlannedSegments = (Math.floor((DRIVE_SEGMENT_MAX_DISTANCE_METERS - DRIVE_SEGMENT_MIN_DISTANCE_METERS + 1e-9) / DRIVE_SEGMENT_STEP_METERS) + 1) * (includeReverseLegs ? 2 : 1);

    this.segmentTrainingProgress = null;
    this.segmentTrainingProgressFeed = [];
    this.segmentTrainingResults = [];
    this.shortTrainingProgress = null;
    this.shortTrainingProgressFeed = [];
    this.shortTrainingResults = [];
    this.stopRequested = false;
    systemStop.clearStop("drive-segment-training-start");

    const progressReporter: SegmentTrainingProgressReporter = (progress) => {
      this.segmentTrainingProgress = progress;
      this.segmentTrainingProgressFeed = [progress, ...this.segmentTrainingProgressFeed].slice(0, 12);
      externalProgressReporter?.(progress);
    };

    this.sensorController.beginMotionSession();
    try {
      this.status = "learning";

    const reportProgress = (
      phase: SegmentTrainingProgress["phase"],
      message: string,
      details: Partial<SegmentTrainingProgress> = {},
    ): void => {
      progressReporter?.({
        mode: "segment",
        phase,
        distanceMeters: details.distanceMeters ?? 0,
        pairAttempt: details.pairAttempt ?? 0,
        segmentAttempt: details.segmentAttempt ?? 0,
        directionSign: details.directionSign ?? null,
        targetXErrorMeters,
        completedSegments: details.completedSegments ?? results.length,
        totalPlannedSegments,
        message,
        timestamp: new Date().toISOString(),
        resultStatus: details.resultStatus ?? null,
        errorXMeters: details.errorXMeters ?? null,
        absErrorXMeters: details.absErrorXMeters ?? null,
      });
    };

    const segmentLineAnchorPose = this.poseFusion.getCurrentPose();
    const segmentLineAnchorPosition = segmentLineAnchorPose.position;
    const segmentLineHeadingDegrees = unwrapInternalHeading(segmentLineAnchorPose.heading);

    this.status = "learning";
    this.logger.info("drive.segment_training.started", {
      startPosition: {
        x: unwrapMeters(segmentLineAnchorPosition.xMeters),
        y: unwrapMeters(segmentLineAnchorPosition.yMeters),
      },
      startHeading: segmentLineHeadingDegrees,
      minDistanceMeters: DRIVE_SEGMENT_MIN_DISTANCE_METERS,
      maxDistanceMeters: DRIVE_SEGMENT_MAX_DISTANCE_METERS,
      stepMeters: DRIVE_SEGMENT_STEP_METERS,
      targetXErrorMeters,
      includeReverseLegs,
    });
    reportProgress(
      "started",
      `Starting segment training from ${Math.round(DRIVE_SEGMENT_MIN_DISTANCE_METERS * 100)} cm to ${Math.round(DRIVE_SEGMENT_MAX_DISTANCE_METERS * 100)} cm.`,
      {
        distanceMeters: DRIVE_SEGMENT_MIN_DISTANCE_METERS,
      },
    );

    for (let distanceMeters = DRIVE_SEGMENT_MIN_DISTANCE_METERS; distanceMeters <= DRIVE_SEGMENT_MAX_DISTANCE_METERS + 1e-9; distanceMeters += DRIVE_SEGMENT_STEP_METERS) {
      const directionSigns = includeReverseLegs ? ([1, -1] as const) : ([1] as const);
      let pairAttempt = 0;

      while (true) {
        if (systemStop.isStopped() || this.stopRequested) {
          this.logger.warn("drive.segment_training.stopped", {
            completed: results.length,
            distanceMeters,
            reason: systemStop.isStopped() ? "system_stop" : "stop_requested",
          });
          reportProgress("stopped", `Segment training stopped after ${results.length} run${results.length === 1 ? "" : "s"}.`, {
            distanceMeters,
            completedSegments: results.length,
          });
          this.stopRequested = false;
          this.status = "idle";
          return results;
        }

        pairAttempt += 1;
        this.logger.info("drive.segment_training.pair_attempt", {
          distanceMeters,
          pairAttempt,
          includeReverseLegs,
        });
        reportProgress(
          "pair_attempt",
          `Segment ${Math.round(distanceMeters * 100)} cm, pair attempt ${pairAttempt}.`,
          {
            distanceMeters,
            pairAttempt,
            completedSegments: results.length,
          },
        );

        let pairSucceeded = true;
        let segmentAttempt = 0;

        for (const directionSign of directionSigns) {
          segmentAttempt += 1;
          if (systemStop.isStopped() || this.stopRequested) {
            this.logger.warn("drive.segment_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
              reason: systemStop.isStopped() ? "system_stop" : "stop_requested",
            });
            reportProgress("stopped", `Segment training stopped after ${results.length} run${results.length === 1 ? "" : "s"}.`, {
              distanceMeters,
              pairAttempt,
              segmentAttempt,
              directionSign,
              completedSegments: results.length,
            });
            this.stopRequested = false;
            this.status = "idle";
            return results;
          }

          const targetPosition = this.createSegmentTrainingTargetPosition(
            segmentLineAnchorPosition,
            segmentLineHeadingDegrees,
            distanceMeters,
            directionSign,
          );

          this.logger.info("drive.segment_training.attempt", {
            distanceMeters,
            directionSign,
            pairAttempt,
            segmentAttempt,
            anchorPosition: {
              x: unwrapMeters(segmentLineAnchorPosition.xMeters),
              y: unwrapMeters(segmentLineAnchorPosition.yMeters),
              heading: segmentLineHeadingDegrees,
            },
            targetPosition: {
              x: unwrapMeters(targetPosition.xMeters),
              y: unwrapMeters(targetPosition.yMeters),
            },
          });
          reportProgress(
            "segment_attempt",
            `Segment ${Math.round(distanceMeters * 100)} cm, pair ${pairAttempt}, ${directionSign > 0 ? "forward" : "reverse"} segment running.`,
            {
              distanceMeters,
              pairAttempt,
              segmentAttempt,
              directionSign,
              completedSegments: results.length,
            },
          );

          const result = await this.executeDrive({
            targetPosition,
            learningEnabled: true,
          });

          const segmentResult: SegmentTrainingResult = {
            ...result,
            distanceMeters,
            directionSign,
            pairAttempt,
            segmentAttempt,
            anchorHeadingDeg: segmentLineHeadingDegrees,
          };
          results.push(segmentResult);
          this.segmentTrainingResults.push(segmentResult);

          if (result.status === "success") {
            this.addToHistory(result);
          }

          const absErrorX = Math.abs(unwrapMeters(result.errorX));
          const absErrorY = Math.abs(unwrapMeters(result.errorY));
          // Pass criterion: both axes within bound. Long drives have more
          // time to correct so the same 3 cm bound applies as for short.
          // See feedback memory [[feedback-drive-acceptance]].
          const segmentSucceeded = result.status === "success" &&
            absErrorX <= targetXErrorMeters &&
            absErrorY <= targetYErrorMeters;
          pairSucceeded = pairSucceeded && segmentSucceeded;
          this.logger.info("drive.segment_training.result", {
            distanceMeters,
            directionSign,
            pairAttempt,
            segmentAttempt,
            errorX: unwrapMeters(result.errorX),
            errorY: unwrapMeters(result.errorY),
            absErrorX,
            absErrorY,
            targetXErrorMeters,
            targetYErrorMeters,
            status: result.status,
            segmentSucceeded,
            pairSucceeded,
          });
          reportProgress(
            "segment_result",
            `Segment ${Math.round(distanceMeters * 100)} cm, pair ${pairAttempt}, ${directionSign > 0 ? "forward" : "reverse"} segment ${result.status}${Number.isFinite(absErrorX) && Number.isFinite(absErrorY) ? `, X ${Math.round(absErrorX * 100)} cm Y ${Math.round(absErrorY * 100)} cm` : ""}.`,
            {
              distanceMeters,
              pairAttempt,
              segmentAttempt,
              directionSign,
              completedSegments: results.length,
              resultStatus: result.status,
              errorXMeters: unwrapMeters(result.errorX),
              absErrorXMeters: absErrorX,
            },
          );

          if (result.status !== "success") {
            this.logger.warn("drive.segment_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
              reason: result.status,
            });
            reportProgress("stopped", `Segment training stopped after ${results.length} run${results.length === 1 ? "" : "s"} (${result.status}).`, {
              distanceMeters,
              pairAttempt,
              directionSign,
              completedSegments: results.length,
              resultStatus: result.status,
            });
            this.stopRequested = false;
            this.status = "idle";
            return results;
          }
        }

        if (pairSucceeded) {
          reportProgress(
            "completed",
            `Segment ${Math.round(distanceMeters * 100)} cm completed after pair attempt ${pairAttempt}.`,
            {
              distanceMeters,
              pairAttempt,
              completedSegments: results.length,
            },
          );
          break;
        }

        reportProgress(
          "pair_retry",
          `Segment ${Math.round(distanceMeters * 100)} cm pair attempt ${pairAttempt} missed target, retrying the forward/reverse pair.`,
          {
            distanceMeters,
            pairAttempt,
            completedSegments: results.length,
          },
        );
        const pauseCompleted = await this.sleepWithStopChecks(500);
        if (!pauseCompleted || this.stopRequested || systemStop.isStopped()) {
          this.logger.warn("drive.segment_training.stopped", {
            completed: results.length,
            distanceMeters,
            pairAttempt,
          });
          reportProgress("stopped", `Segment training stopped after ${results.length} run${results.length === 1 ? "" : "s"}.`, {
            distanceMeters,
            pairAttempt,
            completedSegments: results.length,
          });
          this.stopRequested = false;
          this.status = "idle";
          return results;
        }
      }
    }

    this.logger.info("drive.segment_training.completed", { totalRuns: results.length });
    reportProgress(
      "completed",
      `Segment training complete. Ran ${results.length} learning run${results.length === 1 ? "" : "s"}.`,
      {
        distanceMeters: DRIVE_SEGMENT_MAX_DISTANCE_METERS,
        completedSegments: results.length,
      },
    );
      this.status = "idle";
      this.stopRequested = false;
      return results;
    } finally {
      this.sensorController.endMotionSession();
    }
  }

  /**
   * Get current controller state
   */
  getState(): DriveControllerState {
    const lineState = this.lineDriveController.getState();
    return {
      status: this.status,
      currentDrive: this.currentDrive,
      drivesCompleted: this.drivesCompleted,
      averageErrorXMeters: this.drivesCompleted > 0 ? this.totalErrorXMeters / this.drivesCompleted : 0,
      averageErrorYMeters: this.drivesCompleted > 0 ? this.totalErrorYMeters / this.drivesCompleted : 0,
      shortTrainingProgress: this.shortTrainingProgress,
      shortTrainingProgressFeed: [...this.shortTrainingProgressFeed],
      shortTrainingResults: [...lineState.shortTrainingResults],
      segmentTrainingProgress: this.segmentTrainingProgress,
      segmentTrainingProgressFeed: [...this.segmentTrainingProgressFeed],
      segmentTrainingResults: [...this.segmentTrainingResults],
    };
  }

  /**
   * Get drive history
   */
  getDriveHistory(): DriveResult[] {
    return [...this.driveHistory];
  }

  /**
   * Clear drive history
   */
  clearHistory(): void {
    this.driveHistory = [];
    this.drivesCompleted = 0;
    this.totalErrorXMeters = 0;
    this.totalErrorYMeters = 0;
  }

  private createSegmentTrainingTargetPosition(
    anchorPosition: Position,
    anchorHeadingDegrees: number,
    distanceMeters: number,
    directionSign: 1 | -1,
  ): Position {
    const anchorHeadingRadians = (anchorHeadingDegrees * Math.PI) / 180;
    return createPosition(
      unwrapMeters(anchorPosition.xMeters) + (directionSign * distanceMeters * Math.cos(anchorHeadingRadians)),
      unwrapMeters(anchorPosition.yMeters) + (directionSign * distanceMeters * Math.sin(anchorHeadingRadians)),
    );
  }

  private sleepWithStopChecks(delayMs: number): Promise<boolean> {
    return sleepWithStopChecks(delayMs, () => this.stopRequested, this.sleep);
  }

  private addToHistory(result: DriveResult): void {
    this.driveHistory.push(result);
    if (this.driveHistory.length > DRIVE_HISTORY_MAX_SIZE) {
      this.driveHistory.shift();
    }
    this.drivesCompleted += 1;
    this.totalErrorXMeters += Math.abs(unwrapMeters(result.errorX));
    this.totalErrorYMeters += Math.abs(unwrapMeters(result.errorY));
  }
}
