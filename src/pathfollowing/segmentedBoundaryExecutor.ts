import { DriveController } from "../control/driveController.js";
import { DriveResult } from "../control/driveControllerTypes.js";
import { DEFAULT_PATH_FOLLOWING_PARAMETERS, PathFollowingParameters } from "../config/pathFollowingConfig.js";
import { Pose, createPosition, unwrapMeters } from "../geometry/positionTypes.js";
import { systemStop } from "../control/systemStop.js";
import { PathFollowResult, PathPoint } from "./pathFollowerApi.js";

const SEGMENTED_DRIVE_TIMEOUT_MINIMUM_MS = 2_000;

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
}

interface Point2 {
  readonly xMeters: number;
  readonly yMeters: number;
}

export function buildSegmentedBoundaryTargets(
  points: PathPoint[],
  parameters: PathFollowingParameters = DEFAULT_PATH_FOLLOWING_PARAMETERS,
): PathPoint[] {
  const filtered = removeTinySegments(points, parameters.segmentedDriveMinSegmentLengthMeters);
  const simplified = simplifyPolyline(
    filtered,
    parameters.segmentedDriveSimplificationToleranceMeters,
    parameters.closedLoopToleranceMeters,
  );
  return resampleLongSegments(simplified, parameters.segmentedDriveMaxSegmentLengthMeters);
}

export function buildSegmentedBoundaryExecutionTargets(
  points: PathPoint[],
  parameters: PathFollowingParameters = DEFAULT_PATH_FOLLOWING_PARAMETERS,
  startPose?: Pose,
): PathPoint[] {
  const targets = buildSegmentedBoundaryTargets(points, parameters);
  if (!startPose || targets.length <= 1) {
    return targets;
  }

  const reanchored = rotateTargetsToNearestPose(targets, startPose);
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
  const targets = buildSegmentedBoundaryExecutionTargets(points, parameters, options.startPose);
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

  for (let index = 0; index < targets.length; index += 1) {
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

    const target = targets[index];
    if (index > 0) {
      distanceTraveled += distance(targets[index - 1], target);
    }
    const driveResult = await driveController.executeDrive({
      targetPosition: createPosition(target.xMeters, target.yMeters),
      learningEnabled: options.learningEnabled ?? true,
      timeoutMinimumMs: SEGMENTED_DRIVE_TIMEOUT_MINIMUM_MS,
      maxCrossTrackErrorMeters: parameters.segmentedDriveMaxCteMeters,
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

function simplifyPolyline(points: PathPoint[], toleranceMeters: number, closedLoopToleranceMeters: number): PathPoint[] {
  if (points.length <= 2 || toleranceMeters <= 0) {
    return points.slice();
  }

  const isClosed = distance(points[0], points[points.length - 1]) <= closedLoopToleranceMeters;
  const working = isClosed ? points.slice(0, -1) : points;
  const simplified = simplifyOpenPolyline(working, toleranceMeters);
  return isClosed ? simplified.concat([simplified[0]]) : simplified;
}

function simplifyOpenPolyline(points: PathPoint[], toleranceMeters: number): PathPoint[] {
  if (points.length <= 2) {
    return points.slice();
  }

  let maxDistance = 0;
  let splitIndex = -1;
  const start = points[0];
  const end = points[points.length - 1];

  for (let index = 1; index < points.length - 1; index += 1) {
    const candidateDistance = pointToSegmentDistance(points[index], start, end);
    if (candidateDistance > maxDistance) {
      maxDistance = candidateDistance;
      splitIndex = index;
    }
  }

  if (maxDistance <= toleranceMeters || splitIndex < 0) {
    return [start, end];
  }

  const first = simplifyOpenPolyline(points.slice(0, splitIndex + 1), toleranceMeters);
  const second = simplifyOpenPolyline(points.slice(splitIndex), toleranceMeters);
  return first.slice(0, -1).concat(second);
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

function areSamePoint(a: Point2, b: Point2): boolean {
  return Math.hypot(a.xMeters - b.xMeters, a.yMeters - b.yMeters) <= 1e-9;
}

function pointToSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  const dx = end.xMeters - start.xMeters;
  const dy = end.yMeters - start.yMeters;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 0) {
    return distance(point, start);
  }

  const t = Math.max(0, Math.min(1, (((point.xMeters - start.xMeters) * dx) + ((point.yMeters - start.yMeters) * dy)) / lengthSquared));
  const projected = {
    xMeters: start.xMeters + (dx * t),
    yMeters: start.yMeters + (dy * t),
  };
  return distance(point, projected);
}

function distance(a: Point2, b: Point2): number {
  const dx = a.xMeters - b.xMeters;
  const dy = a.yMeters - b.yMeters;
  return Math.sqrt((dx * dx) + (dy * dy));
}
