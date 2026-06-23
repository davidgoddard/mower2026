import { DRIVE_FULL_SPEED_COMMAND_DEFAULT } from "../constants.js";
import { PathFollowingParameters, DEFAULT_PATH_FOLLOWING_PARAMETERS } from "../config/pathFollowingConfig.js";
import { crossTrackError, angleTo, Pose, Position, unwrapMeters, createPosition } from "../geometry/positionTypes.js";
import { headingDifference, unwrapRelativeAngle } from "../geometry/headingTypes.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { systemStop } from "../control/systemStop.js";
import { defaultSleep } from "../control/sleep.js";
import { PathFollowResult, PathPoint } from "./pathFollowerApi.js";
import { advancePassedTargets } from "./segmentedBoundaryExecutor.js";

const CONTINUOUS_CONTROL_INTERVAL_MS = 100;
const CONTINUOUS_TRACE_SPEED = 1.0;
const CONTINUOUS_TRACE_SPEED_MIN = 0.5;
const CONTINUOUS_TRACE_SPEED_CURVE_GAIN = 0.006;
const CONTINUOUS_TRACE_SPEED_HEADING_GAIN = 0.003;
const CONTINUOUS_TRACE_SPEED_CTE_GAIN = 0.9;
const CONTINUOUS_LOOKAHEAD_MIN_METERS = 0.25;
const CONTINUOUS_LOOKAHEAD_MAX_METERS = 0.6;
const CONTINUOUS_CTE_GAIN = 1.8;
const CONTINUOUS_HEADING_GAIN = 0.02;
const CONTINUOUS_MAX_TRIM = 0.55;
const CONTINUOUS_PIVOT_ENTER_HEADING_THRESHOLD_DEG = 100;
const CONTINUOUS_PIVOT_EXIT_HEADING_THRESHOLD_DEG = 55;
const CONTINUOUS_PIVOT_OUTPUT = 0.45;
const CONTINUOUS_CORNER_PIVOT_ALIGN_TOLERANCE_DEG = 12;

export interface ContinuousPathFollowerOptions {
  readonly sensorController: SensorController;
  readonly poseFusion: PoseFusion;
  readonly logger: LoggerScope;
  readonly baseSpeed?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface ContinuousPathExecutionOptions {
  readonly parameters?: PathFollowingParameters;
  readonly preserveFirstTargetAtPose?: boolean;
  readonly loopPath?: boolean;
  /**
   * When true, projection is limited to the current local segment window so a
   * pose that is geometrically near some later non-adjacent segment cannot jump
   * progress far ahead in the ordered path.
   */
  readonly strictOrderedProgress?: boolean;
  readonly pivotAtWaypointTurnDeg?: number;
  readonly pivotAtWaypointDistanceMeters?: number;
  readonly minimumSpeed?: number;
  readonly pivotIfInnerWheelBelow?: number;
}

export interface ContinuousPathFollowResult extends PathFollowResult {
  readonly algorithm: "continuous_path_follow";
  readonly pointCount: number;
  readonly completedWaypoints: number;
}

export class ContinuousPathFollower {
  private readonly sensorController: SensorController;
  private readonly poseFusion: PoseFusion;
  private readonly logger: LoggerScope;
  private readonly baseSpeed: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  constructor(options: ContinuousPathFollowerOptions) {
    this.sensorController = options.sensorController;
    this.poseFusion = options.poseFusion;
    this.logger = options.logger;
    this.baseSpeed = Math.max(0.2, Math.min(DRIVE_FULL_SPEED_COMMAND_DEFAULT, options.baseSpeed ?? CONTINUOUS_TRACE_SPEED));
    this.sleep = options.sleep ?? defaultSleep;
  }

