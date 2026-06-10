/**
 * Drive line controller - executes straight-line drives at full power.
 *
 * This component assumes the mower is already aligned with the line of travel.
 * It runs the wheels at full forward (or full reverse) power and applies a
 * proportional left/right wheel-trim to keep cross-track error small; the
 * trim is the only deviation from full power. The drive ends at the brake
 * trigger learned by the drive learning model. There are no curved paths,
 * no pure pursuit, and no concept of m/s in this controller — keeping motor
 * load high is required because the cutting blade and drive are mechanically
 * coupled and slow speeds can stall the mower.
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
  DRIVE_HISTORY_MAX_SIZE,
  DRIVE_FULL_SPEED_COMMAND_DEFAULT,
  MOTOR_RAMP_DOWN_TIME_MS,
  DRIVE_SHORT_BUCKET_STEP_METERS,
  DRIVE_SHORT_BUCKET_MAX_METERS,
  DRIVE_SHORT_BUCKET_DISTANCES_METERS,
  DRIVE_LONG_SAMPLE_DISTANCES_METERS,
  DRIVE_SHORT_TARGET_X_ERROR_METERS,
  DRIVE_ARRIVAL_TOLERANCE_METERS,
  DRIVE_STEERING_ROTATE_TO_HEADING_MIN_ANGLE_DEG,
  DRIVE_STEERING_PIVOT_OUTPUT_PERCENT,
  DRIVE_STEERING_TARGET_INFLUENCE_DISTANCE_METERS,
  DRIVE_STEERING_MAX_TRIM_PERCENT,
  MOTOR_MIN_ACTIVE_OUTPUT_PERCENT,
} from "../constants.js";
import { systemStop } from "./systemStop.js";
import { defaultSleep } from "./sleep.js";

export interface DriveLineRequest extends DriveRequest {
  readonly driveDirectionSign?: 1 | -1;
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
  private brakeDecisionPoseQuality: "gnss" | "dead-reckoning" | "unknown" = "unknown";
  private driveTargetPosition: Position | null = null;
  private driveLineStart: Position | null = null;
  private driveLineEnd: Position | null = null;
  private driveStartTime = 0;
  private driveResolve: ((result: DriveResult) => void) | null = null;
  private cteSamples: Meters[] = [];
  private totalEncoderTicks = 0;
  private driveDirectionSign: 1 | -1 = 1;
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
          learnApplied: false,
          learnSkipReason: "drive_error",
        });
      });
    });
  }

  private async startDriveAsync(request: DriveLineRequest): Promise<void> {
    let subscribed = false;
    try {
      this.stopRequested = false;
      systemStop.clearStop("drive-line-execute");
      this.currentDrive = request;
      this.driveDirectionSign = request.driveDirectionSign ?? 1;
      this.driveStartTime = this.nowMillis();
      this.cteSamples = [];
      this.totalEncoderTicks = 0;
      this.brakeDecisionPoseQuality = "unknown";

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
      const initialRemainingAlongTrackDistance = unwrapMeters(
        distanceBetween(this.driveLineStart, this.driveLineEnd),
      );
      await this.applyStraightLineControl(startPose, initialRemainingAlongTrackDistance);

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
      try {
        await this.sensorController.stopMotors();
      } catch (stopError) {
        const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
        this.logger.warn("drive.line.stop_failed", { error: stopMessage });
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
    this.sensorController.beginMotionSession();
    try {
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

          const result = await this.executeLineDrive({
            targetPosition,
            learningEnabled: true,
            driveDirectionSign: directionSign,
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
    } finally {
      this.sensorController.endMotionSession();
    }
  }

  async stopCurrentDrive(): Promise<void> {
    this.stopRequested = true;
    this.poseFusion.off("poseUpdate", this.onPoseUpdate);
    if (this.currentDrive !== null && this.driveResolve !== null) {
      await this.finishStoppedDrive("Drive stopped by user request");
      return;
    }
    // No drive in flight — just bring the wheels to rest under the ramp
    // profile. The genuine emergency-stop path (operator stop button,
    // stall detection) raises systemStop separately and disables drive
    // there.
    await this.sensorController.stopMotors();
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
        // User-initiated mid-drive stop: bring the wheels to rest under
        // the deceleration profile. Only the emergency-stop path disables
        // drive.
        await this.sensorController.stopMotors();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("drive.line.stop_failed", { error: message });
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
        learnApplied: false,
        learnSkipReason: "drive_stopped",
      });
      this.driveResolve = null;
      return;
    }

    if (systemStop.isStopped()) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      // systemStop is latched: the sensor loop is already re-asserting
      // the H-bridge disable on every tick. We just need to terminate the
      // in-flight drive promise. No motor command needed here.
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
        learnApplied: false,
        learnSkipReason: "drive_stopped",
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
    await this.applyStraightLineControl(pose, remainingAlongTrackDistance);

    // Arrival is the hard stop condition. Braking only helps if there is still
    // enough distance left before the target to make it worthwhile.
    if (remainingAlongTrackDistance <= DRIVE_ARRIVAL_TOLERANCE_METERS) {
      this.brakeDecisionPoseQuality = pose.quality;
      this.logger.info("drive.line.brake_trigger", {
        reason: "arrival_tolerance",
        elapsedMs: this.nowMillis() - this.driveStartTime,
        remainingAlongTrackMeters: remainingAlongTrackDistance,
        targetDistanceMeters: targetDistance,
        arrivalToleranceMeters: DRIVE_ARRIVAL_TOLERANCE_METERS,
        fusedX: unwrapMeters(pose.position.xMeters),
        fusedY: unwrapMeters(pose.position.yMeters),
        fusedHeadingDeg: unwrapInternalHeading(pose.heading),
      });
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
      this.brakeDecisionPoseQuality = pose.quality;
      this.logger.info("drive.line.brake_trigger", {
        reason: "brake_distance",
        elapsedMs: this.nowMillis() - this.driveStartTime,
        remainingAlongTrackMeters: remainingAlongTrackDistance,
        targetDistanceMeters: targetDistance,
        brakeDistanceMeters: unwrapMeters(brakeDistance),
        fusedX: unwrapMeters(pose.position.xMeters),
        fusedY: unwrapMeters(pose.position.yMeters),
        fusedHeadingDeg: unwrapInternalHeading(pose.heading),
      });
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      await this.completeDrive();
      return;
    }

  }

  private normalizeShortTrainingStartDistanceMeters(startDistanceMeters?: number, maxDistanceMeters = DRIVE_SHORT_BUCKET_MAX_METERS): number {
    const availableDistances = this.getStraightLineTrainingDistances();
    const requestedDistance = Number.isFinite(startDistanceMeters)
      ? (startDistanceMeters as number)
      : availableDistances[0];
    const boundedMaxDistance = Math.max(availableDistances[0], Math.min(availableDistances.at(-1) ?? DRIVE_SHORT_BUCKET_MAX_METERS, maxDistanceMeters));
    const firstIncludedDistance = availableDistances.find((distance) => distance >= requestedDistance - 1e-9 && distance <= boundedMaxDistance + 1e-9);
    return firstIncludedDistance ?? availableDistances[0];
  }

  private normalizeShortTrainingMaxDistanceMeters(maxDistanceMeters?: number, startDistanceMeters = DRIVE_SHORT_BUCKET_STEP_METERS): number {
    const availableDistances = this.getStraightLineTrainingDistances();
    const requestedDistance = Number.isFinite(maxDistanceMeters)
      ? (maxDistanceMeters as number)
      : (availableDistances.at(-1) ?? DRIVE_SHORT_BUCKET_MAX_METERS);
    const minimumDistance = Math.max(startDistanceMeters, availableDistances[0]);
    const eligibleDistances = availableDistances.filter((distance) => distance >= minimumDistance - 1e-9 && distance <= requestedDistance + 1e-9);
    return eligibleDistances.at(-1) ?? Math.max(minimumDistance, availableDistances[0]);
  }

  private buildStraightLineTrainingDistances(startDistanceMeters = DRIVE_SHORT_BUCKET_STEP_METERS, maxDistanceMeters = DRIVE_SHORT_BUCKET_MAX_METERS): number[] {
    const start = Math.max(DRIVE_SHORT_BUCKET_STEP_METERS, startDistanceMeters);
    const max = Math.max(start, maxDistanceMeters);
    return this.getStraightLineTrainingDistances()
      .filter((distance) => distance >= start - 1e-9 && distance <= max + 1e-9);
  }

  private getStraightLineTrainingDistances(): readonly number[] {
    return [
      ...DRIVE_SHORT_BUCKET_DISTANCES_METERS,
      ...DRIVE_LONG_SAMPLE_DISTANCES_METERS,
    ];
  }

  private async applyStraightLineControl(
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

    // The "control heading" is the body heading projected forward along the
    // commanded travel direction — the rear of the mower for reverse drives.
    // Steering decisions compare it to the line heading.
    const lineHeading = this.getDriveLineHeading();
    const controlHeading = this.driveDirectionSign > 0
      ? pose.heading
      : createInternalHeading(unwrapInternalHeading(pose.heading) + 180);
    const headingDiff = unwrapRelativeAngle(headingDifference(controlHeading, lineHeading));
    const headingErrorDeg = Math.abs(headingDiff);

    // Large heading errors are recovered by an in-place pivot rather than by
    // trying to steer through them under power.  Skipped in the final
    // approach window so we never pivot right next to the target.
    if (
      headingErrorDeg >= DRIVE_STEERING_ROTATE_TO_HEADING_MIN_ANGLE_DEG &&
      remainingAlongTrackDistance > DRIVE_STEERING_TARGET_INFLUENCE_DISTANCE_METERS
    ) {
      const turnSign = headingDiff >= 0 ? 1 : -1;
      const { leftCommand, rightCommand } = this.calculatePivotCommands(turnSign, false);
      await this.sensorController.setMotorWheelOutputs(leftCommand, rightCommand);
      return;
    }

    // Cross-track error is positive when the mower is to the right of the
    // line (looking from start to end).  We bias the right wheel "forward"
    // and the left wheel "back" by the same amount to rotate the body
    // counterclockwise, pulling it back onto the line.  The same asymmetry
    // applies in reverse — the base command flips sign, the trim direction
    // does not.
    const cte = unwrapMeters(crossTrackError(pose.position, this.driveLineStart, this.driveLineEnd));
    const cteGain = this.learningModel.getCteGainForDirection(this.driveDirectionSign);
    const trim = this.clamp(
      cte * cteGain,
      -DRIVE_STEERING_MAX_TRIM_PERCENT,
      DRIVE_STEERING_MAX_TRIM_PERCENT,
    );

    const baseCommand = this.driveDirectionSign * this.fullSpeedCommand;
    const leftCommand = this.clampNormalizedSpeed(baseCommand - trim);
    const rightCommand = this.clampNormalizedSpeed(baseCommand + trim);
    const normalizedCommands = this.enforceMinimumActiveArcCommands(
      leftCommand,
      rightCommand,
      trim,
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
   * Heartbeat hook left in place for future diagnostic re-enable.  The
   * 5 Hz log volume previously emitted here was enough to make ssh
   * unresponsive on the Pi, so the body is now empty.
   */
  private emitHeartbeatIfDue(pose: Pose, cte: Meters): void {
    void pose;
    void cte;
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

  private clampNormalizedSpeed(speed: number): number {
    return this.clamp(speed, -this.fullSpeedCommand, this.fullSpeedCommand);
  }

  /**
   * Wheel-command sanity pass. If the trim has flipped one wheel's sign or
   * zeroed it (which would otherwise issue a one-wheel scrub) the controller
   * pivots in place toward the requested rotation direction instead. Otherwise
   * each command is floored at the minimum active output so the motors do not
   * stall on grass.
   */
  private enforceMinimumActiveArcCommands(
    leftCommand: number,
    rightCommand: number,
    trim: number,
  ): { leftCommand: number; rightCommand: number } {
    if (leftCommand === 0 && rightCommand === 0) {
      return { leftCommand: 0, rightCommand: 0 };
    }

    const leftSign = Math.sign(leftCommand);
    const rightSign = Math.sign(rightCommand);
    if (leftSign === 0 || rightSign === 0 || leftSign !== rightSign) {
      const turnSign = trim >= 0 ? 1 : -1;
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
      DRIVE_STEERING_PIVOT_OUTPUT_PERCENT,
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
      await this.sensorController.requestNeutralMotorOutputs();

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

      let learnApplied = false;
      let learnSkipReason: string | undefined;
      if (this.currentDrive?.learningEnabled === false) {
        learnSkipReason = "learning_disabled";
      } else {
        // Only feed a drive into the learner when every pose sample that
        // shaped the drive was GNSS-quality: the start anchor (defines the
        // line geometry and so the CTE), the brake-decision pose (defines
        // when braking actually fired), and the final pose (defines the
        // measured X/Y error). A dead-reckoning sample for any of the three
        // would teach the learner to compensate for encoder drift rather
        // than for the brake-time-vs-overshoot relationship we want it to
        // model.
        const learningPoseQualityOk =
          this.driveStartPoseQuality === "gnss" &&
          this.brakeDecisionPoseQuality === "gnss" &&
          finalPose.quality === "gnss";
        if (learningPoseQualityOk) {
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
          learnApplied = true;
        } else {
          learnSkipReason = "non_gnss_pose_sample";
          this.logger.warn("drive.line.learning_skipped", {
            reason: learnSkipReason,
            startPoseQuality: this.driveStartPoseQuality,
            brakeDecisionPoseQuality: this.brakeDecisionPoseQuality,
            finalPoseQuality: finalPose.quality,
          });
        }

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
        learnApplied,
        learnSkipReason,
        startPoseQuality: this.driveStartPoseQuality,
        brakeDecisionPoseQuality: this.brakeDecisionPoseQuality,
        finalPoseQuality: finalPose.quality,
      };

      this.addToHistory(result);
      this.driveResolve?.(result);
      this.driveResolve = null;
    } catch (error) {
      this.status = "idle";
      this.currentDrive = null;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("drive.line.completion_error", { error: errorMessage });
      try {
        await this.sensorController.stopMotors();
      } catch {
        // Best-effort ramp during a completion error.
      }

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
        learnApplied: false,
        learnSkipReason: "drive_error",
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
    // Mid-drive bail-out (CTE limit, user stop, etc.): bring the wheels
    // to rest under the deceleration profile. The emergency-stop path
    // owns the H-bridge disable separately.
    await this.sensorController.stopMotors();
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
      learnApplied: false,
      learnSkipReason: "drive_stopped",
    });
    this.driveResolve = null;
  }

  private calculateMaxCte(): Meters {
    if (this.cteSamples.length === 0) {
      return createMeters(0);
    }
    let maxAbs = 0;
    for (const cte of this.cteSamples) {
      const mag = Math.abs(unwrapMeters(cte));
      if (mag > maxAbs) {
        maxAbs = mag;
      }
    }
    return createMeters(maxAbs);
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

}
