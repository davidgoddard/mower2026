import { DriveController } from "../control/driveController.js";
import { DriveResult } from "../control/driveControllerTypes.js";
import { DEFAULT_PATH_FOLLOWING_PARAMETERS, PathFollowingParameters } from "../config/pathFollowingConfig.js";
import { Pose, createPosition, unwrapMeters } from "../geometry/positionTypes.js";
import { systemStop } from "../control/systemStop.js";
import { PathFollowResult, PathPoint } from "./pathFollowerApi.js";

export interface SegmentedBoundaryResult extends PathFollowResult {
  readonly algorithm: "segmented_drive";
  readonly rawPointCount: number;
  readonly simplifiedPointCount: number;
  readonly segmentCount: number;
  readonly completedSegments: number;
  readonly failedSegment?: DriveResult;
}

export interface SegmentedBoundaryExecutionOptions {
  readonly learningEnabled?: boolean;
  readonly parameters?: PathFollowingParameters;
  readonly startPose?: Pose;
  /**
   * When true, use the caller-supplied points directly instead of applying the
   * segmented-drive simplifier/resampler first. Obstacle paths use this because
   * they are already saved in a smoothed safe shape and re-simplifying them
   * can recreate inside-cutting chords.
   */
  readonly useRawPoints?: boolean;
  /**
   * When false, preserve the caller-supplied target order instead of rotating
   * the path to the nearest live pose. This is useful when an earlier planning
   * step has already chosen the correct join point and traversal direction.
   */
  readonly reanchorToStartPose?: boolean;
  /**
   * When true, retain the first planned target even if the mower is already
   * sitting on it. Verification loops use this so "start at join point, then
   * come back to it" cannot collapse into an immediate completion.
   */
  readonly preserveFirstTargetAtPose?: boolean;
  /**
   * When true, always drive to the next required target in sequence instead of
   * choosing a forward look-ahead target. Obstacle perimeters use this so the
   * mower does not cut chords across the inside of the shape.
   */
  readonly exactSequentialTargets?: boolean;
  /**
   * Optional sink for recording each target the executor has just completed.
   * The retry manager uses this trail to retrace recent targets backward when
   * recovering from a grass-jam high-current obstruction.
   */
  readonly recentTargetSink?: RecentTargetSink;
}

/**
 * Sink that receives each target the segmented executor has just successfully
 * driven to. The implementation can decide retention (e.g. cap by distance).
 */
export interface RecentTargetSink {
  /** Called once per completed target, in execution order. */
  recordCompletedTarget(target: PathPoint): void;
}

interface Point2 {
  readonly xMeters: number;
  readonly yMeters: number;
}

interface PolylineProjection {
  readonly segmentStartIndex: number;
  readonly distanceAlongPathMeters: number;
  readonly distanceToPathMeters: number;
}

const PROGRESS_LOOKAHEAD_MIN_METERS = 0.2;
const TARGET_PASS_MARGIN_MIN_METERS = 0.05;

export function buildSegmentedBoundaryTargets(
  points: PathPoint[],
  parameters: PathFollowingParameters = DEFAULT_PATH_FOLLOWING_PARAMETERS,
): PathPoint[] {
  const filtered = removeTinySegments(points, parameters.segmentedDriveMinSegmentLengthMeters);
  const simplified = simplifyPolyline(
    filtered,
    parameters.segmentedDriveSimplificationToleranceMeters,
    parameters.segmentedDriveMaxVertexTurnDeg,
    parameters.closedLoopToleranceMeters,
  );
  return resampleLongSegments(simplified, parameters.segmentedDriveMaxSegmentLengthMeters);
}

export function buildSegmentedBoundaryExecutionTargets(
  points: PathPoint[],
  parameters: PathFollowingParameters = DEFAULT_PATH_FOLLOWING_PARAMETERS,
  startPose?: Pose,
  reanchorToStartPose = true,
  preserveFirstTargetAtPose = false,
  useRawPoints = false,
): PathPoint[] {
  const targets = useRawPoints ? points.slice() : buildSegmentedBoundaryTargets(points, parameters);
  if (!startPose || targets.length <= 1) {
    return targets;
  }

  const reanchored = reanchorToStartPose
    ? rotateTargetsToNearestPose(targets, startPose)
    : targets;
  if (preserveFirstTargetAtPose) {
    return reanchored;
  }
  return dropTargetsAlreadyAtPose(
    reanchored,
    startPose,
    parameters.segmentedDriveMinSegmentLengthMeters,
  );
}

