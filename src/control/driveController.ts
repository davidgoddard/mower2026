/**
 * Drive controller - executes point-to-point drives with self-learning CTE correction
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { TurnController } from "./turnController.js";
import { DriveLearningModel } from "./driveLearningModel.js";
import { MotorCalibration } from "../config/motorCalibration.js";
import {
  InternalHeading,
  RelativeAngle,
  createRelativeAngle,
  headingDifference,
  unwrapRelativeAngle,
  unwrapInternalHeading,
} from "../geometry/headingTypes.js";
import {
  Position,
  Pose,
  Meters,
  createPosition,
  createMeters,
  unwrapMeters,
  distanceBetween,
  angleTo,
  crossTrackError,
  calculateXError,
} from "../geometry/positionTypes.js";
import {
  DriveRequest,
  DriveResult,
  DriveControllerState,
  DriveStatus,
} from "./driveControllerTypes.js";
import {
  DRIVE_SETTLE_TIME_MS,
  DRIVE_INITIAL_TURN_THRESHOLD_DEG,
  DRIVE_TIMEOUT_MULTIPLIER,
  DRIVE_HISTORY_MAX_SIZE,
  DRIVE_FULL_SPEED_COMMAND_DEFAULT,
  MOTOR_RAMP_DOWN_TIME_MS,
} from "../constants.js";
import { systemStop } from "./systemStop.js";

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export interface DriveControllerOptions {
  sensorController: SensorController;
  poseFusion: PoseFusion;
  turnController: TurnController;
  logger: SessionLogger;
  learningModel: DriveLearningModel;
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
  private readonly motorCalibration: MotorCalibration | null;
  private readonly fullSpeedCommand: number;
  private readonly settleTimeMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private status: DriveStatus = "idle";
  private currentDrive: DriveRequest | null = null;
  private stopRequested = false;
  private driveHistory: DriveResult[] = [];
  private drivesCompleted = 0;
  private totalErrorXMeters = 0;
  private totalErrorYMeters = 0;

  // Event-driven drive state
  private driveStartPosition: Position | null = null;
  private driveStartHeading: InternalHeading | null = null;
  private driveStartPoseQuality: "gnss" | "dead-reckoning" | "unknown" = "unknown";
  private driveTargetPosition: Position | null = null;
  private driveLineStart: Position | null = null;
  private driveLineEnd: Position | null = null;
  private driveStartTime: number = 0;
  private driveResolve: ((result: DriveResult) => void) | null = null;
  private cteSamples: Meters[] = [];
  private totalEncoderTicks: number = 0;
  private motorOperationActive = false;

  constructor(options: DriveControllerOptions) {
    this.logger = options.logger.child({ context: "control", source: "DriveController" });
    this.sensorController = options.sensorController;
    this.poseFusion = options.poseFusion;
    this.turnController = options.turnController;
    this.learningModel = options.learningModel;
    this.motorCalibration = options.motorCalibration ?? null;
    this.fullSpeedCommand = options.fullSpeedCommand ?? DRIVE_FULL_SPEED_COMMAND_DEFAULT;
    this.settleTimeMs = options.settleTimeMs ?? DRIVE_SETTLE_TIME_MS;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;

    // Bind event handler to maintain 'this' context
    this.onPoseUpdate = this.onPoseUpdate.bind(this);
  }

  /**
   * Execute a drive maneuver (event-driven)
   */
  async executeDrive(request: DriveRequest): Promise<DriveResult> {
    return new Promise<DriveResult>(async (resolve) => {
      let subscribed = false;

      try {
        systemStop.clearStop("drive-execute");
        this.beginMotorOperation();

        // 1. Get current pose
        this.currentDrive = request;
        this.driveStartTime = this.nowMillis();
        this.driveResolve = resolve;
        this.cteSamples = [];
        this.totalEncoderTicks = 0;

        const startPose = this.poseFusion.getCurrentPose();
        this.driveStartPosition = startPose.position;
        this.driveStartHeading = startPose.heading;
        this.driveStartPoseQuality = startPose.quality;
        this.driveTargetPosition = request.targetPosition;

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

        // 2. Calculate angle to target
        const angleToTarget = angleTo(this.driveStartPosition, request.targetPosition);
        const headingError = headingDifference(this.driveStartHeading, angleToTarget);
        const headingErrorDeg = Math.abs(unwrapRelativeAngle(headingError));

        // 3. If >5 degrees, turn to face target
        if (headingErrorDeg > DRIVE_INITIAL_TURN_THRESHOLD_DEG) {
          this.status = "turning";
          this.logger.info("drive.turning", {
            headingError: unwrapRelativeAngle(headingError),
          });

          await this.turnController.executeTurn({
            targetAngle: headingError,
            direction: unwrapRelativeAngle(headingError) > 0 ? "ccw" : "cw",
            learningEnabled: true,
          });
        }

        // 4. Settle after turn
        this.status = "settling";
        const settleAfterTurnCompleted = await this.sleepWithStopChecks(this.settleTimeMs);
        if (!settleAfterTurnCompleted || this.stopRequested || systemStop.isStopped()) {
          await this.finishStoppedDrive("Drive stopped during settle");
          return;
        }

        // 5. Get current pose again
        const drivingStartPose = this.poseFusion.getCurrentPose();
        this.driveStartPosition = drivingStartPose.position;
        this.driveStartHeading = drivingStartPose.heading;
        this.driveStartPoseQuality = drivingStartPose.quality;

        // 6. Compute line to target
        this.driveLineStart = this.driveStartPosition;
        this.driveLineEnd = request.targetPosition;

        // 7. Subscribe to pose updates
        this.poseFusion.on("poseUpdate", this.onPoseUpdate);
        subscribed = true;

        // 8. Engage motors at full speed
        this.status = "driving";
        await this.sensorController.setMotorWheelSpeeds(this.fullSpeedCommand, this.fullSpeedCommand);

        this.logger.info("drive.driving", {
          startPosition: {
            x: unwrapMeters(this.driveStartPosition.xMeters),
            y: unwrapMeters(this.driveStartPosition.yMeters),
          },
          heading: unwrapInternalHeading(this.driveStartHeading),
        });

        // Event handler will monitor and complete drive
      } catch (error) {
        // Cleanup on error
        if (subscribed) {
          this.poseFusion.off("poseUpdate", this.onPoseUpdate);
        }
        systemStop.requestStop("drive", "drive_error");
        try {
          await this.sensorController.stopMotors();
        } catch (stopError) {
          const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
          this.logger.warn("drive.stop_failed", { error: stopMessage });
        }
        await this.endMotorOperation();
        this.status = "idle";
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
    });
  }

  /**
   * Event handler for pose updates (called at 30Hz by pose fusion)
   */
  private async onPoseUpdate(pose: Pose): Promise<void> {
    if (
      this.status !== "driving" ||
      this.driveStartPosition === null ||
      this.driveTargetPosition === null ||
      this.driveLineStart === null ||
      this.driveLineEnd === null
    ) {
      return;
    }

    // Check for emergency stop
    if (this.stopRequested) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      try {
        await this.sensorController.stopMotors();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("drive.stop_failed", { error: message });
      } finally {
        await this.endMotorOperation();
      }
      this.status = "stopped";
      const stoppedDrive = this.currentDrive;
      this.currentDrive = null;
      this.stopRequested = false;
      this.logger.warn("drive.stopped", { durationMs: this.nowMillis() - this.driveStartTime });
      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition: pose.position,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs: this.nowMillis() - this.driveStartTime,
        brakeDistanceUsed: this.learningModel.getBrakeDistance(),
        status: "stopped",
        errorMessage: "Drive stopped by user request",
        timestamp: new Date().toISOString(),
      });
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
      const stoppedDrive = this.currentDrive;
      this.currentDrive = null;
      this.logger.warn("drive.stopped", { durationMs: this.nowMillis() - this.driveStartTime, reason: "system_stop" });
      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition: pose.position,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs: this.nowMillis() - this.driveStartTime,
        brakeDistanceUsed: this.learningModel.getBrakeDistance(),
        status: "stopped",
        errorMessage: "Drive stopped by system stop",
        timestamp: new Date().toISOString(),
      });
      this.stopRequested = false;
      return;
    }

    const currentPosition = pose.position;

    // Calculate CTE
    const cte = crossTrackError(currentPosition, this.driveLineStart, this.driveLineEnd);
    this.cteSamples.push(cte);

    // Calculate remaining distance
    const alongTrackError = calculateXError(currentPosition, this.driveLineStart, this.driveLineEnd);
    const remainingAlongTrackDistance = Math.abs(unwrapMeters(alongTrackError));

    // Apply CTE correction
    await this.applyCteCorrection(cte);

    // Check brake condition
    const brakeDistance = this.learningModel.getBrakeDistance();
    if (remainingAlongTrackDistance <= unwrapMeters(brakeDistance)) {
      // Unsubscribe BEFORE completing
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      await this.completeDrive();
      return;
    }

    // Timeout check
    if (this.nowMillis() - this.driveStartTime > this.calculateTimeout()) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      try {
        await this.sensorController.stopMotors();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("drive.stop_failed", { error: message });
      } finally {
        await this.endMotorOperation();
      }
      systemStop.requestStop("drive", "drive_timeout");
      this.status = "idle";
      const finalPosition = pose.position;
      const errorX = calculateXError(finalPosition, this.driveLineStart, this.driveLineEnd);
      const errorY = crossTrackError(finalPosition, this.driveLineStart, this.driveLineEnd);
      this.logger.error("drive.timeout", {
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
      return;
    }
  }

  /**
   * Apply CTE correction (asymmetric wheel speed adjustment)
   */
  private async applyCteCorrection(cte: Meters): Promise<void> {
    const cteValue = unwrapMeters(cte);
    const gain = this.learningModel.getCteGain();

    // Positive CTE = drifting right, need to turn left
    // Keep left wheel at full speed, slow right wheel
    // Negative CTE = drifting left, need to turn right
    // Keep right wheel at full speed, slow left wheel

    let leftSpeed = this.fullSpeedCommand;
    let rightSpeed = this.fullSpeedCommand;

    if (cteValue > 0) {
      // Drifting right - slow right wheel
      rightSpeed = this.fullSpeedCommand * (1 - gain * cteValue);
    } else {
      // Drifting left - slow left wheel
      leftSpeed = this.fullSpeedCommand * (1 + gain * cteValue); // cteValue is negative
    }

    // Clamp speeds to [0, fullSpeedCommand]
    leftSpeed = Math.max(0, Math.min(this.fullSpeedCommand, leftSpeed));
    rightSpeed = Math.max(0, Math.min(this.fullSpeedCommand, rightSpeed));

    await this.sensorController.setMotorWheelSpeeds(leftSpeed, rightSpeed);
  }

  /**
   * Complete drive after brake point reached
   */
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
      // Brake
      this.status = "braking";
      await this.sensorController.stopMotors();

      this.logger.info("drive.braking", {});

      // Wait for motor ramp-down (2x ramp-down time per spec)
      const rampDownTime = this.motorCalibration?.getRampDownTime() ?? MOTOR_RAMP_DOWN_TIME_MS;
      const rampDownCompleted = await this.sleepWithStopChecks(2 * rampDownTime);
      if (!rampDownCompleted || this.stopRequested || systemStop.isStopped()) {
        await this.finishStoppedDrive("Drive stopped during ramp-down");
        return;
      }

      // Settle
      this.status = "settling";
      const settleCompleted = await this.sleepWithStopChecks(this.settleTimeMs);
      if (!settleCompleted || this.stopRequested || systemStop.isStopped()) {
        await this.finishStoppedDrive("Drive stopped during settle");
        return;
      }

      // Measure final position
      this.status = "measuring";
      const finalPose = this.poseFusion.getCurrentPose();
      const finalPosition = finalPose.position;

      // Calculate errors
      const errorX = calculateXError(finalPosition, this.driveLineStart, this.driveLineEnd);
      const errorY = crossTrackError(finalPosition, this.driveLineStart, this.driveLineEnd);

      // Calculate CTE statistics
      const maxCte = this.calculateMaxCte();
      const avgCte = this.calculateAvgCte();

      this.logger.info("drive.completed", {
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
      });

      // Update learning model
      if (this.currentDrive?.learningEnabled !== false) {
        this.status = "learning";
        await this.learningModel.updateFromDrive({
          startPosition: this.driveStartPosition,
          targetPosition: this.driveTargetPosition,
          finalPosition,
          errorX,
          errorY,
          maxCte,
          avgCte,
          brakeDistanceUsed: this.learningModel.getBrakeDistance(),
        });

        // Update encoder calibration if both poses were GNSS quality
        if (this.driveStartPoseQuality === "gnss" && finalPose.quality === "gnss") {
          const actualDistance = distanceBetween(this.driveStartPosition, finalPosition);
          if (this.totalEncoderTicks > 0) {
            const measuredMetersPerTick = unwrapMeters(actualDistance) / this.totalEncoderTicks;
            const currentCalibration = this.poseFusion.getEncoderCalibration();
            const newCalibration = 0.9 * currentCalibration + 0.1 * measuredMetersPerTick;
            await this.poseFusion.setEncoderCalibration(newCalibration);
            this.logger.info("drive.encoder_calibrated", {
              actualDistance: unwrapMeters(actualDistance),
              encoderTicks: this.totalEncoderTicks,
              newCalibration,
            });
          }
        }
      }

      // Return to idle
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
        brakeDistanceUsed: this.learningModel.getBrakeDistance(),
        status: "success",
        timestamp: new Date().toISOString(),
      };

      // Update history
      this.addToHistory(result);

      // Resolve the promise
      this.driveResolve?.(result);
    } catch (error) {
      // Error during completion - ensure cleanup
      this.status = "idle";
      this.currentDrive = null;
      systemStop.requestStop("drive", "drive_completion_error");
      await this.endMotorOperation();

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("drive.completion_error", { error: errorMessage });

      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition: this.driveStartPosition,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs: this.nowMillis() - this.driveStartTime,
        brakeDistanceUsed: this.learningModel.getBrakeDistance(),
        status: "error",
        errorMessage,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Stop current drive immediately (emergency stop)
   */
  async stopCurrentDrive(): Promise<void> {
    if (this.currentDrive) {
      this.stopRequested = true;
      systemStop.requestStop("drive", "drive_stop_requested");
      const stopCurrentTurn = (this.turnController as any).stopCurrentTurn;
      if (typeof stopCurrentTurn === "function") {
        void stopCurrentTurn.call(this.turnController);
      }
    }
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

    this.logger.info("drive.test_pattern.started", {
      waypointCount,
      testDriveCount,
      phase: "collecting_waypoints"
    });

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
        this.beginMotorOperation();
        try {
          await this.sensorController.setMotorWheelSpeeds(this.fullSpeedCommand, this.fullSpeedCommand);
          const driveCompleted = await this.sleepWithStopChecks(driveTimeMs);
          if (!driveCompleted || this.stopRequested || systemStop.isStopped()) {
            await this.sensorController.stopMotors();
            return results;
          }
          await this.sensorController.stopMotors();
        } finally {
          await this.endMotorOperation();
        }

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
  }

  /**
   * Get current controller state
   */
  getState(): DriveControllerState {
    return {
      status: this.status,
      currentDrive: this.currentDrive,
      drivesCompleted: this.drivesCompleted,
      averageErrorXMeters: this.drivesCompleted > 0 ? this.totalErrorXMeters / this.drivesCompleted : 0,
      averageErrorYMeters: this.drivesCompleted > 0 ? this.totalErrorYMeters / this.drivesCompleted : 0,
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

  /**
   * Calculate timeout for drive
   */
  private calculateTimeout(): number {
    if (this.driveStartPosition === null || this.driveTargetPosition === null) {
      return 60000; // 1 minute default
    }

    const distance = unwrapMeters(distanceBetween(this.driveStartPosition, this.driveTargetPosition));
    // Assume 0.5 m/s average speed (conservative)
    const estimatedDurationMs = (distance / 0.5) * 1000;
    return estimatedDurationMs * DRIVE_TIMEOUT_MULTIPLIER;
  }

  /**
   * Calculate max CTE from samples
   */
  private calculateMaxCte(): Meters {
    if (this.cteSamples.length === 0) {
      return createMeters(0);
    }
    return this.cteSamples.reduce((max, cte) =>
      Math.abs(unwrapMeters(cte)) > Math.abs(unwrapMeters(max)) ? cte : max,
      createMeters(0)
    );
  }

  /**
   * Calculate average absolute CTE from samples
   */
  private calculateAvgCte(): Meters {
    if (this.cteSamples.length === 0) {
      return createMeters(0);
    }
    const sum = this.cteSamples.reduce((sum, cte) => sum + Math.abs(unwrapMeters(cte)), 0);
    return createMeters(sum / this.cteSamples.length);
  }

  /**
   * Add result to history with size limit
   */
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

  private async finishStoppedDrive(errorMessage: string): Promise<void> {
    const stoppedDrive = this.currentDrive ?? {
      targetPosition: this.driveTargetPosition ?? createPosition(0, 0),
      learningEnabled: true,
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
    this.logger.warn("drive.stopped", {
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
      brakeDistanceUsed: this.learningModel.getBrakeDistance(),
      status: "stopped",
      errorMessage,
      timestamp: new Date().toISOString(),
    });
    this.driveResolve = null;
  }

  private beginMotorOperation(): void {
    if (this.motorOperationActive) {
      return;
    }

    this.motorOperationActive = true;
    const beginMotorOperation = (this.sensorController as any).beginMotorOperation;
    if (typeof beginMotorOperation === "function") {
      beginMotorOperation.call(this.sensorController);
    }
  }

  private async endMotorOperation(): Promise<void> {
    if (!this.motorOperationActive) {
      return;
    }

    this.motorOperationActive = false;
    const endMotorOperation = (this.sensorController as any).endMotorOperation;
    if (typeof endMotorOperation === "function") {
      await endMotorOperation.call(this.sensorController);
      return;
    }

    const stopMotors = (this.sensorController as any).stopMotors;
    if (typeof stopMotors === "function") {
      await stopMotors.call(this.sensorController);
    }
  }
}
