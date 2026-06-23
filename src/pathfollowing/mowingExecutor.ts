import { PathPoint } from "./pathFollowerApi.js";
import { ContinuousPathFollower } from "./continuousPathFollower.js";
import { buildMowingPlan, type MowingBoundaryReference, type MowingInitialEntryPlan, type MowingPlan } from "./mowingPlanner.js";
import { buildPerimeterPathPointsFromPlan, buildPerimeterJoinPlan } from "./pathVerification.js";
import { RecentTargetSink } from "./segmentedBoundaryExecutor.js";
import { DriveController } from "../control/driveController.js";
import { TurnController } from "../control/turnController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { LoggerScope } from "../logging/types.js";
import { systemStop } from "../control/systemStop.js";
import { createPosition } from "../geometry/positionTypes.js";
import { headingDifference, unwrapRelativeAngle, createInternalHeading } from "../geometry/headingTypes.js";
import type { PathFollowingParameters } from "../config/pathFollowingConfig.js";
import { DEFAULT_PATH_FOLLOWING_PARAMETERS } from "../config/pathFollowingConfig.js";

export type MowingPhase =
  | "idle"
  | "approaching_area_perimeter"
  | "approaching_strip"
  | "tracing_boundary"
  | "mowing_strip"
  | "following_connector"
  | "complete"
  | "stopped"
  | "error";

export interface MowingStatus {
  readonly phase: MowingPhase;
  readonly currentStripIndex: number;
  readonly totalStrips: number;
  readonly tracedBoundaryCount: number;
  readonly error?: string;
}

export interface MowingExecutorOptions {
  readonly plan: MowingPlan;
  readonly initialEntryPlan?: MowingInitialEntryPlan;
  readonly areaPoints: ReadonlyArray<PathPoint>;
  readonly obstaclePointsArray: ReadonlyArray<ReadonlyArray<PathPoint>>;
  readonly driveController: DriveController;
  readonly turnController: TurnController;
  readonly poseFusion: PoseFusion;
  readonly continuousPathFollower: ContinuousPathFollower;
  readonly logger: LoggerScope;
  readonly parameters?: PathFollowingParameters;
  /**
   * Optional sink for recording boundary targets the segmented executor has
   * just completed. Wired through to perimeter traces and inter-strip
   * connectors so the retry manager can reverse-retrace recent targets when
   * a high-current obstruction interrupts a mowing run.
   */
  readonly recentTargetSink?: RecentTargetSink;
}

const PREFERRED_BOUNDARY_POINT_TOLERANCE_METERS = 0.05;
const AREA_ESCAPE_STOP_DISTANCE_METERS = 0.05;
const AREA_ESCAPE_CHECK_INTERVAL_MS = 100;
const MOWING_TARGET_REACHED_TOLERANCE_METERS = 0.1;
const PERIMETER_EXPLICIT_CORNER_TURN_DEG = 35;
const PERIMETER_CORNER_MIN_SEGMENT_METERS = 0.15;
const PERIMETER_CORNER_CAPTURE_DISTANCE_METERS = 0.3;

export class MowingExecutor {
  private plan: MowingPlan;
  private readonly initialEntryPlan: MowingInitialEntryPlan | null;
  private readonly areaPoints: ReadonlyArray<PathPoint>;
  private readonly obstaclePointsArray: ReadonlyArray<ReadonlyArray<PathPoint>>;
  private readonly driveController: DriveController;
  private readonly turnController: TurnController;
  private readonly poseFusion: PoseFusion;
  private readonly continuousPathFollower: ContinuousPathFollower;
  private readonly logger: LoggerScope;
  private readonly parameters: PathFollowingParameters;
  private readonly standoff: number;
  private readonly recentTargetSink: RecentTargetSink | undefined;

  private phase: MowingPhase = "idle";
  private currentStripIndex: number = 0;
  private tracedBoundaries: Set<string> = new Set();
  private stopRequested: boolean = false;
  private areaEscapeMonitor: NodeJS.Timeout | null = null;
  private outsideAreaViolationMessage: string | null = null;

  constructor(options: MowingExecutorOptions) {
    this.plan = options.plan;
    this.initialEntryPlan = options.initialEntryPlan ?? null;
    this.areaPoints = options.areaPoints;
    this.obstaclePointsArray = options.obstaclePointsArray;
    this.driveController = options.driveController;
    this.turnController = options.turnController;
    this.poseFusion = options.poseFusion;
    this.continuousPathFollower = options.continuousPathFollower;
    this.logger = options.logger;
    this.parameters = options.parameters ?? DEFAULT_PATH_FOLLOWING_PARAMETERS;
    this.standoff = this.parameters.mowingStandoffMeters;
    this.recentTargetSink = options.recentTargetSink;
  }

  getStatus(): MowingStatus {
    return {
      phase: this.phase,
      currentStripIndex: this.currentStripIndex,
      totalStrips: this.plan.strips.length,
      tracedBoundaryCount: this.tracedBoundaries.size,
    };
  }

