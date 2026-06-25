import { PathPoint } from "./pathFollowerApi.js";

interface Vector2 {
  readonly x: number;
  readonly y: number;
}

const RESAMPLE_SPACING_METERS = 0.05;
const MAX_CTE_METERS = 0.10;
const CORNER_WINDOW_METERS = 0.50;
const CORNER_HEADING_THRESHOLD_DEG = 32;
const DOUBLE_BACK_MAX_LENGTH_METERS = 0.50;
const DOUBLE_BACK_CLOSE_DISTANCE_METERS = 0.12;
const CURVE_CUT_DISTANCE_METERS = 0.08;
const NUMERIC_EPSILON_METERS = 0.001;
const LOOP_CLOSE_TOLERANCE_METERS = 0.20;
const OVERLAP_SEARCH_DISTANCE_METERS = 2.5;
const OVERLAP_MAX_PAIR_DISTANCE_METERS = 0.25;
const OVERLAP_MAX_HEADING_DIFF_DEG = 45;
const SAMPLE_SPACING_METERS = 0.02;
const DUPLICATE_POINT_TOLERANCE_METERS = 0.01;
const SPIKE_NEIGHBOR_MAX_METERS = 0.20;
const SPIKE_BASELINE_MAX_METERS = 0.08;
const ROUNDING_MIN_ANGLE_DEG = 8;

export function shapeAreaRecordedPath(points: PathPoint[]): PathPoint[] {
  if (points.length <= 2) {
    return points.slice();
  }

  const cleaned = removeObviousSpikes(removeDuplicateOrNearDuplicatePoints(pointsToVectors(points)));
  const trimmed = trimStartEndOverlap(cleaned);
  const closed = closeLoopVectors(trimmed);
  if (closed.length < 4) {
    return closeLoopPoints(points.slice());
  }

  const originalLoop = stripDuplicateClosure(closed);
  const repairedLoop = signedArea(originalLoop) < 0 ? originalLoop.slice().reverse() : originalLoop.slice();
  const resampled = resampleClosedLoop(repairedLoop, RESAMPLE_SPACING_METERS);
  if (resampled.length < 4) {
    return vectorsToClosedPathPoints(repairedLoop, points);
  }

  let working = stripDuplicateClosure(removeShortDoubleBacks(resampled, repairedLoop));
  if (working.length < 4) {
    working = stripDuplicateClosure(resampled);
  }

  const protectedCorners = detectProtectedCorners(working);
  const simplified = simplifyClosedLoop(working, repairedLoop, protectedCorners);
  const rounded = roundNonProtectedCorners(simplified, repairedLoop, protectedCorners);
  const validated = validateCandidate(rounded, repairedLoop) ? rounded
    : validateCandidate(simplified, repairedLoop) ? simplified
      : validateCandidate(working, repairedLoop) ? working
        : repairedLoop;

  return vectorsToClosedPathPoints(validated, points);
}

function pointsToVectors(points: ReadonlyArray<PathPoint>): Vector2[] {
  return points.map((point) => ({ x: point.xMeters, y: point.yMeters }));
}

function vectorsToClosedPathPoints(points: ReadonlyArray<Vector2>, source: ReadonlyArray<PathPoint>): PathPoint[] {
  const closed = closeLoopVectors(points);
  return closed.map((point, index) => ({
    xMeters: point.x,
    yMeters: point.y,
    capturedAt: source[Math.min(index, source.length - 1)]?.capturedAt ?? Date.now(),
  }));
}

