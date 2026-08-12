import { PathPoint } from "./pathFollowerApi.js";

export interface ConservativeLookaheadPlan {
  readonly lookaheadMeters: number;
  readonly maximumDeviationMeters: number;
  readonly requiresCornerStops: boolean;
}

const LOOKAHEAD_SEARCH_STEP_METERS = 0.05;
const ROUTE_ANALYSIS_SAMPLE_SPACING_METERS = 0.05;

/**
 * Chooses one stable moving-lookahead distance for a complete ordered route.
 * The selected distance is the longest candidate whose chords stay within the
 * permitted deviation at every sampled position. A route with a genuine sharp
 * corner falls back to the minimum lookahead and advertises that a deliberate
 * stop/pivot is required there; it never relaxes the deviation limit.
 */
export function planConservativeRouteLookahead(
  points: ReadonlyArray<PathPoint>,
  options: {
    readonly minimumLookaheadMeters: number;
    readonly maximumLookaheadMeters: number;
    readonly maximumPathDeviationMeters: number;
    readonly loopPath: boolean;
  },
): ConservativeLookaheadPlan {
  const minimumLookaheadMeters = Math.max(LOOKAHEAD_SEARCH_STEP_METERS, options.minimumLookaheadMeters);
  const maximumPathDeviationMeters = Math.max(0, options.maximumPathDeviationMeters);
  const samples = resampleRoute(points, ROUTE_ANALYSIS_SAMPLE_SPACING_METERS, options.loopPath);

  if (samples.length < 2) {
    return {
      lookaheadMeters: minimumLookaheadMeters,
      maximumDeviationMeters: 0,
      requiresCornerStops: false,
    };
  }
  const routeLengthMeters = samples.slice(1).reduce(
    (total, point, index) => total + distance(samples[index], point),
    0,
  );
  const boundedMaximumLookaheadMeters = Math.min(options.maximumLookaheadMeters, routeLengthMeters);
  const maximumLookaheadMeters = Math.max(
    minimumLookaheadMeters,
    Math.floor(boundedMaximumLookaheadMeters / LOOKAHEAD_SEARCH_STEP_METERS)
      * LOOKAHEAD_SEARCH_STEP_METERS,
  );

  for (
    let candidateMeters = maximumLookaheadMeters;
    candidateMeters >= minimumLookaheadMeters - 1e-9;
    candidateMeters -= LOOKAHEAD_SEARCH_STEP_METERS
  ) {
    const deviation = maximumRouteChordDeviation(samples, candidateMeters, options.loopPath);
    if (deviation <= maximumPathDeviationMeters + 1e-9) {
      return {
        lookaheadMeters: roundCentimeters(candidateMeters),
        maximumDeviationMeters: deviation,
        requiresCornerStops: false,
      };
    }
  }

  return {
    lookaheadMeters: roundCentimeters(minimumLookaheadMeters),
    maximumDeviationMeters: maximumRouteChordDeviation(samples, minimumLookaheadMeters, options.loopPath),
    requiresCornerStops: true,
  };
}

function maximumRouteChordDeviation(
  samples: ReadonlyArray<PathPoint>,
  lookaheadMeters: number,
  loopPath: boolean,
): number {
  const stepCount = Math.max(1, Math.round(lookaheadMeters / ROUTE_ANALYSIS_SAMPLE_SPACING_METERS));
  const uniqueCount = loopPath && samePoint(samples[0], samples[samples.length - 1])
    ? samples.length - 1
    : samples.length;
  let maximumDeviationMeters = 0;
  let testedWindowCount = 0;

  for (let startIndex = 0; startIndex < uniqueCount; startIndex += 1) {
    if (!loopPath && startIndex + stepCount >= uniqueCount) {
      break;
    }
    const endIndex = loopPath
      ? (startIndex + stepCount) % uniqueCount
      : startIndex + stepCount;
    const start = samples[startIndex];
    const end = samples[endIndex];
    testedWindowCount += 1;

    for (let step = 1; step < stepCount; step += 1) {
      const index = loopPath
        ? (startIndex + step) % uniqueCount
        : startIndex + step;
      maximumDeviationMeters = Math.max(
        maximumDeviationMeters,
        pointToSegmentDistance(samples[index], start, end),
      );
    }
  }

  if (testedWindowCount === 0 || maximumDeviationMeters <= Number.EPSILON * 2) {
    return 0;
  }
  return maximumDeviationMeters;
}

function resampleRoute(
  points: ReadonlyArray<PathPoint>,
  spacingMeters: number,
  loopPath: boolean,
): PathPoint[] {
  if (points.length === 0) {
    return [];
  }
  const working = points.slice();
  if (loopPath && working.length > 1 && samePoint(working[0], working[working.length - 1])) {
    working.pop();
  }
  if (working.length < 2) {
    return working;
  }
  if (loopPath) {
    working.push(working[0]);
  }

  const sampled: PathPoint[] = [working[0]];
  for (let index = 1; index < working.length; index += 1) {
    const start = working[index - 1];
    const end = working[index];
    const lengthMeters = distance(start, end);
    const subdivisions = Math.max(1, Math.ceil(lengthMeters / spacingMeters));
    for (let step = 1; step <= subdivisions; step += 1) {
      const fraction = step / subdivisions;
      sampled.push({
        xMeters: start.xMeters + ((end.xMeters - start.xMeters) * fraction),
        yMeters: start.yMeters + ((end.yMeters - start.yMeters) * fraction),
        capturedAt: end.capturedAt,
      });
    }
  }
  return sampled;
}

function pointToSegmentDistance(point: PathPoint, start: PathPoint, end: PathPoint): number {
  const dx = end.xMeters - start.xMeters;
  const dy = end.yMeters - start.yMeters;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 1e-12) {
    return distance(point, start);
  }
  const fraction = Math.max(0, Math.min(1, (
    ((point.xMeters - start.xMeters) * dx)
    + ((point.yMeters - start.yMeters) * dy)
  ) / lengthSquared));
  return Math.hypot(
    point.xMeters - (start.xMeters + (dx * fraction)),
    point.yMeters - (start.yMeters + (dy * fraction)),
  );
}

function distance(first: PathPoint, second: PathPoint): number {
  return Math.hypot(first.xMeters - second.xMeters, first.yMeters - second.yMeters);
}

function samePoint(first: PathPoint, second: PathPoint): boolean {
  return distance(first, second) <= 1e-9;
}

function roundCentimeters(value: number): number {
  return Math.round(value * 100) / 100;
}
