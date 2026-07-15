import { PathPoint } from "./pathFollowerApi.js";
import { DEFAULT_PATH_FOLLOWING_PARAMETERS } from "../config/pathFollowingConfig.js";

export type MowingBoundaryReference =
  | { readonly kind: "area" }
  | { readonly kind: "obstacle"; readonly obstacleIndex: number };

export interface MowingStrip {
  readonly start: PathPoint;
  readonly end: PathPoint;
  readonly startBoundary: MowingBoundaryReference;
  readonly endBoundary: MowingBoundaryReference;
  readonly centerOffsetMeters: number;
  readonly sequenceIndex: number;
  readonly traversalReversed: boolean;
}

export interface MowingPlan {
  readonly headingDeg: number;
  readonly stripSpacingMeters: number;
  readonly bladeWidthMeters: number;
  readonly stripCount: number;
  readonly strips: MowingStrip[];
  readonly connectors: PathPoint[][];
  readonly performance?: MowingPlanPerformance;
}

export interface MowingPlanOptions {
  readonly headingDeg: number;
  readonly stripSpacingMeters?: number;
  readonly bladeWidthMeters?: number;
  readonly mowingStandoffMeters?: number;
  readonly preferredStartPoint?: MowingInitialEntryPosition;
  readonly obstacles?: ReadonlyArray<ReadonlyArray<PathPoint>>;
}

export interface MowingInitialEntryPosition {
  readonly xMeters: number;
  readonly yMeters: number;
}

export interface MowingInitialEntryPlanOptions {
  readonly obstacles?: ReadonlyArray<ReadonlyArray<PathPoint>>;
  readonly mowingStandoffMeters?: number;
}

export interface MowingInitialEntryPlan {
  readonly entryPoint: PathPoint;
  readonly approachTarget: MowingInitialEntryPosition;
  readonly segmentIndex: number;
  readonly distanceMeters: number;
  readonly tangentHeadingDeg: number;
}

const DEFAULT_STRIP_SPACING_METERS = 0.3;
const DEFAULT_BLADE_WIDTH_METERS = 0.4;
const EPSILON = 1e-9;
const MOWN_STRIP_CROSSING_PENALTY = 10;
const INITIAL_ENTRY_CORNER_CLEARANCE_METERS = 0.3;
const ROUTED_OBSTACLE_PENALTY = 2;
const ROUTED_OBSTACLE_PREFERENCE_MARGIN = 0.75;
const SAME_OFFSET_ROUTED_OBSTACLE_PENALTY = 5;

interface Vector {
  readonly x: number;
  readonly y: number;
}

interface Intersection {
  readonly along: number;
  readonly point: Vector;
  readonly boundary: MowingBoundaryReference;
}

interface Interval {
  readonly start: Intersection;
  readonly end: Intersection;
}

interface TraversalStep {
  readonly strip: MowingStrip;
  readonly reversed: boolean;
}

interface PreparedObstacle {
  readonly obstacleIndex: number;
  readonly polygon: Vector[];
  readonly minOffset: number;
  readonly maxOffset: number;
}

interface PreparedMowingPlanBuild {
  readonly headingDeg: number;
  readonly stripSpacingMeters: number;
  readonly bladeWidthMeters: number;
  readonly mowingStandoffMeters: number;
  readonly polygon: Vector[];
  readonly direction: Vector;
  readonly normal: Vector;
  readonly maxOffset: number;
  readonly firstOffset: number;
  readonly obstacles: PreparedObstacle[];
}

export interface MowingPlanPerformance {
  readonly prepareMs: number;
  readonly stripBuildMs: number;
  readonly sequenceMs: number;
  readonly connectorBuildMs: number;
  readonly totalMs: number;
  readonly polygonPointCount: number;
  readonly obstacleCount: number;
  readonly obstaclePointCount: number;
  readonly stripOffsetCount: number;
  readonly stripCount: number;
  readonly connectorCount: number;
  readonly traversalCandidateEvaluations: number;
  readonly traversalConnectorPathEvaluations: number;
  readonly routedCandidateCount: number;
  readonly routedConnectorCount: number;
}

interface TraversalEvaluation {
  readonly step: TraversalStep;
  readonly connectorPath: Vector[];
  readonly cost: number;
  readonly requiresObstacleRouting: boolean;
}

interface SequenceStripsResult {
  readonly traversal: TraversalStep[];
  readonly performance: Pick<
    MowingPlanPerformance,
    "traversalCandidateEvaluations"
    | "traversalConnectorPathEvaluations"
    | "routedCandidateCount"
  >;
}

export function buildMowingPlan(points: PathPoint[], options: MowingPlanOptions): MowingPlan {
  const startedAtMs = Date.now();
  const prepareStartedAtMs = startedAtMs;
  const prepared = prepareMowingPlanBuild(points, options);
  const prepareMs = Date.now() - prepareStartedAtMs;
  const {
    headingDeg,
    stripSpacingMeters,
    bladeWidthMeters,
    mowingStandoffMeters,
    polygon,
    direction,
    normal,
    maxOffset,
    firstOffset,
    obstacles,
  } = prepared;
  if (polygon.length < 3) {
    return {
      headingDeg,
      stripSpacingMeters,
      bladeWidthMeters,
      stripCount: 0,
      strips: [],
      connectors: [],
      performance: {
        prepareMs,
        stripBuildMs: 0,
        sequenceMs: 0,
        connectorBuildMs: 0,
        totalMs: Date.now() - startedAtMs,
        polygonPointCount: polygon.length,
        obstacleCount: obstacles.length,
        obstaclePointCount: obstacles.reduce((sum, obstacle) => sum + obstacle.polygon.length, 0),
        stripOffsetCount: 0,
        stripCount: 0,
        connectorCount: 0,
        traversalCandidateEvaluations: 0,
        traversalConnectorPathEvaluations: 0,
        routedCandidateCount: 0,
        routedConnectorCount: 0,
      },
    };
  }

  const stripBuildStartedAtMs = Date.now();
  const strips = buildStripGeometry(polygon, direction, normal, firstOffset, maxOffset, stripSpacingMeters, obstacles);
  const stripBuildMs = Date.now() - stripBuildStartedAtMs;

  const obstaclePolygons = obstacles.map((obstacle) => obstacle.polygon);
  const sequenceStartedAtMs = Date.now();
  const sequencing = sequenceStripsForMowing(strips, direction, obstaclePolygons);
  const reanchoredTraversal = reanchorTraversalToPreferredStart(
    sequencing.traversal,
    options.preferredStartPoint,
  );
  const sequenceMs = Date.now() - sequenceStartedAtMs;
  const sequencedStrips = reanchoredTraversal.map((step, index) => ({
    ...step.strip,
    sequenceIndex: index,
    traversalReversed: step.reversed,
  }));
  const connectorBuildStartedAtMs = Date.now();
  const connectors = buildStripConnectors(reanchoredTraversal, polygon, obstaclePolygons, mowingStandoffMeters);
  const connectorBuildMs = Date.now() - connectorBuildStartedAtMs;
  const stripOffsetCount = countStripOffsets(firstOffset, maxOffset, stripSpacingMeters);
  const routedConnectorCount = connectors.filter((connector) => connector.length > 2).length;

  return {
    headingDeg,
    stripSpacingMeters,
    bladeWidthMeters,
    stripCount: sequencedStrips.length,
    strips: sequencedStrips,
    connectors,
    performance: {
      prepareMs,
      stripBuildMs,
      sequenceMs,
      connectorBuildMs,
      totalMs: Date.now() - startedAtMs,
      polygonPointCount: polygon.length,
      obstacleCount: obstacles.length,
      obstaclePointCount: obstacles.reduce((sum, obstacle) => sum + obstacle.polygon.length, 0),
      stripOffsetCount,
      stripCount: sequencedStrips.length,
      connectorCount: connectors.length,
      traversalCandidateEvaluations: sequencing.performance.traversalCandidateEvaluations,
      traversalConnectorPathEvaluations: sequencing.performance.traversalConnectorPathEvaluations,
      routedCandidateCount: sequencing.performance.routedCandidateCount,
      routedConnectorCount,
    },
  };
}