function closeLoopPoints(points: PathPoint[]): PathPoint[] {
  if (points.length === 0) {
    return [];
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (distance({ x: first.xMeters, y: first.yMeters }, { x: last.xMeters, y: last.yMeters }) <= NUMERIC_EPSILON_METERS) {
    return points.slice();
  }
  return points.concat([{ ...first, capturedAt: last.capturedAt }]);
}

function removeDuplicateOrNearDuplicatePoints(points: ReadonlyArray<Vector2>): Vector2[] {
  if (points.length <= 1) {
    return points.slice();
  }

  const filtered: Vector2[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    if (distance(points[index], filtered[filtered.length - 1]) > DUPLICATE_POINT_TOLERANCE_METERS) {
      filtered.push(points[index]);
    }
  }
  if (filtered.length > 1 && distance(filtered[0], filtered[filtered.length - 1]) <= DUPLICATE_POINT_TOLERANCE_METERS) {
    filtered.pop();
  }
  return filtered;
}

function removeObviousSpikes(points: ReadonlyArray<Vector2>): Vector2[] {
  if (points.length < 3) {
    return points.slice();
  }

  const filtered: Vector2[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const prevDistance = distance(previous, current);
    const nextDistance = distance(current, next);
    const baseline = distance(previous, next);
    const turnDeg = absoluteAngleBetween(previous, current, next);

    const isSpike = prevDistance <= SPIKE_NEIGHBOR_MAX_METERS
      && nextDistance <= SPIKE_NEIGHBOR_MAX_METERS
      && baseline <= SPIKE_BASELINE_MAX_METERS
      && turnDeg >= 150;

    if (!isSpike) {
      filtered.push(current);
    }
  }
  return filtered.length >= 3 ? filtered : points.slice();
}

function trimStartEndOverlap(points: ReadonlyArray<Vector2>): Vector2[] {
  if (points.length < 4) {
    return points.slice();
  }

  const cumulative = buildCumulativeDistances(points);
  const startLimit = indexAtDistance(cumulative, OVERLAP_SEARCH_DISTANCE_METERS);
  const endStartIndex = Math.max(1, indexAtDistanceFromEnd(cumulative, OVERLAP_SEARCH_DISTANCE_METERS));

  let bestPair: { startIndex: number; endIndex: number; score: number } | null = null;
  for (let startIndex = 0; startIndex <= startLimit; startIndex += 1) {
    const startHeading = segmentHeading(points, startIndex, true);
    if (startHeading === null) {
      continue;
    }
    for (let endIndex = endStartIndex; endIndex < points.length; endIndex += 1) {
      const pairDistance = distance(points[startIndex], points[endIndex]);
      if (pairDistance > OVERLAP_MAX_PAIR_DISTANCE_METERS) {
        continue;
      }
      const endHeading = segmentHeading(points, endIndex, false);
      if (endHeading === null) {
        continue;
      }
      const headingDiff = wrappedAngleDifferenceDeg(startHeading, endHeading);
      if (headingDiff > OVERLAP_MAX_HEADING_DIFF_DEG) {
        continue;
      }
      const score = pairDistance + (headingDiff * 0.002);
      if (!bestPair || score < bestPair.score) {
        bestPair = { startIndex, endIndex, score };
      }
    }
  }

  if (!bestPair || bestPair.endIndex - bestPair.startIndex < 3) {
    return points.slice();
  }

  return points.slice(bestPair.startIndex, bestPair.endIndex + 1);
}

function closeLoopVectors(points: ReadonlyArray<Vector2>): Vector2[] {
  if (points.length === 0) {
    return [];
  }
  const closed = points.slice();
  if (distance(closed[0], closed[closed.length - 1]) > LOOP_CLOSE_TOLERANCE_METERS) {
    closed.push(closed[0]);
  } else {
    closed[closed.length - 1] = closed[0];
  }
  return closed;
}

function stripDuplicateClosure(points: ReadonlyArray<Vector2>): Vector2[] {
  if (points.length <= 1) {
    return points.slice();
  }
  return distance(points[0], points[points.length - 1]) <= NUMERIC_EPSILON_METERS
    ? points.slice(0, -1)
    : points.slice();
}

function resampleClosedLoop(points: ReadonlyArray<Vector2>, spacingMeters: number): Vector2[] {
  const open = stripDuplicateClosure(closeLoopVectors(points));
  if (open.length < 3) {
    return open.slice();
  }

  const output: Vector2[] = [];
  for (let index = 0; index < open.length; index += 1) {
    const start = open[index];
    const end = open[(index + 1) % open.length];
    if (output.length === 0) {
      output.push(start);
    }
    const segmentLength = distance(start, end);
    if (segmentLength <= NUMERIC_EPSILON_METERS) {
      continue;
    }
    const steps = Math.max(1, Math.ceil(segmentLength / spacingMeters));
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      output.push(interpolate(start, end, t));
    }
    output.push(end);
  }
  return stripDuplicateOrNearDuplicateVectors(output, DUPLICATE_POINT_TOLERANCE_METERS);
}

