/**
 * Drive line controller - executes straight-line drives with regulated pure pursuit.
 *
 * This component assumes the mower is already aligned with the line of travel.
 * It is responsible only for following the line, braking, learning, and short
 * distance training. Forward and reverse line travel share the same geometric
 * line-following model while reverse motion uses the correct body-heading
 * reference. Short training samples a fresh pose/heading for each leg.
 * Segment orchestration is handled by DriveController.
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { DriveLearningModel } from "./driveLearningModel.js";
import { MotorCalibration } from "../config/motorCalibration.js";
import {
  Position,
  Pose,
  Meters,
  createPosition,
  createMeters,
  unwrapMeters,
  distanceBetween,
  crossTrackError,
  calculateXError,
  pointAlongLine,
} from "../geometry/positionTypes.js";
import {
  InternalHeading,
  createInternalHeading,
  headingDifference,
  unwrapInternalHeading,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
import {
  DriveRequest,
  DriveResult,
  DriveTrainingProgress,
  DriveTrainingProgressReporter,
  DriveControllerState,
  DriveStatus,
} from "./driveControllerTypes.js";
import {
  DRIVE_SETTLE_TIME_MS,
  DRIVE_TIMEOUT_MULTIPLIER,
  DRIVE_HISTORY_MAX_SIZE,
  DRIVE_FULL_SPEED_COMMAND_DEFAULT,
  MAX_WHEEL_SPEED_MPS_DEFAULT,
  DRIVE_WHEEL_BASE_METERS_DEFAULT,
  MOTOR_RAMP_DOWN_TIME_MS,
  DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
  DRIVE_SHORT_BUCKET_STEP_METERS,
  DRIVE_SHORT_BUCKET_MAX_METERS,
  DRIVE_SHORT_BUCKET_COARSE_STEP_METERS,
  DRIVE_SHORT_TARGET_X_ERROR_METERS,
  DRIVE_ARRIVAL_TOLERANCE_METERS,
  DRIVE_PURSUIT_TARGET_SPEED_SCALE,
  DRIVE_PURSUIT_BASE_LOOKAHEAD_METERS,
  DRIVE_PURSUIT_MIN_LOOKAHEAD_METERS,
  DRIVE_PURSUIT_MAX_LOOKAHEAD_METERS,
  DRIVE_PURSUIT_LOOKAHEAD_TIME_SECONDS,
  DRIVE_PURSUIT_APPROACH_SCALING_DISTANCE_METERS,
  DRIVE_PURSUIT_MIN_APPROACH_SPEED_SCALE,
  DRIVE_PURSUIT_CURVATURE_SPEED_GAIN,
  DRIVE_PURSUIT_MIN_CURVATURE_SPEED_SCALE,
  DRIVE_PURSUIT_ROTATE_TO_HEADING_MIN_ANGLE_DEG,
  DRIVE_PURSUIT_PIVOT_SPEED_SCALE,
  DRIVE_PURSUIT_TARGET_INFLUENCE_DISTANCE_METERS,
  MOTOR_MIN_ACTIVE_OUTPUT_PERCENT,
} from "../constants.js";
import { systemStop } from "./systemStop.js";
import { defaultSleep } from "./sleep.js";

export interface DriveLineRequest extends DriveRequest {
  readonly driveDirectionSign?: 1 | -1;
  readonly timeoutMinimumMs?: number;
  readonly disableTimeout?: boolean;
  readonly maxCrossTrackErrorMeters?: number;
}

export interface DriveLineControllerOptions {
  sensorController: SensorController;
  poseFusion: PoseFusion;
  logger: SessionLogger;
  learningModel: DriveLearningModel;
  motorCalibration?: MotorCalibration;
  fullSpeedCommand?: number;
  settleTimeMs?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export class DriveLineController {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly poseFusion: PoseFusion;
  private readonly learningModel: DriveLearningModel;
  private readonly motorCalibration: MotorCalibration | null;
  private readonly fullSpeedCommand: number;
  private readonly settleTimeMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private status: DriveStatus = "idle";
  private currentDrive: DriveLineRequest | null = null;
  private stopRequested = false;
  private driveHistory: DriveResult[] = [];
  private shortTrainingResults: DriveResult[] = [];
  private drivesCompleted = 0;
  private totalErrorXMeters = 0;
  private totalErrorYMeters = 0;

  private poseUpdateInFlight = false;
  private driveStartPosition: Position | null = null;
  private driveStartHeading: InternalHeading | null = null;
  private driveStartPoseQuality: "gnss" | "dead-reckoning" | "unknown" = "unknown";
  private driveTargetPosition: Position | null = null;
  private driveLineStart: Position | null = null;
  private driveLineEnd: Position | null = null;
  private driveStartTime = 0;
  private driveResolve: ((result: DriveResult) => void) | null = null;
  private cteSamples: Meters[] = [];
  private totalEncoderTicks = 0;
  private motorOperationActive = false;
  private driveDirectionSign: 1 | -1 = 1;
  private driveTimeoutMinimumMs = 0;
  private driveTimeoutDisabled = false;
  // Drive heartbeat — the per-drive diagnostic record.  Captures every
  // contributor to fused pose at ~5 Hz so the next failure can be diagnosed
  // from the log alone.
  private lastHeartbeatMs = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 200;

  constructor(options: DriveLineControllerOptions) {
    this.logger = options.logger.child({ context: "control", source: "DriveLineController" });
    this.sensorController = options.sensorController;
    this.poseFusion = options.poseFusion;
    this.learningModel = options.learningModel;
    this.motorCalibration = options.motorCalibration ?? null;
    this.fullSpeedCommand = options.fullSpeedCommand ?? DRIVE_FULL_SPEED_COMMAND_DEFAULT;
    this.settleTimeMs = options.settleTimeMs ?? DRIVE_SETTLE_TIME_MS;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;

    this.onPoseUpdate = this.onPoseUpdate.bind(this);
  }

  executeLineDrive(request: DriveLineRequest): Promise<DriveResult> {
    return new Promise<DriveResult>((resolve) => {
      this.driveResolve = resolve;
      this.startDriveAsync(request).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("drive.line.error", { error: errorMessage });
        const r = this.driveResolve;
        this.driveResolve = null;
        r?.({
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
      });
    });
  }

  private async startDriveAsync(request: DriveLineRequest): Promise<void> {
    let subscribed = false;
    try {
      this.stopRequested = false;
      systemStop.clearStop("drive-line-execute");
      this.beginMotorOperation();

      this.currentDrive = request;
      this.driveDirectionSign = request.driveDirectionSign ?? 1;
      this.driveTimeoutMinimumMs = request.timeoutMinimumMs ?? 0;
      this.driveTimeoutDisabled = request.disableTimeout ?? false;
      this.driveStartTime = this.nowMillis();
      this.cteSamples = [];
      this.totalEncoderTicks = 0;

      const startPose = this.poseFusion.getCurrentPose();
      this.driveStartPosition = startPose.position;
      this.driveStartHeading = startPose.heading;
      this.driveStartPoseQuality = startPose.quality;
      this.driveTargetPosition = request.targetPosition;

      // Calibration banner — captures the encoder/wheelbase values that this
      // drive will run with so a corrupted calibration is visible at a glance
      // alongside the failure event.  Plausibility flags pre-empt the
      // post-mortem question "was the wheelbase even sensible?"
      const calibrationDiag = this.poseFusion.getDiagnosticSnapshot().calibration;
      const wheelbasePlausible = calibrationDiag.wheelbaseMeters >= 0.20 && calibrationDiag.wheelbaseMeters <= 1.5;
      const leftMtPlausible = calibrationDiag.leftMetersPerTick >= 1e-5 && calibrationDiag.leftMetersPerTick <= 1e-2;
      const rightMtPlausible = calibrationDiag.rightMetersPerTick >= 1e-5 && calibrationDiag.rightMetersPerTick <= 1e-2;
      this.logger.info("drive.line.calibration_state", {
        leftMetersPerTick: calibrationDiag.leftMetersPerTick,
        rightMetersPerTick: calibrationDiag.rightMetersPerTick,
        wheelbaseMeters: calibrationDiag.wheelbaseMeters,
        plausible: wheelbasePlausible && leftMtPlausible && rightMtPlausible,
        wheelbasePlausible,
        leftMtPlausible,
        rightMtPlausible,
      });

      this.logger.info("drive.line.started", {
        startPosition: {
          x: unwrapMeters(this.driveStartPosition.xMeters),
          y: unwrapMeters(this.driveStartPosition.yMeters),
        },
        targetPosition: {
          x: unwrapMeters(request.targetPosition.xMeters),
          y: unwrapMeters(request.targetPosition.yMeters),
        },
        startHeading: unwrapInternalHeading(this.driveStartHeading),
        driveDirectionSign: this.driveDirectionSign,
      });
      this.lastHeartbeatMs = 0;

      this.driveLineStart = this.driveStartPosition;
      this.driveLineEnd = request.targetPosition;

      this.poseFusion.on("poseUpdate", this.onPoseUpdate);
      subscribed = true;

      this.status = "driving";
      const startSpeed = this.fullSpeedCommand * this.driveDirectionSign;
      await this.sensorController.setMotorWheelOutputs(startSpeed, startSpeed);

      this.logger.info("drive.line.driving", {
        startPosition: {
          x: unwrapMeters(this.driveStartPosition.xMeters),
          y: unwrapMeters(this.driveStartPosition.yMeters),
        },
        heading: unwrapInternalHeading(this.driveStartHeading),
        driveDirectionSign: this.driveDirectionSign,
      });
    } catch (error) {
      if (subscribed) {
        this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      }
      systemStop.requestStop("drive", "drive_line_error");
      try {
        await this.sensorController.stopMotors();
      } catch (stopError) {
        const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
        this.logger.warn("drive.line.stop_failed", { error: stopMessage });
      } finally {
        await this.endMotorOperation();
      }
      this.status = "idle";
      this.currentDrive = null;
      throw error;
    }
  }

  async runShortDistanceTraining(options?: {
    targetXErrorMeters?: number;
    includeReverseLegs?: boolean;
    startDistanceMeters?: number;
    maxDistanceMeters?: number;
    progressReporter?: DriveTrainingProgressReporter;
    pauseBeforeDriveMs?: number;
  }): Promise<DriveResult[]> {
    const targetXErrorMeters = options?.targetXErrorMeters ?? DRIVE_SHORT_TARGET_X_ERROR_METERS;
    const includeReverseLegs = options?.includeReverseLegs ?? true;
    const maxDistanceMeters = this.normalizeShortTrainingMaxDistanceMeters(options?.maxDistanceMeters ?? DRIVE_SHORT_BUCKET_MAX_METERS);
    const startDistanceMeters = this.normalizeShortTrainingStartDistanceMeters(options?.startDistanceMeters, maxDistanceMeters);
    const requestedPauseBeforeDriveMs = options?.pauseBeforeDriveMs;
    const pauseBeforeDriveMs = Number.isFinite(requestedPauseBeforeDriveMs)
      ? Math.max(0, requestedPauseBeforeDriveMs ?? 0)
      : 2000;
    const progressReporter = options?.progressReporter;
    const distancePlan = this.buildStraightLineTrainingDistances(startDistanceMeters, maxDistanceMeters);
    const results: DriveResult[] = [];
    const totalPlannedDrives = distancePlan.length * (includeReverseLegs ? 2 : 1);
    this.stopRequested = false;
    systemStop.clearStop("drive-short-training-start");
    this.shortTrainingResults = [];

    const reportProgress = (
      phase: DriveTrainingProgress["phase"],
      message: string,
      details: Partial<DriveTrainingProgress> = {},
    ): void => {
      progressReporter?.({
        mode: "short-distance",
        phase,
        distanceMeters: details.distanceMeters ?? 0,
        pairAttempt: details.pairAttempt ?? 0,
        legAttempt: details.legAttempt ?? 0,
        directionSign: details.directionSign ?? null,
        targetXErrorMeters,
        completedDrives: details.completedDrives ?? results.length,
        totalPlannedDrives,
        message,
        timestamp: new Date().toISOString(),
        resultStatus: details.resultStatus ?? null,
        errorXMeters: details.errorXMeters ?? null,
        absErrorXMeters: details.absErrorXMeters ?? null,
      });
    };

    this.logger.info("drive.line.short_training.started", {
      stepMeters: DRIVE_SHORT_BUCKET_STEP_METERS,
      defaultMaxDistanceMeters: DRIVE_SHORT_BUCKET_MAX_METERS,
      startDistanceMeters,
      requestedMaxDistanceMeters: maxDistanceMeters,
      targetXErrorMeters,
      includeReverseLegs,
    });
    reportProgress(
      "started",
      `Starting straight-line training from ${Math.round(startDistanceMeters * 100)} cm to ${Math.round(maxDistanceMeters * 100)} cm.`,
      {
        distanceMeters: startDistanceMeters,
      },
    );

    for (const distanceMeters of distancePlan) {
      const directionSigns = includeReverseLegs ? ([1, -1] as const) : ([1] as const);
      let pairAttempt = 0;
      const MAX_PAIR_ATTEMPTS = 10;

      while (pairAttempt < MAX_PAIR_ATTEMPTS) {
        if (systemStop.isStopped()) {
          this.logger.warn("drive.line.short_training.stopped", {
            completed: results.length,
            reason: "system_stop",
            distanceMeters,
          });
          reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
            distanceMeters,
            completedDrives: results.length,
          });
          return results;
        }
        if (this.stopRequested) {
          this.logger.warn("drive.line.short_training.stopped", {
            completed: results.length,
            distanceMeters,
          });
          this.stopRequested = false;
          reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
            distanceMeters,
            completedDrives: results.length,
          });
          return results;
        }

        pairAttempt += 1;
        this.logger.info("drive.line.short_training.pair_attempt", {
          distanceMeters,
          pairAttempt,
          includeReverseLegs,
        });
        reportProgress(
          "pair_attempt",
          `Distance ${Math.round(distanceMeters * 100)} cm, pair attempt ${pairAttempt}.`,
          {
            distanceMeters,
            pairAttempt,
            completedDrives: results.length,
          },
        );

        let pairSucceeded = true;
        let legAttempt = 0;

        for (const directionSign of directionSigns) {
          legAttempt += 1;
          if (systemStop.isStopped()) {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
              reason: "system_stop",
            });
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
              distanceMeters,
              pairAttempt,
              directionSign,
              completedDrives: results.length,
            });
            return results;
          }
          if (this.stopRequested) {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
            });
            this.stopRequested = false;
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
              distanceMeters,
              pairAttempt,
              directionSign,
              completedDrives: results.length,
            });
            return results;
          }

          const anchorPose = this.poseFusion.getCurrentPose();
          const anchorPosition = anchorPose.position;
          const anchorHeadingDegrees = unwrapInternalHeading(anchorPose.heading);
          const anchorHeadingRadians = (anchorHeadingDegrees * Math.PI) / 180;

          const targetPosition = createPosition(
            unwrapMeters(anchorPosition.xMeters) + (directionSign * distanceMeters * Math.cos(anchorHeadingRadians)),
            unwrapMeters(anchorPosition.yMeters) + (directionSign * distanceMeters * Math.sin(anchorHeadingRadians)),
          );

          this.logger.info("drive.line.short_training.attempt", {
            distanceMeters,
            directionSign,
            pairAttempt,
            anchorPosition: {
              x: unwrapMeters(anchorPosition.xMeters),
              y: unwrapMeters(anchorPosition.yMeters),
              heading: anchorHeadingDegrees,
            },
            targetPosition: {
              x: unwrapMeters(targetPosition.xMeters),
              y: unwrapMeters(targetPosition.yMeters),
            },
          });
          reportProgress(
            "leg_attempt",
            `Distance ${Math.round(distanceMeters * 100)} cm, pair ${pairAttempt}, ${directionSign > 0 ? "forward" : "reverse"} leg running.`,
            {
              distanceMeters,
              pairAttempt,
              legAttempt,
              directionSign,
              completedDrives: results.length,
            },
          );

          reportProgress(
            "waiting",
            `Pausing ${Math.round(pauseBeforeDriveMs / 1000)} seconds before the ${directionSign > 0 ? "forward" : "reverse"} leg starts.`,
            {
              distanceMeters,
              pairAttempt,
              legAttempt,
              directionSign,
              completedDrives: results.length,
            },
          );
          const pauseCompleted = await this.sleepWithStopChecks(pauseBeforeDriveMs);
          if (!pauseCompleted || this.stopRequested || systemStop.isStopped()) {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
              reason: "pause_interrupted",
            });
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
              distanceMeters,
              pairAttempt,
              directionSign,
              completedDrives: results.length,
            });
            return results;
          }

          const result = await this.executeLineDrive({
            targetPosition,
            learningEnabled: true,
            driveDirectionSign: directionSign,
            disableTimeout: true,
            maxCrossTrackErrorMeters: distanceMeters,
          });
          results.push(result);
          this.shortTrainingResults = [...results];

          const absErrorX = Math.abs(unwrapMeters(result.errorX));
          const legSucceeded = absErrorX <= targetXErrorMeters;
          pairSucceeded = pairSucceeded && legSucceeded;
          this.logger.info("drive.line.short_training.result", {
            distanceMeters,
            directionSign,
            pairAttempt,
            errorX: unwrapMeters(result.errorX),
            absErrorX,
            targetXErrorMeters,
            status: result.status,
            legSucceeded,
            pairSucceeded,
          });
          reportProgress(
            "leg_result",
            `Distance ${Math.round(distanceMeters * 100)} cm, pair ${pairAttempt}, ${directionSign > 0 ? "forward" : "reverse"} leg ${result.status}${Number.isFinite(absErrorX) ? `, error ${Math.round(absErrorX * 100)} cm` : ""}.`,
            {
              distanceMeters,
              pairAttempt,
              legAttempt,
              directionSign,
              completedDrives: results.length,
              resultStatus: result.status,
              errorXMeters: unwrapMeters(result.errorX),
              absErrorXMeters: absErrorX,
            },
          );

          if (result.status !== "success") {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
              reason: result.status,
            });
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"} (${result.status}).`, {
              distanceMeters,
              pairAttempt,
              directionSign,
              completedDrives: results.length,
              resultStatus: result.status,
            });
            return results;
          }
        }

        if (pairSucceeded) {
          reportProgress(
            "completed",
            `Distance ${Math.round(distanceMeters * 100)} cm completed after pair attempt ${pairAttempt}.`,
            {
              distanceMeters,
              pairAttempt,
              completedDrives: results.length,
            },
          );
          break;
        }

        if (pairAttempt >= MAX_PAIR_ATTEMPTS) {
          this.logger.warn("drive.line.short_training.max_attempts_reached", {
            distanceMeters, pairAttempt,
          });
          reportProgress(
            "completed",
            `Distance ${Math.round(distanceMeters * 100)} cm reached max ${MAX_PAIR_ATTEMPTS} attempts, moving on.`,
            { distanceMeters, pairAttempt, completedDrives: results.length },
          );
          break;
        }

        reportProgress(
          "pair_retry",
          `Distance ${Math.round(distanceMeters * 100)} cm pair attempt ${pairAttempt} missed target, retrying the forward/reverse pair.`,
          {
            distanceMeters,
            pairAttempt,
            completedDrives: results.length,
          },
        );
        const pauseCompleted = await this.sleepWithStopChecks(500);
        if (!pauseCompleted || this.stopRequested || systemStop.isStopped()) {
          this.logger.warn("drive.line.short_training.stopped", {
            completed: results.length,
            distanceMeters,
            pairAttempt,
          });
          reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
            distanceMeters,
            pairAttempt,
            completedDrives: results.length,
          });
          return results;
        }
      }
    }

    this.logger.info("drive.line.short_training.completed", { totalDrives: results.length });
    reportProgress(
      "completed",
      `Straight-line training complete. Ran ${results.length} learning drive${results.length === 1 ? "" : "s"}.`,
      {
        distanceMeters: DRIVE_SHORT_BUCKET_MAX_METERS,
        completedDrives: results.length,
      },
    );
    return results;
  }

  async stopCurrentDrive(): Promise<void> {
    if (this.currentDrive) {
      this.stopRequested = true;
      systemStop.requestStop("drive", "drive_stop_requested");
    }
  }

  getState(): DriveControllerState {
    return {
      status: this.status,
      currentDrive: this.currentDrive,
      drivesCompleted: this.drivesCompleted,
      averageErrorXMeters: this.drivesCompleted > 0 ? this.totalErrorXMeters / this.drivesCompleted : 0,
      averageErrorYMeters: this.drivesCompleted > 0 ? this.totalErrorYMeters / this.drivesCompleted : 0,
      shortTrainingProgress: null,
      shortTrainingProgressFeed: [],
      shortTrainingResults: [...this.shortTrainingResults],
      segmentTrainingProgress: null,
      segmentTrainingProgressFeed: [],
      segmentTrainingResults: [],
    };
  }

  getDriveHistory(): DriveResult[] {
    return [...this.driveHistory];
  }

  clearHistory(): void {
    this.driveHistory = [];
    this.drivesCompleted = 0;
    this.totalErrorXMeters = 0;
    this.totalErrorYMeters = 0;
  }

  private async onPoseUpdate(pose: Pose): Promise<void> {
    if (this.poseUpdateInFlight) return;
    if (
      this.status !== "driving" ||
      this.driveStartPosition === null ||
      this.driveTargetPosition === null ||
      this.driveLineStart === null ||
      this.driveLineEnd === null
    ) {
      return;
    }
    this.poseUpdateInFlight = true;
    try {
      await this.onPoseUpdateInner(pose);
    } finally {
      this.poseUpdateInFlight = false;
    }
  }

  private async onPoseUpdateInner(pose: Pose): Promise<void> {
    if (
      this.status !== "driving" ||
      this.driveStartPosition === null ||
      this.driveTargetPosition === null ||
      this.driveLineStart === null ||
      this.driveLineEnd === null
    ) {
      return;
    }

    if (this.stopRequested) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      try {
        await this.sensorController.stopMotors();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("drive.line.stop_failed", { error: message });
      } finally {
        await this.endMotorOperation();
      }
      this.status = "stopped";
      const stoppedDrive = this.currentDrive;
      this.currentDrive = null;
      this.stopRequested = false;
      this.logger.warn("drive.line.stopped", { durationMs: this.nowMillis() - this.driveStartTime });
      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition: pose.position,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs: this.nowMillis() - this.driveStartTime,
        brakeDistanceUsed: this.getBrakeDistanceForCurrentDrive(),
        status: "stopped",
        errorMessage: "Drive stopped by user request",
        timestamp: new Date().toISOString(),
      });
      this.driveResolve = null;
      return;
    }

    if (systemStop.isStopped()) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      try {
        await this.sensorController.stopMotors();
      } finally {
        await this.endMotorOperation();
      }
      this.status = "stopped";
      this.currentDrive = null;
      this.logger.warn("drive.line.stopped", { durationMs: this.nowMillis() - this.driveStartTime, reason: "system_stop" });
      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition: pose.position,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs: this.nowMillis() - this.driveStartTime,
        brakeDistanceUsed: this.getBrakeDistanceForCurrentDrive(),
        status: "stopped",
        errorMessage: "Drive stopped by system stop",
        timestamp: new Date().toISOString(),
      });
      this.stopRequested = false;
      this.driveResolve = null;
      return;
    }

    const currentPosition = pose.position;
    const cte = crossTrackError(currentPosition, this.driveLineStart, this.driveLineEnd);
    this.cteSamples.push(cte);

    this.emitHeartbeatIfDue(pose, cte);

    const maxCrossTrackErrorMeters = this.currentDrive?.maxCrossTrackErrorMeters;
    if (
      maxCrossTrackErrorMeters !== undefined &&
      Math.abs(unwrapMeters(cte)) > maxCrossTrackErrorMeters
    ) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      await this.finishStoppedDrive("Cross-track error exceeded limit");
      return;
    }

    const targetDistance = unwrapMeters(distanceBetween(this.driveLineStart, this.driveLineEnd));
    const projectedAlongTrackDistance = this.projectAlongTrackDistance(currentPosition);
    const remainingAlongTrackDistance = Math.max(0, targetDistance - projectedAlongTrackDistance);
    await this.applyRegulatedPurePursuitControl(pose, remainingAlongTrackDistance);

    // Arrival is the hard stop condition. Braking only helps if there is still
    // enough distance left before the target to make it worthwhile.
    if (remainingAlongTrackDistance <= DRIVE_ARRIVAL_TOLERANCE_METERS) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      await this.completeDrive();
      return;
    }

    const brakeDistance = this.getBrakeDistanceForCurrentDrive();
    if (
      targetDistance > 0 &&
      unwrapMeters(brakeDistance) > 0 &&
      unwrapMeters(brakeDistance) < targetDistance &&
      remainingAlongTrackDistance <= unwrapMeters(brakeDistance)
    ) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      await this.completeDrive();
      return;
    }

    if (!this.driveTimeoutDisabled && this.nowMillis() - this.driveStartTime > this.calculateTimeout()) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      try {
        await this.sensorController.stopMotors();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("drive.line.stop_failed", { error: message });
      } finally {
        await this.endMotorOperation();
      }
      systemStop.requestStop("drive", "drive_timeout");
      this.status = "idle";
      const finalPosition = pose.position;
      const errorX = calculateXError(finalPosition, this.driveLineStart, this.driveLineEnd);
      const errorY = crossTrackError(finalPosition, this.driveLineStart, this.driveLineEnd);
      this.logger.error("drive.line.timeout", {
        durationMs: this.nowMillis() - this.driveStartTime,
      });
      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition,
        errorX,
        errorY,
        maxCteMeters: this.calculateMaxCte(),
        avgCteMeters: this.calculateAvgCte(),
        durationMs: this.nowMillis() - this.driveStartTime,
        brakeDistanceUsed: brakeDistance,
        status: "timeout",
        errorMessage: "Drive execution timeout",
        timestamp: new Date().toISOString(),
      });
      this.currentDrive = null;
      this.driveResolve = null;
      return;
    }
  }

  private normalizeShortTrainingStartDistanceMeters(startDistanceMeters?: number, maxDistanceMeters = DRIVE_SHORT_BUCKET_MAX_METERS): number {
    const requestedDistance = Number.isFinite(startDistanceMeters) ? (startDistanceMeters as number) : DRIVE_SHORT_BUCKET_STEP_METERS;
    const upperBound = Math.max(DRIVE_SHORT_BUCKET_MAX_METERS, maxDistanceMeters);
    const clampedDistance = Math.max(
      DRIVE_SHORT_BUCKET_STEP_METERS,
      Math.min(upperBound, requestedDistance),
    );
    const alignedDistance = Math.ceil((clampedDistance - 1e-9) / DRIVE_SHORT_BUCKET_STEP_METERS) * DRIVE_SHORT_BUCKET_STEP_METERS;
    return Number(Math.max(
      DRIVE_SHORT_BUCKET_STEP_METERS,
      Math.min(upperBound, alignedDistance),
    ).toFixed(2));
  }

  private normalizeShortTrainingMaxDistanceMeters(maxDistanceMeters?: number, startDistanceMeters = DRIVE_SHORT_BUCKET_STEP_METERS): number {
    const requestedDistance = Number.isFinite(maxDistanceMeters) ? (maxDistanceMeters as number) : DRIVE_SHORT_BUCKET_MAX_METERS;
    const minimumDistance = Math.max(startDistanceMeters, DRIVE_SHORT_BUCKET_STEP_METERS);
    const clampedDistance = Math.max(minimumDistance, requestedDistance);
    return Number(clampedDistance.toFixed(2));
  }

  private buildStraightLineTrainingDistances(startDistanceMeters = DRIVE_SHORT_BUCKET_STEP_METERS, maxDistanceMeters = DRIVE_SHORT_BUCKET_MAX_METERS): number[] {
    const distances: number[] = [];
    const start = Math.max(DRIVE_SHORT_BUCKET_STEP_METERS, startDistanceMeters);
    const max = Math.max(start, maxDistanceMeters);

    for (let distance = start; distance <= max + 1e-9; ) {
      distances.push(Number(distance.toFixed(2)));
      const step = distance <= DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS + 1e-9
        ? DRIVE_SHORT_BUCKET_STEP_METERS
        : DRIVE_SHORT_BUCKET_COARSE_STEP_METERS;
      distance = Number((distance + step).toFixed(2));
    }

    return distances;
  }

  private async applyRegulatedPurePursuitControl(
    pose: Pose,
    remainingAlongTrackDistance: number,
  ): Promise<void> {
    if (this.driveLineStart === null || this.driveLineEnd === null) {
      await this.sensorController.setMotorWheelOutputs(0, 0);
      return;
    }

    const totalDistance = unwrapMeters(distanceBetween(this.driveLineStart, this.driveLineEnd));
    if (totalDistance <= 1e-6) {
      await this.sensorController.setMotorWheelOutputs(0, 0);
      return;
    }

    const lineHeading = this.getDriveLineHeading();
    const controlHeading = this.driveDirectionSign > 0
      ? pose.heading
      : createInternalHeading(unwrapInternalHeading(pose.heading) + 180);
    const headingErrorDeg = Math.abs(unwrapRelativeAngle(headingDifference(controlHeading, lineHeading)));
    const ignoreTargetEndpoint = remainingAlongTrackDistance <= DRIVE_PURSUIT_TARGET_INFLUENCE_DISTANCE_METERS;

    if (headingErrorDeg >= DRIVE_PURSUIT_ROTATE_TO_HEADING_MIN_ANGLE_DEG && remainingAlongTrackDistance > DRIVE_PURSUIT_TARGET_INFLUENCE_DISTANCE_METERS) {
      const turnSign = unwrapRelativeAngle(headingDifference(controlHeading, lineHeading)) >= 0 ? 1 : -1;
      const { leftCommand, rightCommand } = this.calculatePivotCommands(turnSign, false);
      await this.sensorController.setMotorWheelOutputs(leftCommand, rightCommand);
      return;
    }

    const projectedAlongTrackDistance = this.projectAlongTrackDistance(pose.position);
    const lookaheadDistance = this.calculateLookaheadDistance(remainingAlongTrackDistance, ignoreTargetEndpoint);
    const lookaheadAlongTrackDistance = ignoreTargetEndpoint
      ? Math.max(0, projectedAlongTrackDistance + lookaheadDistance)
      : Math.max(
          0,
          Math.min(totalDistance, projectedAlongTrackDistance + lookaheadDistance),
        );
    const lookaheadPoint = pointAlongLine(
      this.driveLineStart,
      this.driveLineEnd,
      createMeters(lookaheadAlongTrackDistance),
    );
    const lookaheadFrame = this.toRobotFrame(pose.position, lookaheadPoint, controlHeading);
    const lookaheadDistanceMeters = Math.hypot(lookaheadFrame.x, lookaheadFrame.y);

    if (!Number.isFinite(lookaheadDistanceMeters) || lookaheadDistanceMeters < 1e-6) {
      await this.sensorController.setMotorWheelOutputs(0, 0);
      return;
    }

    const curvature = (2 * lookaheadFrame.y) / (lookaheadDistanceMeters * lookaheadDistanceMeters);
    const targetLinearSpeedMps = this.calculateTargetLinearSpeedMps(remainingAlongTrackDistance, curvature);
    const signedLinearSpeedMps = targetLinearSpeedMps * this.driveDirectionSign;
    const angularSpeedRadPerSec = targetLinearSpeedMps * curvature;
    const leftWheelSpeedMps = signedLinearSpeedMps - (angularSpeedRadPerSec * DRIVE_WHEEL_BASE_METERS_DEFAULT / 2);
    const rightWheelSpeedMps = signedLinearSpeedMps + (angularSpeedRadPerSec * DRIVE_WHEEL_BASE_METERS_DEFAULT / 2);

    const leftCommand = this.clampNormalizedSpeed(leftWheelSpeedMps / MAX_WHEEL_SPEED_MPS_DEFAULT);
    const rightCommand = this.clampNormalizedSpeed(rightWheelSpeedMps / MAX_WHEEL_SPEED_MPS_DEFAULT);
    const normalizedCommands = this.enforceMinimumActiveArcCommands(
      leftCommand,
      rightCommand,
      curvature,
    );

    await this.sensorController.setMotorWheelOutputs(
      normalizedCommands.leftCommand,
      normalizedCommands.rightCommand,
    );
  }

  private getDriveLineHeading(): InternalHeading {
    if (this.driveLineStart === null || this.driveLineEnd === null) {
      return createInternalHeading(0);
    }

    const dx = unwrapMeters(this.driveLineEnd.xMeters) - unwrapMeters(this.driveLineStart.xMeters);
    const dy = unwrapMeters(this.driveLineEnd.yMeters) - unwrapMeters(this.driveLineStart.yMeters);

    return createInternalHeading((Math.atan2(dy, dx) * 180) / Math.PI);
  }

  /**
   * Emit a per-drive diagnostic heartbeat at HEARTBEAT_INTERVAL_MS cadence.
   * Captures the contributions of every sensor source so a failed drive can
   * be diagnosed from the log alone — see redesign notes in CLAUDE.md.
   */
  private emitHeartbeatIfDue(pose: Pose, cte: Meters): void {
    const now = this.nowMillis();
    if (now - this.lastHeartbeatMs < DriveLineController.HEARTBEAT_INTERVAL_MS) {
      return;
    }
    this.lastHeartbeatMs = now;

    const diag = this.poseFusion.getDiagnosticSnapshot();
    this.logger.info("drive.line.heartbeat", {
      tSinceStartMs: now - this.driveStartTime,
      cteMeters: unwrapMeters(cte),
      fused: {
        x: diag.fused.x,
        y: diag.fused.y,
        headingDeg: diag.fused.headingDeg,
        quality: diag.fused.quality,
        usingGnssHeading: diag.fused.usingGnssHeading,
      },
      encoder: {
        onlyX: diag.encoder.onlyX,
        onlyY: diag.encoder.onlyY,
        onlyHeadingDeg: diag.encoder.onlyHeadingDeg,
        drConfidence: diag.encoder.drConfidence,
        encoderSynced: diag.encoder.encoderSynced,
        wheelSlipSuspected: diag.encoder.wheelSlipSuspected,
        lastLeftDelta: diag.encoder.lastLeftDelta,
        lastRightDelta: diag.encoder.lastRightDelta,
      },
      gnss: {
        gnssToFusedSeparationMeters: diag.gnss.gnssToFusedSeparationMeters,
        lastAcceptedAgoMs: diag.gnss.lastAcceptedAgoMs,
        lastRejectionReason: diag.gnss.lastRejectionReason,
        lastRejectionAgoMs: diag.gnss.lastRejectionAgoMs,
        lastBlendFactor: diag.gnss.lastBlendFactor,
        raw: diag.gnss.raw,
      },
    });
  }

  private projectAlongTrackDistance(position: Position): number {
    if (this.driveLineStart === null || this.driveLineEnd === null) {
      return 0;
    }

    const totalDistance = unwrapMeters(distanceBetween(this.driveLineStart, this.driveLineEnd));
    if (totalDistance <= 1e-6) {
      return 0;
    }

    const lineDx = (unwrapMeters(this.driveLineEnd.xMeters) - unwrapMeters(this.driveLineStart.xMeters)) / totalDistance;
    const lineDy = (unwrapMeters(this.driveLineEnd.yMeters) - unwrapMeters(this.driveLineStart.yMeters)) / totalDistance;
    const dx = unwrapMeters(position.xMeters) - unwrapMeters(this.driveLineStart.xMeters);
    const dy = unwrapMeters(position.yMeters) - unwrapMeters(this.driveLineStart.yMeters);
    return dx * lineDx + dy * lineDy;
  }

  private calculateLookaheadDistance(remainingAlongTrackDistance: number, ignoreTargetEndpoint = false): number {
    const targetSpeedMps = MAX_WHEEL_SPEED_MPS_DEFAULT * this.fullSpeedCommand * DRIVE_PURSUIT_TARGET_SPEED_SCALE;
    const dynamicLookahead = DRIVE_PURSUIT_BASE_LOOKAHEAD_METERS +
      (targetSpeedMps * DRIVE_PURSUIT_LOOKAHEAD_TIME_SECONDS);
    const clampedLookahead = Math.max(
      DRIVE_PURSUIT_MIN_LOOKAHEAD_METERS,
      Math.min(DRIVE_PURSUIT_MAX_LOOKAHEAD_METERS, dynamicLookahead),
    );

    if (ignoreTargetEndpoint) {
      return clampedLookahead;
    }

    if (remainingAlongTrackDistance <= DRIVE_ARRIVAL_TOLERANCE_METERS) {
      return DRIVE_ARRIVAL_TOLERANCE_METERS;
    }

    return Math.min(clampedLookahead, Math.max(DRIVE_ARRIVAL_TOLERANCE_METERS, remainingAlongTrackDistance));
  }

  private calculateTargetLinearSpeedMps(remainingAlongTrackDistance: number, curvature: number): number {
    const nominalTargetSpeedMps = MAX_WHEEL_SPEED_MPS_DEFAULT * this.fullSpeedCommand * DRIVE_PURSUIT_TARGET_SPEED_SCALE;
    const approachScale = this.clamp(
      remainingAlongTrackDistance / DRIVE_PURSUIT_APPROACH_SCALING_DISTANCE_METERS,
      DRIVE_PURSUIT_MIN_APPROACH_SPEED_SCALE,
      1,
    );
    const curvatureScale = this.clamp(
      1 / (1 + (Math.abs(curvature) * DRIVE_PURSUIT_CURVATURE_SPEED_GAIN)),
      DRIVE_PURSUIT_MIN_CURVATURE_SPEED_SCALE,
      1,
    );
    return nominalTargetSpeedMps * approachScale * curvatureScale;
  }

  private toRobotFrame(
    currentPosition: Position,
    targetPosition: Position,
    heading: InternalHeading,
  ): { x: number; y: number } {
    const dx = unwrapMeters(targetPosition.xMeters) - unwrapMeters(currentPosition.xMeters);
    const dy = unwrapMeters(targetPosition.yMeters) - unwrapMeters(currentPosition.yMeters);
    const theta = (unwrapInternalHeading(heading) * Math.PI) / 180;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);

    return {
      x: (dx * cosTheta) + (dy * sinTheta),
      y: (-dx * sinTheta) + (dy * cosTheta),
    };
  }

  private clampNormalizedSpeed(speed: number): number {
    return this.clamp(speed, -this.fullSpeedCommand, this.fullSpeedCommand);
  }

  private enforceMinimumActiveArcCommands(
    leftCommand: number,
    rightCommand: number,
    curvature: number,
  ): { leftCommand: number; rightCommand: number } {
    if (leftCommand === 0 && rightCommand === 0) {
      return { leftCommand: 0, rightCommand: 0 };
    }

    const leftSign = Math.sign(leftCommand);
    const rightSign = Math.sign(rightCommand);
    if (leftSign === 0 || rightSign === 0 || leftSign !== rightSign) {
      const turnSign = curvature >= 0 ? 1 : -1;
      return this.calculatePivotCommands(turnSign, true);
    }

    return {
      leftCommand: this.applyMinimumActiveCommand(leftCommand),
      rightCommand: this.applyMinimumActiveCommand(rightCommand),
    };
  }

  private calculatePivotCommands(
    turnSign: 1 | -1,
    followTravelDirection: boolean,
  ): { leftCommand: number; rightCommand: number } {
    const pivotSpeed = Math.max(
      MOTOR_MIN_ACTIVE_OUTPUT_PERCENT,
      this.fullSpeedCommand * DRIVE_PURSUIT_PIVOT_SPEED_SCALE,
    );
    const directionSign = followTravelDirection ? this.driveDirectionSign : 1;

    return {
      leftCommand: this.clampNormalizedSpeed(-turnSign * pivotSpeed * directionSign),
      rightCommand: this.clampNormalizedSpeed(turnSign * pivotSpeed * directionSign),
    };
  }

  private applyMinimumActiveCommand(command: number): number {
    if (command === 0 || Math.abs(command) >= MOTOR_MIN_ACTIVE_OUTPUT_PERCENT) {
      return command;
    }

    return Math.sign(command) * MOTOR_MIN_ACTIVE_OUTPUT_PERCENT;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private async completeDrive(): Promise<void> {
    if (
      this.driveStartPosition === null ||
      this.driveTargetPosition === null ||
      this.driveLineStart === null ||
      this.driveLineEnd === null
    ) {
      return;
    }

    try {
      this.status = "braking";
      await this.sensorController.stopMotors();

      this.logger.info("drive.line.braking", {
        driveDirectionSign: this.driveDirectionSign,
      });

      const rampDownTime = this.motorCalibration?.getRampDownTime() ?? MOTOR_RAMP_DOWN_TIME_MS;
      const rampDownCompleted = await this.sleepWithStopChecks(2 * rampDownTime);
      if (!rampDownCompleted || this.stopRequested || systemStop.isStopped()) {
        await this.finishStoppedDrive("Drive stopped during ramp-down");
        return;
      }

      this.status = "settling";
      const settleCompleted = await this.sleepWithStopChecks(this.settleTimeMs);
      if (!settleCompleted || this.stopRequested || systemStop.isStopped()) {
        await this.finishStoppedDrive("Drive stopped during settle");
        return;
      }

      this.status = "measuring";
      const finalPose = this.poseFusion.getCurrentPose();
      const finalPosition = finalPose.position;

      const errorX = calculateXError(finalPosition, this.driveLineStart, this.driveLineEnd);
      const errorY = crossTrackError(finalPosition, this.driveLineStart, this.driveLineEnd);
      const maxCte = this.calculateMaxCte();
      const avgCte = this.calculateAvgCte();
      const brakeDistance = this.getBrakeDistanceForCurrentDrive();

      this.logger.info("drive.line.completed", {
        startPosition: {
          x: unwrapMeters(this.driveStartPosition.xMeters),
          y: unwrapMeters(this.driveStartPosition.yMeters),
        },
        targetPosition: {
          x: unwrapMeters(this.driveTargetPosition.xMeters),
          y: unwrapMeters(this.driveTargetPosition.yMeters),
        },
        finalPosition: {
          x: unwrapMeters(finalPosition.xMeters),
          y: unwrapMeters(finalPosition.yMeters),
        },
        errorX: unwrapMeters(errorX),
        errorY: unwrapMeters(errorY),
        maxCte: unwrapMeters(maxCte),
        avgCte: unwrapMeters(avgCte),
        durationMs: this.nowMillis() - this.driveStartTime,
        driveDirectionSign: this.driveDirectionSign,
      });

      if (this.currentDrive?.learningEnabled !== false) {
        this.status = "learning";
        await this.learningModel.updateFromDrive({
          startPosition: this.driveStartPosition,
          targetPosition: this.driveTargetPosition,
          finalPosition,
          driveDirectionSign: this.driveDirectionSign,
          errorX,
          errorY,
          maxCte,
          avgCte,
          brakeDistanceUsed: brakeDistance,
        });

        // Only calibrate when both poses are GNSS-quality and the drive was
        // substantially straight (avg CTE < 3 cm), so encoder ticks reflect
        // path length ≈ displacement and we don't underestimate metersPerTick.
        const avgCteForCalibration = unwrapMeters(avgCte);
        if (
          this.driveStartPoseQuality === "gnss" &&
          finalPose.quality === "gnss" &&
          Math.abs(avgCteForCalibration) < 0.03
        ) {
          const actualDistance = distanceBetween(this.driveStartPosition, finalPosition);
          if (this.totalEncoderTicks > 0) {
            const measuredMetersPerTick = unwrapMeters(actualDistance) / this.totalEncoderTicks;
            const currentCalibration = this.poseFusion.getEncoderCalibration();
            const newCalibration = 0.9 * currentCalibration + 0.1 * measuredMetersPerTick;
            await this.poseFusion.setEncoderCalibration(newCalibration);
            this.logger.info("drive.line.encoder_calibrated", {
              actualDistance: unwrapMeters(actualDistance),
              encoderTicks: this.totalEncoderTicks,
              avgCteMeters: avgCteForCalibration,
              newCalibration,
            });
          }
        }
      }

      this.status = "idle";
      this.currentDrive = null;
      await this.endMotorOperation();

      const result: DriveResult = {
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition,
        errorX,
        errorY,
        maxCteMeters: maxCte,
        avgCteMeters: avgCte,
        durationMs: this.nowMillis() - this.driveStartTime,
        brakeDistanceUsed: brakeDistance,
        status: "success",
        timestamp: new Date().toISOString(),
      };

      this.addToHistory(result);
      this.driveResolve?.(result);
      this.driveResolve = null;
    } catch (error) {
      this.status = "idle";
      this.currentDrive = null;
      systemStop.requestStop("drive", "drive_completion_error");
      await this.endMotorOperation();

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("drive.line.completion_error", { error: errorMessage });

      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition: this.driveStartPosition,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs: this.nowMillis() - this.driveStartTime,
        brakeDistanceUsed: this.getBrakeDistanceForCurrentDrive(),
        status: "error",
        errorMessage,
        timestamp: new Date().toISOString(),
      });
      this.driveResolve = null;
    }
  }

  private async finishStoppedDrive(errorMessage: string): Promise<void> {
    const stoppedDrive = this.currentDrive ?? {
      targetPosition: this.driveTargetPosition ?? createPosition(0, 0),
      learningEnabled: true,
      driveDirectionSign: this.driveDirectionSign,
    };
    const finalPose = this.poseFusion.getCurrentPose();
    const finalPosition = finalPose.position;
    this.status = "stopped";
    this.currentDrive = null;
    this.stopRequested = false;
    systemStop.requestStop("drive", errorMessage);
    try {
      await this.sensorController.stopMotors();
    } finally {
      await this.endMotorOperation();
    }
    this.logger.warn("drive.line.stopped", {
      durationMs: this.nowMillis() - this.driveStartTime,
      reason: errorMessage,
      currentDrive: stoppedDrive,
    });
    this.driveResolve?.({
      startPosition: this.driveStartPosition ?? createPosition(0, 0),
      targetPosition: stoppedDrive.targetPosition,
      finalPosition,
      errorX: createMeters(0),
      errorY: createMeters(0),
      maxCteMeters: createMeters(0),
      avgCteMeters: createMeters(0),
      durationMs: this.nowMillis() - this.driveStartTime,
      brakeDistanceUsed: this.getBrakeDistanceForCurrentDrive(),
      status: "stopped",
      errorMessage,
      timestamp: new Date().toISOString(),
    });
    this.driveResolve = null;
  }

  private calculateTimeout(): number {
    if (this.driveStartPosition === null || this.driveTargetPosition === null) {
      return 60000;
    }

    const distance = unwrapMeters(distanceBetween(this.driveStartPosition, this.driveTargetPosition));
    const nominalSpeedMps = MAX_WHEEL_SPEED_MPS_DEFAULT * this.fullSpeedCommand * DRIVE_PURSUIT_TARGET_SPEED_SCALE;
    const estimatedDurationMs = (distance / Math.max(nominalSpeedMps, 1e-6)) * 1000;
    return Math.max(estimatedDurationMs * DRIVE_TIMEOUT_MULTIPLIER, this.driveTimeoutMinimumMs);
  }

  private calculateMaxCte(): Meters {
    if (this.cteSamples.length === 0) {
      return createMeters(0);
    }
    return this.cteSamples.reduce((max, cte) =>
      Math.abs(unwrapMeters(cte)) > Math.abs(unwrapMeters(max)) ? cte : max,
      createMeters(0)
    );
  }

  private calculateAvgCte(): Meters {
    if (this.cteSamples.length === 0) {
      return createMeters(0);
    }
    const sum = this.cteSamples.reduce((sum, cte) => sum + Math.abs(unwrapMeters(cte)), 0);
    return createMeters(sum / this.cteSamples.length);
  }

  private addToHistory(result: DriveResult): void {
    this.driveHistory.push(result);
    if (this.driveHistory.length > DRIVE_HISTORY_MAX_SIZE) {
      this.driveHistory.shift();
    }
    this.drivesCompleted++;
    this.totalErrorXMeters += Math.abs(unwrapMeters(result.errorX));
    this.totalErrorYMeters += Math.abs(unwrapMeters(result.errorY));
  }

  private async sleepWithStopChecks(delayMs: number): Promise<boolean> {
    let remainingMs = delayMs;

    while (remainingMs > 0) {
      if (this.stopRequested || systemStop.isStopped()) {
        return false;
      }

      const chunkMs = Math.min(50, remainingMs);
      await this.sleep(chunkMs);
      remainingMs -= chunkMs;
    }

    return true;
  }

  private getBrakeDistanceForCurrentDrive(): Meters {
    if (this.driveStartPosition === null || this.driveTargetPosition === null) {
      return createMeters(this.learningModel.getParameters().longDriveBrakeDistanceMeters ?? 0);
    }

    return this.learningModel.getBrakeDistanceForDrive(
      this.driveStartPosition,
      this.driveTargetPosition,
      this.driveDirectionSign,
    );
  }

  private beginMotorOperation(): void {
    if (this.motorOperationActive) return;
    this.motorOperationActive = true;
    this.sensorController.beginMotorOperation();
  }

  private async endMotorOperation(): Promise<void> {
    if (!this.motorOperationActive) return;
    this.motorOperationActive = false;
    await this.sensorController.endMotorOperation();
  }
}