function prepareMowingPlanBuild(points: PathPoint[], options: MowingPlanOptions): PreparedMowingPlanBuild {
  const stripSpacingMeters = options.stripSpacingMeters ?? DEFAULT_STRIP_SPACING_METERS;
  const bladeWidthMeters = options.bladeWidthMeters ?? DEFAULT_BLADE_WIDTH_METERS;
  const mowingStandoffMeters = options.mowingStandoffMeters ?? DEFAULT_PATH_FOLLOWING_PARAMETERS.mowingStandoffMeters;
  if (!Number.isFinite(stripSpacingMeters) || stripSpacingMeters <= 0) {
    throw new Error("strip_spacing_must_be_positive");
  }
  if (!Number.isFinite(mowingStandoffMeters) || mowingStandoffMeters < 0) {
    throw new Error("mowing_standoff_must_be_non_negative");
  }

  const polygon = normalizePolygon(points);
  const headingDeg = normalizeAxisHeading(options.headingDeg);
  const headingRadians = (headingDeg * Math.PI) / 180;
  const direction = { x: Math.cos(headingRadians), y: Math.sin(headingRadians) };
  const normal = { x: -direction.y, y: direction.x };
  const projectedOffsets = polygon.map((point) => dot(point, normal));
  const minOffset = projectedOffsets.length > 0 ? Math.min(...projectedOffsets) : 0;
  const maxOffset = projectedOffsets.length > 0 ? Math.max(...projectedOffsets) : 0;
  const firstOffset = Math.ceil((minOffset - EPSILON) / stripSpacingMeters) * stripSpacingMeters;
  const obstacles = prepareObstacles(options.obstacles ?? [], normal);

  return {
    headingDeg,
    stripSpacingMeters,
    bladeWidthMeters,
    mowingStandoffMeters,
    polygon,
    direction,
    normal,
    maxOffset,
    firstOffset,
    obstacles,
  };
}

function prepareObstacles(
  obstacles: ReadonlyArray<ReadonlyArray<PathPoint>>,
  normal: Vector,
): PreparedObstacle[] {
  return obstacles
    .map((obstacle, obstacleIndex) => {
      const polygon = normalizePolygon(obstacle);
      if (polygon.length < 3) {
        return null;
      }
      const offsets = polygon.map((point) => dot(point, normal));
      return {
        obstacleIndex,
        polygon,
        minOffset: Math.min(...offsets),
        maxOffset: Math.max(...offsets),
      };
    })
    .filter((obstacle): obstacle is PreparedObstacle => obstacle !== null);
}

function buildStripGeometry(
  polygon: Vector[],
  direction: Vector,
  normal: Vector,
  firstOffset: number,
  maxOffset: number,
  stripSpacingMeters: number,
  obstacles: ReadonlyArray<PreparedObstacle>,
): MowingStrip[] {
  const strips: MowingStrip[] = [];

  for (let offset = firstOffset; offset <= maxOffset + EPSILON; offset += stripSpacingMeters) {
    const areaIntervals = buildLineIntervals(polygon, direction, normal, offset, { kind: "area" });
    const obstacleIntervals = buildObstacleIntervalsForOffset(obstacles, direction, normal, offset);
    const clearIntervals = areaIntervals.flatMap((interval) => subtractIntervals(interval, obstacleIntervals));

    for (const interval of clearIntervals) {
      const strip = buildStripFromInterval(interval, offset, strips.length);
      if (strip) {
        strips.push(strip);
      }
    }
  }

  return strips;
}

function buildObstacleIntervalsForOffset(
  obstacles: ReadonlyArray<PreparedObstacle>,
  direction: Vector,
  normal: Vector,
  offset: number,
): Interval[] {
  return obstacles
    .filter((obstacle) => obstacleMayIntersectOffset(obstacle, offset))
    .flatMap((obstacle) => buildLineIntervals(
      obstacle.polygon,
      direction,
      normal,
      offset,
      { kind: "obstacle", obstacleIndex: obstacle.obstacleIndex },
    ));
}

function obstacleMayIntersectOffset(obstacle: PreparedObstacle, offset: number): boolean {
  return offset >= obstacle.minOffset - EPSILON && offset <= obstacle.maxOffset + EPSILON;
}

function buildStripFromInterval(interval: Interval, offset: number, sequenceIndex: number): MowingStrip | null {
  const start = interval.start;
  const end = interval.end;
  if (distance(start.point, end.point) <= EPSILON) {
    return null;
  }

  const capturedAt = Date.now();
  return {
    start: {
      xMeters: start.point.x,
      yMeters: start.point.y,
      capturedAt,
    },
    end: {
      xMeters: end.point.x,
      yMeters: end.point.y,
      capturedAt,
    },
    startBoundary: start.boundary,
    endBoundary: end.boundary,
    centerOffsetMeters: offset,
    sequenceIndex,
    traversalReversed: false,
  };
}

