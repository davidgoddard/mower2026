import type { PathPoint } from "./pathFollowerApi.js";

interface Vector2 {
  readonly x: number;
  readonly y: number;
}

interface PreparedEdge {
  readonly start: Vector2;
  readonly end: Vector2;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface AdaptiveAreaSmoothingOptions {
  readonly resampleSpacingMeters?: number;
  readonly passes?: number;
  readonly maxDeviationMeters?: number;
  readonly maxSmoothingFactor?: number;
  readonly minSmoothingFactor?: number;
  readonly cornerStartDeg?: number;
  readonly cornerFullDeg?: number;
  readonly segmentValidationSpacingMeters?: number;
}

export interface AdaptiveAreaSmoothingResult {
  readonly originalPointCount: number;
  readonly resampledPointCount: number;
  readonly smoothedPointCount: number;
  readonly smoothedPoints: PathPoint[];
  readonly maxDeviationMeters: number;
  readonly averageDeviationMeters: number;
  readonly outsidePointCount: number;
  readonly invalidSegmentCount: number;
  readonly repairIterations: number;
}

export interface AdaptiveAreaDecimationOptions {
  readonly maxDeviationMeters?: number;
  readonly segmentValidationSpacingMeters?: number;
}

export interface AdaptiveAreaDecimationResult {
  readonly sourcePointCount: number;
  readonly decimatedPointCount: number;
  readonly decimatedPoints: PathPoint[];
  readonly maxDeviationMeters: number;
  readonly averageDeviationMeters: number;
  readonly outsidePointCount: number;
  readonly invalidSegmentCount: number;
}

const DEFAULT_RESAMPLE_SPACING_METERS = 0.15;
const DEFAULT_SEGMENT_VALIDATION_SPACING_METERS = 0.05;
const DEFAULT_MAX_DEVIATION_METERS = 0.1;
const DEFAULT_SMOOTHING_PASSES = 3;
const DEFAULT_MAX_SMOOTHING_FACTOR = 0.42;
const DEFAULT_MIN_SMOOTHING_FACTOR = 0.04;
const DEFAULT_CORNER_START_DEG = 12;
const DEFAULT_CORNER_FULL_DEG = 40;
const EPSILON = 1e-9;
const BOUNDARY_EPSILON_METERS = 0.01;

class PreparedPolygon {
  readonly points: readonly Vector2[];
  readonly edges: readonly PreparedEdge[];
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  private readonly segmentContainmentCache = new Map<string, boolean>();

  constructor(points: ReadonlyArray<Vector2>) {
    this.points = points.slice();
    this.edges = buildPreparedEdges(this.points);
    const bounds = computePolygonBounds(this.points);
    this.minX = bounds.minX;
    this.maxX = bounds.maxX;
    this.minY = bounds.minY;
    this.maxY = bounds.maxY;
  }

