/**
 * Segment test runner.
 *
 * This is a test harness only: it collects a rough waypoint line by briefly
 * driving forward, then reuses the existing segment drive controller to drive
 * back to the first waypoint and to random non-nearest waypoints.
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { DriveResult } from "./driveControllerTypes.js";
import { DriveController } from "./driveController.js";
import { SensorController } from "../sensing/sensorController.js";
import { Pose } from "../geometry/positionTypes.js";
import {
  angleTo,
  distanceBetween,
  unwrapMeters,
} from "../geometry/positionTypes.js";
import {
  headingDifference,
  unwrapInternalHeading,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
import { systemStop } from "./systemStop.js";
import { DRIVE_FULL_SPEED_COMMAND_DEFAULT } from "../constants.js";

export type SegmentTestPhase =
  | "idle"
  | "collecting-waypoints"
  | "driving-home"
  | "testing-random"
  | "stopped"
  | "completed";

export interface SegmentTestResult {
  readonly index: number;
  readonly timestamp: string;
  readonly phase: "home" | "random";
  readonly waypointIndex: number;
  readonly waypointLabel: string;
  readonly distanceToWaypointMeters: number;
  readonly requiredHeadingChangeDeg: number;
  readonly achievedHeadingChangeDeg: number | null;
  readonly driveStatus: DriveResult["status"];
  readonly cteMeters: number;
  readonly maxCteMeters: number;
  readonly xErrorMeters: number;
  readonly yErrorMeters: number;
  readonly startHeadingDeg: number;
  readonly targetHeadingDeg: number;
  readonly finalHeadingDeg: number | null;
  readonly startXMeters: number;
  readonly startYMeters: number;
  readonly targetXMeters: number;
  readonly targetYMeters: number;
}

export interface SegmentTestRunnerState {
  readonly running: boolean;
  readonly phase: SegmentTestPhase;
  readonly collectedWaypoints: number;
  readonly totalWaypoints: number;
  readonly completedRuns: number;
  readonly totalRuns: number;
  readonly currentTargetWaypointIndex: number | null;
  readonly currentTargetLabel: string | null;
  readonly lastUpdated: string | null;
  readonly stopRequested: boolean;
}

export interface SegmentTestRunnerOptions {
  driveController: DriveController;
  sensorController: SensorController;
  poseProvider: () => Pose | null;
  logger: SessionLogger;
  random?: () => number;
  fullSpeedCommand?: number;
  collectDriveMs?: number;
  collectSettleMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class SegmentTestRunner {
  private static readonly DEFAULT_WAYPOINT_COUNT = 7;
  private static readonly DEFAULT_TEST_RUN_COUNT = 10;
  private static readonly DEFAULT_COLLECT_DRIVE_MS = 3000;
  private static readonly DEFAULT_COLLECT_SETTLE_MS = 750;

  private readonly logger: LoggerScope;
  private readonly driveController: DriveController;
  private readonly sensorController: SensorController;
  private readonly poseProvider: () => Pose | null;
  private readonly random: () => number;
  private readonly fullSpeedCommand: number;
  private readonly collectDriveMs: number;
  private readonly collectSettleMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private running = false;
  private phase: SegmentTestPhase = "idle";
  private collectedWaypoints = 0;
  private totalWaypoints = 0;
  private completedRuns = 0;
  private totalRuns = 0;
  private currentTargetWaypointIndex: number | null = null;
  private currentTargetLabel: string | null = null;
  private lastUpdated: string | null = null;
  private stopRequested = false;
  private history: SegmentTestResult[] = [];

  constructor(options: SegmentTestRunnerOptions) {
    this.logger = options.logger.child({ context: "control", source: "SegmentTestRunner" });
    this.driveController = options.driveController;
    this.sensorController = options.sensorController;
    this.poseProvider = options.poseProvider;
    this.random = options.random ?? Math.random;
    this.fullSpeedCommand = options.fullSpeedCommand ?? DRIVE_FULL_SPEED_COMMAND_DEFAULT;
    this.collectDriveMs = Math.max(0, Math.floor(options.collectDriveMs ?? SegmentTestRunner.DEFAULT_COLLECT_DRIVE_MS));
    this.collectSettleMs = Math.max(0, Math.floor(options.collectSettleMs ?? SegmentTestRunner.DEFAULT_COLLECT_SETTLE_MS));
    this.sleep = options.sleep ?? defaultSleep;
  }

  async run(options: { waypointCount?: number; testRunCount?: number } = {}): Promise<SegmentTestResult[]> {
    const waypointCount = Math.max(2, Math.floor(options.waypointCount ?? SegmentTestRunner.DEFAULT_WAYPOINT_COUNT));
    const testRunCount = Math.max(0, Math.floor(options.testRunCount ?? SegmentTestRunner.DEFAULT_TEST_RUN_COUNT));
    const results: SegmentTestResult[] = [];
    const waypoints: Pose[] = [];

    this.history = [];
    this.stopRequested = false;
    this.running = true;
    this.sensorController.beginMotionSession();
    this.phase = "collecting-waypoints";
    this.collectedWaypoints = 0;
    this.totalWaypoints = waypointCount;
    this.completedRuns = 0;
    this.totalRuns = 1 + testRunCount;
    this.currentTargetWaypointIndex = null;
    this.currentTargetLabel = null;
    this.lastUpdated = new Date().toISOString();

    systemStop.clearStop("segment-test-start");
    this.logger.info("segment_test.started", {
      waypointCount,
      testRunCount,
      collectDriveMs: this.collectDriveMs,
    });

    try {
      const initialPose = this.poseProvider();
      if (initialPose === null) {
        this.logStopped(results.length, "pose_unavailable");
        return results;
      }

      waypoints.push(initialPose);
      this.collectedWaypoints = waypoints.length;
      this.lastUpdated = new Date().toISOString();
      this.logger.info("segment_test.waypoint_collected", {
        waypointIndex: 1,
        totalWaypoints: waypointCount,
        position: {
          x: unwrapMeters(initialPose.position.xMeters),
          y: unwrapMeters(initialPose.position.yMeters),
        },
        headingDeg: unwrapInternalHeading(initialPose.heading),
      });

      for (let waypointIndex = 1; waypointIndex < waypointCount; waypointIndex += 1) {
        if (this.shouldStop()) {
          this.logStopped(results.length, "waypoint_collection");
          return results;
        }

        await this.sensorController.setMotorWheelOutputs(this.fullSpeedCommand, this.fullSpeedCommand);
        const driveCompleted = await this.sleepWithStopChecks(this.collectDriveMs);
        await this.sensorController.stopMotors();
        const settleCompleted = await this.sleepWithStopChecks(this.collectSettleMs);

        if (!driveCompleted || !settleCompleted || this.shouldStop()) {
          this.logStopped(results.length, this.stopRequested ? "stop_requested" : "system_stop");
          return results;
        }

        const pose = this.poseProvider();
        if (pose === null) {
          this.logStopped(results.length, "pose_unavailable");
          return results;
        }

        waypoints.push(pose);
        this.collectedWaypoints = waypoints.length;
        this.lastUpdated = new Date().toISOString();
        this.logger.info("segment_test.waypoint_collected", {
          waypointIndex: waypointIndex + 1,
          totalWaypoints: waypointCount,
          position: {
            x: unwrapMeters(pose.position.xMeters),
            y: unwrapMeters(pose.position.yMeters),
          },
          headingDeg: unwrapInternalHeading(pose.heading),
        });
      }

      if (waypoints.length < 2) {
        this.phase = "completed";
        this.running = false;
        this.lastUpdated = new Date().toISOString();
        return results;
      }

      // First test: drive back to the first captured waypoint.
      const homePose = this.poseProvider();
      if (homePose === null) {
        this.logStopped(results.length, "pose_unavailable");
        return results;
      }

      const homeResult = await this.runSegmentTest({
        results,
        startPose: homePose,
        targetPose: waypoints[0],
        phase: "home",
        waypointIndex: 0,
        waypointLabel: "first waypoint",
      });
      if (homeResult === null) {
        return results;
      }

      // Then run 10 random non-nearest waypoint segments.
      for (let runIndex = 0; runIndex < testRunCount; runIndex += 1) {
        if (this.shouldStop()) {
          this.logStopped(results.length, this.stopRequested ? "stop_requested" : "system_stop");
          return results;
        }

        const currentPose = this.poseProvider();
        if (currentPose === null) {
          this.logStopped(results.length, "pose_unavailable");
          return results;
        }

        const targetChoice = this.pickRandomNonNearestWaypoint(currentPose, waypoints);
        if (targetChoice === null) {
          this.logger.warn("segment_test.no_eligible_waypoints", {
            completedRuns: results.length,
            runIndex: runIndex + 1,
          });
          break;
        }

        const result = await this.runSegmentTest({
          results,
          startPose: currentPose,
          targetPose: targetChoice.pose,
          phase: "random",
          waypointIndex: targetChoice.index,
          waypointLabel: `waypoint ${targetChoice.index + 1}`,
        });
        if (result === null) {
          return results;
        }
      }

      this.phase = "completed";
      this.running = false;
      this.completedRuns = results.length;
      this.lastUpdated = new Date().toISOString();
      this.logger.info("segment_test.completed", { totalRuns: results.length });
      return results;
    } finally {
      this.history = [...results];
      this.running = false;
      this.completedRuns = results.length;
      this.lastUpdated = new Date().toISOString();
      this.sensorController.endMotionSession();
    }
  }

  getState(): SegmentTestRunnerState {
    return {
      running: this.running,
      phase: this.phase,
      collectedWaypoints: this.collectedWaypoints,
      totalWaypoints: this.totalWaypoints,
      completedRuns: this.completedRuns,
      totalRuns: this.totalRuns,
      currentTargetWaypointIndex: this.currentTargetWaypointIndex,
      currentTargetLabel: this.currentTargetLabel,
      lastUpdated: this.lastUpdated,
      stopRequested: this.stopRequested,
    };
  }

  getHistory(): SegmentTestResult[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  stopCurrentTest(): void {
    this.stopRequested = true;
    void this.sensorController.stopMotors();
    void this.driveController.stopCurrentDrive();
  }

  private async runSegmentTest(options: {
    results: SegmentTestResult[];
    startPose: Pose;
    targetPose: Pose;
    phase: "home" | "random";
    waypointIndex: number;
    waypointLabel: string;
  }): Promise<SegmentTestResult | null> {
    const { results, startPose, targetPose, phase, waypointIndex, waypointLabel } = options;

    this.phase = phase === "home" ? "driving-home" : "testing-random";
    this.currentTargetWaypointIndex = waypointIndex + 1;
    this.currentTargetLabel = waypointLabel;
    this.lastUpdated = new Date().toISOString();

    const distanceToWaypointMeters = unwrapMeters(distanceBetween(startPose.position, targetPose.position));
    const targetHeading = angleTo(startPose.position, targetPose.position);
    const requiredHeadingChangeDeg = unwrapRelativeAngle(headingDifference(startPose.heading, targetHeading));

    this.logger.info("segment_test.drive_starting", {
      phase,
      waypointIndex: waypointIndex + 1,
      waypointLabel,
      distanceToWaypointMeters,
      requiredHeadingChangeDeg,
      startPosition: {
        x: unwrapMeters(startPose.position.xMeters),
        y: unwrapMeters(startPose.position.yMeters),
      },
      targetPosition: {
        x: unwrapMeters(targetPose.position.xMeters),
        y: unwrapMeters(targetPose.position.yMeters),
      },
    });

    let driveResult: DriveResult;
    try {
      driveResult = await this.driveController.executeDrive({
        targetPosition: targetPose.position,
        learningEnabled: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.phase = "stopped";
      this.stopRequested = false;
      this.logger.error("segment_test.drive_failed", {
        phase,
        waypointIndex: waypointIndex + 1,
        waypointLabel,
        error: message,
      });
      return null;
    }

    const endPose = this.poseProvider();
    const achievedHeadingChangeDeg = endPose === null
      ? null
      : unwrapRelativeAngle(headingDifference(startPose.heading, endPose.heading));

    const result: SegmentTestResult = {
      index: results.length + 1,
      timestamp: driveResult.timestamp,
      phase,
      waypointIndex: waypointIndex + 1,
      waypointLabel,
      distanceToWaypointMeters,
      requiredHeadingChangeDeg,
      achievedHeadingChangeDeg,
      driveStatus: driveResult.status,
      cteMeters: unwrapMeters(driveResult.avgCteMeters),
      maxCteMeters: unwrapMeters(driveResult.maxCteMeters),
      xErrorMeters: unwrapMeters(driveResult.errorX),
      yErrorMeters: unwrapMeters(driveResult.errorY),
      startHeadingDeg: unwrapInternalHeading(startPose.heading),
      targetHeadingDeg: unwrapInternalHeading(targetHeading),
      finalHeadingDeg: endPose === null ? null : unwrapInternalHeading(endPose.heading),
      startXMeters: unwrapMeters(startPose.position.xMeters),
      startYMeters: unwrapMeters(startPose.position.yMeters),
      targetXMeters: unwrapMeters(targetPose.position.xMeters),
      targetYMeters: unwrapMeters(targetPose.position.yMeters),
    };

    results.push(result);
    this.history.push(result);
    this.completedRuns = results.length;
    this.lastUpdated = new Date().toISOString();

    this.logger.info("segment_test.drive_result", {
      phase,
      waypointIndex: waypointIndex + 1,
      waypointLabel,
      driveStatus: driveResult.status,
      distanceToWaypointMeters,
      requiredHeadingChangeDeg,
      achievedHeadingChangeDeg,
      cteMeters: result.cteMeters,
      maxCteMeters: result.maxCteMeters,
      xErrorMeters: result.xErrorMeters,
      yErrorMeters: result.yErrorMeters,
    });

    if (driveResult.status !== "success") {
      this.phase = "stopped";
      this.stopRequested = false;
      this.logger.warn("segment_test.stopped", {
        completedRuns: results.length,
        reason: driveResult.status,
      });
      return null;
    }

    return result;
  }

  private pickRandomNonNearestWaypoint(currentPose: Pose, waypoints: Pose[]): { index: number; pose: Pose; distanceMeters: number } | null {
    const waypointsWithDistance = waypoints.map((pose, index) => ({
      index,
      pose,
      distanceMeters: unwrapMeters(distanceBetween(currentPose.position, pose.position)),
    }));

    waypointsWithDistance.sort((a, b) => a.distanceMeters - b.distanceMeters);
    if (waypointsWithDistance.length === 0) {
      return null;
    }

    const minDistance = waypointsWithDistance[0].distanceMeters + 1.0;
    const eligibleWaypoints = waypointsWithDistance.filter((waypoint) => waypoint.distanceMeters > minDistance);
    if (eligibleWaypoints.length === 0) {
      return null;
    }

    const randomIndex = Math.floor(this.random() * eligibleWaypoints.length);
    return eligibleWaypoints[randomIndex] ?? null;
  }

  private async sleepWithStopChecks(delayMs: number): Promise<boolean> {
    let remainingMs = delayMs;

    while (remainingMs > 0) {
      if (this.shouldStop()) {
        return false;
      }

      const chunkMs = Math.min(50, remainingMs);
      await this.sleep(chunkMs);
      remainingMs -= chunkMs;
    }

    return true;
  }

  private shouldStop(): boolean {
    return systemStop.isStopped() || this.stopRequested;
  }

  private logStopped(completedRuns: number, reason: "stop_requested" | "system_stop" | "pose_unavailable" | "waypoint_collection"): void {
    this.phase = "stopped";
    this.running = false;
    this.completedRuns = completedRuns;
    this.lastUpdated = new Date().toISOString();
    this.logger.warn("segment_test.stopped", {
      completedRuns,
      reason,
    });
  }
}