export async function executeSegmentedBoundaryPath(
  points: PathPoint[],
  driveController: DriveController,
  options: SegmentedBoundaryExecutionOptions = {},
): Promise<SegmentedBoundaryResult> {
  const parameters = options.parameters ?? DEFAULT_PATH_FOLLOWING_PARAMETERS;
  const targets = buildSegmentedBoundaryExecutionTargets(
    points,
    parameters,
    options.startPose,
    options.reanchorToStartPose ?? true,
    options.preserveFirstTargetAtPose ?? false,
    options.useRawPoints ?? false,
  );
  let completedSegments = 0;
  let distanceTraveled = 0;

  if (targets.length < 2) {
    return {
      algorithm: "segmented_drive",
      completed: false,
      reason: "error",
      error: "segmented_path_too_short",
      rawPointCount: points.length,
      simplifiedPointCount: targets.length,
      segmentCount: 0,
      completedSegments: 0,
      distanceTraveled: 0,
    };
  }

  let currentPose = options.startPose ?? driveController.getCurrentPose();
  let currentIndex = 0;
  let preserveCurrentTargetAtPose = options.preserveFirstTargetAtPose ?? false;

  while (currentIndex < targets.length) {
    if (systemStop.isStopped()) {
      return {
        algorithm: "segmented_drive",
        completed: false,
        reason: "user_stopped",
        finalPose: undefined,
        distanceTraveled,
        rawPointCount: points.length,
        simplifiedPointCount: targets.length,
        segmentCount: targets.length,
        completedSegments,
      };
    }
    currentIndex = advancePassedTargets(
      targets,
      currentPose,
      currentIndex,
      parameters,
      preserveCurrentTargetAtPose,
    );
    preserveCurrentTargetAtPose = false;
    if (currentIndex >= targets.length) {
      break;
    }

    const targetIndex = selectSegmentedBoundaryTargetIndex(
      targets,
      currentIndex,
      parameters,
      options.exactSequentialTargets ?? false,
    );
    if (targetIndex > currentIndex) {
      for (let index = Math.max(1, currentIndex); index <= targetIndex; index += 1) {
        distanceTraveled += distance(targets[index - 1], targets[index]);
      }
    }
    currentIndex = targetIndex;

    const target = targets[currentIndex];
    const driveResult = await driveController.executeDrive({
      targetPosition: createPosition(target.xMeters, target.yMeters),
      learningEnabled: options.learningEnabled ?? true,
      maxCrossTrackErrorMeters: parameters.segmentedDriveMaxCteMeters,
      alwaysTurnToFaceTarget: true,
    });

    if (driveResult.status !== "success") {
      return {
        algorithm: "segmented_drive",
        completed: false,
        reason: driveResult.errorMessage === "Drive stopped by user request" ? "user_stopped" : "error",
        error: driveResult.errorMessage,
        distanceTraveled,
        rawPointCount: points.length,
        simplifiedPointCount: targets.length,
        segmentCount: targets.length,
        completedSegments,
        failedSegment: driveResult,
      };
    }

    completedSegments += 1;
    options.recentTargetSink?.recordCompletedTarget(target);
    currentPose = driveController.getCurrentPose();
    if (Math.abs(unwrapMeters(driveResult.maxCteMeters)) > parameters.segmentedDriveMaxCteMeters) {
      systemStop.requestStop("segmented-boundary", "segmented_boundary_cte_exceeded");
      return {
        algorithm: "segmented_drive",
        completed: false,
        reason: "error",
        error: "segmented_boundary_cte_exceeded",
        distanceTraveled,
        rawPointCount: points.length,
        simplifiedPointCount: targets.length,
        segmentCount: targets.length,
        completedSegments,
        failedSegment: driveResult,
      };
    }

    currentIndex = advancePassedTargets(targets, currentPose, currentIndex, parameters);
  }

  return {
    algorithm: "segmented_drive",
    completed: true,
    reason: "reached_end",
    distanceTraveled,
    rawPointCount: points.length,
    simplifiedPointCount: targets.length,
    segmentCount: targets.length,
    completedSegments,
  };
}