  containsPoint(point: Vector2): boolean {
    if (
      point.x < this.minX - BOUNDARY_EPSILON_METERS
      || point.x > this.maxX + BOUNDARY_EPSILON_METERS
      || point.y < this.minY - BOUNDARY_EPSILON_METERS
      || point.y > this.maxY + BOUNDARY_EPSILON_METERS
    ) {
      return false;
    }
    if (this.isPointOnBoundary(point)) {
      return true;
    }

    let inside = false;
    for (const edge of this.edges) {
      const { start, end } = edge;
      const intersects = ((start.y > point.y) !== (end.y > point.y))
        && (point.x < (((end.x - start.x) * (point.y - start.y)) / ((end.y - start.y) || EPSILON)) + start.x);
      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  isPointOnBoundary(point: Vector2): boolean {
    for (const edge of this.edges) {
      if (
        point.x < edge.minX - BOUNDARY_EPSILON_METERS
        || point.x > edge.maxX + BOUNDARY_EPSILON_METERS
        || point.y < edge.minY - BOUNDARY_EPSILON_METERS
        || point.y > edge.maxY + BOUNDARY_EPSILON_METERS
      ) {
        continue;
      }
      if (pointToSegmentDistance(point, edge.start, edge.end) <= BOUNDARY_EPSILON_METERS) {
        return true;
      }
    }
    return false;
  }

  segmentStaysInside(start: Vector2, end: Vector2, spacingMeters: number): boolean {
    const cacheKey = `${start.x},${start.y}|${end.x},${end.y}`;
    const cached = this.segmentContainmentCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let result = this.segmentStaysInsideByIntersection(start, end);
    if (!result) {
      result = this.segmentStaysInsideBySampling(start, end, spacingMeters);
    }

    this.segmentContainmentCache.set(cacheKey, result);
    this.segmentContainmentCache.set(`${end.x},${end.y}|${start.x},${start.y}`, result);
    return result;
  }

  private segmentStaysInsideByIntersection(start: Vector2, end: Vector2): boolean {
    if (!this.containsPoint(start) || !this.containsPoint(end)) {
      return false;
    }

    const midpoint = interpolate(start, end, 0.5);
    if (!this.containsPoint(midpoint)) {
      return false;
    }

    const segmentBounds = {
      minX: Math.min(start.x, end.x) - BOUNDARY_EPSILON_METERS,
      maxX: Math.max(start.x, end.x) + BOUNDARY_EPSILON_METERS,
      minY: Math.min(start.y, end.y) - BOUNDARY_EPSILON_METERS,
      maxY: Math.max(start.y, end.y) + BOUNDARY_EPSILON_METERS,
    };
    for (const edge of this.edges) {
      if (!boundsOverlap(segmentBounds, edge)) {
        continue;
      }
      if (segmentsProperlyIntersect(start, end, edge.start, edge.end)) {
        return false;
      }
    }
    return true;
  }

  private segmentStaysInsideBySampling(start: Vector2, end: Vector2, spacingMeters: number): boolean {
    const segmentLength = distance(start, end);
    const steps = Math.max(1, Math.ceil(segmentLength / spacingMeters));
    for (let step = 0; step <= steps; step += 1) {
      const point = interpolate(start, end, step / steps);
      if (!this.containsPoint(point)) {
        return false;
      }
    }
    return true;
  }
}

class PreparedReductionContext {
  private readonly collapseCache = new Map<string, boolean>();

  constructor(
    private readonly linear: ReadonlyArray<Vector2>,
    private readonly originalBoundary: PreparedPolygon,
    private readonly maxDeviationMeters: number,
    private readonly spacingMeters: number,
  ) {}

  canCollapse(startIndex: number, endIndex: number): boolean {
    const cacheKey = `${startIndex}:${endIndex}`;
    const cached = this.collapseCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const start = this.linear[startIndex];
    const end = this.linear[endIndex];
    let result = this.originalBoundary.segmentStaysInside(start, end, this.spacingMeters);
    if (result) {
      for (let index = startIndex + 1; index < endIndex; index += 1) {
        if (pointToSegmentDistance(this.linear[index], start, end) > this.maxDeviationMeters + EPSILON) {
          result = false;
          break;
        }
      }
    }

    this.collapseCache.set(cacheKey, result);
    return result;
  }
}

export function smoothAreaPerimeterAdaptively(
  points: ReadonlyArray<PathPoint>,
  options: AdaptiveAreaSmoothingOptions = {},
): AdaptiveAreaSmoothingResult {
  const normalized = stripDuplicateClosure(pointsToVectors(points));
  if (normalized.length < 3) {
    return {
      originalPointCount: points.length,
      resampledPointCount: normalized.length,
      smoothedPointCount: points.length,
      smoothedPoints: points.slice(),
      maxDeviationMeters: 0,
      averageDeviationMeters: 0,
      outsidePointCount: 0,
      invalidSegmentCount: 0,
      repairIterations: 0,
    };
  }

  const resampleSpacingMeters = options.resampleSpacingMeters ?? DEFAULT_RESAMPLE_SPACING_METERS;
  const passes = options.passes ?? DEFAULT_SMOOTHING_PASSES;
  const maxDeviationMeters = options.maxDeviationMeters ?? DEFAULT_MAX_DEVIATION_METERS;
  const maxSmoothingFactor = options.maxSmoothingFactor ?? DEFAULT_MAX_SMOOTHING_FACTOR;
  const minSmoothingFactor = options.minSmoothingFactor ?? DEFAULT_MIN_SMOOTHING_FACTOR;
  const cornerStartDeg = options.cornerStartDeg ?? DEFAULT_CORNER_START_DEG;
  const cornerFullDeg = options.cornerFullDeg ?? DEFAULT_CORNER_FULL_DEG;
  const segmentValidationSpacingMeters = options.segmentValidationSpacingMeters ?? DEFAULT_SEGMENT_VALIDATION_SPACING_METERS;

  const originalLoop = ensureCounterClockwise(resampleClosedLoop(normalized, resampleSpacingMeters));
  const preparedOriginal = new PreparedPolygon(originalLoop);
  const smoothed = originalLoop.slice();
  const smoothingFactors = originalLoop.map((_, index) => computeSmoothingFactor(
    originalLoop,
    index,
    minSmoothingFactor,
    maxSmoothingFactor,
    cornerStartDeg,
    cornerFullDeg,
  ));

  for (let pass = 0; pass < passes; pass += 1) {
    applyAdaptiveLowPass(smoothed, originalLoop, smoothingFactors);
  }

  let repairIterations = 0;
  let changed = true;
  while (changed && repairIterations < 8) {
    changed = false;
    repairIterations += 1;
    for (let index = 0; index < smoothed.length; index += 1) {
      const repaired = repairPointAgainstConstraints(
        smoothed,
        preparedOriginal,
        index,
        maxDeviationMeters,
        segmentValidationSpacingMeters,
      );
      if (repaired) {
        changed = true;
      }
    }
  }

  const deviations = smoothed.map((point, index) => distance(point, originalLoop[index]));
  const outsidePointCount = smoothed.filter((point) => !preparedOriginal.containsPoint(point)).length;
  const invalidSegmentCount = countInvalidSegments(smoothed, preparedOriginal, segmentValidationSpacingMeters);

  return {
    originalPointCount: points.length,
    resampledPointCount: originalLoop.length,
    smoothedPointCount: smoothed.length + 1,
    smoothedPoints: vectorsToClosedPathPoints(smoothed, points),
    maxDeviationMeters: deviations.length > 0 ? Math.max(...deviations) : 0,
    averageDeviationMeters: deviations.length > 0 ? deviations.reduce((sum, value) => sum + value, 0) / deviations.length : 0,
    outsidePointCount,
    invalidSegmentCount,
    repairIterations,
  };
}

export function decimateSmoothedAreaPerimeter(
  smoothedPoints: ReadonlyArray<PathPoint>,
  originalBoundaryPoints: ReadonlyArray<PathPoint>,
  options: AdaptiveAreaDecimationOptions = {},
): AdaptiveAreaDecimationResult {
  const maxDeviationMeters = options.maxDeviationMeters ?? DEFAULT_MAX_DEVIATION_METERS;
  const segmentValidationSpacingMeters = options.segmentValidationSpacingMeters ?? DEFAULT_SEGMENT_VALIDATION_SPACING_METERS;
  const smoothedOpen = stripDuplicateClosure(pointsToVectors(smoothedPoints));
  const originalOpen = ensureCounterClockwise(stripDuplicateClosure(pointsToVectors(originalBoundaryPoints)));
  const preparedOriginal = new PreparedPolygon(originalOpen);

  if (smoothedOpen.length < 3) {
    return {
      sourcePointCount: smoothedPoints.length,
      decimatedPointCount: smoothedPoints.length,
      decimatedPoints: smoothedPoints.slice(),
      maxDeviationMeters: 0,
      averageDeviationMeters: 0,
      outsidePointCount: 0,
      invalidSegmentCount: 0,
    };
  }

  const linear = smoothedOpen.concat([smoothedOpen[0]]);
  const reductionContext = new PreparedReductionContext(
    linear,
    preparedOriginal,
    maxDeviationMeters,
    segmentValidationSpacingMeters,
  );
  const keptIndices = [0];
  let currentIndex = 0;
  while (currentIndex < linear.length - 1) {
    let bestIndex = currentIndex + 1;
    for (let candidateIndex = currentIndex + 2; candidateIndex < linear.length; candidateIndex += 1) {
      if (!reductionContext.canCollapse(currentIndex, candidateIndex)) {
        break;
      }
      bestIndex = candidateIndex;
    }
    keptIndices.push(bestIndex);
    currentIndex = bestIndex;
  }

  const decimatedLinear = keptIndices.map((index) => linear[index]);
  const decimatedOpen = stripDuplicateClosure(decimatedLinear);
  const deviations = measurePolylineDeviation(smoothedOpen, decimatedOpen);

  return {
    sourcePointCount: smoothedPoints.length,
    decimatedPointCount: decimatedOpen.length + 1,
    decimatedPoints: vectorsToClosedPathPoints(decimatedOpen, smoothedPoints),
    maxDeviationMeters: deviations.maxDeviationMeters,
    averageDeviationMeters: deviations.averageDeviationMeters,
    outsidePointCount: decimatedOpen.filter((point) => !preparedOriginal.containsPoint(point)).length,
    invalidSegmentCount: countInvalidSegments(decimatedOpen, preparedOriginal, segmentValidationSpacingMeters),
  };
}

function pointsToVectors(points: ReadonlyArray<PathPoint>): Vector2[] {
  return points.map((point) => ({ x: point.xMeters, y: point.yMeters }));
}

function buildPreparedEdges(points: ReadonlyArray<Vector2>): PreparedEdge[] {
  const edges: PreparedEdge[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    edges.push({
      start,
      end,
      minX: Math.min(start.x, end.x),
      maxX: Math.max(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxY: Math.max(start.y, end.y),
    });
  }
  return edges;
}

function computePolygonBounds(points: ReadonlyArray<Vector2>): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return { minX, maxX, minY, maxY };
}

function vectorsToClosedPathPoints(points: ReadonlyArray<Vector2>, source: ReadonlyArray<PathPoint>): PathPoint[] {
  const closed = closeLoop(points);
  return closed.map((point, index) => ({
    xMeters: point.x,
    yMeters: point.y,
    capturedAt: source[Math.min(index, source.length - 1)]?.capturedAt ?? Date.now(),
  }));
}

function stripDuplicateClosure(points: ReadonlyArray<Vector2>): Vector2[] {
  if (points.length <= 1) {
    return points.slice();
  }
  return distance(points[0], points[points.length - 1]) <= EPSILON ? points.slice(0, -1) : points.slice();
}

function closeLoop(points: ReadonlyArray<Vector2>): Vector2[] {
  if (points.length === 0) {
    return [];
  }
  const closed = points.slice();
  if (distance(closed[0], closed[closed.length - 1]) > EPSILON) {
    closed.push(closed[0]);
  }
  return closed;
}

function resampleClosedLoop(points: ReadonlyArray<Vector2>, spacingMeters: number): Vector2[] {
  const output: Vector2[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (output.length === 0) {
      output.push(start);
    }
    const segmentLength = distance(start, end);
    if (segmentLength <= EPSILON) {
      continue;
    }
    const steps = Math.max(1, Math.ceil(segmentLength / spacingMeters));
    for (let step = 1; step < steps; step += 1) {
      output.push(interpolate(start, end, step / steps));
    }
    output.push(end);
  }
  return stripNearDuplicates(output);
}

function stripNearDuplicates(points: ReadonlyArray<Vector2>): Vector2[] {
  if (points.length <= 1) {
    return points.slice();
  }
  const filtered = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    if (distance(points[index], filtered[filtered.length - 1]) > 0.005) {
      filtered.push(points[index]);
    }
  }
  return stripDuplicateClosure(filtered);
}

function ensureCounterClockwise(points: ReadonlyArray<Vector2>): Vector2[] {
  return signedArea(points) >= 0 ? points.slice() : points.slice().reverse();
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

function computeSmoothingFactor(
  points: ReadonlyArray<Vector2>,
  index: number,
  minFactor: number,
  maxFactor: number,
  cornerStartDeg: number,
  cornerFullDeg: number,
): number {
  const previous = points[(index - 1 + points.length) % points.length];
  const current = points[index];
  const next = points[(index + 1) % points.length];
  const turnDeg = absoluteAngleBetween(previous, current, next);
  const cornerStrength = clamp01((turnDeg - cornerStartDeg) / Math.max(EPSILON, cornerFullDeg - cornerStartDeg));
  return maxFactor - ((maxFactor - minFactor) * cornerStrength);
}

function applyAdaptiveLowPass(
  smoothed: Vector2[],
  original: ReadonlyArray<Vector2>,
  smoothingFactors: ReadonlyArray<number>,
): void {
  const next = smoothed.map((point, index) => {
    const previous = smoothed[(index - 1 + smoothed.length) % smoothed.length];
    const current = point;
    const following = smoothed[(index + 1) % smoothed.length];
    const midpoint = {
      x: (previous.x + following.x) / 2,
      y: (previous.y + following.y) / 2,
    };
    const factor = smoothingFactors[index];
    return {
      x: current.x + ((midpoint.x - current.x) * factor),
      y: current.y + ((midpoint.y - current.y) * factor),
    };
  });

  for (let index = 0; index < smoothed.length; index += 1) {
    smoothed[index] = next[index];
    if (distance(smoothed[index], original[index]) > 0.35) {
      smoothed[index] = blend(smoothed[index], original[index], 0.5);
    }
  }
}

function repairPointAgainstConstraints(
  smoothed: Vector2[],
  original: PreparedPolygon,
  index: number,
  maxDeviationMeters: number,
  segmentValidationSpacingMeters: number,
): boolean {
  const originalPoint = original.points[index];
  let candidate = smoothed[index];
  let changed = false;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    if (
      distance(candidate, originalPoint) <= maxDeviationMeters + EPSILON
      && original.containsPoint(candidate)
      && pointSegmentsAreValid(candidate, smoothed, original, index, segmentValidationSpacingMeters)
    ) {
      break;
    }
    candidate = blend(candidate, originalPoint, 0.5);
    changed = true;
  }
  smoothed[index] = candidate;
  return changed;
}

function pointSegmentsAreValid(
  candidate: Vector2,
  smoothed: ReadonlyArray<Vector2>,
  original: PreparedPolygon,
  index: number,
  spacingMeters: number,
): boolean {
  const previous = smoothed[(index - 1 + smoothed.length) % smoothed.length];
  const next = smoothed[(index + 1) % smoothed.length];
  return original.segmentStaysInside(previous, candidate, spacingMeters)
    && original.segmentStaysInside(candidate, next, spacingMeters);
}

function countInvalidSegments(points: ReadonlyArray<Vector2>, original: PreparedPolygon, spacingMeters: number): number {
  let invalidCount = 0;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (!original.segmentStaysInside(start, end, spacingMeters)) {
      invalidCount += 1;
    }
  }
  return invalidCount;
}

function measurePolylineDeviation(
  sourcePoints: ReadonlyArray<Vector2>,
  candidatePoints: ReadonlyArray<Vector2>,
): { maxDeviationMeters: number; averageDeviationMeters: number } {
  if (sourcePoints.length === 0 || candidatePoints.length === 0) {
    return { maxDeviationMeters: 0, averageDeviationMeters: 0 };
  }
  const candidateClosed = closeLoop(candidatePoints);
  const deviations = sourcePoints.map((point) => pointToPolylineDistance(point, candidateClosed));
  return {
    maxDeviationMeters: Math.max(...deviations),
    averageDeviationMeters: deviations.reduce((sum, value) => sum + value, 0) / deviations.length,
  };
}

function boundsOverlap(
  a: Pick<PreparedEdge, "minX" | "maxX" | "minY" | "maxY">,
  b: Pick<PreparedEdge, "minX" | "maxX" | "minY" | "maxY">,
): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function segmentsProperlyIntersect(a: Vector2, b: Vector2, c: Vector2, d: Vector2): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);

  if (Math.abs(abC) <= EPSILON && onSegment(a, c, b)) return false;
  if (Math.abs(abD) <= EPSILON && onSegment(a, d, b)) return false;
  if (Math.abs(cdA) <= EPSILON && onSegment(c, a, d)) return false;
  if (Math.abs(cdB) <= EPSILON && onSegment(c, b, d)) return false;

  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function orientation(a: Vector2, b: Vector2, c: Vector2): number {
  return ((b.x - a.x) * (c.y - a.y)) - ((b.y - a.y) * (c.x - a.x));
}

