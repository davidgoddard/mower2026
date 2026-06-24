import { PathPoint } from "./pathFollowerApi.js";

interface Vector2 {
  readonly x: number;
  readonly y: number;
}

/**
 * If the recorded loop already comes back within this tolerance, treat it as
 * closed and drop the duplicate trailing point before shaping.
 */
const LOOP_CLOSE_TOLERANCE_METERS = 0.05;
/**
 * Primary safety margin applied to obstacle recordings: the convex hull is
 * offset outward by this amount before smoothing so the saved obstacle trace
 * sits slightly outside the operator-drawn perimeter.
 */
const OBSTACLE_SHAPING_OUTWARD_OFFSET_METERS = 0.08;
/**
 * Area runtime shaping should preserve the operator's actual perimeter while
 * removing local GNSS wiggles. The adaptive fitter first tries to replace
 * roughly 2m runs with one straight leg; if the trend is not consistent it
 * recursively halves the attempted run length down to about 20cm.
 */
const AREA_PATH_MIN_SEGMENT_METERS = 0.08;
const AREA_PATH_MAX_TREND_LEG_METERS = 2.0;
const AREA_PATH_MIN_TREND_LEG_METERS = 0.2;
const AREA_PATH_MAX_DEVIATION_METERS = 0.05;
const AREA_PATH_MAX_HEADING_DEVIATION_DEG = 18;
const OBSTACLE_SHAPING_OUTSIDE_MARGIN_STEP_METERS = 0.02;
/**
 * Number of Chaikin corner-cutting passes used to smooth the offset hull.
 * One pass keeps the result recognisable while removing the harshest corners.
 */
const OBSTACLE_SHAPING_CHAIKIN_PASSES = 1;
/**
 * Safety cap on the number of outward nudges for a smoothed point that still
 * falls inside the originally recorded polygon after smoothing.
 */
const OBSTACLE_SHAPING_MAX_OUTSIDE_NUDGE_ATTEMPTS = 24;
/**
 * Chaikin closed-curve subdivision weights. Each edge generates a near-point
 * and far-point that together round the corner without leaving the convex hull.
 */
const CHAIKIN_NEAR_WEIGHT = 0.75;
const CHAIKIN_FAR_WEIGHT = 0.25;

export function shapeObstacleRecordedPath(points: PathPoint[]): PathPoint[] {
  return shapeRecordedClosedPath(points, "outward");
}

export function shapeAreaRecordedPath(points: PathPoint[]): PathPoint[] {
  const normalized = normalizeClosedLoop(points);
  if (normalized.length < 3) {
    return points.slice();
  }

  const filtered = removeTinyClosedSegments(normalized, AREA_PATH_MIN_SEGMENT_METERS);
  const simplified = simplifyClosedLoopByTrend(filtered);
  return closeLoop(
    simplified.map((point, index) => ({
      xMeters: point.x,
      yMeters: point.y,
      capturedAt: points[Math.min(index, points.length - 1)]?.capturedAt ?? Date.now(),
    })),
  );
}

function shapeRecordedClosedPath(points: PathPoint[], mode: "outward" | "inward"): PathPoint[] {
  const normalized = normalizeClosedLoop(points);
  if (normalized.length < 3) {
    return points.slice();
  }

  const hull = buildConvexHull(normalized);
  if (hull.length < 3) {
    return closeLoop(
      normalized.map((point, index) => ({
        xMeters: point.x,
        yMeters: point.y,
        capturedAt: points[Math.min(index, points.length - 1)]?.capturedAt ?? Date.now(),
      })),
    );
  }

  const offsetDistance = mode === "outward"
    ? OBSTACLE_SHAPING_OUTWARD_OFFSET_METERS
    : 0;
  const offset = offsetConvexPolygon(hull, offsetDistance);
  const smoothed = chaikinClosed(offset, OBSTACLE_SHAPING_CHAIKIN_PASSES);
  const centroid = polygonCentroid(hull);
  const safe = smoothed.map((point) => pushPointOutsidePolygon(
    point,
    normalized,
    centroid,
    OBSTACLE_SHAPING_OUTSIDE_MARGIN_STEP_METERS,
  ));

  return closeLoop(
    safe.map((point, index) => ({
      xMeters: point.x,
      yMeters: point.y,
      capturedAt: points[Math.min(index, points.length - 1)]?.capturedAt ?? Date.now(),
    })),
  );
}

function normalizeClosedLoop(points: PathPoint[]): Vector2[] {
  if (points.length === 0) {
    return [];
  }
  const vectors = points.map((point) => ({ x: point.xMeters, y: point.yMeters }));
  const first = vectors[0];
  const last = vectors[vectors.length - 1];
  if (distance(first, last) <= LOOP_CLOSE_TOLERANCE_METERS) {
    vectors.pop();
  }
  return vectors;
}