  stop(): void {
    this.stopRequested = true;
  }

  async execute(): Promise<MowingStatus> {
    this.stopRequested = false;
    this.tracedBoundaries = new Set();
    this.outsideAreaViolationMessage = null;
    this.stopAreaEscapeMonitor();
    this.logger.info("mowing.execute.start", { stripCount: this.plan.strips.length });

    try {
      const initialEntryStatus = await this.executeInitialEntry();
      if (initialEntryStatus) {
        return initialEntryStatus;
      }

      this.reanchorPlanToCurrentPose();
      this.startAreaEscapeMonitor();
      const outsideAreaStatus = this.buildOutsideAreaStatus();
      if (outsideAreaStatus) {
        return outsideAreaStatus;
      }

      for (let index = 0; index < this.plan.strips.length; index += 1) {
        if (this.isStopped()) {
          const stoppedOutsideAreaStatus = this.buildOutsideAreaStatus();
          if (stoppedOutsideAreaStatus) {
            return stoppedOutsideAreaStatus;
          }
          this.phase = "stopped";
          return this.getStatus();
        }

        this.currentStripIndex = index;
        const strip = this.plan.strips[index];
        const stripStart = strip.traversalReversed ? strip.end : strip.start;
        const stripEnd = strip.traversalReversed ? strip.start : strip.end;
        const dir = normalise({
          x: stripEnd.xMeters - stripStart.xMeters,
          y: stripEnd.yMeters - stripStart.yMeters,
        });

        const entryStandoff = offsetPoint(stripStart, dir, this.standoff);
        const exitStandoff = offsetPoint(stripEnd, dir, -this.standoff);

        // 1. Segment-drive to entry standoff point
        this.phase = "approaching_strip";
        if (!this.isNearCurrentPose(entryStandoff.x, entryStandoff.y)) {
          const approachResult = await this.driveController.executeDrive({
            targetPosition: createPosition(entryStandoff.x, entryStandoff.y),
            learningEnabled: true,
          });
          if (approachResult.status !== "success") {
            if (approachResult.status === "stopped") {
              this.phase = "stopped";
              return this.getStatus();
            }
            this.phase = "error";
            return { ...this.getStatus(), error: `approach_failed:${approachResult.status}` };
          }
        }

        // 2. First encounter of start boundary → trace full loop
        const startBoundaryKey = this.boundaryKeyFromReference(
          strip.traversalReversed ? strip.endBoundary : strip.startBoundary,
        );
        if (!this.tracedBoundaries.has(startBoundaryKey)) {
          const traceResult = await this.traceBoundary(startBoundaryKey, stripStart);
          if (!traceResult) {
            return this.getStatus();
          }
          this.tracedBoundaries.add(startBoundaryKey);
        }

        if (this.isStopped()) {
          this.phase = "stopped";
          return this.getStatus();
        }

        // 3. Turn to face strip direction and segment-drive the strip
        const stripHeading = Math.atan2(dir.y, dir.x) * (180 / Math.PI);
        await this.turnToHeading(stripHeading);

        if (this.isStopped()) {
          this.phase = "stopped";
          return this.getStatus();
        }

        this.phase = "mowing_strip";
        if (!this.isNearCurrentPose(exitStandoff.x, exitStandoff.y)) {
          const stripResult = await this.driveController.executeDrive({
            targetPosition: createPosition(exitStandoff.x, exitStandoff.y),
            learningEnabled: true,
          });
          if (stripResult.status !== "success") {
            if (stripResult.status === "stopped") {
              this.phase = "stopped";
              return this.getStatus();
            }
            this.phase = "error";
            return { ...this.getStatus(), error: `strip_drive_failed:${stripResult.status}` };
          }
        }

        // 4. First encounter of end boundary → trace full loop
        const endBoundaryKey = this.boundaryKeyFromReference(
          strip.traversalReversed ? strip.startBoundary : strip.endBoundary,
        );
        if (!this.tracedBoundaries.has(endBoundaryKey)) {
          const traceResult = await this.traceBoundary(endBoundaryKey, stripEnd);
          if (!traceResult) {
            return this.getStatus();
          }
          this.tracedBoundaries.add(endBoundaryKey);
        }

        if (this.isStopped()) {
          this.phase = "stopped";
          return this.getStatus();
        }

        // 5. Follow connector to next strip entry standoff (not last strip)
        const isLastStrip = index === this.plan.strips.length - 1;
        if (!isLastStrip) {
          const nextStrip = this.plan.strips[index + 1];
          const connector = this.plan.connectors[index];
          const nextStripStart = nextStrip.traversalReversed ? nextStrip.end : nextStrip.start;
          const nextStripEnd = nextStrip.traversalReversed ? nextStrip.start : nextStrip.end;
          const nextDir = normalise({
            x: nextStripEnd.xMeters - nextStripStart.xMeters,
            y: nextStripEnd.yMeters - nextStripStart.yMeters,
          });
          const nextEntryStandoff = offsetPoint(nextStripStart, nextDir, this.standoff);
          const transitionResult = this.shouldUseDirectLaneTransfer(nextEntryStandoff.x, nextEntryStandoff.y)
            ? await this.followDirectLaneTransfer(nextEntryStandoff.x, nextEntryStandoff.y)
            : connector && connector.length >= 2
              ? await this.followConnector(connector)
              : { completed: true as const, reason: "reached_end" as const };
          if (transitionResult) {
            this.phase = "following_connector";
            if (!transitionResult.completed) {
              if (transitionResult.reason === "user_stopped") {
                this.phase = "stopped";
                return this.getStatus();
              }
              this.phase = "error";
              return { ...this.getStatus(), error: `connector_failed:${transitionResult.reason}` };
            }
          }
        }
      }

      this.phase = "complete";
      this.logger.info("mowing.execute.complete", { strips: this.plan.strips.length, tracedBoundaries: this.tracedBoundaries.size });
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("mowing.execute.error", { error: message });
      this.phase = "error";
      return { ...this.getStatus(), error: message };
    } finally {
      this.stopAreaEscapeMonitor();
    }
  }