function removeShortDoubleBacks(points: ReadonlyArray<Vector2>, originalLoop: ReadonlyArray<Vector2>): Vector2[] {
  const working = points.slice();
  let changed = true;

  while (changed) {
    changed = false;
    const protectedCorners = detectProtectedCorners(working);

    for (let startIndex = 0; startIndex < working.length - 3; startIndex += 1) {
      let travelled = 0;
      for (let endIndex = startIndex + 2; endIndex < working.length - 1; endIndex += 1) {
        travelled += distance(working[endIndex - 1], working[endIndex]);
        if (travelled > DOUBLE_BACK_MAX_LENGTH_METERS) {
          break;
        }
        if (distance(working[startIndex], working[endIndex]) > DOUBLE_BACK_CLOSE_DISTANCE_METERS) {
          continue;
        }
        if (hasProtectedCornerBetween(protectedCorners, startIndex, endIndex)) {
          continue;
        }

        const nextIndex = endIndex + 1;
        const candidate = working
          .slice(0, startIndex + 1)
          .concat(working.slice(nextIndex));
        if (!validateCandidate(candidate, originalLoop)) {
          continue;
        }

        working.splice(startIndex + 1, nextIndex - startIndex - 1);
        changed = true;
        break;
      }
      if (changed) {
        break;
      }
    }
  }

  return stripDuplicateOrNearDuplicateVectors(working, DUPLICATE_POINT_TOLERANCE_METERS);
}

function detectProtectedCorners(points: ReadonlyArray<Vector2>): Set<number> {
  const protectedCorners = new Set<number>();
  if (points.length < 3) {
    return protectedCorners;
  }

  const cumulative = buildCumulativeDistancesForOpen(points);
  const halfWindow = CORNER_WINDOW_METERS / 2;
  for (let index = 0; index < points.length; index += 1) {
    const before = pointAtDistanceBefore(points, cumulative, index, halfWindow);
    const after = pointAtDistanceAfter(points, cumulative, index, halfWindow);
    if (!before || !after) {
      continue;
    }
    const headingBefore = Math.atan2(points[index].y - before.y, points[index].x - before.x) * (180 / Math.PI);
    const headingAfter = Math.atan2(after.y - points[index].y, after.x - points[index].x) * (180 / Math.PI);
    const delta = wrappedAngleDifferenceDeg(headingBefore, headingAfter);
    if (delta >= CORNER_HEADING_THRESHOLD_DEG) {
      protectedCorners.add(index);
    }
  }
  return mergeNearbyProtectedCorners(points, protectedCorners);
}

function simplifyClosedLoop(
  points: ReadonlyArray<Vector2>,
  originalLoop: ReadonlyArray<Vector2>,
  protectedCorners: ReadonlySet<number>,
): Vector2[] {
  if (points.length < 4) {
    return points.slice();
  }

  const rotated = rotateToPreferredStart(points, protectedCorners);
  const rotatedProtected = rotateProtectedIndices(protectedCorners, points.length, rotated.offset);
  const linear = rotated.points.concat([rotated.points[0]]);
  const output: Vector2[] = [linear[0]];

  let anchorIndex = 0;
  while (anchorIndex < linear.length - 1) {
    let bestIndex = anchorIndex + 1;
    for (let candidateIndex = linear.length - 1; candidateIndex > anchorIndex + 1; candidateIndex -= 1) {
      if (candidateIndex < linear.length - 1 && hasProtectedCornerBetween(rotatedProtected, anchorIndex, candidateIndex)) {
        continue;
      }
      if (!isSegmentSafe(linear, anchorIndex, candidateIndex, originalLoop)) {
        continue;
      }
      if (!isNewSegmentSimple(output, linear[candidateIndex])) {
        continue;
      }
      bestIndex = candidateIndex;
      break;
    }
    output.push(linear[bestIndex]);
    anchorIndex = bestIndex;
  }

  return stripDuplicateClosure(stripDuplicateOrNearDuplicateVectors(output, DUPLICATE_POINT_TOLERANCE_METERS));
}

