/**
 * Helpers for path verification runs.
 *
 * Verification starts at the nearest point on the stored path and then
 * continues around the path until it returns to that join point.
 */

import { PathPoint } from "./pathFollowerApi.js";
import { Pose, createPosition, distanceBetween, unwrapMeters } from "../geometry/positionTypes.js";

const CLOSED_LOOP_TOLERANCE_METERS = 0.05;

function arePathPointsClose(a: PathPoint, b: PathPoint): boolean {
  return unwrapMeters(
    distanceBetween(
      createPosition(a.xMeters, a.yMeters),
      createPosition(b.xMeters, b.yMeters),
    ),
  ) <= CLOSED_LOOP_TOLERANCE_METERS;
}

function normalizePathPoints(points: PathPoint[]): PathPoint[] {
  if (points.length <= 1) {
    return points.slice();
  }

  const normalized = points.slice();
  const firstPoint = normalized[0];
  const lastPoint = normalized[normalized.length - 1];
  if (arePathPointsClose(firstPoint, lastPoint)) {
    normalized.pop();
  }

  return normalized;
}

export function findNearestPathPointIndex(points: PathPoint[], pose: Pose): number {
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

export function buildDrivePathPoints(points: PathPoint[], pose: Pose): PathPoint[] {
  const normalized = normalizePathPoints(points);
  if (normalized.length === 0) {
    return [];
  }

  const nearestIndex = findNearestPathPointIndex(normalized, pose);
  if (nearestIndex < 0) {
    return [];
  }

  return normalized.slice(nearestIndex).concat(normalized.slice(0, nearestIndex));
}

export function buildVerificationPathPoints(points: PathPoint[], pose: Pose): PathPoint[] {
  const rotated = buildDrivePathPoints(points, pose);
  if (rotated.length === 0) {
    return [];
  }

  return rotated.concat([rotated[0]]);
}