  private async executeInitialEntry(): Promise<MowingStatus | null> {
    const entryPlan = this.initialEntryPlan;
    if (!entryPlan) {
      return null;
    }
    if (this.isStopped()) {
      const outsideAreaStatus = this.buildOutsideAreaStatus();
      if (outsideAreaStatus) {
        return outsideAreaStatus;
      }
      this.phase = "stopped";
      return this.getStatus();
    }

    if (!pointInPolygon(
      entryPlan.approachTarget.xMeters,
      entryPlan.approachTarget.yMeters,
      this.areaPoints,
    )) {
      const insideApproachTarget = movePointInsideArea(
        entryPlan.entryPoint,
        entryPlan.approachTarget,
        this.areaPoints,
        this.standoff,
      );
      this.logger.info("mowing.initial_entry.adjusted_inside_area", {
        originalApproachX: entryPlan.approachTarget.xMeters,
        originalApproachY: entryPlan.approachTarget.yMeters,
        adjustedApproachX: insideApproachTarget.x,
        adjustedApproachY: insideApproachTarget.y,
      });
      return this.executeInitialEntryDriveAndTrace(entryPlan, insideApproachTarget);
    }

    return this.executeInitialEntryDriveAndTrace(entryPlan, entryPlan.approachTarget);
  }

  private async executeInitialEntryDriveAndTrace(
    entryPlan: MowingInitialEntryPlan,
    approachTarget: { xMeters: number; yMeters: number } | { x: number; y: number },
  ): Promise<MowingStatus | null> {
    this.phase = "approaching_area_perimeter";
    this.currentStripIndex = 0;
    this.logger.info("mowing.initial_entry.start", {
      segmentIndex: entryPlan.segmentIndex,
      entryX: entryPlan.entryPoint.xMeters,
      entryY: entryPlan.entryPoint.yMeters,
      approachX: "xMeters" in approachTarget ? approachTarget.xMeters : approachTarget.x,
      approachY: "yMeters" in approachTarget ? approachTarget.yMeters : approachTarget.y,
      distanceMeters: entryPlan.distanceMeters,
    });

    const approachX = "xMeters" in approachTarget ? approachTarget.xMeters : approachTarget.x;
    const approachY = "yMeters" in approachTarget ? approachTarget.yMeters : approachTarget.y;
    if (!this.isNearCurrentPose(approachX, approachY)) {
      const approachResult = await this.driveController.executeDrive({
        targetPosition: createPosition(approachX, approachY),
        learningEnabled: true,
      });
      if (approachResult.status !== "success") {
        if (approachResult.status === "stopped") {
          const outsideAreaStatus = this.buildOutsideAreaStatus();
          if (outsideAreaStatus) {
            return outsideAreaStatus;
          }
          this.phase = "stopped";
          return this.getStatus();
        }
        this.phase = "error";
        return { ...this.getStatus(), error: `initial_entry_failed:${approachResult.status}` };
      }
    }

    if (this.isStopped()) {
      const outsideAreaStatus = this.buildOutsideAreaStatus();
      if (outsideAreaStatus) {
        return outsideAreaStatus;
      }
      this.phase = "stopped";
      return this.getStatus();
    }

    const traceResult = await this.traceBoundary("area", entryPlan.entryPoint);
    if (!traceResult) {
      return this.getStatus();
    }

    this.tracedBoundaries.add("area");
    this.logger.info("mowing.initial_entry.done", {
      tracedBoundary: "area",
      segmentIndex: entryPlan.segmentIndex,
    });
    return null;
  }