function roundNonProtectedCorners(
  points: ReadonlyArray<Vector2>,
  originalLoop: ReadonlyArray<Vector2>,
  protectedCorners: ReadonlySet<number>,
): Vector2[] {
  if (points.length < 4) {
    return points.slice();
  }

  const rounded: Vector2[] = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];

    if (protectedCorners.has(index)) {
      rounded.push(current);
      continue;
    }

    const angleDeg = absoluteAngleBetween(previous, current, next);
    if (angleDeg < ROUNDING_MIN_ANGLE_DEG || angleDeg >= CORNER_HEADING_THRESHOLD_DEG) {
      rounded.push(current);
      continue;
    }

    const prevLength = distance(previous, current);
    const nextLength = distance(current, next);
    if (prevLength < CURVE_CUT_DISTANCE_METERS * 2 || nextLength < CURVE_CUT_DISTANCE_METERS * 2) {
      rounded.push(current);
      continue;
    }

    const cutDistance = Math.min(CURVE_CUT_DISTANCE_METERS, prevLength * 0.25, nextLength * 0.25);
    const before = interpolate(current, previous, cutDistance / prevLength);
    const after = interpolate(current, next, cutDistance / nextLength);
    const candidate = rounded
      .concat([before, after])
      .concat(points.slice(index + 1));
    if (!validateCandidate(candidate, originalLoop)) {
      rounded.push(current);
      continue;
    }

    rounded.push(before, after);
  }

  rounded.push(points[points.length - 1]);
  return stripDuplicateClosure(stripDuplicateOrNearDuplicateVectors(rounded, DUPLICATE_POINT_TOLERANCE_METERS));
}

function validateCandidate(candidateLoop: ReadonlyArray<Vector2>, originalLoop: ReadonlyArray<Vector2>): boolean {
  if (candidateLoop.length < 3) {
    return false;
  }
  const closedCandidate = closeLoopVectors(candidateLoop);
  const closedOriginal = closeLoopVectors(originalLoop);
  if (!isSimpleClosedLoop(closedCandidate)) {
    return false;
  }
  if (!allSamplesInsidePolygon(closedCandidate, closedOriginal)) {
    return false;
  }

  const originalSamples = sampleClosedPolyline(closedOriginal, SAMPLE_SPACING_METERS);
  const candidateSamples = sampleClosedPolyline(closedCandidate, SAMPLE_SPACING_METERS);
  return maxDistanceFromPointsToPolyline(candidateSamples, closedOriginal) <= MAX_CTE_METERS + NUMERIC_EPSILON_METERS
    && maxDistanceFromPointsToPolyline(originalSamples, closedCandidate) <= MAX_CTE_METERS + NUMERIC_EPSILON_METERS;
}

function isSegmentSafe(points: ReadonlyArray<Vector2>, startIndex: number, endIndex: number, originalLoop: ReadonlyArray<Vector2>): boolean {
  if (endIndex <= startIndex) {
    return false;
  }
  const section = points.slice(startIndex, endIndex + 1);
  const candidate = [points[startIndex], points[endIndex]];
  if (!allSamplesInsidePolygon(candidate, closeLoopVectors(originalLoop))) {
    return false;
  }

  const sectionSamples = sampleOpenPolyline(section, SAMPLE_SPACING_METERS);
  const candidateSamples = sampleOpenPolyline(candidate, SAMPLE_SPACING_METERS);
  return maxDistanceFromPointsToPolyline(candidateSamples, closeLoopVectors(originalLoop)) <= MAX_CTE_METERS + NUMERIC_EPSILON_METERS
    && maxDistanceFromPointsToPolyline(sectionSamples, candidate) <= MAX_CTE_METERS + NUMERIC_EPSILON_METERS;
}