export function selectSegmentedBoundaryTargetIndex(
  points: PathPoint[],
  startIndex: number,
  parameters: PathFollowingParameters = DEFAULT_PATH_FOLLOWING_PARAMETERS,
  exactSequentialTargets = false,
): number {
  if (points.length === 0) {
    return -1;
  }

  const clampedStartIndex = Math.max(0, Math.min(startIndex, points.length - 1));
  if (exactSequentialTargets || clampedStartIndex >= points.length - 1) {
    return clampedStartIndex;
  }

  const cumulativeDistances = buildCumulativeDistances(points);
  const lookaheadMeters = Math.min(
    parameters.segmentedDriveMaxSegmentLengthMeters,
    Math.max(parameters.segmentedDriveMinSegmentLengthMeters, PROGRESS_LOOKAHEAD_MIN_METERS),
  );
  const targetDistance = cumulativeDistances[clampedStartIndex] + lookaheadMeters;

  for (let index = clampedStartIndex; index < points.length; index += 1) {
    if (cumulativeDistances[index] >= targetDistance) {
      return index;
    }
  }

  return points.length - 1;
}

export function advancePassedTargets(
  points: PathPoint[],
  pose: Pose,
  startIndex: number,
  parameters: PathFollowingParameters = DEFAULT_PATH_FOLLOWING_PARAMETERS,
  preserveCurrentTargetAtPose = false,
  allowClosedLoopStartProgression = false,
): number {
  if (points.length === 0) {
    return 0;
  }

  const passMarginMeters = Math.max(
    TARGET_PASS_MARGIN_MIN_METERS,
    parameters.segmentedDriveMinSegmentLengthMeters,
  );
  let index = Math.max(0, startIndex);

  while (index < points.length) {
    if (preserveCurrentTargetAtPose) {
      break;
    }
    if (!hasPassedTarget(points, pose, index, passMarginMeters, allowClosedLoopStartProgression)) {
      break;
    }
    index += 1;
  }

  return index;
}

function removeTinySegments(points: PathPoint[], minDistanceMeters: number): PathPoint[] {
  if (points.length <= 1) {
    return points.slice();
  }

  const filtered: PathPoint[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const previous = filtered[filtered.length - 1];
    const isLast = index === points.length - 1;
    if (isLast || distance(previous, point) >= minDistanceMeters) {
      filtered.push(point);
    }
  }
  return filtered;
}

function simplifyPolyline(
  points: PathPoint[],
  toleranceMeters: number,
  maxVertexTurnDeg: number,
  closedLoopToleranceMeters: number,
): PathPoint[] {
  if (points.length <= 2) {
    return points.slice();
  }

  const isClosed = distance(points[0], points[points.length - 1]) <= closedLoopToleranceMeters;
  const working = isClosed ? points.slice(0, -1) : points.slice();
  const simplified = simplifyByGreedyChord(working, toleranceMeters, maxVertexTurnDeg);
  return isClosed ? simplified.concat([simplified[0]]) : simplified;
}

/**
 * Walk the recorded points and fuse consecutive ones into a single chord while
 *   1) every interior recorded point stays within `toleranceMeters` of the chord, and
 *   2) no interior recorded point requires a heading change above `maxVertexTurnDeg`.
 * The first vertex that fails either gate becomes a kept pivot, then the next chord starts there.
 */
function simplifyByGreedyChord(
  points: PathPoint[],
  toleranceMeters: number,
  maxVertexTurnDeg: number,
): PathPoint[] {
  if (points.length <= 2) {
    return points.slice();
  }

  const tolerance = Math.max(0, toleranceMeters);
  const turnRadians = Math.max(0, maxVertexTurnDeg) * (Math.PI / 180);
  const cosLimit = Math.cos(turnRadians);
  const kept: PathPoint[] = [points[0]];
  let anchorIndex = 0;

  while (anchorIndex < points.length - 1) {
    let candidateEnd = anchorIndex + 1;

    for (let probe = anchorIndex + 2; probe < points.length; probe += 1) {
      if (
        chordViolation(points, anchorIndex, probe, tolerance, cosLimit)
      ) {
        break;
      }
      candidateEnd = probe;
    }

    kept.push(points[candidateEnd]);
    anchorIndex = candidateEnd;
  }

  return kept;
}