function closeLoop(points: PathPoint[]): PathPoint[] {
  if (points.length === 0) {
    return [];
  }
  const closed = points.slice();
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (distance({ x: first.xMeters, y: first.yMeters }, { x: last.xMeters, y: last.yMeters }) > 1e-9) {
    closed.push({
      ...first,
      capturedAt: last.capturedAt,
    });
  }
  return closed;
}

function buildConvexHull(points: Vector2[]): Vector2[] {
  const sorted = points
    .slice()
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (sorted.length <= 1) {
    return sorted;
  }

  const lower: Vector2[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Vector2[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function offsetConvexPolygon(points: Vector2[], offsetMeters: number): Vector2[] {
  if (points.length < 3) {
    return points.slice();
  }

  const ccw = signedArea(points) > 0;
  const offsetPoints: Vector2[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const previousDirection = normalizeVector({ x: current.x - previous.x, y: current.y - previous.y });
    const nextDirection = normalizeVector({ x: next.x - current.x, y: next.y - current.y });
    const previousNormal = outwardNormal(previousDirection, ccw);
    const nextNormal = outwardNormal(nextDirection, ccw);

    const previousLinePoint = {
      x: current.x + (previousNormal.x * offsetMeters),
      y: current.y + (previousNormal.y * offsetMeters),
    };
    const nextLinePoint = {
      x: current.x + (nextNormal.x * offsetMeters),
      y: current.y + (nextNormal.y * offsetMeters),
    };

    const intersection = intersectLines(previousLinePoint, previousDirection, nextLinePoint, nextDirection);
    if (intersection !== null) {
      offsetPoints.push(intersection);
      continue;
    }

    const averageNormal = normalizeVector({
      x: previousNormal.x + nextNormal.x,
      y: previousNormal.y + nextNormal.y,
    });
    offsetPoints.push({
      x: current.x + (averageNormal.x * offsetMeters),
      y: current.y + (averageNormal.y * offsetMeters),
    });
  }

  return offsetPoints;
}

function chaikinClosed(points: Vector2[], passes: number): Vector2[] {
  let current = points.slice();
  for (let pass = 0; pass < passes; pass += 1) {
    const next: Vector2[] = [];
    for (let index = 0; index < current.length; index += 1) {
      const a = current[index];
      const b = current[(index + 1) % current.length];
      next.push(
        {
          x: (CHAIKIN_NEAR_WEIGHT * a.x) + (CHAIKIN_FAR_WEIGHT * b.x),
          y: (CHAIKIN_NEAR_WEIGHT * a.y) + (CHAIKIN_FAR_WEIGHT * b.y),
        },
        {
          x: (CHAIKIN_FAR_WEIGHT * a.x) + (CHAIKIN_NEAR_WEIGHT * b.x),
          y: (CHAIKIN_FAR_WEIGHT * a.y) + (CHAIKIN_NEAR_WEIGHT * b.y),
        },
      );
    }
    current = next;
  }
  return current;
}

function pushPointOutsidePolygon(point: Vector2, polygon: Vector2[], centroid: Vector2, marginMeters: number): Vector2 {
  let candidate = point;
  let attempts = 0;
  while (
    isPointInsidePolygon(candidate, polygon) &&
    attempts < OBSTACLE_SHAPING_MAX_OUTSIDE_NUDGE_ATTEMPTS
  ) {
    const direction = normalizeVector({
      x: candidate.x - centroid.x,
      y: candidate.y - centroid.y,
    });
    candidate = {
      x: candidate.x + (direction.x * marginMeters),
      y: candidate.y + (direction.y * marginMeters),
    };
    attempts += 1;
  }
  return candidate;
}

function removeTinyClosedSegments(points: Vector2[], minDistanceMeters: number): Vector2[] {
  if (points.length <= 1) {
    return points.slice();
  }

  const filtered: Vector2[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const previous = filtered[filtered.length - 1];
    const isLast = index === points.length - 1;
    if (isLast || distance(previous, point) >= minDistanceMeters) {
      filtered.push(point);
    }
  }
  return filtered.length >= 3 ? filtered : points.slice();
}

function simplifyClosedLoopByTrend(points: Vector2[]): Vector2[] {
  if (points.length <= 3) {
    return points.slice();
  }

  const kept: Vector2[] = [points[0]];
  let anchorIndex = 0;

  while (anchorIndex < points.length - 1) {
    const candidateEnd = pickAdaptiveTrendEndpoint(points, anchorIndex);
    kept.push(points[candidateEnd]);
    anchorIndex = candidateEnd;
  }

  if (kept.length >= 3 && distance(kept[0], kept[kept.length - 1]) <= LOOP_CLOSE_TOLERANCE_METERS) {
    kept.pop();
  }
  return kept.length >= 3 ? kept : points.slice();
}

function pickAdaptiveTrendEndpoint(points: Vector2[], anchorIndex: number): number {
  if (anchorIndex >= points.length - 1) {
    return anchorIndex;
  }

  let attemptLengthMeters = AREA_PATH_MAX_TREND_LEG_METERS;
  while (attemptLengthMeters >= AREA_PATH_MIN_TREND_LEG_METERS) {
    const candidateIndex = advanceIndexByDistance(points, anchorIndex, attemptLengthMeters);
    if (candidateIndex <= anchorIndex + 1) {
      break;
    }
    if (!closedTrendViolation(points, anchorIndex, candidateIndex)) {
      return candidateIndex;
    }
    attemptLengthMeters /= 2;
  }

  const minimumCandidateIndex = advanceIndexByDistance(points, anchorIndex, AREA_PATH_MIN_TREND_LEG_METERS);
  if (minimumCandidateIndex > anchorIndex) {
    return minimumCandidateIndex;
  }
  return anchorIndex + 1;
}

function advanceIndexByDistance(points: Vector2[], anchorIndex: number, targetDistanceMeters: number): number {
  let travelledMeters = 0;
  let index = anchorIndex;
  while (index < points.length - 1) {
    const nextIndex = index + 1;
    travelledMeters += distance(points[index], points[nextIndex]);
    index = nextIndex;
    if (travelledMeters >= targetDistanceMeters) {
      return index;
    }
  }
  return points.length - 1;
}

function closedTrendViolation(
  points: Vector2[],
  anchorIndex: number,
  probeIndex: number,
): boolean {
  const start = points[anchorIndex];
  const end = points[probeIndex];
  const direction = normalizeVector({
    x: end.x - start.x,
    y: end.y - start.y,
  });
  const cosLimit = Math.cos((AREA_PATH_MAX_HEADING_DEVIATION_DEG * Math.PI) / 180);

  for (let index = anchorIndex + 1; index < probeIndex; index += 1) {
    if (pointToSegmentDistance(points[index], start, end) > AREA_PATH_MAX_DEVIATION_METERS) {
      return true;
    }
    if (localHeadingDeviationExceeds(points[index - 1], points[index], direction, cosLimit)) {
      return true;
    }
  }

  if (localHeadingDeviationExceeds(points[probeIndex - 1], points[probeIndex], direction, cosLimit)) {
    return true;
  }

  return false;
}

function localHeadingDeviationExceeds(start: Vector2, end: Vector2, overallDirection: Vector2, cosLimit: number): boolean {
  const segmentDx = end.x - start.x;
  const segmentDy = end.y - start.y;
  const segmentLength = Math.hypot(segmentDx, segmentDy);
  if (segmentLength <= 1e-9) {
    return false;
  }

  const cosine = ((segmentDx * overallDirection.x) + (segmentDy * overallDirection.y)) / segmentLength;
  return cosine < cosLimit;
}

function pointToSegmentDistance(point: Vector2, start: Vector2, end: Vector2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = (dx * dx) + (dy * dy);
  if (lenSq <= 1e-9) {
    return distance(point, start);
  }

  const t = Math.max(0, Math.min(1, (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lenSq));
  const projected = {
    x: start.x + (dx * t),
    y: start.y + (dy * t),
  };
  return distance(point, projected);
}

function polygonCentroid(points: Vector2[]): Vector2 {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function signedArea(points: Vector2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += (current.x * next.y) - (next.x * current.y);
  }
  return area / 2;
}

function outwardNormal(direction: Vector2, ccw: boolean): Vector2 {
  return ccw
    ? { x: direction.y, y: -direction.x }
    : { x: -direction.y, y: direction.x };
}

function normalizeVector(vector: Vector2): Vector2 {
  const length = Math.hypot(vector.x, vector.y);
  if (length <= 1e-9) {
    return { x: 1, y: 0 };
  }
  return { x: vector.x / length, y: vector.y / length };
}

function intersectLines(pointA: Vector2, directionA: Vector2, pointB: Vector2, directionB: Vector2): Vector2 | null {
  const denominator = (directionA.x * directionB.y) - (directionA.y * directionB.x);
  if (Math.abs(denominator) <= 1e-9) {
    return null;
  }
  const dx = pointB.x - pointA.x;
  const dy = pointB.y - pointA.y;
  const t = ((dx * directionB.y) - (dy * directionB.x)) / denominator;
  return {
    x: pointA.x + (directionA.x * t),
    y: pointA.y + (directionA.y * t),
  };
}

function isPointInsidePolygon(point: Vector2, polygon: Vector2[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < (((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-9)) + a.x);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function cross(origin: Vector2, a: Vector2, b: Vector2): number {
  return ((a.x - origin.x) * (b.y - origin.y)) - ((a.y - origin.y) * (b.x - origin.x));
}

function distance(a: Vector2, b: Vector2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