function allSamplesInsidePolygon(candidatePath: ReadonlyArray<Vector2>, closedPolygon: ReadonlyArray<Vector2>): boolean {
  const samples = candidatePath.length <= 2
    ? sampleOpenPolyline(candidatePath, SAMPLE_SPACING_METERS)
    : sampleClosedPolyline(closeLoopVectors(candidatePath), SAMPLE_SPACING_METERS);
  return samples.every((point) => isPointInsideOrOnPolygon(point, closedPolygon));
}

function maxDistanceFromPointsToPolyline(points: ReadonlyArray<Vector2>, polyline: ReadonlyArray<Vector2>): number {
  let maxDistanceMeters = 0;
  for (const point of points) {
    maxDistanceMeters = Math.max(maxDistanceMeters, pointToPolylineDistance(point, polyline));
  }
  return maxDistanceMeters;
}

function sampleClosedPolyline(points: ReadonlyArray<Vector2>, spacingMeters: number): Vector2[] {
  const open = stripDuplicateClosure(points);
  const sampled: Vector2[] = [];
  for (let index = 0; index < open.length; index += 1) {
    const start = open[index];
    const end = open[(index + 1) % open.length];
    pushSampledSegment(sampled, start, end, spacingMeters, index === 0);
  }
  return sampled;
}

function sampleOpenPolyline(points: ReadonlyArray<Vector2>, spacingMeters: number): Vector2[] {
  if (points.length === 0) {
    return [];
  }
  const sampled: Vector2[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    pushSampledSegment(sampled, points[index], points[index + 1], spacingMeters, index === 0);
  }
  if (sampled.length === 0) {
    sampled.push(points[0]);
  }
  return sampled;
}

function pushSampledSegment(target: Vector2[], start: Vector2, end: Vector2, spacingMeters: number, includeStart: boolean): void {
  const segmentLength = distance(start, end);
  const steps = Math.max(1, Math.ceil(segmentLength / spacingMeters));
  if (includeStart) {
    target.push(start);
  }
  for (let step = 1; step <= steps; step += 1) {
    target.push(interpolate(start, end, step / steps));
  }
}

function pointToPolylineDistance(point: Vector2, polyline: ReadonlyArray<Vector2>): number {
  if (polyline.length === 0) {
    return Infinity;
  }
  if (polyline.length === 1) {
    return distance(point, polyline[0]);
  }

  let minDistance = Infinity;
  for (let index = 0; index < polyline.length - 1; index += 1) {
    minDistance = Math.min(minDistance, pointToSegmentDistance(point, polyline[index], polyline[index + 1]));
  }
  if (distance(polyline[0], polyline[polyline.length - 1]) > NUMERIC_EPSILON_METERS) {
    return minDistance;
  }
  minDistance = Math.min(minDistance, pointToSegmentDistance(point, polyline[polyline.length - 1], polyline[0]));
  return minDistance;
}

function pointToSegmentDistance(point: Vector2, start: Vector2, end: Vector2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= NUMERIC_EPSILON_METERS) {
    return distance(point, start);
  }
  const t = Math.max(0, Math.min(1, (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSquared));
  return distance(point, {
    x: start.x + (dx * t),
    y: start.y + (dy * t),
  });
}