function chordViolation(
  points: PathPoint[],
  anchorIndex: number,
  probeIndex: number,
  toleranceMeters: number,
  cosLimit: number,
): boolean {
  const start = points[anchorIndex];
  const end = points[probeIndex];

  for (let index = anchorIndex + 1; index < probeIndex; index += 1) {
    if (pointToSegmentDistance(points[index], start, end) > toleranceMeters) {
      return true;
    }
    if (vertexTurnExceeds(points, index, cosLimit)) {
      return true;
    }
  }

  return false;
}

function vertexTurnExceeds(points: PathPoint[], vertexIndex: number, cosLimit: number): boolean {
  const previous = points[vertexIndex - 1];
  const current = points[vertexIndex];
  const next = points[vertexIndex + 1];
  const inDx = current.xMeters - previous.xMeters;
  const inDy = current.yMeters - previous.yMeters;
  const outDx = next.xMeters - current.xMeters;
  const outDy = next.yMeters - current.yMeters;
  const inLength = Math.hypot(inDx, inDy);
  const outLength = Math.hypot(outDx, outDy);
  if (inLength <= 1e-9 || outLength <= 1e-9) {
    return false;
  }
  const cosTheta = ((inDx * outDx) + (inDy * outDy)) / (inLength * outLength);
  return cosTheta < cosLimit;
}

function resampleLongSegments(points: PathPoint[], maxSegmentLengthMeters: number): PathPoint[] {
  if (points.length <= 1 || maxSegmentLengthMeters <= 0) {
    return points.slice();
  }

  const resampled: PathPoint[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const from = resampled[resampled.length - 1];
    const to = points[index];
    const segmentDistance = distance(from, to);
    const subdivisions = Math.max(1, Math.ceil(segmentDistance / maxSegmentLengthMeters));
    for (let step = 1; step <= subdivisions; step += 1) {
      const t = step / subdivisions;
      resampled.push({
        xMeters: from.xMeters + ((to.xMeters - from.xMeters) * t),
        yMeters: from.yMeters + ((to.yMeters - from.yMeters) * t),
        capturedAt: to.capturedAt,
      });
    }
  }
  return resampled;
}

function rotateTargetsToNearestPose(points: PathPoint[], pose: Pose): PathPoint[] {
  const isClosed = areSamePoint(points[0], points[points.length - 1]);
  const working = isClosed ? points.slice(0, -1) : points;
  const poseX = unwrapMeters(pose.position.xMeters);
  const poseY = unwrapMeters(pose.position.yMeters);
  let nearestIndex = 0;
  let nearestDistance = Infinity;

  for (let index = 0; index < working.length; index += 1) {
    const point = working[index];
    const pointDistance = Math.hypot(point.xMeters - poseX, point.yMeters - poseY);
    if (pointDistance < nearestDistance) {
      nearestDistance = pointDistance;
      nearestIndex = index;
    }
  }

  if (nearestIndex === 0 && !isClosed) {
    return points.slice();
  }

  const rotated = working.slice(nearestIndex).concat(working.slice(0, nearestIndex));
  if (isClosed) {
    rotated.push(rotated[0]);
  }
  return rotated;
}

function dropTargetsAlreadyAtPose(
  points: PathPoint[],
  pose: Pose,
  minDistanceMeters: number,
): PathPoint[] {
  const poseX = unwrapMeters(pose.position.xMeters);
  const poseY = unwrapMeters(pose.position.yMeters);
  let firstTargetIndex = 0;

  while (
    firstTargetIndex < points.length - 1 &&
    Math.hypot(points[firstTargetIndex].xMeters - poseX, points[firstTargetIndex].yMeters - poseY) < minDistanceMeters
  ) {
    firstTargetIndex += 1;
  }

  return points.slice(firstTargetIndex);
}

