import type { PathPoint } from "./pathFollowerApi.js";
import {
  decimateSmoothedAreaPerimeter,
  smoothAreaPerimeterAdaptively,
} from "./experimentalAdaptiveAreaSmoothing.js";

export interface AreaPerimeterGeometry {
  readonly rawPoints: PathPoint[];
  readonly smoothedPoints: PathPoint[];
  readonly reducedPoints: PathPoint[];
  readonly chosenPoints: PathPoint[];
  readonly chosenShape: "raw" | "smoothed" | "reduced";
  readonly timings: {
    readonly smoothingMs: number;
    readonly reductionMs: number;
    readonly totalMs: number;
  };
  readonly stats: {
    readonly rawPointCount: number;
    readonly smoothedPointCount: number;
    readonly reducedPointCount: number;
    readonly smoothedMaxDeviationMeters: number;
    readonly reducedMaxDeviationMeters: number;
    readonly reducedOutsidePointCount: number;
    readonly reducedInvalidSegmentCount: number;
  };
}

const DEFAULT_SMOOTHING_MAX_DEVIATION_METERS = 0.10;
const DEFAULT_REDUCTION_MAX_DEVIATION_METERS = 0.05;
const DEFAULT_RESAMPLE_SPACING_METERS = 0.15;
const DEFAULT_SEGMENT_VALIDATION_SPACING_METERS = 0.05;
const SEAM_REPAIR_TOTAL_BLEND_LENGTH_METERS = 1.0;
const SEAM_REPAIR_HALF_BLEND_LENGTH_METERS = SEAM_REPAIR_TOTAL_BLEND_LENGTH_METERS / 2;
const SEAM_REPAIR_MIN_GAP_METERS = 0.12;
const SEAM_REPAIR_MIN_POINT_COUNT = 8;
const SEAM_REPAIR_SAMPLE_SPACING_METERS = 0.1;

export function shapeAreaRecordedPath(points: PathPoint[]): PathPoint[] {
  return buildAreaPerimeterGeometry(points).chosenPoints;
}

export function buildAreaPerimeterGeometry(points: ReadonlyArray<PathPoint>): AreaPerimeterGeometry {
  const startedAtMs = Date.now();
  const rawPoints = closeLoopPoints(points);
  const repairedRawPoints = hasExplicitClosure(points) ? rawPoints : repairClosureSeam(rawPoints);
  if (rawPoints.length <= 3) {
    return {
      rawPoints,
      smoothedPoints: rawPoints,
      reducedPoints: rawPoints,
      chosenPoints: rawPoints,
      chosenShape: "raw",
      timings: {
        smoothingMs: 0,
        reductionMs: 0,
        totalMs: Date.now() - startedAtMs,
      },
      stats: {
        rawPointCount: rawPoints.length,
        smoothedPointCount: rawPoints.length,
        reducedPointCount: rawPoints.length,
        smoothedMaxDeviationMeters: 0,
        reducedMaxDeviationMeters: 0,
        reducedOutsidePointCount: 0,
        reducedInvalidSegmentCount: 0,
      },
    };
  }

  const smoothingStartedAtMs = Date.now();
  const smoothed = smoothAreaPerimeterAdaptively(repairedRawPoints, {
    resampleSpacingMeters: DEFAULT_RESAMPLE_SPACING_METERS,
    maxDeviationMeters: DEFAULT_SMOOTHING_MAX_DEVIATION_METERS,
    segmentValidationSpacingMeters: DEFAULT_SEGMENT_VALIDATION_SPACING_METERS,
    passes: 3,
    maxSmoothingFactor: 0.42,
    minSmoothingFactor: 0.04,
    cornerStartDeg: 12,
    cornerFullDeg: 40,
  });
  const smoothingMs = Date.now() - smoothingStartedAtMs;

  const reductionStartedAtMs = Date.now();
  const reduced = decimateSmoothedAreaPerimeter(smoothed.smoothedPoints, repairedRawPoints, {
    maxDeviationMeters: DEFAULT_REDUCTION_MAX_DEVIATION_METERS,
    segmentValidationSpacingMeters: DEFAULT_SEGMENT_VALIDATION_SPACING_METERS,
  });
  const reductionMs = Date.now() - reductionStartedAtMs;

  const reducedIsValid = reduced.outsidePointCount === 0
    && reduced.invalidSegmentCount === 0
    && reduced.maxDeviationMeters <= DEFAULT_REDUCTION_MAX_DEVIATION_METERS + 0.000001;
  const smoothedIsValid = smoothed.outsidePointCount === 0
    && smoothed.invalidSegmentCount === 0
    && smoothed.maxDeviationMeters <= DEFAULT_SMOOTHING_MAX_DEVIATION_METERS + 0.000001;

  const chosenPoints = reducedIsValid
    ? reduced.decimatedPoints
    : smoothedIsValid
      ? smoothed.smoothedPoints
      : rawPoints;
  const chosenShape: AreaPerimeterGeometry["chosenShape"] = reducedIsValid
    ? "reduced"
    : smoothedIsValid
      ? "smoothed"
      : "raw";

  return {
    rawPoints,
    smoothedPoints: smoothed.smoothedPoints,
    reducedPoints: reduced.decimatedPoints,
    chosenPoints,
    chosenShape,
    timings: {
      smoothingMs,
      reductionMs,
      totalMs: Date.now() - startedAtMs,
    },
    stats: {
      rawPointCount: rawPoints.length,
      smoothedPointCount: smoothed.smoothedPointCount,
      reducedPointCount: reduced.decimatedPointCount,
      smoothedMaxDeviationMeters: smoothed.maxDeviationMeters,
      reducedMaxDeviationMeters: reduced.maxDeviationMeters,
      reducedOutsidePointCount: reduced.outsidePointCount,
      reducedInvalidSegmentCount: reduced.invalidSegmentCount,
    },
  };
}