  private async traceBoundary(boundaryKey: string, nearPoint: PathPoint): Promise<boolean> {
    this.phase = "tracing_boundary";
    this.logger.info("mowing.trace_boundary.start", {
      boundary: boundaryKey,
      nearX: nearPoint.xMeters,
      nearY: nearPoint.yMeters,
    });

    const boundaryPoints = insertPreferredBoundaryPoint(this.getBoundaryPoints(boundaryKey), nearPoint);
    if (boundaryPoints.length < 3) {
      this.logger.warn("mowing.trace_boundary.too_short", { boundary: boundaryKey });
      return true;
    }

    const currentPose = this.poseFusion.getCurrentPose();
    const anchoredJoinPose = {
      ...currentPose,
      position: createPosition(nearPoint.xMeters, nearPoint.yMeters),
    };
    const joinPlan = buildPerimeterJoinPlan(boundaryPoints, anchoredJoinPose, this.parameters);
    if (!joinPlan) {
      this.logger.warn("mowing.trace_boundary.no_join_plan", { boundary: boundaryKey });
      return true;
    }

    const turnAngle = headingDifference(currentPose.heading, joinPlan.tangentHeading);
    if (Math.abs(unwrapRelativeAngle(turnAngle)) > this.parameters.turnAlignmentThresholdDeg) {
      const turnResult = await this.turnController.executeTurn({
        targetAngle: turnAngle,
        direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
        learningEnabled: true,
      });
      if (turnResult.status !== "success") {
        if (turnResult.status === "stopped") {
          this.phase = "stopped";
          return false;
        }
      }
    }

    if (this.isStopped()) {
      this.phase = "stopped";
      return false;
    }

    const loopPoints = buildPerimeterPathPointsFromPlan(boundaryPoints, joinPlan, this.parameters);
    if (loopPoints.length < 2) {
      return true;
    }

    const followResult = await this.executePerimeterRuns(loopPoints);
    if (!followResult.completed) {
      if (followResult.reason === "user_stopped") {
        this.phase = "stopped";
        return false;
      }
      this.phase = "error";
      this.logger.warn("mowing.trace_boundary.failed", {
        boundary: boundaryKey,
        reason: followResult.reason,
        error: followResult.error,
      });
      return false;
    }

    this.logger.info("mowing.trace_boundary.done", { boundary: boundaryKey });
    return true;
  }

  private async executePerimeterRuns(loopPoints: ReadonlyArray<PathPoint>): Promise<{
    readonly completed: boolean;
    readonly reason: "reached_end" | "user_stopped" | "error";
    readonly error?: string;
  }> {
    const cornerIndices = findSharpCornerIndices(loopPoints, PERIMETER_EXPLICIT_CORNER_TURN_DEG, PERIMETER_CORNER_MIN_SEGMENT_METERS);
    let runStartIndex = 0;
    let preserveFirstTargetAtPose = true;
    let pendingLeadPoint: PathPoint | null = null;

    for (const cornerIndex of [...cornerIndices, loopPoints.length - 1]) {
      const baseRunPoints = loopPoints.slice(runStartIndex, cornerIndex + 1);
      const runPoints = pendingLeadPoint
        ? [pendingLeadPoint, ...baseRunPoints]
        : baseRunPoints;
      if (runPoints.length >= 2) {
        const followResult = await this.continuousPathFollower.executePath(runPoints, {
          parameters: this.parameters,
          preserveFirstTargetAtPose,
          loopPath: false,
          strictOrderedProgress: true,
          minimumSpeed: 0.68,
          pivotIfInnerWheelBelow: 0.45,
        });
        preserveFirstTargetAtPose = false;
        pendingLeadPoint = null;
        if (!followResult.completed) {
          return {
            completed: false,
            reason: followResult.reason === "user_stopped" ? "user_stopped" : "error",
            error: followResult.error ?? (followResult.reason === "obstruction"
              ? "perimeter_follow_obstruction"
              : "perimeter_follow_failed"),
          };
        }
      }

      if (cornerIndex >= loopPoints.length - 1) {
        break;
      }

      const cornerPoint = loopPoints[cornerIndex];
      const nextPoint = loopPoints[cornerIndex + 1];
      const currentPose = this.poseFusion.getCurrentPose();
      const targetHeading = createInternalHeading(
        Math.atan2(nextPoint.yMeters - cornerPoint.yMeters, nextPoint.xMeters - cornerPoint.xMeters) * (180 / Math.PI),
      );
      const turnAngle = headingDifference(currentPose.heading, targetHeading);
      if (Math.abs(unwrapRelativeAngle(turnAngle)) > this.parameters.turnAlignmentThresholdDeg) {
        const turnResult = await this.turnController.executeTurn({
          targetAngle: turnAngle,
          direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
          learningEnabled: true,
        });
        if (turnResult.status !== "success") {
          return {
            completed: false,
            reason: turnResult.status === "stopped" ? "user_stopped" : "error",
            error: "perimeter_corner_turn_failed",
          };
        }
      }

      const captureResult = await this.capturePerimeterRunAfterCorner(cornerPoint, nextPoint);
      if (!captureResult.completed) {
        return {
          completed: false,
          reason: captureResult.reason === "user_stopped" ? "user_stopped" : "error",
          error: captureResult.error ?? "perimeter_corner_capture_failed",
        };
      }

      const capturePoint = captureResult.capturePoint;
      if (capturePoint) {
        pendingLeadPoint = capturePoint;
      }
      runStartIndex = cornerIndex + 1;
      preserveFirstTargetAtPose = false;
    }

    return { completed: true, reason: "reached_end" };
  }