function projectPoseOntoRemainingPath(
  points: PathPoint[],
  pose: Pose,
  startIndex: number,
): PolylineProjection | null {
  if (points.length === 0 || startIndex >= points.length) {
    return null;
  }

  const clampedStartIndex = Math.max(0, Math.min(startIndex, points.length - 1));
  const cumulativeDistances = buildCumulativeDistances(points);
  const posePoint = {
    xMeters: unwrapMeters(pose.position.xMeters),
    yMeters: unwrapMeters(pose.position.yMeters),
  };

  if (clampedStartIndex >= points.length - 1) {
    return {
      segmentStartIndex: clampedStartIndex,
      distanceAlongPathMeters: cumulativeDistances[clampedStartIndex],
      distanceToPathMeters: distance(posePoint, points[clampedStartIndex]),
    };
  }

  let best: PolylineProjection | null = null;
  for (let index = clampedStartIndex; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const projection = projectPointOntoSegment(posePoint, start, end);
    const distanceAlongPathMeters = cumulativeDistances[index] + (projection.t * distance(start, end));
    if (
      best === null ||
      projection.distanceToSegmentMeters < best.distanceToPathMeters
    ) {
      best = {
        segmentStartIndex: index,
        distanceAlongPathMeters,
        distanceToPathMeters: projection.distanceToSegmentMeters,
      };
    }
  }

  return best;
}

function buildCumulativeDistances(points: PathPoint[]): number[] {
  const cumulative = new Array<number>(points.length).fill(0);
  for (let index = 1; index < points.length; index += 1) {
    cumulative[index] = cumulative[index - 1] + distance(points[index - 1], points[index]);
  }
  return cumulative;
}

function hasPassedTarget(
  points: PathPoint[],
  pose: Pose,
  targetIndex: number,
  passMarginMeters: number,
  allowClosedLoopStartProgression = false,
): boolean {
  const posePoint = {
    xMeters: unwrapMeters(pose.position.xMeters),
    yMeters: unwrapMeters(pose.position.yMeters),
  };
  const target = points[targetIndex];
  if (distance(posePoint, target) <= passMarginMeters) {
    return true;
  }

  if (targetIndex === 0) {
    if (allowClosedLoopStartProgression && points.length >= 3) {
      const next = points[1];
      const segmentDx = next.xMeters - target.xMeters;
      const segmentDy = next.yMeters - target.yMeters;
      const segmentLength = Math.hypot(segmentDx, segmentDy);
      if (segmentLength > 1e-9) {
        const unitX = segmentDx / segmentLength;
        const unitY = segmentDy / segmentLength;
        const poseDx = posePoint.xMeters - target.xMeters;
        const poseDy = posePoint.yMeters - target.yMeters;
        const alongMeters = (poseDx * unitX) + (poseDy * unitY);
        const crossMeters = Math.abs((poseDx * -unitY) + (poseDy * unitX));
        if (alongMeters >= passMarginMeters && crossMeters <= (passMarginMeters * 2)) {
          return true;
        }
      }
    }
    return false;
  }

  const previous = points[targetIndex - 1];
  const segmentDx = target.xMeters - previous.xMeters;
  const segmentDy = target.yMeters - previous.yMeters;
  const segmentLength = Math.hypot(segmentDx, segmentDy);
  if (segmentLength <= 1e-9) {
    return false;
  }

  const unitX = segmentDx / segmentLength;
  const unitY = segmentDy / segmentLength;
  const poseDx = posePoint.xMeters - previous.xMeters;
  const poseDy = posePoint.yMeters - previous.yMeters;
  const alongMeters = (poseDx * unitX) + (poseDy * unitY);

  return alongMeters >= segmentLength + passMarginMeters;
}

function areSamePoint(a: Point2, b: Point2): boolean {
  return Math.hypot(a.xMeters - b.xMeters, a.yMeters - b.yMeters) <= 1e-9;
}

function projectPointOntoSegment(point: Point2, start: Point2, end: Point2): { t: number; distanceToSegmentMeters: number } {
  const dx = end.xMeters - start.xMeters;
  const dy = end.yMeters - start.yMeters;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 0) {
    return {
      t: 0,
      distanceToSegmentMeters: distance(point, start),
    };
  }

  const unclampedT = (((point.xMeters - start.xMeters) * dx) + ((point.yMeters - start.yMeters) * dy)) / lengthSquared;
  const t = Math.max(0, Math.min(1, unclampedT));
  const projected = {
    xMeters: start.xMeters + (dx * t),
    yMeters: start.yMeters + (dy * t),
  };

  return {
    t,
    distanceToSegmentMeters: distance(point, projected),
  };
}

function pointToSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  return projectPointOntoSegment(point, start, end).distanceToSegmentMeters;
}

function distance(a: Point2, b: Point2): number {
  const dx = a.xMeters - b.xMeters;
  const dy = a.yMeters - b.yMeters;
  return Math.sqrt((dx * dx) + (dy * dy));
}