export function normalizeAxisHeading(headingDeg: number): number {
  if (!Number.isFinite(headingDeg)) {
    return 0;
  }

  const normalized = ((headingDeg % 180) + 180) % 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function buildMowingInitialEntryPlan(
  areaPoints: ReadonlyArray<PathPoint>,
  currentPosition: MowingInitialEntryPosition,
  options: MowingInitialEntryPlanOptions = {},
): MowingInitialEntryPlan | null {
  const mowingStandoffMeters = options.mowingStandoffMeters ?? DEFAULT_PATH_FOLLOWING_PARAMETERS.mowingStandoffMeters;
  if (!Number.isFinite(mowingStandoffMeters) || mowingStandoffMeters < 0) {
    throw new Error("mowing_standoff_must_be_non_negative");
  }
  if (!Number.isFinite(currentPosition.xMeters) || !Number.isFinite(currentPosition.yMeters)) {
    throw new Error("current_position_must_be_finite");
  }

  const areaPolygon = normalizePolygon(areaPoints);
  if (areaPolygon.length < 3) {
    return null;
  }

  const obstacles = (options.obstacles ?? [])
    .map((obstacle) => normalizePolygon(obstacle))
    .filter((obstacle) => obstacle.length >= 3);
  const current = { x: currentPosition.xMeters, y: currentPosition.yMeters };
  const signedArea = calculateSignedArea(areaPolygon);
  const currentInsideArea = pointInPolygon(current, areaPolygon);
  let bestPlan: MowingInitialEntryPlan | null = null;

  for (let segmentIndex = 0; segmentIndex < areaPolygon.length; segmentIndex += 1) {
    const segmentStart = areaPolygon[segmentIndex];
    const segmentEnd = areaPolygon[(segmentIndex + 1) % areaPolygon.length];
    const projection = nearestPointOnSegmentWithT(current, segmentStart, segmentEnd);
    const entry = moveEntryPointAwayFromCorners(
      projection.point,
      projection.t,
      segmentStart,
      segmentEnd,
      INITIAL_ENTRY_CORNER_CLEARANCE_METERS,
    );
    if (!isAreaEntryCandidateReachable(current, entry, areaPolygon, obstacles, currentInsideArea)) {
      continue;
    }

    const distanceMeters = distance(current, entry);
    const inwardNormal = boundaryOffsetNormal(segmentStart, segmentEnd, signedArea, { kind: "area" });
    const approachTarget = {
      xMeters: entry.x + (inwardNormal.x * mowingStandoffMeters),
      yMeters: entry.y + (inwardNormal.y * mowingStandoffMeters),
    };
    const tangentHeadingDeg = Math.atan2(segmentEnd.y - segmentStart.y, segmentEnd.x - segmentStart.x) * (180 / Math.PI);
    const plan: MowingInitialEntryPlan = {
      entryPoint: {
        xMeters: entry.x,
        yMeters: entry.y,
        capturedAt: Date.now(),
      },
      approachTarget,
      segmentIndex,
      distanceMeters,
      tangentHeadingDeg,
    };

    if (!bestPlan || plan.distanceMeters < bestPlan.distanceMeters - EPSILON) {
      bestPlan = plan;
    }
  }

  return bestPlan;
}

function normalizePolygon(points: ReadonlyArray<PathPoint>): Vector[] {
  const polygon = points.map((point) => ({ x: point.xMeters, y: point.yMeters }));
  if (polygon.length <= 1) {
    return polygon;
  }

  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  if (distance(first, last) <= 0.05) {
    polygon.pop();
  }

  return polygon;
}

function findLinePolygonIntersections(
  polygon: Vector[],
  direction: Vector,
  normal: Vector,
  offset: number,
  boundary: MowingBoundaryReference,
): Intersection[] {
  const intersections: Intersection[] = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentOffset = dot(current, normal) - offset;
    const nextOffset = dot(next, normal) - offset;

    if (Math.abs(currentOffset) <= EPSILON && Math.abs(nextOffset) <= EPSILON) {
      addUniqueIntersection(intersections, current, direction, boundary);
      addUniqueIntersection(intersections, next, direction, boundary);
      continue;
    }

    if (Math.abs(currentOffset) <= EPSILON) {
      addUniqueIntersection(intersections, current, direction, boundary);
      continue;
    }

    if (currentOffset * nextOffset < 0 || Math.abs(nextOffset) <= EPSILON) {
      const t = currentOffset / (currentOffset - nextOffset);
      const point = {
        x: current.x + ((next.x - current.x) * t),
        y: current.y + ((next.y - current.y) * t),
      };
      addUniqueIntersection(intersections, point, direction, boundary);
    }
  }

  return intersections.sort((a, b) => a.along - b.along);
}

function buildLineIntervals(
  polygon: Vector[],
  direction: Vector,
  normal: Vector,
  offset: number,
  boundary: MowingBoundaryReference,
): Interval[] {
  const intersections = findLinePolygonIntersections(polygon, direction, normal, offset, boundary);
  const intervals: Interval[] = [];

  for (let index = 0; index < intersections.length - 1; index += 2) {
    const start = intersections[index];
    const end = intersections[index + 1];
    if (end.along - start.along > EPSILON) {
      intervals.push({ start, end });
    }
  }

  return intervals;
}

function subtractIntervals(area: Interval, blockedIntervals: Interval[]): Interval[] {
  let clearIntervals: Interval[] = [area];

  for (const blocked of blockedIntervals) {
    clearIntervals = clearIntervals.flatMap((clear) => subtractInterval(clear, blocked));
  }

  return clearIntervals;
}

function subtractInterval(clear: Interval, blocked: Interval): Interval[] {
  const start = Math.max(clear.start.along, blocked.start.along);
  const end = Math.min(clear.end.along, blocked.end.along);
  if (end - start <= EPSILON) {
    return [clear];
  }

  const intervals: Interval[] = [];
  if (start - clear.start.along > EPSILON) {
    intervals.push({
      start: clear.start,
      end: interpolateIntersection(clear.start, clear.end, start, blocked.start.boundary),
    });
  }
  if (clear.end.along - end > EPSILON) {
    intervals.push({
      start: interpolateIntersection(clear.start, clear.end, end, blocked.end.boundary),
      end: clear.end,
    });
  }

  return intervals;
}

function interpolateIntersection(
  start: Intersection,
  end: Intersection,
  along: number,
  boundary: MowingBoundaryReference,
): Intersection {
  const span = end.along - start.along;
  if (Math.abs(span) <= EPSILON) {
    return { ...start, boundary };
  }

  const t = (along - start.along) / span;
  return {
    along,
    point: {
      x: start.point.x + ((end.point.x - start.point.x) * t),
      y: start.point.y + ((end.point.y - start.point.y) * t),
    },
    boundary,
  };
}