  private async capturePerimeterRunAfterCorner(
    cornerPoint: PathPoint,
    nextPoint: PathPoint,
  ): Promise<{
    readonly completed: boolean;
    readonly reason: "reached_end" | "user_stopped" | "error";
    readonly error?: string;
    readonly capturePoint?: PathPoint;
  }> {
    const segmentDx = nextPoint.xMeters - cornerPoint.xMeters;
    const segmentDy = nextPoint.yMeters - cornerPoint.yMeters;
    const segmentLengthMeters = Math.hypot(segmentDx, segmentDy);
    if (segmentLengthMeters <= MOWING_TARGET_REACHED_TOLERANCE_METERS) {
      return { completed: true, reason: "reached_end" };
    }

    const desiredCaptureDistanceMeters = Math.min(
      PERIMETER_CORNER_CAPTURE_DISTANCE_METERS,
      segmentLengthMeters,
    );
    const pose = this.poseFusion.getCurrentPose();
    const poseDx = pose.position.xMeters - cornerPoint.xMeters;
    const poseDy = pose.position.yMeters - cornerPoint.yMeters;
    const projectionRatio = Math.max(
      0,
      Math.min(
        1,
        ((poseDx * segmentDx) + (poseDy * segmentDy)) / Math.max(segmentLengthMeters * segmentLengthMeters, 1e-9),
      ),
    );
    const liveAlongSegmentMeters = projectionRatio * segmentLengthMeters;
    const captureDistanceMeters = Math.max(desiredCaptureDistanceMeters, liveAlongSegmentMeters);
    const captureRatio = captureDistanceMeters / Math.max(segmentLengthMeters, 1e-9);
    const capturePoint: PathPoint = {
      xMeters: cornerPoint.xMeters + (segmentDx * captureRatio),
      yMeters: cornerPoint.yMeters + (segmentDy * captureRatio),
      capturedAt: nextPoint.capturedAt,
    };

    if (this.isNearCurrentPose(capturePoint.xMeters, capturePoint.yMeters)) {
      return {
        completed: true,
        reason: "reached_end",
        capturePoint,
      };
    }

    this.logger.info("mowing.trace_boundary.corner_capture.start", {
      fromX: cornerPoint.xMeters,
      fromY: cornerPoint.yMeters,
      toX: capturePoint.xMeters,
      toY: capturePoint.yMeters,
      distanceMeters: captureDistanceMeters,
      desiredDistanceMeters: desiredCaptureDistanceMeters,
      liveAlongSegmentMeters,
    });

    const driveResult = await this.driveController.executeDrive({
      targetPosition: createPosition(capturePoint.xMeters, capturePoint.yMeters),
      learningEnabled: true,
    });
    if (driveResult.status !== "success") {
      return {
        completed: false,
        reason: driveResult.status === "stopped" ? "user_stopped" : "error",
        error: "perimeter_corner_capture_failed",
      };
    }

    return {
      completed: true,
      reason: "reached_end",
      capturePoint,
    };
  }

  private async followConnector(connector: ReadonlyArray<PathPoint>): Promise<{
    readonly completed: boolean;
    readonly reason: "reached_end" | "user_stopped" | "error";
    readonly error?: string;
  }> {
    if (connector.length < 2) {
      return { completed: true, reason: "reached_end" };
    }

    if (connector.length === 2) {
      const target = connector[connector.length - 1];
      if (this.isNearCurrentPose(target.xMeters, target.yMeters)) {
        return { completed: true, reason: "reached_end" };
      }
      const driveResult = await this.driveController.executeDrive({
        targetPosition: createPosition(target.xMeters, target.yMeters),
        learningEnabled: true,
      });
      if (driveResult.status === "success") {
        return { completed: true, reason: "reached_end" };
      }
      return {
        completed: false,
        reason: driveResult.status === "stopped" ? "user_stopped" : "error",
        error: driveResult.errorMessage,
      };
    }

    const followResult = await this.continuousPathFollower.executePath(
      [...connector],
      {
        parameters: this.parameters,
        loopPath: false,
        strictOrderedProgress: true,
      },
    );
    if (followResult.completed) {
      return { completed: true, reason: "reached_end" };
    }
    return {
      completed: false,
      reason: followResult.reason === "user_stopped" ? "user_stopped" : "error",
      error: followResult.error,
    };
  }