function isPointInsideOrOnPolygon(point: Vector2, polygon: ReadonlyArray<Vector2>): boolean {
  if (isPointOnPolygonBoundary(point, polygon)) {
    return true;
  }

  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < (((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || NUMERIC_EPSILON_METERS)) + a.x);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function isPointOnPolygonBoundary(point: Vector2, polygon: ReadonlyArray<Vector2>): boolean {
  for (let index = 0; index < polygon.length - 1; index += 1) {
    if (pointToSegmentDistance(point, polygon[index], polygon[index + 1]) <= NUMERIC_EPSILON_METERS) {
      return true;
    }
  }
  return false;
}

function isSimpleClosedLoop(points: ReadonlyArray<Vector2>): boolean {
  const open = stripDuplicateClosure(points);
  for (let aIndex = 0; aIndex < open.length; aIndex += 1) {
    const aStart = open[aIndex];
    const aEnd = open[(aIndex + 1) % open.length];
    for (let bIndex = aIndex + 1; bIndex < open.length; bIndex += 1) {
      if (Math.abs(aIndex - bIndex) <= 1 || (aIndex === 0 && bIndex === open.length - 1)) {
        continue;
      }
      const bStart = open[bIndex];
      const bEnd = open[(bIndex + 1) % open.length];
      if (segmentsIntersect(aStart, aEnd, bStart, bEnd)) {
        return false;
      }
    }
  }
  return true;
}

function isNewSegmentSimple(existing: ReadonlyArray<Vector2>, nextPoint: Vector2): boolean {
  if (existing.length < 3) {
    return true;
  }
  const newStart = existing[existing.length - 1];
  for (let index = 0; index < existing.length - 2; index += 1) {
    if (segmentsIntersect(existing[index], existing[index + 1], newStart, nextPoint)) {
      return false;
    }
  }
  return true;
}

function rotateToPreferredStart(points: ReadonlyArray<Vector2>, protectedCorners: ReadonlySet<number>): { points: Vector2[]; offset: number } {
  const offset = protectedCorners.size > 0 ? Math.min(...protectedCorners) : 0;
  if (offset === 0) {
    return { points: points.slice(), offset };
  }
  return {
    points: points.slice(offset).concat(points.slice(0, offset)),
    offset,
  };
}

function rotateProtectedIndices(indices: ReadonlySet<number>, length: number, offset: number): Set<number> {
  const rotated = new Set<number>();
  for (const index of indices) {
    rotated.add((index - offset + length) % length);
  }
  return rotated;
}

function mergeNearbyProtectedCorners(points: ReadonlyArray<Vector2>, indices: ReadonlySet<number>): Set<number> {
  const sorted = [...indices].sort((a, b) => a - b);
  if (sorted.length <= 1) {
    return new Set(sorted);
  }

  const merged = new Set<number>();
  let current = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    if (distance(points[current], points[sorted[index]]) <= CORNER_WINDOW_METERS / 2) {
      continue;
    }
    merged.add(current);
    current = sorted[index];
  }
  merged.add(current);
  return merged;
}

function hasProtectedCornerBetween(indices: ReadonlySet<number>, startIndex: number, endIndex: number): boolean {
  for (const index of indices) {
    if (index > startIndex && index < endIndex) {
      return true;
    }
  }
  return false;
}

function pointAtDistanceBefore(points: ReadonlyArray<Vector2>, cumulative: ReadonlyArray<number>, index: number, distanceMeters: number): Vector2 | null {
  const targetDistance = cumulative[index] - distanceMeters;
  if (targetDistance < 0) {
    return null;
  }
  return interpolateAtDistance(points, cumulative, targetDistance);
}

function pointAtDistanceAfter(points: ReadonlyArray<Vector2>, cumulative: ReadonlyArray<number>, index: number, distanceMeters: number): Vector2 | null {
  const targetDistance = cumulative[index] + distanceMeters;
  if (targetDistance > cumulative[cumulative.length - 1]) {
    return null;
  }
  return interpolateAtDistance(points, cumulative, targetDistance);
}

function interpolateAtDistance(points: ReadonlyArray<Vector2>, cumulative: ReadonlyArray<number>, targetDistance: number): Vector2 {
  for (let index = 1; index < cumulative.length; index += 1) {
    if (cumulative[index] < targetDistance) {
      continue;
    }
    const segmentDistance = cumulative[index] - cumulative[index - 1];
    if (segmentDistance <= NUMERIC_EPSILON_METERS) {
      return points[index];
    }
    const t = (targetDistance - cumulative[index - 1]) / segmentDistance;
    return interpolate(points[index - 1], points[index], t);
  }
  return points[points.length - 1];
}

function buildCumulativeDistances(points: ReadonlyArray<Vector2>): number[] {
  const cumulative = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
    cumulative.push(total);
  }
  return cumulative;
}

function buildCumulativeDistancesForOpen(points: ReadonlyArray<Vector2>): number[] {
  const cumulative = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
    cumulative.push(total);
  }
  return cumulative;
}

function indexAtDistance(cumulative: ReadonlyArray<number>, distanceMeters: number): number {
  for (let index = 0; index < cumulative.length; index += 1) {
    if (cumulative[index] >= distanceMeters) {
      return index;
    }
  }
  return cumulative.length - 1;
}

