import { PathPoint } from "./pathFollowerApi.js";
import type { MowingInitialEntryPlan, MowingPlan } from "./mowingPlanner.js";
import { buildPerimeterPathPointsFromPlan, buildPerimeterJoinPlan } from "./pathVerification.js";
import { executeSegmentedBoundaryPath, RecentTargetSink } from "./segmentedBoundaryExecutor.js";
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

const TURN_ALIGNMENT_THRESHOLD_DEG = 2;
const PREFERRED_BOUNDARY_POINT_TOLERANCE_METERS = 0.05;

export class MowingExecutor {
  private readonly plan: MowingPlan;
  private readonly initialEntryPlan: MowingInitialEntryPlan | null;
  private readonly areaPoints: ReadonlyArray<PathPoint>;
  private readonly obstaclePointsArray: ReadonlyArray<ReadonlyArray<PathPoint>>;
  private readonly driveController: DriveController;
  private readonly turnController: TurnController;
  private readonly poseFusion: PoseFusion;
  private readonly logger: LoggerScope;
  private readonly parameters: PathFollowingParameters;
  private readonly standoff: number;
  private readonly recentTargetSink: RecentTargetSink | undefined;

  private phase: MowingPhase = "idle";
  private currentStripIndex: number = 0;
  private tracedBoundaries: Set<string> = new Set();
  private stopRequested: boolean = false;

  constructor(options: MowingExecutorOptions) {
    this.plan = options.plan;
    this.initialEntryPlan = options.initialEntryPlan ?? null;
    this.areaPoints = options.areaPoints;
    this.obstaclePointsArray = options.obstaclePointsArray;
    this.driveController = options.driveController;
    this.turnController = options.turnController;
    this.poseFusion = options.poseFusion;
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
    this.logger.info("mowing.execute.start", { stripCount: this.plan.strips.length });

    try {
      const initialEntryStatus = await this.executeInitialEntry();
      if (initialEntryStatus) {
        return initialEntryStatus;
      }

      for (let index = 0; index < this.plan.strips.length; index += 1) {
        if (this.isStopped()) {
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

        // 2. First encounter of start boundary → trace full loop
        const startBoundaryKey = this.nearestBoundaryKey(stripStart);
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

        // 4. First encounter of end boundary → trace full loop
        const endBoundaryKey = this.nearestBoundaryKey(stripEnd);
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
          const connector = this.plan.connectors[index];
          if (connector && connector.length >= 2) {
            this.phase = "following_connector";
            const connectorResult = await executeSegmentedBoundaryPath(
              [...connector],
              this.driveController,
              {
                parameters: this.parameters,
                learningEnabled: true,
                startPose: this.poseFusion.getCurrentPose(),
                recentTargetSink: this.recentTargetSink,
              },
            );
            if (!connectorResult.completed) {
              if (connectorResult.reason === "user_stopped") {
                this.phase = "stopped";
                return this.getStatus();
              }
              this.phase = "error";
              return { ...this.getStatus(), error: `connector_failed:${connectorResult.reason}` };
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
    }
  }

  private async executeInitialEntry(): Promise<MowingStatus | null> {
    if (!this.initialEntryPlan) {
      return null;
    }
    if (this.isStopped()) {
      this.phase = "stopped";
      return this.getStatus();
    }

    this.phase = "approaching_area_perimeter";
    this.currentStripIndex = 0;
    this.logger.info("mowing.initial_entry.start", {
      segmentIndex: this.initialEntryPlan.segmentIndex,
      entryX: this.initialEntryPlan.entryPoint.xMeters,
      entryY: this.initialEntryPlan.entryPoint.yMeters,
      approachX: this.initialEntryPlan.approachTarget.xMeters,
      approachY: this.initialEntryPlan.approachTarget.yMeters,
      distanceMeters: this.initialEntryPlan.distanceMeters,
    });

    const approachResult = await this.driveController.executeDrive({
      targetPosition: createPosition(
        this.initialEntryPlan.approachTarget.xMeters,
        this.initialEntryPlan.approachTarget.yMeters,
      ),
      learningEnabled: true,
    });
    if (approachResult.status !== "success") {
      if (approachResult.status === "stopped") {
        this.phase = "stopped";
        return this.getStatus();
      }
      this.phase = "error";
      return { ...this.getStatus(), error: `initial_entry_failed:${approachResult.status}` };
    }

    if (this.isStopped()) {
      this.phase = "stopped";
      return this.getStatus();
    }

    const traceResult = await this.traceBoundary("area", this.initialEntryPlan.entryPoint);
    if (!traceResult) {
      return this.getStatus();
    }

    this.tracedBoundaries.add("area");
    this.logger.info("mowing.initial_entry.done", {
      tracedBoundary: "area",
      segmentIndex: this.initialEntryPlan.segmentIndex,
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
    const joinPlan = buildPerimeterJoinPlan(boundaryPoints, currentPose, this.parameters);
    if (!joinPlan) {
      this.logger.warn("mowing.trace_boundary.no_join_plan", { boundary: boundaryKey });
      return true;
    }

    const turnAngle = headingDifference(currentPose.heading, joinPlan.tangentHeading);
    if (Math.abs(unwrapRelativeAngle(turnAngle)) > TURN_ALIGNMENT_THRESHOLD_DEG) {
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

    const followResult = await executeSegmentedBoundaryPath(
      loopPoints,
      this.driveController,
      {
        parameters: this.parameters,
        learningEnabled: true,
        startPose: this.poseFusion.getCurrentPose(),
        recentTargetSink: this.recentTargetSink,
      },
    );
    if (!followResult.completed && followResult.reason === "user_stopped") {
      this.phase = "stopped";
      return false;
    }

    this.logger.info("mowing.trace_boundary.done", { boundary: boundaryKey });
    return true;
  }

  private async turnToHeading(targetHeadingDeg: number): Promise<void> {
    const currentPose = this.poseFusion.getCurrentPose();
    const targetHeading = createInternalHeading(targetHeadingDeg);
    const turnAngle = headingDifference(currentPose.heading, targetHeading);
    if (Math.abs(unwrapRelativeAngle(turnAngle)) <= TURN_ALIGNMENT_THRESHOLD_DEG) {
      return;
    }
    await this.turnController.executeTurn({
      targetAngle: turnAngle,
      direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
      learningEnabled: true,
    });
  }

  private nearestBoundaryKey(point: PathPoint): string {
    let nearestKey = "area";
    let nearestDist = pointToPathDistance(point, this.areaPoints);

    this.obstaclePointsArray.forEach((obstacle, obstacleIndex) => {
      const dist = pointToPathDistance(point, obstacle);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestKey = `obstacle:${obstacleIndex}`;
      }
    });

    return nearestKey;
  }

  private getBoundaryPoints(key: string): ReadonlyArray<PathPoint> {
    if (key === "area") {
      return this.areaPoints;
    }
    const match = key.match(/^obstacle:(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      return this.obstaclePointsArray[idx] ?? [];
    }
    return [];
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