  private async turnToHeading(targetHeadingDeg: number): Promise<void> {
    const currentPose = this.poseFusion.getCurrentPose();
    const targetHeading = createInternalHeading(targetHeadingDeg);
    const turnAngle = headingDifference(currentPose.heading, targetHeading);
    if (Math.abs(unwrapRelativeAngle(turnAngle)) <= this.parameters.turnAlignmentThresholdDeg) {
      return;
    }
    await this.turnController.executeTurn({
      targetAngle: turnAngle,
      direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
      learningEnabled: true,
    });
  }

  private boundaryKeyFromReference(boundary: MowingBoundaryReference): string {
    return boundary.kind === "area" ? "area" : `obstacle:${boundary.obstacleIndex}`;
  }

  private shouldUseDirectLaneTransfer(targetX: number, targetY: number): boolean {
    const pose = this.poseFusion.getCurrentPose();
    return !this.segmentIntersectsAnyObstacle(
      pose.position.xMeters,
      pose.position.yMeters,
      targetX,
      targetY,
    );
  }

  private async followDirectLaneTransfer(targetX: number, targetY: number): Promise<{
    readonly completed: boolean;
    readonly reason: "reached_end" | "user_stopped" | "error";
    readonly error?: string;
  }> {
    if (this.isNearCurrentPose(targetX, targetY)) {
      return { completed: true, reason: "reached_end" };
    }

    const driveResult = await this.driveController.executeDrive({
      targetPosition: createPosition(targetX, targetY),
      learningEnabled: true,
    });
    if (driveResult.status === "success") {
      return { completed: true, reason: "reached_end" };
    }
    return {
      completed: false,
      reason: driveResult.status === "stopped" ? "user_stopped" : "error",
      error: driveResult.errorMessage,
    };
  }

  private isNearCurrentPose(x: number, y: number, toleranceMeters: number = MOWING_TARGET_REACHED_TOLERANCE_METERS): boolean {
    const pose = this.poseFusion.getCurrentPose();
    return Math.hypot(
      pose.position.xMeters - x,
      pose.position.yMeters - y,
    ) <= toleranceMeters;
  }

  private segmentIntersectsAnyObstacle(startX: number, startY: number, endX: number, endY: number): boolean {
    return this.obstaclePointsArray.some((obstacle) => segmentIntersectsPolygon(
      { x: startX, y: startY },
      { x: endX, y: endY },
      normalizePolygon(obstacle),
    ));
  }

  private reanchorPlanToCurrentPose(): void {
    if (this.plan.strips.length <= 1) {
      return;
    }

    const pose = this.poseFusion.getCurrentPose();
    const replanned = buildMowingPlan(
      [...this.areaPoints],
      {
        headingDeg: this.plan.headingDeg,
        stripSpacingMeters: this.plan.stripSpacingMeters,
        bladeWidthMeters: this.plan.bladeWidthMeters,
        mowingStandoffMeters: this.parameters.mowingStandoffMeters,
        preferredStartPoint: {
          xMeters: pose.position.xMeters,
          yMeters: pose.position.yMeters,
        },
        obstacles: this.obstaclePointsArray,
      },
    );

    if (replanned.stripCount !== this.plan.stripCount) {
      this.logger.warn("mowing.plan_reanchor_rejected", {
        originalStripCount: this.plan.stripCount,
        replannedStripCount: replanned.stripCount,
      });
      return;
    }

    this.plan = replanned;
    this.currentStripIndex = 0;
    this.logger.info("mowing.plan_reanchored", {
      stripCount: this.plan.stripCount,
      poseX: pose.position.xMeters,
      poseY: pose.position.yMeters,
      firstStripStartX: this.plan.strips[0]?.traversalReversed
        ? this.plan.strips[0].end.xMeters
        : this.plan.strips[0].start.xMeters,
      firstStripStartY: this.plan.strips[0]?.traversalReversed
        ? this.plan.strips[0].end.yMeters
        : this.plan.strips[0].start.yMeters,
    });
  }

  private getBoundaryPoints(key: string): ReadonlyArray<PathPoint> {
    if (key === "area") {
      return [...this.areaPoints];
    }
    const match = key.match(/^obstacle:(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      return this.obstaclePointsArray[idx] ?? [];
    }
    return [];
  }

  private startAreaEscapeMonitor(): void {
    if (this.areaEscapeMonitor) {
      clearInterval(this.areaEscapeMonitor);
    }
    this.areaEscapeMonitor = setInterval(() => {
      if (this.outsideAreaViolationMessage || this.stopRequested || systemStop.isStopped()) {
        return;
      }
      const pose = this.poseFusion.getCurrentPose();
      const outsideDistanceMeters = outsideDistanceFromAreaMeters(
        pose.position.xMeters,
        pose.position.yMeters,
        this.areaPoints,
      );
      if (outsideDistanceMeters <= AREA_ESCAPE_STOP_DISTANCE_METERS) {
        return;
      }
      this.outsideAreaViolationMessage = `outside_mowing_area:${outsideDistanceMeters.toFixed(2)}m`;
      this.logger.warn("mowing.outside_area_limit_exceeded", {
        xMeters: pose.position.xMeters,
        yMeters: pose.position.yMeters,
        outsideDistanceMeters,
        limitMeters: AREA_ESCAPE_STOP_DISTANCE_METERS,
      });
      systemStop.requestStop("mowing", "outside_mowing_area_limit_exceeded");
    }, AREA_ESCAPE_CHECK_INTERVAL_MS);
  }

  private stopAreaEscapeMonitor(): void {
    if (!this.areaEscapeMonitor) {
      return;
    }
    clearInterval(this.areaEscapeMonitor);
    this.areaEscapeMonitor = null;
  }

  private buildOutsideAreaStatus(): MowingStatus | null {
    if (!this.outsideAreaViolationMessage) {
      return null;
    }
    this.phase = "error";
    return { ...this.getStatus(), error: this.outsideAreaViolationMessage };
  }

  private isStopped(): boolean {
    return this.stopRequested || systemStop.isStopped();
  }
}

function normalise(v: { x: number; y: number }): { x: number; y: number } {
  const len = Math.hypot(v.x, v.y);
  return len < 1e-9 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len };
}