function onSegment(a: Vector2, b: Vector2, c: Vector2): boolean {
  return b.x >= Math.min(a.x, c.x) - EPSILON
    && b.x <= Math.max(a.x, c.x) + EPSILON
    && b.y >= Math.min(a.y, c.y) - EPSILON
    && b.y <= Math.max(a.y, c.y) + EPSILON;
}

function pointToSegmentDistance(point: Vector2, start: Vector2, end: Vector2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= EPSILON) {
    return distance(point, start);
  }
  const t = Math.max(0, Math.min(1, (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSquared));
  return distance(point, {
    x: start.x + (dx * t),
    y: start.y + (dy * t),
  });
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
  return minDistance;
}

function absoluteAngleBetween(previous: Vector2, current: Vector2, next: Vector2): number {
  const a = Math.atan2(previous.y - current.y, previous.x - current.x);
  const b = Math.atan2(next.y - current.y, next.x - current.x);
  let delta = Math.abs((b - a) * (180 / Math.PI));
  while (delta > 180) {
    delta -= 360;
  }
  return Math.abs(delta);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function blend(a: Vector2, b: Vector2, amountToB: number): Vector2 {
  return {
    x: a.x + ((b.x - a.x) * amountToB),
    y: a.y + ((b.y - a.y) * amountToB),
  };
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
