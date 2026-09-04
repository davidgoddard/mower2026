import { PathPoint } from "./pathFollowerApi.js";

export interface MowingCoverageTrace {
  readonly stripIndex: number;
  readonly points: ReadonlyArray<PathPoint>;
}

export interface MowingCoverageGapAssessment {
  readonly exceedsCutterWidth: boolean;
  readonly maximumPerpendicularSeparationMeters: number;
  readonly longestOverWidthRunMeters: number;
  readonly comparedSampleCount: number;
}

export interface MowingCoverageRepairLine {
  readonly start: PathPoint;
  readonly end: PathPoint;
  readonly entryStandoff: PathPoint;
  readonly exitStandoff: PathPoint;
  readonly headingDeg: number;
}

interface ProjectedPoint {
  readonly along: number;
  readonly perpendicular: number;
}

const EPSILON = 1e-9;

export function assessPerpendicularCoverageGap(
  previous: MowingCoverageTrace,
  current: MowingCoverageTrace,
  headingDeg: number,
  cutterWidthMeters: number,
  sampleStepMeters: number = 0.05,
  minimumConfirmedRunMeters: number = 0.2,
): MowingCoverageGapAssessment {
  const headingRadians = headingDeg * (Math.PI / 180);
  const direction = { x: Math.cos(headingRadians), y: Math.sin(headingRadians) };
  const normal = { x: -direction.y, y: direction.x };
  const project = (trace: MowingCoverageTrace): ProjectedPoint[] => trace.points
    .map((point) => ({
      along: (point.xMeters * direction.x) + (point.yMeters * direction.y),
      perpendicular: (point.xMeters * normal.x) + (point.yMeters * normal.y),
    }))
    .sort((left, right) => left.along - right.along)
    .filter((point, index, points) => index === 0 || Math.abs(point.along - points[index - 1].along) > EPSILON);

  const previousProjected = project(previous);
  const currentProjected = project(current);
  if (previousProjected.length < 2 || currentProjected.length < 2) {
    return {
      exceedsCutterWidth: false,
      maximumPerpendicularSeparationMeters: 0,
      longestOverWidthRunMeters: 0,
      comparedSampleCount: 0,
    };
  }

  const commonStart = Math.max(previousProjected[0].along, currentProjected[0].along);
  const commonEnd = Math.min(previousProjected.at(-1)!.along, currentProjected.at(-1)!.along);
  if (commonEnd <= commonStart) {
    return {
      exceedsCutterWidth: false,
      maximumPerpendicularSeparationMeters: 0,
      longestOverWidthRunMeters: 0,
      comparedSampleCount: 0,
    };
  }

  const stepMeters = Math.max(0.01, sampleStepMeters);
  let maximumSeparationMeters = 0;
  let overWidthRunStartAlong: number | null = null;
  let longestOverWidthRunMeters = 0;
  let comparedSampleCount = 0;
  for (let along = commonStart; along <= commonEnd + EPSILON; along += stepMeters) {
    const previousPerpendicular = interpolatePerpendicular(previousProjected, along);
    const currentPerpendicular = interpolatePerpendicular(currentProjected, along);
    if (previousPerpendicular === null || currentPerpendicular === null) continue;
    comparedSampleCount += 1;
    const separationMeters = Math.abs(currentPerpendicular - previousPerpendicular);
    maximumSeparationMeters = Math.max(maximumSeparationMeters, separationMeters);
    if (separationMeters > cutterWidthMeters) {
      overWidthRunStartAlong ??= along;
      longestOverWidthRunMeters = Math.max(longestOverWidthRunMeters, along - overWidthRunStartAlong);
    } else {
      overWidthRunStartAlong = null;
    }
  }

  return {
    exceedsCutterWidth: longestOverWidthRunMeters + EPSILON >= minimumConfirmedRunMeters,
    maximumPerpendicularSeparationMeters: maximumSeparationMeters,
    longestOverWidthRunMeters,
    comparedSampleCount,
  };
}

export function buildAdjacentTraceBisector(
  previous: MowingCoverageTrace,
  current: MowingCoverageTrace,
): MowingCoverageRepairLine {
  const previousStart = previous.points[0];
  const previousEnd = previous.points.at(-1);
  const currentFirst = current.points[0];
  const currentLast = current.points.at(-1);
  if (!previousStart || !previousEnd || !currentFirst || !currentLast) {
    throw new Error("coverage_bisector_trace_empty");
  }

  const firstPairingDistance = pointDistance(previousStart, currentFirst)
    + pointDistance(previousEnd, currentLast);
  const reversedPairingDistance = pointDistance(previousStart, currentLast)
    + pointDistance(previousEnd, currentFirst);
  const currentAtPreviousStart = firstPairingDistance <= reversedPairingDistance ? currentFirst : currentLast;
  const currentAtPreviousEnd = firstPairingDistance <= reversedPairingDistance ? currentLast : currentFirst;
  const start = midpoint(previousStart, currentAtPreviousStart);
  const end = midpoint(previousEnd, currentAtPreviousEnd);
  const dx = end.xMeters - start.xMeters;
  const dy = end.yMeters - start.yMeters;
  const lengthMeters = Math.hypot(dx, dy);
  if (lengthMeters <= EPSILON) {
    throw new Error("coverage_bisector_has_no_length");
  }
  return {
    start,
    end,
    entryStandoff: start,
    exitStandoff: end,
    headingDeg: Math.atan2(dy, dx) * (180 / Math.PI),
  };
}

function interpolatePerpendicular(points: ReadonlyArray<ProjectedPoint>, along: number): number | null {
  if (along < points[0].along - EPSILON || along > points.at(-1)!.along + EPSILON) return null;
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (along > right.along + EPSILON) continue;
    const span = right.along - left.along;
    if (span <= EPSILON) return right.perpendicular;
    const fraction = Math.max(0, Math.min(1, (along - left.along) / span));
    return left.perpendicular + ((right.perpendicular - left.perpendicular) * fraction);
  }
  return points.at(-1)!.perpendicular;
}

function midpoint(left: PathPoint, right: PathPoint): PathPoint {
  return {
    xMeters: (left.xMeters + right.xMeters) / 2,
    yMeters: (left.yMeters + right.yMeters) / 2,
    capturedAt: Date.now(),
  };
}

function pointDistance(left: PathPoint, right: PathPoint): number {
  return Math.hypot(right.xMeters - left.xMeters, right.yMeters - left.yMeters);
}
