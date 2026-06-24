/**
 * Helpers for path verification runs.
 *
 * Verification starts at the nearest point on the stored path and then
 * continues around the path until it returns to that join point.
 */

import { PathPoint } from "./pathFollowerApi.js";
import { InternalHeading, headingDifference, unwrapInternalHeading, unwrapRelativeAngle } from "../geometry/headingTypes.js";
import { Pose, angleTo, createPosition, distanceBetween, unwrapMeters } from "../geometry/positionTypes.js";
import { DEFAULT_PATH_FOLLOWING_PARAMETERS, type PathFollowingParameters } from "../config/pathFollowingConfig.js";

export type PathVerificationParameters = PathFollowingParameters;

export const DEFAULT_PATH_VERIFICATION_PARAMETERS: PathVerificationParameters = DEFAULT_PATH_FOLLOWING_PARAMETERS;

interface NormalizedPath {
  readonly points: PathPoint[];
  readonly isClosedLoop: boolean;
}

function arePathPointsClose(a: PathPoint, b: PathPoint, parameters: PathVerificationParameters): boolean {
  return unwrapMeters(
    distanceBetween(
      createPosition(a.xMeters, a.yMeters),
      createPosition(b.xMeters, b.yMeters),
    ),
  ) <= parameters.closedLoopToleranceMeters;
}

function normalizePathPoints(
  points: ReadonlyArray<PathPoint>,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): PathPoint[] {
  return normalizePath(points, parameters).points;
}

function normalizePath(points: ReadonlyArray<PathPoint>, parameters: PathVerificationParameters): NormalizedPath {
  if (points.length <= 1) {
    return { points: points.slice(), isClosedLoop: false };
  }

  const normalized = points.slice();
  const firstPoint = normalized[0];
  const lastPoint = normalized[normalized.length - 1];
  const endDistanceMeters = unwrapMeters(
    distanceBetween(
      createPosition(firstPoint.xMeters, firstPoint.yMeters),
      createPosition(lastPoint.xMeters, lastPoint.yMeters),
    ),
  );
  const isDuplicateClosedLoop = endDistanceMeters <= parameters.closedLoopToleranceMeters;
  if (arePathPointsClose(firstPoint, lastPoint, parameters)) {
    normalized.pop();
  }

  return {
    points: normalized,
    isClosedLoop: isDuplicateClosedLoop || endDistanceMeters <= parameters.closedLoopDetectionToleranceMeters,
  };
}