function sequenceStripsForMowing(
  strips: MowingStrip[],
  direction: Vector,
  obstacles: Vector[][],
): SequenceStripsResult {
  const offsets = [...new Set(strips.map((strip) => strip.centerOffsetMeters))].sort((a, b) => a - b);
  const remaining = strips.slice();
  const traversal: TraversalStep[] = [];
  const mownCrossings = new Map<MowingStrip, number>();
  let traversalCandidateEvaluations = 0;
  let traversalConnectorPathEvaluations = 0;
  let routedCandidateCount = 0;
  let currentPoint: Vector | null = null;
  let lockedOffsetDirection: -1 | 1 | null = null;

  if (remaining.length === 0) {
    return {
      traversal,
      performance: {
        traversalCandidateEvaluations,
        traversalConnectorPathEvaluations,
        routedCandidateCount,
      },
    };
  }

  const firstOffset = offsets[0];
  const firstCandidates = remaining.filter((strip) => Math.abs(strip.centerOffsetMeters - firstOffset) <= EPSILON);
  const firstStep = chooseFirstTraversalStep(firstCandidates, direction);
  const firstStrip = firstStep.strip;
  traversal.push(firstStep);
  removeStrip(remaining, firstStrip);
  mownCrossings.set(firstStrip, 0);
  currentPoint = stripTraversalEnd(firstStrip, firstStep.reversed);

  while (remaining.length > 0 && currentPoint !== null) {
    const currentOffset = traversal[traversal.length - 1].strip.centerOffsetMeters;
    const candidates = selectTraversalCandidates(remaining, currentOffset, lockedOffsetDirection);
    const bestEvaluation = chooseBestTraversalStep(candidates, currentPoint, currentOffset, direction, obstacles, mownCrossings);
    traversalCandidateEvaluations += candidates.length * 2;
    traversalConnectorPathEvaluations += candidates.length * 2;
    if (bestEvaluation.requiresObstacleRouting) {
      routedCandidateCount += 1;
    }
    const nextStrip = bestEvaluation.step.strip;
    const nextOffsetDelta = nextStrip.centerOffsetMeters - currentOffset;
    if (lockedOffsetDirection === null && Math.abs(nextOffsetDelta) > EPSILON) {
      lockedOffsetDirection = nextOffsetDelta > 0 ? 1 : -1;
    }

    const connectorPath = bestEvaluation.connectorPath;
    for (const [strip, count] of mownCrossings) {
      const stripStart = { x: strip.start.xMeters, y: strip.start.yMeters };
      const stripEnd = { x: strip.end.xMeters, y: strip.end.yMeters };
      for (let index = 1; index < connectorPath.length; index += 1) {
        if (segmentsIntersect(connectorPath[index - 1], connectorPath[index], stripStart, stripEnd)) {
          mownCrossings.set(strip, count + 1);
          break;
        }
      }
    }

    traversal.push(bestEvaluation.step);
    mownCrossings.set(nextStrip, 0);
    currentPoint = stripTraversalEnd(nextStrip, bestEvaluation.step.reversed);
    removeStrip(remaining, nextStrip);
  }

  return {
    traversal,
    performance: {
      traversalCandidateEvaluations,
      traversalConnectorPathEvaluations,
      routedCandidateCount,
    },
  };
}

function chooseFirstTraversalStep(candidates: MowingStrip[], direction: Vector): TraversalStep {
  let bestStep: TraversalStep | null = null;
  let bestProjection = -Infinity;

  for (const candidate of candidates) {
    for (const reversed of [false, true] as const) {
      const projection = dot(stripTraversalStart(candidate, reversed), direction);
      if (projection > bestProjection + EPSILON || (Math.abs(projection - bestProjection) <= EPSILON && (!bestStep || candidate.sequenceIndex < bestStep.strip.sequenceIndex))) {
        bestStep = { strip: candidate, reversed };
        bestProjection = projection;
      }
    }
  }

  if (!bestStep) {
    throw new Error("mowing_plan_has_no_first_strip");
  }
  return bestStep;
}

function selectTraversalCandidates(
  remaining: MowingStrip[],
  currentOffset: number,
  lockedOffsetDirection: -1 | 1 | null,
): MowingStrip[] {
  const sameOffset = remaining.filter((strip) => Math.abs(strip.centerOffsetMeters - currentOffset) <= EPSILON);
  if (sameOffset.length > 0) {
    const otherOffsets = remaining.filter((strip) => Math.abs(strip.centerOffsetMeters - currentOffset) > EPSILON);
    if (otherOffsets.length === 0) {
      return sameOffset;
    }

    const nearestOtherOffsetDistance = Math.min(...otherOffsets.map((strip) => Math.abs(strip.centerOffsetMeters - currentOffset)));
    const nearestOtherOffsets = otherOffsets.filter((strip) => Math.abs(Math.abs(strip.centerOffsetMeters - currentOffset) - nearestOtherOffsetDistance) <= EPSILON);
    return [...sameOffset, ...nearestOtherOffsets];
  }

  const direction = lockedOffsetDirection ?? 1;
  const sameDirection = remaining.filter((strip) => (strip.centerOffsetMeters - currentOffset) * direction > EPSILON);
  if (sameDirection.length > 0) {
    const nearestOffsetDistance = Math.min(...sameDirection.map((strip) => Math.abs(strip.centerOffsetMeters - currentOffset)));
    return sameDirection.filter((strip) => Math.abs(Math.abs(strip.centerOffsetMeters - currentOffset) - nearestOffsetDistance) <= EPSILON);
  }

  const nearestOffsetDistance = Math.min(...remaining.map((strip) => Math.abs(strip.centerOffsetMeters - currentOffset)));
  return remaining.filter((strip) => Math.abs(Math.abs(strip.centerOffsetMeters - currentOffset) - nearestOffsetDistance) <= EPSILON);
}

function chooseBestTraversalStep(
  candidates: MowingStrip[],
  currentPoint: Vector,
  currentOffset: number,
  direction: Vector,
  obstacles: Vector[][],
  mownCrossings: ReadonlyMap<MowingStrip, number>,
): TraversalEvaluation {
  let bestEvaluation: TraversalEvaluation | null = null;

  for (const candidate of candidates) {
    for (const reversed of [false, true] as const) {
      const candidateStart = stripTraversalStart(candidate, reversed);
      const evaluation = evaluateTraversalCandidate(
        currentPoint,
        candidateStart,
        currentOffset,
        candidate.centerOffsetMeters,
        obstacles,
        mownCrossings,
        candidate,
        reversed,
      );
      if (
        !bestEvaluation
        || isBetterTraversalEvaluation(
          evaluation,
          bestEvaluation,
          candidate,
          reversed,
          bestEvaluation.step.strip,
          bestEvaluation.step.reversed,
          direction,
        )
      ) {
        bestEvaluation = evaluation;
      }
    }
  }

  if (!bestEvaluation) {
    throw new Error("mowing_plan_has_no_next_strip");
  }
  return bestEvaluation;
}

