import { PathPoint } from "./pathFollowerApi.js";

export type FittedPathPrimitive =
  | {
    readonly kind: "straight";
    readonly startIndex: number;
    readonly endIndex: number;
    readonly executionStartIndex: number;
    readonly executionEndIndex: number;
    readonly maxDeviationMeters: number;
  }
  | {
    readonly kind: "arc";
    readonly startIndex: number;
    readonly endIndex: number;
    readonly executionStartIndex: number;
    readonly executionEndIndex: number;
    readonly maxDeviationMeters: number;
    readonly centerX: number;
    readonly centerY: number;
    readonly radiusMeters: number;
    readonly direction: 1 | -1;
  };

export interface FittedPath {
  readonly points: PathPoint[];
  readonly primitives: FittedPathPrimitive[];
}

interface CircleFit {
  readonly centerX: number;
  readonly centerY: number;
  readonly radiusMeters: number;
  readonly direction: 1 | -1;
  readonly angles: number[];
  readonly maxDeviationMeters: number;
}

const ARC_MIN_POINT_COUNT = 3;
const ARC_MIN_TOTAL_TURN_DEG = 3;
const ARC_MAX_LOCAL_TURN_DEG = 15;
const ARC_MIN_RADIUS_METERS = 0.3;
const ARC_MAX_STEP_SWEEP_DEG = 45;

/**
 * Greedily fits the furthest valid primitive from each retained endpoint.
 * A straight wins ties because it is simpler to execute. Smooth arcs retain
 * reference samples projected onto the fitted circle; those samples guide one
 * continuous arc and are not discrete stop-and-turn targets.
 */
export function fitPathToStraightAndArcPrimitives(
  points: ReadonlyArray<PathPoint>,
  maximumDeviationMeters: number,
  maximumStraightVertexTurnDeg = 10,
): FittedPath {
  if (points.length <= 1) {
    return { points: [...points], primitives: [] };
  }

  const tolerance = Math.max(0, maximumDeviationMeters);
  const fittedPoints: PathPoint[] = [points[0]];
  const primitives: FittedPathPrimitive[] = [];
  let anchorIndex = 0;

  while (anchorIndex < points.length - 1) {
    let best: FittedPathPrimitive = {
      kind: "straight",
      startIndex: anchorIndex,
      endIndex: anchorIndex + 1,
      executionStartIndex: 0,
      executionEndIndex: 0,
      maxDeviationMeters: 0,
    };
    let bestCircle: CircleFit | null = null;

    for (let endIndex = anchorIndex + 2; endIndex < points.length; endIndex += 1) {
      const straightDeviation = maximumStraightDeviation(points, anchorIndex, endIndex);
      const straightValid = straightDeviation <= tolerance
        && collectLocalTurns(points, anchorIndex, endIndex).every(
          (turn) => Math.abs(turn) <= Math.max(0, maximumStraightVertexTurnDeg),
        );
      const circle = fitAndValidateCircle(points, anchorIndex, endIndex, tolerance);
      const arcValid = circle !== null;

      if (!straightValid && !arcValid) {
        break;
      }

      if (straightValid) {
        best = {
          kind: "straight",
          startIndex: anchorIndex,
          endIndex,
          executionStartIndex: 0,
          executionEndIndex: 0,
          maxDeviationMeters: straightDeviation,
        };
        bestCircle = null;
      } else if (circle) {
        best = {
          kind: "arc",
          startIndex: anchorIndex,
          endIndex,
          executionStartIndex: 0,
          executionEndIndex: 0,
          maxDeviationMeters: circle.maxDeviationMeters,
          centerX: circle.centerX,
          centerY: circle.centerY,
          radiusMeters: circle.radiusMeters,
          direction: circle.direction,
        };
        bestCircle = circle;
      }
    }

    const executionStartIndex = fittedPoints.length - 1;
    if (best.kind === "straight") {
      fittedPoints.push(points[best.endIndex]);
    } else {
      const circle = bestCircle ?? fitAndValidateCircle(
        points,
        best.startIndex,
        best.endIndex,
        tolerance,
      );
      if (!circle) {
        fittedPoints.push(points[best.endIndex]);
      } else {
        for (let index = best.startIndex + 1; index <= best.endIndex; index += 1) {
          const angle = circle.angles[index - best.startIndex];
          fittedPoints.push({
            xMeters: circle.centerX + (Math.cos(angle) * circle.radiusMeters),
            yMeters: circle.centerY + (Math.sin(angle) * circle.radiusMeters),
            capturedAt: points[index].capturedAt,
          });
        }
      }
    }
    primitives.push({
      ...best,
      executionStartIndex,
      executionEndIndex: fittedPoints.length - 1,
    });
    anchorIndex = best.endIndex;
  }

  return { points: removeDuplicatePoints(fittedPoints), primitives };
}

function maximumStraightDeviation(
  points: ReadonlyArray<PathPoint>,
  startIndex: number,
  endIndex: number,
): number {
  const start = points[startIndex];
  const end = points[endIndex];
  let maximum = 0;
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    maximum = Math.max(maximum, pointToSegmentDistance(points[index], start, end));
  }
  return maximum;
}