function hasExplicitClosure(points: ReadonlyArray<PathPoint>): boolean {
  return points.length > 1 && distance(points[0], points[points.length - 1]) <= 0.001;
}

function closeLoopPoints(points: ReadonlyArray<PathPoint>): PathPoint[] {
  if (points.length === 0) {
    return [];
  }

  const closed = points.slice();
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (distance(first, last) > 0.001) {
    closed.push({
      ...first,
      capturedAt: last.capturedAt,
    });
  }
  return closed;
}

function repairClosureSeam(points: ReadonlyArray<PathPoint>): PathPoint[] {
  const openPoints = stripDuplicateClosure(points);
  if (openPoints.length < SEAM_REPAIR_MIN_POINT_COUNT) {
    return closeLoopPoints(openPoints);
  }

  const seamGapMeters = distance(openPoints[0], openPoints[openPoints.length - 1]);
  if (seamGapMeters < SEAM_REPAIR_MIN_GAP_METERS) {
    return closeLoopPoints(openPoints);
  }

  const headEndIndex = advanceIndexByDistance(openPoints, 0, 1, SEAM_REPAIR_HALF_BLEND_LENGTH_METERS);
  const tailStartIndex = advanceIndexByDistance(openPoints, openPoints.length - 1, -1, SEAM_REPAIR_HALF_BLEND_LENGTH_METERS);
  if (tailStartIndex <= headEndIndex + 2) {
    return closeLoopPoints(openPoints);
  }

  const tailAnchor = openPoints[tailStartIndex];
  const headAnchor = openPoints[headEndIndex];
  const repairedSpanLengthMeters = measureSeamSpanLength(openPoints, tailStartIndex, headEndIndex);
  const sampleCount = Math.max(4, Math.ceil(repairedSpanLengthMeters / SEAM_REPAIR_SAMPLE_SPACING_METERS));
  const tangentScaleMeters = Math.min(
    SEAM_REPAIR_HALF_BLEND_LENGTH_METERS * 0.75,
    distance(tailAnchor, headAnchor) * 0.5,
  );
  const startTangent = scaleVector(estimateLoopTangent(openPoints, tailStartIndex), tangentScaleMeters);
  const endTangent = scaleVector(estimateLoopTangent(openPoints, headEndIndex), tangentScaleMeters);
  const seamCurve = sampleHermiteJoin(
    tailAnchor,
    headAnchor,
    startTangent,
    endTangent,
    sampleCount,
  );

  const repairedOpenPoints = seamCurve.concat(openPoints.slice(headEndIndex + 1, tailStartIndex));
  return closeLoopPoints(repairedOpenPoints);
}

