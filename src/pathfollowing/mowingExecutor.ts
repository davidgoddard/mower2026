import { PathPoint, IPathFollower } from "./pathFollowerApi.js";
import { MowingPlan } from "./mowingPlanner.js";
import { buildPerimeterPathPointsFromPlan, buildPerimeterJoinPlan } from "./pathVerification.js";
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
  readonly areaPoints: ReadonlyArray<PathPoint>;
  readonly obstaclePointsArray: ReadonlyArray<ReadonlyArray<PathPoint>>;
  readonly driveController: DriveController;
  readonly turnController: TurnController;
  readonly pathFollower: IPathFollower;
  readonly poseFusion: PoseFusion;
  readonly logger: LoggerScope;
  readonly parameters?: PathFollowingParameters;
}

const TURN_ALIGNMENT_THRESHOLD_DEG = 2;

export class MowingExecutor {
  private readonly plan: MowingPlan;
  private readonly areaPoints: ReadonlyArray<PathPoint>;
  private readonly obstaclePointsArray: ReadonlyArray<ReadonlyArray<PathPoint>>;
  private readonly driveController: DriveController;
  private readonly turnController: TurnController;
  private readonly pathFollower: IPathFollower;
  private readonly poseFusion: PoseFusion;
  private readonly logger: LoggerScope;
  private readonly parameters: PathFollowingParameters;
  private readonly standoff: number;

  private phase: MowingPhase = "idle";
  private currentStripIndex: number = 0;
  private tracedBoundaries: Set<string> = new Set();
  private stopRequested: boolean = false;

  constructor(options: MowingExecutorOptions) {
    this.plan = options.plan;
    this.areaPoints = options.areaPoints;
    this.obstaclePointsArray = options.obstaclePointsArray;
    this.driveController = options.driveController;
    this.turnController = options.turnController;
    this.pathFollower = options.pathFollower;
    this.poseFusion = options.poseFusion;
    this.logger = options.logger;
    this.parameters = options.parameters ?? DEFAULT_PATH_FOLLOWING_PARAMETERS;
    this.standoff = this.parameters.mowingStandoffMeters;
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
      for (let index = 0; index < this.plan.strips.length; index += 1) {
        if (this.isStopped()) {
          this.phase = "stopped";
          return this.getStatus();
        }

        this.currentStripIndex = index;
        const strip = this.plan.strips[index];
        const dir = normalise({
          x: strip.end.xMeters - strip.start.xMeters,
          y: strip.end.yMeters - strip.start.yMeters,
        });

        const entryStandoff = offsetPoint(strip.start, dir, this.standoff);
        const exitStandoff = offsetPoint(strip.end, dir, -this.standoff);

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
        const startBoundaryKey = this.nearestBoundaryKey(strip.start);
        if (!this.tracedBoundaries.has(startBoundaryKey)) {
          const traceResult = await this.traceBoundary(startBoundaryKey, strip.start);
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
        const endBoundaryKey = this.nearestBoundaryKey(strip.end);
        if (!this.tracedBoundaries.has(endBoundaryKey)) {
          const traceResult = await this.traceBoundary(endBoundaryKey, strip.end);
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
            const connectorResult = await this.pathFollower.followPathPoints(connector);
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

  private async traceBoundary(boundaryKey: string, nearPoint: PathPoint): Promise<boolean> {
    this.phase = "tracing_boundary";
    this.logger.info("mowing.trace_boundary.start", { boundary: boundaryKey });

    const boundaryPoints = this.getBoundaryPoints(boundaryKey);
    if (boundaryPoints.length < 3) {
      this.logger.warn("mowing.trace_boundary.too_short", { boundary: boundaryKey });
      return true;
    }

    const currentPose = this.poseFusion.getCurrentPose();
    const joinPlan = buildPerimeterJoinPlan(boundaryPoints as PathPoint[], currentPose, this.parameters);
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

    const loopPoints = buildPerimeterPathPointsFromPlan(boundaryPoints as PathPoint[], joinPlan, this.parameters);
    if (loopPoints.length < 2) {
      return true;
    }

    const followResult = await this.pathFollower.followPathPoints(loopPoints);
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
    return this.stopRequested || systemStop.isStopRequested();
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