function fitAndValidateCircle(
  points: ReadonlyArray<PathPoint>,
  startIndex: number,
  endIndex: number,
  toleranceMeters: number,
): CircleFit | null {
  const pointCount = endIndex - startIndex + 1;
  if (pointCount < ARC_MIN_POINT_COUNT) {
    return null;
  }

  const localTurns = collectLocalTurns(points, startIndex, endIndex);
  if (localTurns.length === 0) {
    return null;
  }
  const nonTrivialTurns = localTurns.filter((turn) => Math.abs(turn) > 0.25);
  if (nonTrivialTurns.length === 0) {
    return null;
  }
  const direction: 1 | -1 = nonTrivialTurns.reduce((sum, turn) => sum + turn, 0) >= 0 ? 1 : -1;
  if (
    nonTrivialTurns.some((turn) => Math.sign(turn) !== direction)
    || localTurns.some((turn) => Math.abs(turn) > ARC_MAX_LOCAL_TURN_DEG)
    || Math.abs(localTurns.reduce((sum, turn) => sum + turn, 0)) < ARC_MIN_TOTAL_TURN_DEG
  ) {
    return null;
  }

  const middleIndex = Math.floor((startIndex + endIndex) / 2);
  const circle = circumcircle(points[startIndex], points[middleIndex], points[endIndex]);
  if (!circle || circle.radiusMeters < ARC_MIN_RADIUS_METERS) {
    return null;
  }

  const angles: number[] = [];
  let maxDeviationMeters = 0;
  let previousAngle: number | null = null;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const point = points[index];
    let angle = Math.atan2(point.yMeters - circle.centerY, point.xMeters - circle.centerX);
    if (previousAngle !== null) {
      angle = unwrapAngleFromPrevious(angle, previousAngle, direction);
      const stepSweepDeg = Math.abs(angle - previousAngle) * (180 / Math.PI);
      if (stepSweepDeg > ARC_MAX_STEP_SWEEP_DEG) {
        return null;
      }
    }
    previousAngle = angle;
    angles.push(angle);
    const radialDistance = Math.hypot(
      point.xMeters - circle.centerX,
      point.yMeters - circle.centerY,
    );
    maxDeviationMeters = Math.max(
      maxDeviationMeters,
      Math.abs(radialDistance - circle.radiusMeters),
    );
  }

  if (maxDeviationMeters > toleranceMeters) {
    return null;
  }
  return {
    ...circle,
    direction,
    angles,
    maxDeviationMeters,
  };
}

function collectLocalTurns(
  points: ReadonlyArray<PathPoint>,
  startIndex: number,
  endIndex: number,
): number[] {
  const turns: number[] = [];
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const incoming = Math.atan2(
      points[index].yMeters - points[index - 1].yMeters,
      points[index].xMeters - points[index - 1].xMeters,
    );
    const outgoing = Math.atan2(
      points[index + 1].yMeters - points[index].yMeters,
      points[index + 1].xMeters - points[index].xMeters,
    );
    turns.push(normalizeRadians(outgoing - incoming) * (180 / Math.PI));
  }
  return turns;
}

function circumcircle(
  first: PathPoint,
  middle: PathPoint,
  last: PathPoint,
): { centerX: number; centerY: number; radiusMeters: number } | null {
  const determinant = 2 * (
    (first.xMeters * (middle.yMeters - last.yMeters))
    + (middle.xMeters * (last.yMeters - first.yMeters))
    + (last.xMeters * (first.yMeters - middle.yMeters))
  );
  if (Math.abs(determinant) <= 1e-9) {
    return null;
  }
  const firstSquared = (first.xMeters ** 2) + (first.yMeters ** 2);
  const middleSquared = (middle.xMeters ** 2) + (middle.yMeters ** 2);
  const lastSquared = (last.xMeters ** 2) + (last.yMeters ** 2);
  const centerX = (
    (firstSquared * (middle.yMeters - last.yMeters))
    + (middleSquared * (last.yMeters - first.yMeters))
    + (lastSquared * (first.yMeters - middle.yMeters))
  ) / determinant;
  const centerY = (
    (firstSquared * (last.xMeters - middle.xMeters))
    + (middleSquared * (first.xMeters - last.xMeters))
    + (lastSquared * (middle.xMeters - first.xMeters))
  ) / determinant;
  return {
    centerX,
    centerY,
    radiusMeters: Math.hypot(first.xMeters - centerX, first.yMeters - centerY),
  };
}

function unwrapAngleFromPrevious(angle: number, previous: number, direction: 1 | -1): number {
  let unwrapped = angle;
  if (direction > 0) {
    while (unwrapped < previous) {
      unwrapped += Math.PI * 2;
    }
  } else {
    while (unwrapped > previous) {
      unwrapped -= Math.PI * 2;
    }
  }
  return unwrapped;
}

function pointToSegmentDistance(point: PathPoint, start: PathPoint, end: PathPoint): number {
  const dx = end.xMeters - start.xMeters;
  const dy = end.yMeters - start.yMeters;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 1e-12) {
    return Math.hypot(point.xMeters - start.xMeters, point.yMeters - start.yMeters);
  }
  const fraction = clamp(
    (((point.xMeters - start.xMeters) * dx) + ((point.yMeters - start.yMeters) * dy))
      / lengthSquared,
    0,
    1,
  );
  return Math.hypot(
    point.xMeters - (start.xMeters + (dx * fraction)),
    point.yMeters - (start.yMeters + (dy * fraction)),
  );
}

function removeDuplicatePoints(points: PathPoint[]): PathPoint[] {
  return points.filter((point, index) => (
    index === 0
    || Math.hypot(
      point.xMeters - points[index - 1].xMeters,
      point.yMeters - points[index - 1].yMeters,
    ) > 1e-6
  ));
}

function normalizeRadians(value: number): number {
  let normalized = value;
  while (normalized > Math.PI) {
    normalized -= Math.PI * 2;
  }
  while (normalized <= -Math.PI) {
    normalized += Math.PI * 2;
  }
  return normalized;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