function indexAtDistanceFromEnd(cumulative: ReadonlyArray<number>, distanceMeters: number): number {
  const total = cumulative[cumulative.length - 1];
  const target = Math.max(0, total - distanceMeters);
  for (let index = 0; index < cumulative.length; index += 1) {
    if (cumulative[index] >= target) {
      return index;
    }
  }
  return cumulative.length - 1;
}

function segmentHeading(points: ReadonlyArray<Vector2>, index: number, forward: boolean): number | null {
  if (forward) {
    for (let cursor = index + 1; cursor < points.length; cursor += 1) {
      if (distance(points[index], points[cursor]) > NUMERIC_EPSILON_METERS) {
        return Math.atan2(points[cursor].y - points[index].y, points[cursor].x - points[index].x) * (180 / Math.PI);
      }
    }
    return null;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (distance(points[index], points[cursor]) > NUMERIC_EPSILON_METERS) {
      return Math.atan2(points[index].y - points[cursor].y, points[index].x - points[cursor].x) * (180 / Math.PI);
    }
  }
  return null;
}

function stripDuplicateOrNearDuplicateVectors(points: ReadonlyArray<Vector2>, toleranceMeters: number): Vector2[] {
  if (points.length <= 1) {
    return points.slice();
  }
  const filtered: Vector2[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    if (distance(points[index], filtered[filtered.length - 1]) > toleranceMeters) {
      filtered.push(points[index]);
    }
  }
  return filtered;
}

function absoluteAngleBetween(previous: Vector2, current: Vector2, next: Vector2): number {
  const headingBefore = Math.atan2(current.y - previous.y, current.x - previous.x) * (180 / Math.PI);
  const headingAfter = Math.atan2(next.y - current.y, next.x - current.x) * (180 / Math.PI);
  return wrappedAngleDifferenceDeg(headingBefore, headingAfter);
}

function wrappedAngleDifferenceDeg(aDeg: number, bDeg: number): number {
  const diff = ((bDeg - aDeg + 540) % 360) - 180;
  return Math.abs(diff);
}

function signedArea(points: ReadonlyArray<Vector2>): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += (current.x * next.y) - (next.x * current.y);
  }
  return area / 2;
}

function interpolate(start: Vector2, end: Vector2, t: number): Vector2 {
  return {
    x: start.x + ((end.x - start.x) * t),
    y: start.y + ((end.y - start.y) * t),
  };
}

function distance(a: Vector2, b: Vector2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function segmentsIntersect(aStart: Vector2, aEnd: Vector2, bStart: Vector2, bEnd: Vector2): boolean {
  const o1 = orientation(aStart, aEnd, bStart);
  const o2 = orientation(aStart, aEnd, bEnd);
  const o3 = orientation(bStart, bEnd, aStart);
  const o4 = orientation(bStart, bEnd, aEnd);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }

  if (o1 === 0 && isPointOnSegment(bStart, aStart, aEnd)) return true;
  if (o2 === 0 && isPointOnSegment(bEnd, aStart, aEnd)) return true;
  if (o3 === 0 && isPointOnSegment(aStart, bStart, bEnd)) return true;
  if (o4 === 0 && isPointOnSegment(aEnd, bStart, bEnd)) return true;
  return false;
}

function orientation(a: Vector2, b: Vector2, c: Vector2): number {
  const cross = ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
  if (Math.abs(cross) <= NUMERIC_EPSILON_METERS) {
    return 0;
  }
  return cross > 0 ? 1 : 2;
}

function isPointOnSegment(point: Vector2, start: Vector2, end: Vector2): boolean {
  return point.x <= Math.max(start.x, end.x) + NUMERIC_EPSILON_METERS
    && point.x + NUMERIC_EPSILON_METERS >= Math.min(start.x, end.x)
    && point.y <= Math.max(start.y, end.y) + NUMERIC_EPSILON_METERS
    && point.y + NUMERIC_EPSILON_METERS >= Math.min(start.y, end.y)
    && pointToSegmentDistance(point, start, end) <= NUMERIC_EPSILON_METERS;
}