export function findNearestPathPointIndex(points: ReadonlyArray<PathPoint>, pose: Pose): number {
  if (points.length === 0) {
    return -1;
  }

  const poseX = unwrapMeters(pose.position.xMeters);
  const poseY = unwrapMeters(pose.position.yMeters);

  let nearestIndex = 0;
  let nearestDistance = Infinity;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const dx = poseX - point.xMeters;
    const dy = poseY - point.yMeters;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

export function buildDrivePathPoints(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): PathPoint[] {
  const approachPlan = buildVerificationApproachPlan(points, pose, parameters);
  if (approachPlan === null) {
    return [];
  }

  return buildDrivePathPointsForDirection(points, pose, approachPlan.pathDirection, parameters);
}

export function buildDrivePathPointsForDirection(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  pathDirection: "forward" | "reverse",
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): PathPoint[] {
  const normalizedPath = normalizePath(points, parameters);
  const normalized = normalizedPath.points;
  if (normalized.length === 0) {
    return [];
  }

  const nearestIndex = findNearestPathPointIndex(normalized, pose);
  if (nearestIndex < 0) {
    return [];
  }

  return buildPathPointsForDirectionFromIndex(normalized, nearestIndex, pathDirection, normalizedPath.isClosedLoop);
}

function buildPathPointsForDirectionFromIndex(
  points: ReadonlyArray<PathPoint>,
  startIndex: number,
  pathDirection: "forward" | "reverse",
  isClosedLoop: boolean,
): PathPoint[] {
  if (points.length === 0 || startIndex < 0 || startIndex >= points.length) {
    return [];
  }

  const rotated = pathDirection === "forward"
    ? rotatePathForward(points, startIndex)
    : rotatePathReverse(points, startIndex);

  return isClosedLoop ? rotated.concat([rotated[0]]) : rotated;
}

export function buildVerificationPathPoints(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): PathPoint[] {
  const approachPlan = buildVerificationApproachPlan(points, pose, parameters);
  if (approachPlan === null) {
    return [];
  }

  return buildVerificationPathPointsFromPlan(points, pose, approachPlan, parameters);
}

export function buildVerificationPathPointsFromPlan(
  points: ReadonlyArray<PathPoint>,
  _pose: Pose,
  plan: VerificationApproachPlan,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): PathPoint[] {
  const normalizedPath = normalizePath(points, parameters);
  const drivePoints = buildPathPointsForDirectionFromIndex(
    normalizedPath.points,
    plan.nearestIndex,
    plan.pathDirection,
    normalizedPath.isClosedLoop,
  );
  if (drivePoints.length < 2) {
    return drivePoints;
  }

  // Verify always returns to the join point. For closed loops the drive helper
  // already appends a duplicate trailing point; for open paths we add it here
  // so the segmented executor drives back to where it joined.
  const first = drivePoints[0];
  const last = drivePoints[drivePoints.length - 1];
  if (first.xMeters === last.xMeters && first.yMeters === last.yMeters) {
    return drivePoints;
  }
  return drivePoints.concat([first]);
}

export function buildPerimeterDrivePathPoints(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): PathPoint[] {
  const plan = buildPerimeterJoinPlan(points, pose, parameters);
  if (plan === null) {
    return [];
  }

  return buildPerimeterPathPointsFromPlan(points, plan, parameters);
}

export function buildPerimeterFollowPlan(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  pathDirection: "forward" | "reverse",
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): VerificationApproachPlan | null {
  const normalized = normalizePathPoints(points, parameters);
  if (normalized.length === 0) {
    return null;
  }

  const nearestIndex = findNearestPathPointIndex(normalized, pose);
  if (nearestIndex < 0) {
    return null;
  }

  const { approachAlignmentErrorDeg: _unused, ...plan } = buildDirectJoinPlanForDirection(
    normalized,
    pose,
    nearestIndex,
    pathDirection,
    parameters,
  );
  return plan;
}

export function buildPerimeterPathPointsFromPlan(
  points: ReadonlyArray<PathPoint>,
  plan: VerificationApproachPlan,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): PathPoint[] {
  const normalizedPath = normalizePath(points, parameters);
  const normalized = normalizedPath.points;
  if (normalized.length === 0 || plan.nearestIndex < 0 || plan.nearestIndex >= normalized.length) {
    return [];
  }

  const rotated = plan.pathDirection === "forward"
    ? rotatePathForward(normalized, plan.nearestIndex)
    : rotatePathReverse(normalized, plan.nearestIndex);

  return normalizedPath.isClosedLoop
    ? rotated.concat([rotated[0]])
    : rotated;
}

export function buildPerimeterPathPointsFromPose(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  pathDirection: "forward" | "reverse",
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
  minimumStartDistanceMeters = 0.5,
): PathPoint[] {
  const followPlan = buildPerimeterFollowPlan(points, pose, pathDirection, parameters);
  if (followPlan === null) {
    return [];
  }

  const normalizedPath = normalizePath(points, parameters);
  const perimeterPoints = buildPathPointsForDirectionFromIndex(
    normalizedPath.points,
    followPlan.nearestIndex,
    followPlan.pathDirection,
    normalizedPath.isClosedLoop,
  );
  if (perimeterPoints.length === 0) {
    return [];
  }

  const livePosePoint: PathPoint = {
    xMeters: unwrapMeters(pose.position.xMeters),
    yMeters: unwrapMeters(pose.position.yMeters),
    capturedAt: perimeterPoints[0]?.capturedAt ?? Date.now(),
  };

  const startDistanceMeters = Math.max(0, minimumStartDistanceMeters);
  if (startDistanceMeters <= 1e-9) {
    return finalizePoseJoinedPerimeterPath(livePosePoint, perimeterPoints, normalizedPath.isClosedLoop);
  }

  let accumulatedMeters = pointDistance(livePosePoint, perimeterPoints[0]);
  if (accumulatedMeters >= startDistanceMeters) {
    return finalizePoseJoinedPerimeterPath(livePosePoint, perimeterPoints, normalizedPath.isClosedLoop);
  }

  for (let index = 1; index < perimeterPoints.length; index += 1) {
    const previous = perimeterPoints[index - 1];
    const current = perimeterPoints[index];
    const segmentLengthMeters = pointDistance(previous, current);
    if (segmentLengthMeters <= 1e-9) {
      continue;
    }

    if (accumulatedMeters + segmentLengthMeters >= startDistanceMeters) {
      const remainingMeters = startDistanceMeters - accumulatedMeters;
      const ratio = remainingMeters / segmentLengthMeters;
      const injectedPoint: PathPoint = {
        xMeters: previous.xMeters + ((current.xMeters - previous.xMeters) * ratio),
        yMeters: previous.yMeters + ((current.yMeters - previous.yMeters) * ratio),
        capturedAt: current.capturedAt,
      };
      return finalizePoseJoinedPerimeterPath(
        livePosePoint,
        [injectedPoint, ...perimeterPoints.slice(index)],
        normalizedPath.isClosedLoop,
      );
    }
    accumulatedMeters += segmentLengthMeters;
  }

  return finalizePoseJoinedPerimeterPath(livePosePoint, perimeterPoints, normalizedPath.isClosedLoop);
}

export function buildPerimeterPathPointsFromPlanAndPose(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  plan: VerificationApproachPlan,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
  minimumStartDistanceMeters = 0.5,
): PathPoint[] {
  const normalizedPath = normalizePath(points, parameters);
  const perimeterPoints = buildPathPointsForDirectionFromIndex(
    normalizedPath.points,
    plan.nearestIndex,
    plan.pathDirection,
    normalizedPath.isClosedLoop,
  );
  if (perimeterPoints.length === 0) {
    return [];
  }

  const livePosePoint: PathPoint = {
    xMeters: unwrapMeters(pose.position.xMeters),
    yMeters: unwrapMeters(pose.position.yMeters),
    capturedAt: perimeterPoints[0]?.capturedAt ?? Date.now(),
  };

  const startDistanceMeters = Math.max(0, minimumStartDistanceMeters);
  if (startDistanceMeters <= 1e-9) {
    return finalizePoseJoinedPerimeterPath(livePosePoint, perimeterPoints, normalizedPath.isClosedLoop);
  }

  let accumulatedMeters = pointDistance(livePosePoint, perimeterPoints[0]);
  if (accumulatedMeters >= startDistanceMeters) {
    return finalizePoseJoinedPerimeterPath(livePosePoint, perimeterPoints, normalizedPath.isClosedLoop);
  }

  for (let index = 1; index < perimeterPoints.length; index += 1) {
    const previous = perimeterPoints[index - 1];
    const current = perimeterPoints[index];
    const segmentLengthMeters = pointDistance(previous, current);
    if (segmentLengthMeters <= 1e-9) {
      continue;
    }

    if (accumulatedMeters + segmentLengthMeters >= startDistanceMeters) {
      const remainingMeters = startDistanceMeters - accumulatedMeters;
      const ratio = remainingMeters / segmentLengthMeters;
      const injectedPoint: PathPoint = {
        xMeters: previous.xMeters + ((current.xMeters - previous.xMeters) * ratio),
        yMeters: previous.yMeters + ((current.yMeters - previous.yMeters) * ratio),
        capturedAt: current.capturedAt,
      };
      return finalizePoseJoinedPerimeterPath(
        livePosePoint,
        [injectedPoint, ...perimeterPoints.slice(index)],
        normalizedPath.isClosedLoop,
      );
    }
    accumulatedMeters += segmentLengthMeters;
  }

  return finalizePoseJoinedPerimeterPath(livePosePoint, perimeterPoints, normalizedPath.isClosedLoop);
}

function pointDistance(a: PathPoint, b: PathPoint): number {
  return Math.hypot(a.xMeters - b.xMeters, a.yMeters - b.yMeters);
}

function finalizePoseJoinedPerimeterPath(
  livePosePoint: PathPoint,
  remainder: PathPoint[],
  isClosedLoop: boolean,
): PathPoint[] {
  const path = [livePosePoint, ...remainder];
  return isClosedLoop ? path.concat([livePosePoint]) : path;
}

/**
 * Approach an obstacle path tangentially so the mower arrives already facing
 * roughly along the perimeter rather than poking into it.
 */
export interface VerificationApproachPlan {
  readonly nearestIndex: number;
  readonly joinPoint: PathPoint;
  readonly tangentHeading: InternalHeading;
  readonly approachTarget: { xMeters: number; yMeters: number };
  readonly distanceToJoinMeters: number;
  readonly turnOnly: boolean;
  readonly pathDirection: "forward" | "reverse";
}

interface VerificationApproachCandidate extends VerificationApproachPlan {
  readonly approachAlignmentErrorDeg: number;
}

function getForwardTangentPoint(points: ReadonlyArray<PathPoint>, nearestIndex: number): PathPoint {
  if (points.length === 1) {
    return points[nearestIndex];
  }

  const nextIndex = nearestIndex < points.length - 1 ? nearestIndex + 1 : 0;
  if (nextIndex !== nearestIndex) {
    return points[nextIndex];
  }

  const previousIndex = nearestIndex > 0 ? nearestIndex - 1 : points.length - 1;
  return points[previousIndex];
}

function getReverseTangentPoint(points: ReadonlyArray<PathPoint>, nearestIndex: number): PathPoint {
  if (points.length === 1) {
    return points[nearestIndex];
  }

  const previousIndex = nearestIndex > 0 ? nearestIndex - 1 : points.length - 1;
  if (previousIndex !== nearestIndex) {
    return points[previousIndex];
  }

  const nextIndex = nearestIndex < points.length - 1 ? nearestIndex + 1 : 0;
  return points[nextIndex];
}

function rotatePathForward(points: ReadonlyArray<PathPoint>, startIndex: number): PathPoint[] {
  return points.slice(startIndex).concat(points.slice(0, startIndex));
}

function rotatePathReverse(points: ReadonlyArray<PathPoint>, startIndex: number): PathPoint[] {
  const reversed = points.slice().reverse();
  const reverseStartIndex = points.length - 1 - startIndex;
  return reversed.slice(reverseStartIndex).concat(reversed.slice(0, reverseStartIndex));
}

function getHeadingAlignmentCost(pose: Pose, tangentHeading: InternalHeading): number {
  return Math.abs(unwrapRelativeAngle(headingDifference(pose.heading, tangentHeading)));
}

function buildApproachPlanForDirection(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  nearestIndex: number,
  pathDirection: "forward" | "reverse",
  parameters: PathVerificationParameters,
): VerificationApproachCandidate {
  const joinPoint = points[nearestIndex];
  const tangentPoint = pathDirection === "forward"
    ? getForwardTangentPoint(points, nearestIndex)
    : getReverseTangentPoint(points, nearestIndex);
  const tangentHeading = angleTo(
    createPosition(joinPoint.xMeters, joinPoint.yMeters),
    createPosition(tangentPoint.xMeters, tangentPoint.yMeters),
  ) as InternalHeading;
  const approachTarget = buildTangentialApproachTarget(joinPoint, tangentHeading, parameters);
  const approachHeading = angleTo(
    createPosition(unwrapMeters(pose.position.xMeters), unwrapMeters(pose.position.yMeters)),
    createPosition(joinPoint.xMeters, joinPoint.yMeters),
  ) as InternalHeading;
  const approachAlignmentErrorDeg = Math.abs(unwrapRelativeAngle(headingDifference(approachHeading, tangentHeading)));

  const poseX = unwrapMeters(pose.position.xMeters);
  const poseY = unwrapMeters(pose.position.yMeters);
  const distanceToJoinMeters = Math.hypot(joinPoint.xMeters - poseX, joinPoint.yMeters - poseY);

  return {
    nearestIndex,
    joinPoint,
    tangentHeading,
    approachTarget,
    distanceToJoinMeters,
    turnOnly: distanceToJoinMeters <= parameters.verificationTurnOnlyDistanceMeters,
    pathDirection,
    approachAlignmentErrorDeg,
  };
}

export function buildVerificationApproachPlan(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): VerificationApproachPlan | null {
  const normalized = normalizePathPoints(points, parameters);
  if (normalized.length === 0) {
    return null;
  }

  const nearestIndex = findNearestPathPointIndex(normalized, pose);
  if (nearestIndex < 0) {
    return null;
  }

  const forwardPlan = buildApproachPlanForDirection(normalized, pose, nearestIndex, "forward", parameters);
  const reversePlan = buildApproachPlanForDirection(normalized, pose, nearestIndex, "reverse", parameters);
  const bestPlan = forwardPlan.approachAlignmentErrorDeg <= reversePlan.approachAlignmentErrorDeg
    ? forwardPlan
    : reversePlan;

  const { approachAlignmentErrorDeg: _unused, ...plan } = bestPlan;
  return plan;
}

export function buildPerimeterJoinPlan(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): VerificationApproachPlan | null {
  const normalized = normalizePathPoints(points, parameters);
  if (normalized.length === 0) {
    return null;
  }

  const nearestIndex = findNearestPathPointIndex(normalized, pose);
  if (nearestIndex < 0) {
    return null;
  }

  const forwardPlan = buildDirectJoinPlanForDirection(normalized, pose, nearestIndex, "forward", parameters);
  const reversePlan = buildDirectJoinPlanForDirection(normalized, pose, nearestIndex, "reverse", parameters);
  return forwardPlan.approachAlignmentErrorDeg <= reversePlan.approachAlignmentErrorDeg
    ? forwardPlan
    : reversePlan;
}

export function buildVerificationApproachTarget(
  point: PathPoint,
  pose: Pose,
  parameters: PathVerificationParameters = DEFAULT_PATH_VERIFICATION_PARAMETERS,
): { xMeters: number; yMeters: number } {
  const dx = point.xMeters - unwrapMeters(pose.position.xMeters);
  const dy = point.yMeters - unwrapMeters(pose.position.yMeters);
  const distance = Math.hypot(dx, dy);

  if (!Number.isFinite(distance) || distance <= parameters.verificationApproachStandoffMeters) {
    return { xMeters: point.xMeters, yMeters: point.yMeters };
  }

  const scale = (distance - parameters.verificationApproachStandoffMeters) / distance;
  return {
    xMeters: unwrapMeters(pose.position.xMeters) + (dx * scale),
    yMeters: unwrapMeters(pose.position.yMeters) + (dy * scale),
  };
}

function buildTangentialApproachTarget(
  joinPoint: PathPoint,
  tangentHeading: InternalHeading,
  parameters: PathVerificationParameters,
): { xMeters: number; yMeters: number } {
  const tangentRadians = (unwrapInternalHeading(tangentHeading) * Math.PI) / 180;
  return {
    xMeters: joinPoint.xMeters - (Math.cos(tangentRadians) * parameters.verificationApproachStandoffMeters),
    yMeters: joinPoint.yMeters - (Math.sin(tangentRadians) * parameters.verificationApproachStandoffMeters),
  };
}

function buildDirectJoinPlanForDirection(
  points: ReadonlyArray<PathPoint>,
  pose: Pose,
  nearestIndex: number,
  pathDirection: "forward" | "reverse",
  parameters: PathVerificationParameters,
): VerificationApproachCandidate {
  const joinPoint = points[nearestIndex];
  const tangentPoint = pathDirection === "forward"
    ? getForwardTangentPoint(points, nearestIndex)
    : getReverseTangentPoint(points, nearestIndex);
  const tangentHeading = angleTo(
    createPosition(joinPoint.xMeters, joinPoint.yMeters),
    createPosition(tangentPoint.xMeters, tangentPoint.yMeters),
  ) as InternalHeading;

  const poseX = unwrapMeters(pose.position.xMeters);
  const poseY = unwrapMeters(pose.position.yMeters);
  const distanceToJoinMeters = Math.hypot(joinPoint.xMeters - poseX, joinPoint.yMeters - poseY);

  return {
    nearestIndex,
    joinPoint,
    tangentHeading,
    approachTarget: { xMeters: joinPoint.xMeters, yMeters: joinPoint.yMeters },
    distanceToJoinMeters,
    turnOnly: distanceToJoinMeters <= parameters.verificationTurnOnlyDistanceMeters,
    pathDirection,
    approachAlignmentErrorDeg: getHeadingAlignmentCost(pose, tangentHeading),
  };
}