function isBetterTraversalEvaluation(
  candidateEvaluation: TraversalEvaluation,
  bestEvaluation: TraversalEvaluation,
  candidate: MowingStrip,
  reversed: boolean,
  currentBest: MowingStrip,
  currentBestReversed: boolean,
  direction: Vector,
): boolean {
  const costDelta = candidateEvaluation.cost - bestEvaluation.cost;
  if (costDelta < -EPSILON) {
    if (
      candidateEvaluation.requiresObstacleRouting
      && !bestEvaluation.requiresObstacleRouting
      && costDelta > -ROUTED_OBSTACLE_PREFERENCE_MARGIN
    ) {
      return false;
    }
    return true;
  }

  if (costDelta > EPSILON) {
    if (
      !candidateEvaluation.requiresObstacleRouting
      && bestEvaluation.requiresObstacleRouting
      && costDelta < ROUTED_OBSTACLE_PREFERENCE_MARGIN
    ) {
      return true;
    }
    return false;
  }

  if (candidateEvaluation.requiresObstacleRouting !== bestEvaluation.requiresObstacleRouting) {
    return !candidateEvaluation.requiresObstacleRouting;
  }

  return preferCandidate(candidate, reversed, currentBest, currentBestReversed, direction);
}

function reanchorTraversalToPreferredStart(
  traversal: TraversalStep[],
  preferredStartPoint: MowingInitialEntryPosition | undefined,
): TraversalStep[] {
  if (!preferredStartPoint || traversal.length <= 1) {
    return traversal;
  }
  if (!Number.isFinite(preferredStartPoint.xMeters) || !Number.isFinite(preferredStartPoint.yMeters)) {
    throw new Error("preferred_start_point_must_be_finite");
  }

  const preferred = { x: preferredStartPoint.xMeters, y: preferredStartPoint.yMeters };
  let bestTraversal = traversal;
  let bestDistance = Infinity;

  const candidateTraversals = buildPreferredStartTraversalCandidates(traversal);
  for (const candidate of candidateTraversals) {
    const firstStep = candidate[0];
    if (!firstStep) {
      continue;
    }
    const start = stripTraversalStart(firstStep.strip, firstStep.reversed);
    const currentDistance = distance(preferred, start);
    if (currentDistance < bestDistance - EPSILON) {
      bestDistance = currentDistance;
      bestTraversal = candidate;
    }
  }

  return bestTraversal;
}

function buildPreferredStartTraversalCandidates(traversal: TraversalStep[]): TraversalStep[][] {
  if (traversal.length === 0) {
    return [];
  }

  const forwardCandidates: TraversalStep[][] = [];
  for (let index = 0; index < traversal.length; index += 1) {
    forwardCandidates.push(traversal.slice(index).concat(traversal.slice(0, index)));
  }

  const reversedTraversal = traversal
    .slice()
    .reverse()
    .map((step) => ({
      ...step,
      reversed: !step.reversed,
    }));
  const reverseCandidates: TraversalStep[][] = [];
  for (let index = 0; index < reversedTraversal.length; index += 1) {
    reverseCandidates.push(reversedTraversal.slice(index).concat(reversedTraversal.slice(0, index)));
  }

  return [...forwardCandidates, ...reverseCandidates];
}

function buildStripConnectors(
  traversal: TraversalStep[],
  areaPolygon: Vector[],
  obstacles: Vector[][],
  mowingStandoffMeters: number,
): PathPoint[][] {
  const connectors: PathPoint[][] = [];

  for (let index = 0; index < traversal.length - 1; index += 1) {
    const currentEnd = stripTraversalEnd(traversal[index].strip, traversal[index].reversed);
    const nextStart = stripTraversalStart(traversal[index + 1].strip, traversal[index + 1].reversed);
    const currentEndBoundary = stripTraversalEndBoundary(traversal[index].strip, traversal[index].reversed);
    const nextStartBoundary = stripTraversalStartBoundary(traversal[index + 1].strip, traversal[index + 1].reversed);
    const currentEndStandoff = stripTraversalEndStandoff(traversal[index].strip, traversal[index].reversed, mowingStandoffMeters);
    const nextStartStandoff = stripTraversalStartStandoff(traversal[index + 1].strip, traversal[index + 1].reversed, mowingStandoffMeters);
    connectors.push(buildSafeStripConnector(
      currentEnd,
      nextStart,
      currentEndBoundary,
      nextStartBoundary,
      currentEndStandoff,
      nextStartStandoff,
      areaPolygon,
      obstacles,
      mowingStandoffMeters,
    ));
  }

  return connectors;
}

function buildSafeStripConnector(
  currentEnd: Vector,
  nextStart: Vector,
  currentEndBoundary: MowingBoundaryReference,
  nextStartBoundary: MowingBoundaryReference,
  currentEndStandoff: Vector,
  nextStartStandoff: Vector,
  areaPolygon: Vector[],
  obstacles: Vector[][],
  mowingStandoffMeters: number,
): PathPoint[] {
  if (sameBoundary(currentEndBoundary, nextStartBoundary)) {
    return buildBoundaryStandoffConnector(
      currentEnd,
      nextStart,
      currentEndStandoff,
      nextStartStandoff,
      boundaryPolygon(currentEndBoundary, areaPolygon, obstacles),
      currentEndBoundary,
    );
  }

  const directConnector = [currentEndStandoff, nextStartStandoff];
  if (pathStaysWithinAreaAndAvoidsObstacles(directConnector, areaPolygon, obstacles)) {
    return directConnector.map(toPathPoint);
  }

  const routedObstacle = obstacles.find((obstacle) => segmentIntersectsPolygon(currentEndStandoff, nextStartStandoff, obstacle));
  if (routedObstacle) {
    const obstacleConnector = buildObstaclePerimeterConnector(
      currentEndStandoff,
      nextStartStandoff,
      routedObstacle,
      mowingStandoffMeters,
    );
    const obstacleConnectorVectors = obstacleConnector.map((point) => ({ x: point.xMeters, y: point.yMeters }));
    if (pathStaysWithinAreaAndAvoidsObstacles(obstacleConnectorVectors, areaPolygon, obstacles, routedObstacle)) {
      return obstacleConnector;
    }
  }

  const areaBoundaryConnector = buildAreaBoundaryConnectorBetweenStandoffs(
    currentEndStandoff,
    nextStartStandoff,
    areaPolygon,
    mowingStandoffMeters,
  );
  const areaBoundaryConnectorVectors = areaBoundaryConnector.map((point) => ({ x: point.xMeters, y: point.yMeters }));
  if (pathStaysWithinAreaAndAvoidsObstacles(areaBoundaryConnectorVectors, areaPolygon, obstacles)) {
    return areaBoundaryConnector;
  }

  return areaBoundaryConnector;
}