function stripDuplicateClosure(points: ReadonlyArray<PathPoint>): PathPoint[] {
  if (points.length <= 1) {
    return points.slice();
  }

  const first = points[0];
  const last = points[points.length - 1];
  return distance(first, last) <= 0.001 ? points.slice(0, -1) : points.slice();
}

function advanceIndexByDistance(
  points: ReadonlyArray<PathPoint>,
  startIndex: number,
  step: 1 | -1,
  targetDistanceMeters: number,
): number {
  let index = startIndex;
  let travelledMeters = 0;
  while (travelledMeters < targetDistanceMeters) {
    const nextIndex = index + step;
    if (nextIndex < 0 || nextIndex >= points.length) {
      break;
    }
    travelledMeters += distance(points[index], points[nextIndex]);
    index = nextIndex;
  }
  return index;
}

function measureSeamSpanLength(
  points: ReadonlyArray<PathPoint>,
  tailStartIndex: number,
  headEndIndex: number,
): number {
  let totalMeters = 0;
  for (let index = tailStartIndex + 1; index < points.length; index += 1) {
    totalMeters += distance(points[index - 1], points[index]);
  }
  totalMeters += distance(points[points.length - 1], points[0]);
  for (let index = 1; index <= headEndIndex; index += 1) {
    totalMeters += distance(points[index - 1], points[index]);
  }
  return totalMeters;
}

function estimateLoopTangent(points: ReadonlyArray<PathPoint>, index: number): { x: number; y: number } {
  const pointCount = points.length;
  const previous = points[(index - 1 + pointCount) % pointCount];
  const next = points[(index + 1) % pointCount];
  return normalizeVector({
    x: next.xMeters - previous.xMeters,
    y: next.yMeters - previous.yMeters,
  });
}

function sampleHermiteJoin(
  start: PathPoint,
  end: PathPoint,
  startTangent: { x: number; y: number },
  endTangent: { x: number; y: number },
  sampleCount: number,
): PathPoint[] {
  const sampled: PathPoint[] = [];
  for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
    const t = sampleIndex / sampleCount;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = (2 * t3) - (3 * t2) + 1;
    const h10 = t3 - (2 * t2) + t;
    const h01 = (-2 * t3) + (3 * t2);
    const h11 = t3 - t2;
    sampled.push({
      xMeters: (h00 * start.xMeters) + (h10 * startTangent.x) + (h01 * end.xMeters) + (h11 * endTangent.x),
      yMeters: (h00 * start.yMeters) + (h10 * startTangent.y) + (h01 * end.yMeters) + (h11 * endTangent.y),
      capturedAt: Math.round(((1 - t) * start.capturedAt) + (t * end.capturedAt)),
    });
  }
  return sampled;
}

function normalizeVector(vector: { x: number; y: number }): { x: number; y: number } {
  const magnitude = Math.hypot(vector.x, vector.y);
  if (magnitude <= 1e-9) {
    return { x: 0, y: 0 };
  }
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
  };
}

function scaleVector(vector: { x: number; y: number }, scaleMeters: number): { x: number; y: number } {
  return {
    x: vector.x * scaleMeters,
    y: vector.y * scaleMeters,
  };
}

function distance(a: Pick<PathPoint, "xMeters" | "yMeters">, b: Pick<PathPoint, "xMeters" | "yMeters">): number {
  return Math.hypot(a.xMeters - b.xMeters, a.yMeters - b.yMeters);
}