function offsetPoint(p: PathPoint, dir: { x: number; y: number }, distance: number): { x: number; y: number } {
  return { x: p.xMeters + dir.x * distance, y: p.yMeters + dir.y * distance };
}

function pointToPathDistance(point: PathPoint, path: ReadonlyArray<PathPoint>): number {
  let nearest = Infinity;
  for (const p of path) {
    const d = Math.hypot(p.xMeters - point.xMeters, p.yMeters - point.yMeters);
    if (d < nearest) {
      nearest = d;
    }
  }
  return nearest;
}

function insertPreferredBoundaryPoint(boundaryPoints: ReadonlyArray<PathPoint>, preferredPoint: PathPoint): PathPoint[] {
  if (boundaryPoints.length < 2) {
    return boundaryPoints.slice();
  }

  const points = boundaryPoints.slice();
  const first = points[0];
  const last = points[points.length - 1];
  const wasClosed = pointDistance(first, last) <= PREFERRED_BOUNDARY_POINT_TOLERANCE_METERS;
  if (wasClosed) {
    points.pop();
  }

  if (points.some((point) => pointDistance(point, preferredPoint) <= PREFERRED_BOUNDARY_POINT_TOLERANCE_METERS)) {
    return wasClosed ? points.concat([points[0]]) : points;
  }

  let nearestSegmentIndex = 0;
  let nearestDistance = Infinity;
  const segmentCount = wasClosed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const distance = pointToSegmentDistance(preferredPoint, current, next);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestSegmentIndex = index;
    }
  }

  points.splice(nearestSegmentIndex + 1, 0, preferredPoint);
  return wasClosed ? points.concat([points[0]]) : points;
}

function pointToSegmentDistance(point: PathPoint, start: PathPoint, end: PathPoint): number {
  const segmentX = end.xMeters - start.xMeters;
  const segmentY = end.yMeters - start.yMeters;
  const lengthSquared = (segmentX * segmentX) + (segmentY * segmentY);
  if (lengthSquared <= 1e-9) {
    return pointDistance(point, start);
  }

  const t = Math.max(0, Math.min(1, (((point.xMeters - start.xMeters) * segmentX) + ((point.yMeters - start.yMeters) * segmentY)) / lengthSquared));
  const projected = {
    xMeters: start.xMeters + (segmentX * t),
    yMeters: start.yMeters + (segmentY * t),
    capturedAt: point.capturedAt,
  };
  return pointDistance(point, projected);
}

function pointDistance(a: PathPoint, b: PathPoint): number {
  return Math.hypot(a.xMeters - b.xMeters, a.yMeters - b.yMeters);
}

function findSharpCornerIndices(
  points: ReadonlyArray<PathPoint>,
  thresholdDeg: number,
  minSegmentMeters: number,
): number[] {
  const indices: number[] = [];
  if (points.length < 3) {
    return indices;
  }

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const incomingDx = current.xMeters - previous.xMeters;
    const incomingDy = current.yMeters - previous.yMeters;
    const outgoingDx = next.xMeters - current.xMeters;
    const outgoingDy = next.yMeters - current.yMeters;
    const incomingLength = Math.hypot(incomingDx, incomingDy);
    const outgoingLength = Math.hypot(outgoingDx, outgoingDy);
    if (incomingLength < minSegmentMeters || outgoingLength < minSegmentMeters) {
      continue;
    }

    const incomingHeading = Math.atan2(incomingDy, incomingDx) * (180 / Math.PI);
    const outgoingHeading = Math.atan2(outgoingDy, outgoingDx) * (180 / Math.PI);
    const turnDeg = Math.abs(normalizeSignedDegrees(outgoingHeading - incomingHeading));
    if (turnDeg >= thresholdDeg) {
      indices.push(index);
    }
  }

  return indices;
}