function stripTraversalStart(strip: MowingStrip, reversed: boolean): Vector {
  return reversed
    ? { x: strip.end.xMeters, y: strip.end.yMeters }
    : { x: strip.start.xMeters, y: strip.start.yMeters };
}

function stripTraversalEnd(strip: MowingStrip, reversed: boolean): Vector {
  return reversed
    ? { x: strip.start.xMeters, y: strip.start.yMeters }
    : { x: strip.end.xMeters, y: strip.end.yMeters };
}

function stripTraversalStartBoundary(strip: MowingStrip, reversed: boolean): MowingBoundaryReference {
  return reversed ? strip.endBoundary : strip.startBoundary;
}

function stripTraversalEndBoundary(strip: MowingStrip, reversed: boolean): MowingBoundaryReference {
  return reversed ? strip.startBoundary : strip.endBoundary;
}

function stripTraversalStartStandoff(strip: MowingStrip, reversed: boolean, standoffMeters: number): Vector {
  const start = stripTraversalStart(strip, reversed);
  const end = stripTraversalEnd(strip, reversed);
  const direction = normalise({ x: end.x - start.x, y: end.y - start.y });
  return {
    x: start.x + (direction.x * standoffMeters),
    y: start.y + (direction.y * standoffMeters),
  };
}

function stripTraversalEndStandoff(strip: MowingStrip, reversed: boolean, standoffMeters: number): Vector {
  const start = stripTraversalStart(strip, reversed);
  const end = stripTraversalEnd(strip, reversed);
  const direction = normalise({ x: end.x - start.x, y: end.y - start.y });
  return {
    x: end.x - (direction.x * standoffMeters),
    y: end.y - (direction.y * standoffMeters),
  };
}

function sameBoundary(a: MowingBoundaryReference, b: MowingBoundaryReference): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "area") {
    return true;
  }
  return b.kind === "obstacle" && a.obstacleIndex === b.obstacleIndex;
}

function boundaryPolygon(boundary: MowingBoundaryReference, areaPolygon: Vector[], obstacles: Vector[][]): Vector[] {
  return boundary.kind === "area" ? areaPolygon : obstacles[boundary.obstacleIndex] ?? [];
}

function buildBoundaryStandoffConnector(
  fromBoundaryPoint: Vector,
  toBoundaryPoint: Vector,
  fromStandoff: Vector,
  toStandoff: Vector,
  polygon: Vector[],
  boundary: MowingBoundaryReference,
): PathPoint[] {
  if (polygon.length < 3) {
    return [toPathPoint(fromStandoff), toPathPoint(toStandoff)];
  }

  const fromSegmentIndex = findNearestSegmentIndex(polygon, fromBoundaryPoint);
  const toSegmentIndex = findNearestSegmentIndex(polygon, toBoundaryPoint);
  if (fromSegmentIndex === toSegmentIndex) {
    return [toPathPoint(fromStandoff), toPathPoint(toStandoff)];
  }

  const offsetVertices = buildOffsetBoundaryVertices(polygon, boundary, distance(fromBoundaryPoint, fromStandoff));
  const forward = [
    fromStandoff,
    ...walkBoundaryVertices(offsetVertices, fromSegmentIndex, toSegmentIndex, 1),
    toStandoff,
  ];
  const reverse = [
    fromStandoff,
    ...walkBoundaryVertices(offsetVertices, fromSegmentIndex, toSegmentIndex, -1),
    toStandoff,
  ];
  const chosen = pathLength(forward) <= pathLength(reverse) ? forward : reverse;
  return chosen.map(toPathPoint);
}

function buildObstaclePerimeterConnector(from: Vector, to: Vector, obstacle: Vector[], standoffMeters: number = 0): PathPoint[] {
  const offsetObstacle = buildOffsetBoundaryVertices(obstacle, { kind: "obstacle", obstacleIndex: 0 }, standoffMeters);
  if (offsetObstacle.length < 3) {
    return [toPathPoint(from), toPathPoint(to)];
  }

  const fromIndex = findNearestVertexIndex(obstacle, from);
  const toIndex = findNearestVertexIndex(obstacle, to);
  const forward = [from, ...walkObstacleVertices(offsetObstacle, fromIndex, toIndex, 1), to];
  const reverse = [from, ...walkObstacleVertices(offsetObstacle, fromIndex, toIndex, -1), to];
  const chosen = pathLength(forward) <= pathLength(reverse) ? forward : reverse;

  return chosen.map(toPathPoint);
}

function buildAreaBoundaryConnectorBetweenStandoffs(
  fromStandoff: Vector,
  toStandoff: Vector,
  areaPolygon: Vector[],
  standoffMeters: number,
): PathPoint[] {
  const offsetArea = buildOffsetBoundaryVertices(areaPolygon, { kind: "area" }, standoffMeters);
  if (offsetArea.length < 3) {
    return [toPathPoint(fromStandoff), toPathPoint(toStandoff)];
  }

  const fromIndex = findNearestVertexIndex(offsetArea, fromStandoff);
  const toIndex = findNearestVertexIndex(offsetArea, toStandoff);
  const forward = [fromStandoff, ...walkObstacleVertices(offsetArea, fromIndex, toIndex, 1), toStandoff];
  const reverse = [fromStandoff, ...walkObstacleVertices(offsetArea, fromIndex, toIndex, -1), toStandoff];
  const chosen = pathLength(forward) <= pathLength(reverse) ? forward : reverse;

  return chosen.map(toPathPoint);
}

function walkObstacleVertices(obstacle: Vector[], fromIndex: number, toIndex: number, direction: 1 | -1): Vector[] {
  const vertices: Vector[] = [];
  let index = fromIndex;

  while (true) {
    vertices.push(obstacle[index]);
    if (index === toIndex) {
      break;
    }
    index = (index + direction + obstacle.length) % obstacle.length;
  }

  return vertices;
}

function walkBoundaryVertices(offsetVertices: Vector[], fromSegmentIndex: number, toSegmentIndex: number, direction: 1 | -1): Vector[] {
  const vertices: Vector[] = [];
  const count = offsetVertices.length;
  let index = direction === 1
    ? (fromSegmentIndex + 1) % count
    : fromSegmentIndex;
  const targetIndex = direction === 1
    ? toSegmentIndex
    : (toSegmentIndex + 1) % count;

  while (true) {
    vertices.push(offsetVertices[index]);
    if (index === targetIndex) {
      break;
    }
    index = (index + direction + count) % count;
  }

  return vertices;
}