  async executePath(
    points: PathPoint[],
    options: ContinuousPathExecutionOptions = {},
  ): Promise<ContinuousPathFollowResult> {
    const parameters = options.parameters ?? DEFAULT_PATH_FOLLOWING_PARAMETERS;
    const pathPoints = normalizePathPoints(points, options.loopPath ?? true);
    if (pathPoints.length < 2) {
      return {
        algorithm: "continuous_path_follow",
        completed: false,
        reason: "error",
        error: "continuous_path_too_short",
        pointCount: pathPoints.length,
        completedWaypoints: 0,
      };
    }

    let currentIndex = 0;
    let preserveCurrentTargetAtPose = options.preserveFirstTargetAtPose ?? false;
    let pivoting = false;

    this.sensorController.beginMotionSession();
    try {
      const cumulativeDistances = buildCumulativeDistances(pathPoints);
      while (currentIndex < pathPoints.length) {
        if (systemStop.isStopped()) {
          await this.sensorController.requestNeutralMotorOutputs();
          return {
            algorithm: "continuous_path_follow",
            completed: false,
            reason: "user_stopped",
            pointCount: pathPoints.length,
            completedWaypoints: currentIndex,
          };
        }

        const pose = this.poseFusion.getCurrentPose();
        currentIndex = advancePassedTargets(
          pathPoints,
          pose,
          currentIndex,
          parameters,
          preserveCurrentTargetAtPose,
          options.loopPath ?? true,
        );
        preserveCurrentTargetAtPose = false;
        if (currentIndex >= pathPoints.length) {
          break;
        }

        const projection = projectPoseOntoPath(
          pathPoints,
          pose,
          currentIndex,
          options.strictOrderedProgress ?? false,
        );
        currentIndex = Math.max(currentIndex, projection.segmentStartIndex + 1);
        const guidance = buildContinuousGuidance(pathPoints, cumulativeDistances, projection, parameters);
        const commands = computeContinuousPathWheelCommands(
          pose,
          guidance.segmentStart,
          guidance.segmentEnd,
          guidance.lookaheadTarget,
          this.baseSpeed,
          pivoting,
          {
            pivotAtWaypointTurnDeg: options.pivotAtWaypointTurnDeg,
            pivotAtWaypointDistanceMeters: options.pivotAtWaypointDistanceMeters,
            minimumSpeed: options.minimumSpeed,
            pivotIfInnerWheelBelow: options.pivotIfInnerWheelBelow,
          },
        );
        pivoting = commands.pivoting;

        this.logger.debug("continuous_path.control", {
          currentIndex,
          projectionSegmentStartIndex: projection.segmentStartIndex,
          distanceAlongPathMeters: projection.distanceAlongPathMeters,
          currentTargetX: guidance.segmentEnd.xMeters,
          currentTargetY: guidance.segmentEnd.yMeters,
          lookaheadX: guidance.lookaheadTarget.xMeters,
          lookaheadY: guidance.lookaheadTarget.yMeters,
          left: commands.left,
          right: commands.right,
          pivoting,
        });
        await this.sensorController.setMotorWheelOutputs(commands.left, commands.right);
        await this.sleep(CONTINUOUS_CONTROL_INTERVAL_MS);
      }

      await this.sensorController.requestNeutralMotorOutputs();
      return {
        algorithm: "continuous_path_follow",
        completed: true,
        reason: "reached_end",
        pointCount: pathPoints.length,
        completedWaypoints: pathPoints.length,
      };
    } catch (error) {
      await this.sensorController.requestNeutralMotorOutputs().catch(() => {});
      return {
        algorithm: "continuous_path_follow",
        completed: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
        pointCount: pathPoints.length,
        completedWaypoints: currentIndex,
      };
    } finally {
      this.sensorController.endMotionSession();
    }
  }
}

export function selectContinuousLookaheadTargetIndex(
  points: PathPoint[],
  startIndex: number,
  parameters: PathFollowingParameters = DEFAULT_PATH_FOLLOWING_PARAMETERS,
): number {
  if (points.length === 0) {
    return -1;
  }
  const clampedStartIndex = Math.max(0, Math.min(startIndex, points.length - 1));
  if (clampedStartIndex >= points.length - 1) {
    return clampedStartIndex;
  }

  const cumulativeDistances = buildCumulativeDistances(points);
  const lookaheadMeters = Math.max(
    CONTINUOUS_LOOKAHEAD_MIN_METERS,
    Math.min(CONTINUOUS_LOOKAHEAD_MAX_METERS, parameters.segmentedDriveMaxSegmentLengthMeters),
  );
  const targetDistance = cumulativeDistances[clampedStartIndex] + lookaheadMeters;
  for (let index = clampedStartIndex; index < points.length; index += 1) {
    if (cumulativeDistances[index] >= targetDistance) {
      return index;
    }
  }
  return points.length - 1;
}

export function computeContinuousPathWheelCommands(
  pose: Pose,
  previousPoint: PathPoint,
  currentTarget: PathPoint,
  lookaheadTarget: PathPoint,
  baseSpeed: number,
  pivoting = false,
  options: {
    readonly pivotAtWaypointTurnDeg?: number;
    readonly pivotAtWaypointDistanceMeters?: number;
    readonly minimumSpeed?: number;
    readonly pivotIfInnerWheelBelow?: number;
  } = {},
): { left: number; right: number; pivoting: boolean } {
  const localStart = pointToPosition(previousPoint);
  const localEnd = pointToPosition(currentTarget);
  const lookaheadHeading = angleTo(pose.position, pointToPosition(lookaheadTarget));
  const headingErrorDeg = unwrapRelativeAngle(headingDifference(pose.heading, lookaheadHeading));
  const outgoingHeading = angleTo(pointToPosition(currentTarget), pointToPosition(lookaheadTarget));
  const outgoingHeadingErrorDeg = unwrapRelativeAngle(headingDifference(pose.heading, outgoingHeading));
  const cteMeters = unwrapMeters(crossTrackError(pose.position, localStart, localEnd));
  const distanceToCurrentTargetMeters = Math.hypot(
    unwrapMeters(pose.position.xMeters) - currentTarget.xMeters,
    unwrapMeters(pose.position.yMeters) - currentTarget.yMeters,
  );
  const localPathHeading = unwrapRelativeAngle(headingDifference(
    angleTo(pointToPosition(previousPoint), pointToPosition(currentTarget)),
    angleTo(pointToPosition(currentTarget), pointToPosition(lookaheadTarget)),
  ));
  const adaptiveBaseSpeed = computeContinuousPathBaseSpeed(
    baseSpeed,
    localPathHeading,
    headingErrorDeg,
    cteMeters,
    options.minimumSpeed,
  );
  const shouldPivotAtCorner = Number.isFinite(options.pivotAtWaypointTurnDeg)
    && Number.isFinite(options.pivotAtWaypointDistanceMeters)
    && Math.abs(localPathHeading) >= Math.abs(options.pivotAtWaypointTurnDeg ?? 0)
    && distanceToCurrentTargetMeters <= Math.max(0, options.pivotAtWaypointDistanceMeters ?? 0)
    && Math.abs(outgoingHeadingErrorDeg) > CONTINUOUS_CORNER_PIVOT_ALIGN_TOLERANCE_DEG;
  const predictedInnerWheelCommand = adaptiveBaseSpeed - Math.abs(clamp(
    (cteMeters * CONTINUOUS_CTE_GAIN) + (headingErrorDeg * CONTINUOUS_HEADING_GAIN),
    -CONTINUOUS_MAX_TRIM,
    CONTINUOUS_MAX_TRIM,
  ));
  const shouldPivotForTightArc = Number.isFinite(options.pivotIfInnerWheelBelow)
    && predictedInnerWheelCommand < Math.max(0, options.pivotIfInnerWheelBelow ?? 0);

  const pivotThresholdDeg = pivoting
    ? CONTINUOUS_PIVOT_EXIT_HEADING_THRESHOLD_DEG
    : CONTINUOUS_PIVOT_ENTER_HEADING_THRESHOLD_DEG;
  if (Math.abs(headingErrorDeg) >= pivotThresholdDeg || shouldPivotAtCorner || shouldPivotForTightArc) {
    const pivotHeadingErrorDeg = shouldPivotAtCorner ? outgoingHeadingErrorDeg : headingErrorDeg;
    const turnSign = pivotHeadingErrorDeg >= 0 ? 1 : -1;
    return {
      left: -turnSign * CONTINUOUS_PIVOT_OUTPUT,
      right: turnSign * CONTINUOUS_PIVOT_OUTPUT,
      pivoting: true,
    };
  }

  const trim = clamp(
    (cteMeters * CONTINUOUS_CTE_GAIN) + (headingErrorDeg * CONTINUOUS_HEADING_GAIN),
    -CONTINUOUS_MAX_TRIM,
    CONTINUOUS_MAX_TRIM,
  );

  return {
    left: clamp(adaptiveBaseSpeed - trim, -1, 1),
    right: clamp(adaptiveBaseSpeed + trim, -1, 1),
    pivoting: false,
  };
}

export function computeContinuousPathBaseSpeed(
  requestedBaseSpeed: number,
  localPathTurnDeg: number,
  headingErrorDeg: number,
  cteMeters: number,
  minimumSpeed = CONTINUOUS_TRACE_SPEED_MIN,
): number {
  const curvePenalty = Math.abs(localPathTurnDeg) * CONTINUOUS_TRACE_SPEED_CURVE_GAIN;
  const headingPenalty = Math.abs(headingErrorDeg) * CONTINUOUS_TRACE_SPEED_HEADING_GAIN;
  const ctePenalty = Math.abs(cteMeters) * CONTINUOUS_TRACE_SPEED_CTE_GAIN;
  return clamp(
    requestedBaseSpeed - curvePenalty - headingPenalty - ctePenalty,
    Math.max(0.2, Math.min(requestedBaseSpeed, minimumSpeed)),
    requestedBaseSpeed,
  );
}

function normalizePathPoints(points: PathPoint[], _loopPath: boolean): PathPoint[] {
  return points.slice();
}

function buildCumulativeDistances(points: PathPoint[]): number[] {
  const cumulative = new Array<number>(points.length).fill(0);
  for (let index = 1; index < points.length; index += 1) {
    cumulative[index] = cumulative[index - 1] + distance(points[index - 1], points[index]);
  }
  return cumulative;
}

interface ContinuousPathProjection {
  readonly segmentStartIndex: number;
  readonly distanceAlongPathMeters: number;
}

interface ContinuousGuidance {
  readonly segmentStart: PathPoint;
  readonly segmentEnd: PathPoint;
  readonly lookaheadTarget: PathPoint;
}

function projectPoseOntoPath(
  points: PathPoint[],
  pose: Pose,
  startIndex: number,
  strictOrderedProgress: boolean,
): ContinuousPathProjection {
  const cumulativeDistances = buildCumulativeDistances(points);
  const clampedStartIndex = Math.max(0, Math.min(startIndex, points.length - 2));
  const minSegmentStartIndex = strictOrderedProgress
    ? Math.max(0, clampedStartIndex - 1)
    : clampedStartIndex;
  const maxSegmentStartIndex = strictOrderedProgress
    ? Math.min(points.length - 2, clampedStartIndex + 1)
    : points.length - 2;
  let bestSegmentStartIndex = clampedStartIndex;
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestDistanceAlongPathMeters = cumulativeDistances[bestSegmentStartIndex];

  for (let index = minSegmentStartIndex; index <= maxSegmentStartIndex; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const dx = end.xMeters - start.xMeters;
    const dy = end.yMeters - start.yMeters;
    const lenSq = (dx * dx) + (dy * dy);
    if (lenSq <= 1e-9) {
      continue;
    }
    const px = unwrapMeters(pose.position.xMeters) - start.xMeters;
    const py = unwrapMeters(pose.position.yMeters) - start.yMeters;
    const t = clamp(((px * dx) + (py * dy)) / lenSq, 0, 1);
    const projX = start.xMeters + (dx * t);
    const projY = start.yMeters + (dy * t);
    const distSq = ((unwrapMeters(pose.position.xMeters) - projX) ** 2) + ((unwrapMeters(pose.position.yMeters) - projY) ** 2);
    if (distSq < bestDistanceSq) {
      bestDistanceSq = distSq;
      bestSegmentStartIndex = index;
      bestDistanceAlongPathMeters = cumulativeDistances[index] + (Math.sqrt(lenSq) * t);
    }
  }

  return {
    segmentStartIndex: bestSegmentStartIndex,
    distanceAlongPathMeters: bestDistanceAlongPathMeters,
  };
}

function buildContinuousGuidance(
  points: PathPoint[],
  cumulativeDistances: number[],
  projection: ContinuousPathProjection,
  parameters: PathFollowingParameters,
): ContinuousGuidance {
  const segmentStartIndex = Math.max(0, Math.min(projection.segmentStartIndex, points.length - 2));
  const segmentStart = points[segmentStartIndex];
  const segmentEnd = points[segmentStartIndex + 1];
  const lookaheadMeters = Math.max(
    CONTINUOUS_LOOKAHEAD_MIN_METERS,
    Math.min(CONTINUOUS_LOOKAHEAD_MAX_METERS, parameters.segmentedDriveMaxSegmentLengthMeters),
  );
  const targetDistance = projection.distanceAlongPathMeters + lookaheadMeters;
  const lookaheadTarget = interpolatePathPointAtDistance(points, cumulativeDistances, targetDistance);
  return {
    segmentStart,
    segmentEnd,
    lookaheadTarget,
  };
}

function interpolatePathPointAtDistance(
  points: PathPoint[],
  cumulativeDistances: number[],
  targetDistanceMeters: number,
): PathPoint {
  if (points.length === 0) {
    return { xMeters: 0, yMeters: 0, capturedAt: Date.now() };
  }
  if (targetDistanceMeters <= 0) {
    return points[0];
  }
  const totalDistance = cumulativeDistances[cumulativeDistances.length - 1];
  if (targetDistanceMeters >= totalDistance) {
    return points[points.length - 1];
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const startDistance = cumulativeDistances[index];
    const endDistance = cumulativeDistances[index + 1];
    if (targetDistanceMeters <= endDistance) {
      const span = Math.max(endDistance - startDistance, 1e-9);
      const t = clamp((targetDistanceMeters - startDistance) / span, 0, 1);
      const start = points[index];
      const end = points[index + 1];
      return {
        xMeters: start.xMeters + ((end.xMeters - start.xMeters) * t),
        yMeters: start.yMeters + ((end.yMeters - start.yMeters) * t),
        capturedAt: start.capturedAt,
      };
    }
  }
  return points[points.length - 1];
}

function pointToPosition(point: PathPoint): Position {
  return createPosition(point.xMeters, point.yMeters);
}

function distance(a: PathPoint, b: PathPoint): number {
  return Math.hypot(a.xMeters - b.xMeters, a.yMeters - b.yMeters);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