function normalizeSignedDegrees(angleDeg: number): number {
  let normalized = ((angleDeg + 180) % 360 + 360) % 360 - 180;
  if (normalized === -180) {
    normalized = 180;
  }
  return normalized;
}

function normalizePolygon(points: ReadonlyArray<PathPoint>): Array<{ x: number; y: number }> {
  if (points.length === 0) {
    return [];
  }
  const polygon = points.map((point) => ({ x: point.xMeters, y: point.yMeters }));
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9) {
    polygon.pop();
  }
  return polygon;
}

function pointInPolygon(x: number, y: number, polygonPoints: ReadonlyArray<PathPoint>): boolean {
  const polygon = normalizePolygon(polygonPoints);
  if (polygon.length < 3) {
    return false;
  }

  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const prior = polygon[previous];
    const intersects = ((current.y > y) !== (prior.y > y))
      && (x < (((prior.x - current.x) * (y - current.y)) / ((prior.y - current.y) || 1e-12)) + current.x);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function outsideDistanceFromAreaMeters(x: number, y: number, polygonPoints: ReadonlyArray<PathPoint>): number {
  if (pointInPolygon(x, y, polygonPoints)) {
    return 0;
  }

  const polygon = normalizePolygon(polygonPoints);
  if (polygon.length < 2) {
    return Infinity;
  }

  let nearest = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    nearest = Math.min(nearest, pointToSegmentDistanceMeters(x, y, start.x, start.y, end.x, end.y));
  }
  return nearest;
}

function movePointInsideArea(
  entryPoint: PathPoint,
  approachTarget: { xMeters: number; yMeters: number },
  polygonPoints: ReadonlyArray<PathPoint>,
  preferredInsetMeters: number,
): { x: number; y: number } {
  const dx = approachTarget.xMeters - entryPoint.xMeters;
  const dy = approachTarget.yMeters - entryPoint.yMeters;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) {
    return { x: entryPoint.xMeters, y: entryPoint.yMeters };
  }

  const inset = Math.max(0.02, preferredInsetMeters);
  const candidate = {
    x: entryPoint.xMeters - ((dx / length) * inset),
    y: entryPoint.yMeters - ((dy / length) * inset),
  };
  if (pointInPolygon(candidate.x, candidate.y, polygonPoints)) {
    return candidate;
  }

  for (let scale = 1.5; scale <= 4; scale += 0.5) {
    const retried = {
      x: entryPoint.xMeters - ((dx / length) * inset * scale),
      y: entryPoint.yMeters - ((dy / length) * inset * scale),
    };
    if (pointInPolygon(retried.x, retried.y, polygonPoints)) {
      return retried;
    }
  }

  return { x: entryPoint.xMeters, y: entryPoint.yMeters };
}

function pointToSegmentDistanceMeters(
  x: number,
  y: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const lengthSquared = (segmentX * segmentX) + (segmentY * segmentY);
  if (lengthSquared <= 1e-12) {
    return Math.hypot(x - startX, y - startY);
  }

  const t = Math.max(0, Math.min(1, (((x - startX) * segmentX) + ((y - startY) * segmentY)) / lengthSquared));
  const projectedX = startX + (segmentX * t);
  const projectedY = startY + (segmentY * t);
  return Math.hypot(x - projectedX, y - projectedY);
}

function segmentIntersectsPolygon(
  start: { x: number; y: number },
  end: { x: number; y: number },
  polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  if (polygon.length < 2) {
    return false;
  }
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    if (segmentsIntersect(start, end, current, next)) {
      return true;
    }
  }
  return false;
}

function segmentsIntersect(
  aStart: { x: number; y: number },
  aEnd: { x: number; y: number },
  bStart: { x: number; y: number },
  bEnd: { x: number; y: number },
): boolean {
  const o1 = orientation(aStart, aEnd, bStart);
  const o2 = orientation(aStart, aEnd, bEnd);
  const o3 = orientation(bStart, bEnd, aStart);
  const o4 = orientation(bStart, bEnd, aEnd);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }
  if (o1 === 0 && onSegment(aStart, bStart, aEnd)) {
    return true;
  }
  if (o2 === 0 && onSegment(aStart, bEnd, aEnd)) {
    return true;
  }
  if (o3 === 0 && onSegment(bStart, aStart, bEnd)) {
    return true;
  }
  if (o4 === 0 && onSegment(bStart, aEnd, bEnd)) {
    return true;
  }
  return false;
}

function orientation(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  const value = ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
  if (Math.abs(value) <= 1e-9) {
    return 0;
  }
  return value > 0 ? 1 : 2;
}

function onSegment(
  start: { x: number; y: number },
  point: { x: number; y: number },
  end: { x: number; y: number },
): boolean {
  return point.x <= Math.max(start.x, end.x) + 1e-9
    && point.x + 1e-9 >= Math.min(start.x, end.x)
    && point.y <= Math.max(start.y, end.y) + 1e-9
    && point.y + 1e-9 >= Math.min(start.y, end.y);
}