function pathStaysWithinAreaAndAvoidsObstacles(
  points: Vector[],
  areaPolygon: Vector[],
  obstacles: Vector[][],
  ignoredObstacle?: Vector[],
): boolean {
  for (let index = 1; index < points.length; index += 1) {
    if (!segmentStaysWithinArea(points[index - 1], points[index], areaPolygon)) {
      return false;
    }
    for (const obstacle of obstacles) {
      if (obstacle === ignoredObstacle) {
        continue;
      }
      if (segmentIntersectsPolygon(points[index - 1], points[index], obstacle)) {
        return false;
      }
    }
  }
  return true;
}

function segmentStaysWithinArea(start: Vector, end: Vector, areaPolygon: Vector[]): boolean {
  if (!pointInPolygonOrOnBoundary(start, areaPolygon) || !pointInPolygonOrOnBoundary(end, areaPolygon)) {
    return false;
  }

  const segmentLength = distance(start, end);
  const steps = Math.max(1, Math.ceil(segmentLength / 0.1));
  for (let step = 0; step <= steps; step += 1) {
    const point = interpolateVector(start, end, step / steps);
    if (!pointInPolygonOrOnBoundary(point, areaPolygon)) {
      return false;
    }
  }
  return true;
}

function pointInPolygonOrOnBoundary(point: Vector, polygon: Vector[]): boolean {
  return pointOnPolygonBoundary(point, polygon) || pointInPolygon(point, polygon);
}

function pointOnPolygonBoundary(point: Vector, polygon: Vector[]): boolean {
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    if (pointToSegmentDistance(point, current, next) <= 0.01) {
      return true;
    }
  }
  return false;
}

function findNearestVertexIndex(points: Vector[], target: Vector): number {
  let nearestIndex = 0;
  let nearestDistance = Infinity;

  for (let index = 0; index < points.length; index += 1) {
    const currentDistance = distance(points[index], target);
    if (currentDistance < nearestDistance) {
      nearestDistance = currentDistance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

function findNearestSegmentIndex(points: Vector[], target: Vector): number {
  let nearestIndex = 0;
  let nearestDistance = Infinity;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const currentDistance = pointToSegmentDistance(target, current, next);
    if (currentDistance < nearestDistance) {
      nearestDistance = currentDistance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

function pointToSegmentDistance(point: Vector, start: Vector, end: Vector): number {
  const segment = { x: end.x - start.x, y: end.y - start.y };
  const lengthSquared = dot(segment, segment);
  if (lengthSquared <= EPSILON) {
    return distance(point, start);
  }

  const t = Math.max(0, Math.min(1, dot({ x: point.x - start.x, y: point.y - start.y }, segment) / lengthSquared));
  const projected = {
    x: start.x + (segment.x * t),
    y: start.y + (segment.y * t),
  };
  return distance(point, projected);
}

function nearestPointOnSegment(point: Vector, start: Vector, end: Vector): Vector {
  return nearestPointOnSegmentWithT(point, start, end).point;
}

function nearestPointOnSegmentWithT(point: Vector, start: Vector, end: Vector): { point: Vector; t: number } {
  const segment = { x: end.x - start.x, y: end.y - start.y };
  const lengthSquared = dot(segment, segment);
  if (lengthSquared <= EPSILON) {
    return { point: start, t: 0 };
  }

  const t = Math.max(0, Math.min(1, dot({ x: point.x - start.x, y: point.y - start.y }, segment) / lengthSquared));
  return {
    point: {
      x: start.x + (segment.x * t),
      y: start.y + (segment.y * t),
    },
    t,
  };
}

function moveEntryPointAwayFromCorners(
  entry: Vector,
  t: number,
  start: Vector,
  end: Vector,
  clearanceMeters: number,
): Vector {
  const segmentLength = distance(start, end);
  if (segmentLength <= (2 * clearanceMeters) || clearanceMeters <= EPSILON) {
    return entry;
  }

  const minT = clearanceMeters / segmentLength;
  const clampedT = Math.max(minT, Math.min(1 - minT, t));
  if (Math.abs(clampedT - t) <= EPSILON) {
    return entry;
  }

  return {
    x: start.x + ((end.x - start.x) * clampedT),
    y: start.y + ((end.y - start.y) * clampedT),
  };
}

function isAreaEntryCandidateReachable(
  current: Vector,
  entry: Vector,
  areaPolygon: Vector[],
  obstacles: Vector[][],
  currentInsideArea: boolean,
): boolean {
  if (obstacles.some((obstacle) => segmentIntersectsPolygon(current, entry, obstacle))) {
    return false;
  }

  if (!currentInsideArea && areaApproachCrossesBoundary(current, entry, areaPolygon)) {
    return false;
  }

  if (currentInsideArea && !pointInPolygon(midpoint(current, entry), areaPolygon)) {
    return false;
  }

  return true;
}

function areaApproachCrossesBoundary(current: Vector, entry: Vector, areaPolygon: Vector[]): boolean {
  for (let index = 0; index < areaPolygon.length; index += 1) {
    const segmentStart = areaPolygon[index];
    const segmentEnd = areaPolygon[(index + 1) % areaPolygon.length];
    if (!segmentsIntersect(current, entry, segmentStart, segmentEnd)) {
      continue;
    }

    if (onSegment(segmentStart, entry, segmentEnd)) {
      continue;
    }

    return true;
  }

  return false;
}

function buildOffsetBoundaryVertices(polygon: Vector[], boundary: MowingBoundaryReference, standoffMeters: number): Vector[] {
  if (polygon.length < 3 || standoffMeters <= EPSILON) {
    return polygon.slice();
  }

  const signedArea = calculateSignedArea(polygon);
  if (Math.abs(signedArea) <= EPSILON) {
    return polygon.slice();
  }

  return polygon.map((current, index) => {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const next = polygon[(index + 1) % polygon.length];
    const previousNormal = boundaryOffsetNormal(previous, current, signedArea, boundary);
    const nextNormal = boundaryOffsetNormal(current, next, signedArea, boundary);
    const combined = {
      x: previousNormal.x + nextNormal.x,
      y: previousNormal.y + nextNormal.y,
    };
    const combinedLength = Math.hypot(combined.x, combined.y);
    const normal = combinedLength <= EPSILON
      ? nextNormal
      : { x: combined.x / combinedLength, y: combined.y / combinedLength };
    const miterDenominator = Math.max(0.25, Math.abs(dot(normal, nextNormal)));
    const offsetDistance = standoffMeters / miterDenominator;
    return {
      x: current.x + (normal.x * offsetDistance),
      y: current.y + (normal.y * offsetDistance),
    };
  });
}

function boundaryOffsetNormal(from: Vector, to: Vector, signedArea: number, boundary: MowingBoundaryReference): Vector {
  const outward = segmentOutwardNormal(from, to, signedArea);
  return boundary.kind === "area"
    ? { x: -outward.x, y: -outward.y }
    : outward;
}

function segmentOutwardNormal(from: Vector, to: Vector, signedArea: number): Vector {
  const segment = normalise({ x: to.x - from.x, y: to.y - from.y });
  const leftNormal = { x: -segment.y, y: segment.x };
  const rightNormal = { x: segment.y, y: -segment.x };
  return signedArea >= 0 ? rightNormal : leftNormal;
}

function calculateSignedArea(points: Vector[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += (current.x * next.y) - (next.x * current.y);
  }
  return area / 2;
}

function pathLength(points: Vector[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
  }
  return total;
}

function buildConnectorVectors(from: Vector, to: Vector, obstacles: Vector[][]): Vector[] {
  const obstacle = obstacles.find((candidate) => segmentIntersectsPolygon(from, to, candidate));
  if (!obstacle) {
    return [from, to];
  }
  const connector = buildObstaclePerimeterConnector(from, to, obstacle);
  return connector.map((p) => ({ x: p.xMeters, y: p.yMeters }));
}

function mownCrossingPenalty(connectorPath: Vector[], mownCrossings: ReadonlyMap<MowingStrip, number>): number {
  let penalty = 0;
  for (const [strip, crossCount] of mownCrossings) {
    const stripStart = { x: strip.start.xMeters, y: strip.start.yMeters };
    const stripEnd = { x: strip.end.xMeters, y: strip.end.yMeters };
    for (let index = 1; index < connectorPath.length; index += 1) {
      if (segmentsIntersect(connectorPath[index - 1], connectorPath[index], stripStart, stripEnd)) {
        penalty += MOWN_STRIP_CROSSING_PENALTY * (crossCount + 1);
        break;
      }
    }
  }
  return penalty;
}

function evaluateTraversalCandidate(
  from: Vector,
  to: Vector,
  currentOffset: number,
  candidateOffset: number,
  obstacles: Vector[][],
  mownCrossings: ReadonlyMap<MowingStrip, number>,
  strip: MowingStrip,
  reversed: boolean,
): TraversalEvaluation {
  const path = buildConnectorVectors(from, to, obstacles);
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    total += distance(path[index - 1], path[index]);
  }
  total += mownCrossingPenalty(path, mownCrossings);

  const isSameOffset = Math.abs(candidateOffset - currentOffset) <= EPSILON;
  const requiresObstacleRouting = path.length > 2;
  if (requiresObstacleRouting) {
    total += ROUTED_OBSTACLE_PENALTY;
  }
  if (isSameOffset && requiresObstacleRouting) {
    total += SAME_OFFSET_ROUTED_OBSTACLE_PENALTY;
  }

  return {
    step: {
      strip,
      reversed,
    },
    connectorPath: path,
    cost: total,
    requiresObstacleRouting,
  };
}

function preferCandidate(
  candidate: MowingStrip,
  reversed: boolean,
  currentBest: MowingStrip,
  currentBestReversed: boolean,
  direction: Vector,
): boolean {
  const candidateProjection = dot(stripTraversalStart(candidate, reversed), direction);
  const bestProjection = dot(stripTraversalStart(currentBest, currentBestReversed), direction);
  if (Math.abs(candidateProjection - bestProjection) > EPSILON) {
    return candidateProjection > bestProjection;
  }

  if (Math.abs(candidate.centerOffsetMeters - currentBest.centerOffsetMeters) > EPSILON) {
    return candidate.centerOffsetMeters < currentBest.centerOffsetMeters;
  }

  return candidate.sequenceIndex < currentBest.sequenceIndex;
}

function removeStrip(remaining: MowingStrip[], strip: MowingStrip): void {
  const index = remaining.indexOf(strip);
  if (index >= 0) {
    remaining.splice(index, 1);
  }
}

function segmentIntersectsPolygon(a: Vector, b: Vector, polygon: Vector[]): boolean {
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    if (segmentsIntersect(a, b, current, next)) {
      return true;
    }
  }

  return pointInPolygon(midpoint(a, b), polygon);
}

function segmentsIntersect(a: Vector, b: Vector, c: Vector, d: Vector): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);

  if (Math.abs(abC) <= EPSILON && onSegment(a, c, b)) return true;
  if (Math.abs(abD) <= EPSILON && onSegment(a, d, b)) return true;
  if (Math.abs(cdA) <= EPSILON && onSegment(c, a, d)) return true;
  if (Math.abs(cdB) <= EPSILON && onSegment(c, b, d)) return true;

  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function orientation(a: Vector, b: Vector, c: Vector): number {
  return ((b.x - a.x) * (c.y - a.y)) - ((b.y - a.y) * (c.x - a.x));
}

function onSegment(a: Vector, b: Vector, c: Vector): boolean {
  return b.x >= Math.min(a.x, c.x) - EPSILON &&
    b.x <= Math.max(a.x, c.x) + EPSILON &&
    b.y >= Math.min(a.y, c.y) - EPSILON &&
    b.y <= Math.max(a.y, c.y) + EPSILON;
}

function pointInPolygon(point: Vector, polygon: Vector[]): boolean {
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const intersects = ((current.y > point.y) !== (previous.y > point.y)) &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function midpoint(a: Vector, b: Vector): Vector {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function interpolateVector(start: Vector, end: Vector, t: number): Vector {
  return {
    x: start.x + ((end.x - start.x) * t),
    y: start.y + ((end.y - start.y) * t),
  };
}

function toPathPoint(point: Vector): PathPoint {
  return {
    xMeters: point.x,
    yMeters: point.y,
    capturedAt: Date.now(),
  };
}

function addUniqueIntersection(
  intersections: Intersection[],
  point: Vector,
  direction: Vector,
  boundary: MowingBoundaryReference,
): void {
  const along = dot(point, direction);
  if (intersections.some((existing) => distance(existing.point, point) <= 1e-7)) {
    return;
  }

  intersections.push({ along, point, boundary });
}

function dot(a: Vector, b: Vector): number {
  return (a.x * b.x) + (a.y * b.y);
}

function countStripOffsets(firstOffset: number, maxOffset: number, stripSpacingMeters: number): number {
  if (maxOffset + EPSILON < firstOffset) {
    return 0;
  }
  return Math.max(0, Math.floor(((maxOffset - firstOffset) / stripSpacingMeters) + EPSILON) + 1);
}

function normalise(v: Vector): Vector {
  const len = Math.hypot(v.x, v.y);
  return len < EPSILON ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}

function distance(a: Vector, b: Vector): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
