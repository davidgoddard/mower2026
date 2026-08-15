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
  readonly stableId?: string;
  readonly regionId?: string;
}

export interface MowingRegion {
  readonly id: string;
  readonly orderIndex: number;
  readonly stripIds: string[];
  readonly stripCount: number;
  readonly entryPoint: PathPoint;
  readonly exitPoint: PathPoint;
}

export interface MowingRouteCost {
  readonly mowingDistanceMeters: number;
  readonly connectorDistanceMeters: number;
  readonly startAndReturnDistanceMeters: number;
  readonly estimatedCombinedWheelTravelMeters: number;
  readonly regionTransitionCount: number;
}

export interface MowingPlan {
  readonly headingDeg: number;
  readonly stripSpacingMeters: number;
  readonly bladeWidthMeters: number;
  readonly stripCount: number;
  readonly strips: MowingStrip[];
  readonly connectors: PathPoint[][];
  readonly regions: MowingRegion[];
  readonly regionOrder: string[];
  readonly routeCost: MowingRouteCost;
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
const SAME_OFFSET_ROUTED_OBSTACLE_PENALTY = 5;
const TURN_COST_METERS_PER_RADIAN = 0.4;
const CONNECTOR_VERTEX_COST_METERS = 0.15;
const REGIONAL_ROUTED_TRANSITION_PENALTY_METERS = 2;
// Exact open-route optimisation grows exponentially with the region count.
// Twelve regions produced a 100+ second synchronous planning pause on the
// mower, starving GNSS and motor feedback. Keep exact optimisation for small
// plans and use the bounded nearest-region traversal above this limit.
const MAX_EXACT_REGION_OPTIMISATION_REGIONS = 8;
/**
 * A planned pass needs margin above the executor's 15 cm minimum command.
 * Shorter geometric slivers are covered by the mandatory perimeter trace;
 * retaining them would create turns and connectors without a reliable cut.
 */
export const MINIMUM_EXECUTABLE_MOWING_STRIP_METERS = 0.3;

export function effectiveMowingStripStandoffMeters(stripLengthMeters: number, configuredStandoffMeters: number): number {
  return Math.min(
    configuredStandoffMeters,
    Math.max(0, (stripLengthMeters - MINIMUM_EXECUTABLE_MOWING_STRIP_METERS) / 2),
  );
}

interface Vector {
  readonly x: number;
  readonly y: number;
}

interface RoutingRoadmap {
  readonly points: Vector[];
  readonly segments: ReadonlyArray<readonly [Vector, Vector]>;
}

const EMPTY_ROUTING_ROADMAP: RoutingRoadmap = { points: [], segments: [] };

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

interface RegionalTraversalResult {
  readonly sequencing: SequenceStripsResult;
  readonly regionByStrip: Map<MowingStrip, string>;
  readonly regionOrder: string[];
  readonly turnCostMeters: number;
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
      regions: [],
      regionOrder: [],
      routeCost: { mowingDistanceMeters: 0, connectorDistanceMeters: 0, startAndReturnDistanceMeters: 0, estimatedCombinedWheelTravelMeters: 0, regionTransitionCount: 0 },
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
  const regional = buildRegionalTraversal(
    strips,
    direction,
    polygon,
    obstaclePolygons,
    mowingStandoffMeters,
    options.preferredStartPoint,
  );
  const sequencing = regional.sequencing;
  const reanchoredTraversal = sequencing.traversal;
  const sequenceMs = Date.now() - sequenceStartedAtMs;
  const sequencedStrips = reanchoredTraversal.map((step, index) => ({
    ...step.strip,
    stableId: stableStripId(step.strip),
    regionId: regional.regionByStrip.get(step.strip),
    sequenceIndex: index,
    traversalReversed: step.reversed,
  }));
  const connectorBuildStartedAtMs = Date.now();
  const connectors = buildStripConnectors(reanchoredTraversal, polygon, obstaclePolygons, mowingStandoffMeters);
  const connectorBuildMs = Date.now() - connectorBuildStartedAtMs;
  const stripOffsetCount = countStripOffsets(firstOffset, maxOffset, stripSpacingMeters);
  const routedConnectorCount = connectors.filter((connector) => connector.length > 2).length;
  const connectorDistanceMeters = connectors.reduce((sum, connector) => sum + pathPointPathLength(connector), 0);
  const mowingDistanceMeters = sequencedStrips.reduce((sum, strip) => sum + distance(
    { x: strip.start.xMeters, y: strip.start.yMeters },
    { x: strip.end.xMeters, y: strip.end.yMeters },
  ), 0);
  const firstTraversal = reanchoredTraversal[0];
  const lastTraversal = reanchoredTraversal[reanchoredTraversal.length - 1];
  const startAndReturnDistanceMeters = options.preferredStartPoint && firstTraversal && lastTraversal
    ? distance(
      { x: options.preferredStartPoint.xMeters, y: options.preferredStartPoint.yMeters },
      stripTraversalStart(firstTraversal.strip, firstTraversal.reversed),
    ) + distance(
      stripTraversalEnd(lastTraversal.strip, lastTraversal.reversed),
      { x: options.preferredStartPoint.xMeters, y: options.preferredStartPoint.yMeters },
    )
    : 0;
  const regions = regional.regionOrder.map((regionId, orderIndex) => {
    const regionStrips = sequencedStrips.filter((strip) => strip.regionId === regionId);
    const first = regionStrips[0];
    const last = regionStrips[regionStrips.length - 1];
    return {
      id: regionId,
      orderIndex,
      stripIds: regionStrips.map((strip) => strip.stableId ?? ""),
      stripCount: regionStrips.length,
      entryPoint: toPathPoint(stripTraversalStart(first, first.traversalReversed)),
      exitPoint: toPathPoint(stripTraversalEnd(last, last.traversalReversed)),
    };
  });

  return {
    headingDeg,
    stripSpacingMeters,
    bladeWidthMeters,
    stripCount: sequencedStrips.length,
    strips: sequencedStrips,
    connectors,
    regions,
    regionOrder: regional.regionOrder,
    routeCost: {
      mowingDistanceMeters,
      connectorDistanceMeters,
      startAndReturnDistanceMeters,
      estimatedCombinedWheelTravelMeters: ((mowingDistanceMeters + connectorDistanceMeters + startAndReturnDistanceMeters) * 2) + regional.turnCostMeters,
      regionTransitionCount: Math.max(0, regions.length - 1),
    },
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
  if (distance(start.point, end.point) < MINIMUM_EXECUTABLE_MOWING_STRIP_METERS - EPSILON) {
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
  preferredStartPoint?: MowingInitialEntryPosition,
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

  const firstStep = preferredStartPoint
    ? chooseNearestTraversalStep(remaining, preferredStartPoint)
    : chooseFirstTraversalStep(
      remaining.filter((strip) => Math.abs(strip.centerOffsetMeters - offsets[0]) <= EPSILON),
      direction,
    );
  const firstStrip = firstStep.strip;
  traversal.push(firstStep);
  removeStrip(remaining, firstStrip);
  mownCrossings.set(firstStrip, 0);
  currentPoint = stripTraversalEnd(firstStrip, firstStep.reversed);

  while (remaining.length > 0 && currentPoint !== null) {
    const currentOffset = traversal[traversal.length - 1].strip.centerOffsetMeters;
    const currentStep = traversal[traversal.length - 1];
    // A preferred start only chooses the first strip. Once mowing has begun,
    // preserve the adjacent-offset sweep instead of leaving holes through a
    // repeated global nearest-neighbour search.
    const candidates = selectTraversalCandidates(remaining, currentOffset, lockedOffsetDirection);
    const bestEvaluation = chooseBestTraversalStep(
      candidates,
      currentPoint,
      currentOffset,
      direction,
      obstacles,
      mownCrossings,
      currentStep,
    );
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

function buildRegionalTraversal(
  strips: MowingStrip[],
  direction: Vector,
  areaPolygon: Vector[],
  obstaclePolygons: Vector[][],
  mowingStandoffMeters: number,
  preferredStartPoint?: MowingInitialEntryPosition,
): RegionalTraversalResult {
  if (strips.length === 0) {
    const sequencing = sequenceStripsForMowing(strips, direction, obstaclePolygons, preferredStartPoint);
    return {
      sequencing,
      regionByStrip: new Map(),
      regionOrder: [],
      turnCostMeters: estimateTraversalTurnCost(sequencing.traversal),
    };
  }

  const orderedGroups = decomposeSweepRegions(strips, direction);
  const templates = orderedGroups.map((regionStrips, regionIndex) => {
    const base = sequenceStripsForMowing(
      regionStrips,
      direction,
      obstaclePolygons,
      orderedGroups.length === 1 ? preferredStartPoint : undefined,
    ).traversal;
    const reverse = base.slice().reverse().map((step) => ({ strip: step.strip, reversed: !step.reversed }));
    return {
      id: `region-${String(regionIndex + 1).padStart(2, "0")}`,
      variants: [base, reverse] as const,
    };
  });

  const transitionCostCache = new Map<string, number>();
  const selected = optimiseRegionTemplates(
    templates,
    preferredStartPoint,
    (from, to) => {
      const key = `${from.regionIndex}:${from.variantIndex}>${to.regionIndex}:${to.variantIndex}`;
      const cached = transitionCostCache.get(key);
      if (cached !== undefined) return cached;
      const cost = safeRegionTransitionCost(
        templates[from.regionIndex].variants[from.variantIndex],
        templates[to.regionIndex].variants[to.variantIndex],
        areaPolygon,
        obstaclePolygons,
        mowingStandoffMeters,
      );
      transitionCostCache.set(key, cost);
      return cost;
    },
    preferredStartPoint
      ? (choice) => {
        const traversal = templates[choice.regionIndex].variants[choice.variantIndex];
        const first = traversal[0];
        const entry = stripTraversalStartStandoff(first.strip, first.reversed, mowingStandoffMeters);
        const preferred = { x: preferredStartPoint.xMeters, y: preferredStartPoint.yMeters };
        const obstaclePenalty = obstaclePolygons.some((obstacle) => segmentIntersectsPolygon(preferred, entry, obstacle))
          ? 1_000
          : 0;
        return distance(preferred, entry) + obstaclePenalty;
      }
      : undefined,
  );
  const traversal = selected.flatMap((choice) => templates[choice.regionIndex].variants[choice.variantIndex]);
  const regionByStrip = new Map<MowingStrip, string>();
  selected.forEach((choice) => {
    const template = templates[choice.regionIndex];
    template.variants[choice.variantIndex].forEach((step) => regionByStrip.set(step.strip, template.id));
  });
  const sequencing: SequenceStripsResult = {
    traversal,
    performance: {
      traversalCandidateEvaluations: 0,
      traversalConnectorPathEvaluations: 0,
      routedCandidateCount: 0,
    },
  };
  return {
    sequencing,
    regionByStrip,
    regionOrder: selected.map((choice) => templates[choice.regionIndex].id),
    turnCostMeters: estimateTraversalTurnCost(traversal),
  };
}

interface SweepInterval {
  readonly strip: MowingStrip;
  readonly minAlong: number;
  readonly maxAlong: number;
  regionIndex: number;
}

function decomposeSweepRegions(strips: MowingStrip[], direction: Vector): MowingStrip[][] {
  const offsets = [...new Set(strips.map((strip) => strip.centerOffsetMeters))].sort((a, b) => a - b);
  const regions: MowingStrip[][] = [];
  let previous: SweepInterval[] = [];

  for (const offset of offsets) {
    const current = strips
      .filter((strip) => Math.abs(strip.centerOffsetMeters - offset) <= EPSILON)
      .map((strip): SweepInterval => {
        const startAlong = dot({ x: strip.start.xMeters, y: strip.start.yMeters }, direction);
        const endAlong = dot({ x: strip.end.xMeters, y: strip.end.yMeters }, direction);
        return {
          strip,
          minAlong: Math.min(startAlong, endAlong),
          maxAlong: Math.max(startAlong, endAlong),
          regionIndex: -1,
        };
      })
      .sort((left, right) => left.minAlong - right.minAlong);

    const previousOverlaps = previous.map((prior) => current.filter((candidate) => sweepIntervalsOverlap(prior, candidate)));
    const currentOverlaps = current.map((candidate) => previous.filter((prior) => sweepIntervalsOverlap(prior, candidate)));

    current.forEach((candidate, currentIndex) => {
      const overlappingPrevious = currentOverlaps[currentIndex];
      const continuesOneToOne = overlappingPrevious.length === 1
        && previousOverlaps[previous.indexOf(overlappingPrevious[0])]?.length === 1;
      if (continuesOneToOne) {
        candidate.regionIndex = overlappingPrevious[0].regionIndex;
      } else {
        candidate.regionIndex = regions.length;
        regions.push([]);
      }
      regions[candidate.regionIndex].push(candidate.strip);
    });
    previous = current;
  }

  return regions.filter((region) => region.length > 0);
}

function sweepIntervalsOverlap(left: SweepInterval, right: SweepInterval): boolean {
  return Math.min(left.maxAlong, right.maxAlong) - Math.max(left.minAlong, right.minAlong) > EPSILON;
}

interface RegionTemplateChoice {
  readonly regionIndex: number;
  readonly variantIndex: 0 | 1;
}

function safeRegionTransitionCost(
  fromTraversal: TraversalStep[],
  toTraversal: TraversalStep[],
  _areaPolygon: Vector[],
  _obstacles: Vector[][],
  mowingStandoffMeters: number,
): number {
  const from = fromTraversal[fromTraversal.length - 1];
  const to = toTraversal[0];
  const fromStandoff = stripTraversalEndStandoff(from.strip, from.reversed, mowingStandoffMeters);
  const toStandoff = stripTraversalStartStandoff(to.strip, to.reversed, mowingStandoffMeters);
  // Region ordering can evaluate hundreds of directed alternatives. Even the
  // sampled direct-path validation starves the live sensor loop on a detailed
  // lawn boundary. Rank candidates with a constant-time geometric estimate;
  // buildStripConnectors still constructs and fully validates every selected
  // transition before the plan can execute.
  const obstaclePenalty = _obstacles.some((obstacle) => segmentIntersectsPolygon(fromStandoff, toStandoff, obstacle))
    ? REGIONAL_ROUTED_TRANSITION_PENALTY_METERS
    : 0;
  return distance(fromStandoff, toStandoff) * 2 + obstaclePenalty;
}

function optimiseRegionTemplates(
  templates: ReadonlyArray<{ readonly variants: readonly [TraversalStep[], TraversalStep[]] }>,
  preferredStartPoint?: MowingInitialEntryPosition,
  transitionCost: (from: RegionTemplateChoice, to: RegionTemplateChoice) => number = () => 0,
  preferredEntryCost?: (choice: RegionTemplateChoice) => number,
): RegionTemplateChoice[] {
  if (templates.length === 0) return [];
  const entryCost = (choice: RegionTemplateChoice): number => {
    if (!preferredStartPoint) return 0;
    return preferredEntryCost?.(choice) ?? 0;
  };
  // Optimise the route actually executed: an open traversal beginning at the
  // live entry. Closing an artificial cycle can retain a very long transition
  // that the mower never executes.
  if (templates.length > MAX_EXACT_REGION_OPTIMISATION_REGIONS) {
    const remaining = templates.map((_, regionIndex) => regionIndex);
    const result: RegionTemplateChoice[] = [];
    let previousChoice: RegionTemplateChoice | null = null;
    while (remaining.length > 0) {
      let best = { listIndex: 0, variantIndex: 0 as 0 | 1, cost: Infinity };
      remaining.forEach((regionIndex, listIndex) => {
        ([0, 1] as const).forEach((variantIndex) => {
          const choice = { regionIndex, variantIndex };
          const cost = previousChoice ? transitionCost(previousChoice, choice) : entryCost(choice);
          if (cost < best.cost - EPSILON) best = { listIndex, variantIndex, cost };
        });
      });
      if (!Number.isFinite(best.cost)) {
        throw new Error("mowing_regional_route_unavailable");
      }
      const regionIndex = remaining.splice(best.listIndex, 1)[0];
      previousChoice = { regionIndex, variantIndex: best.variantIndex };
      result.push(previousChoice);
    }
    return result;
  }

  type State = { cost: number; choices: RegionTemplateChoice[] };
  let states = new Map<string, State>();
  templates.forEach((_template, regionIndex) => {
    ([0, 1] as const).forEach((variantIndex) => {
      const choice = { regionIndex, variantIndex };
      const cost = entryCost(choice);
      if (!Number.isFinite(cost)) return;
      states.set(`${1 << regionIndex}:${regionIndex}:${variantIndex}`, {
        cost,
        choices: [choice],
      });
    });
  });
  for (let size = 1; size < templates.length; size += 1) {
    const nextStates = new Map(states);
    for (const [key, state] of states) {
      const mask = Number(key.split(":", 1)[0]);
      if (state.choices.length !== size) continue;
      templates.forEach((_template, regionIndex) => {
        if ((mask & (1 << regionIndex)) !== 0) return;
        ([0, 1] as const).forEach((variantIndex) => {
          const nextChoice = { regionIndex, variantIndex };
          const edgeCost = transitionCost(state.choices[state.choices.length - 1], nextChoice);
          if (!Number.isFinite(edgeCost)) return;
          const candidate: State = {
            cost: state.cost + edgeCost,
            choices: [...state.choices, nextChoice],
          };
          const nextKey = `${mask | (1 << regionIndex)}:${regionIndex}:${variantIndex}`;
          const existing = nextStates.get(nextKey);
          if (!existing || candidate.cost < existing.cost - EPSILON) nextStates.set(nextKey, candidate);
        });
      });
    }
    states = nextStates;
  }
  const complete = [...states.values()]
    .filter((state) => state.choices.length === templates.length)
    .filter((state) => Number.isFinite(state.cost));
  if (complete.length === 0) {
    throw new Error("mowing_regional_route_unavailable");
  }
  complete.sort((left, right) => left.cost - right.cost);
  return complete[0].choices;
}

function estimateTraversalTurnCost(traversal: TraversalStep[]): number {
  let radians = 0;
  for (let index = 1; index < traversal.length; index += 1) {
    const previous = traversal[index - 1];
    const current = traversal[index];
    const previousStart = stripTraversalStart(previous.strip, previous.reversed);
    const previousEnd = stripTraversalEnd(previous.strip, previous.reversed);
    const currentStart = stripTraversalStart(current.strip, current.reversed);
    const currentEnd = stripTraversalEnd(current.strip, current.reversed);
    const a = Math.atan2(previousEnd.y - previousStart.y, previousEnd.x - previousStart.x);
    const b = Math.atan2(currentEnd.y - currentStart.y, currentEnd.x - currentStart.x);
    radians += Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
  }
  return radians * TURN_COST_METERS_PER_RADIAN;
}

function stableStripId(strip: MowingStrip): string {
  const values = [strip.centerOffsetMeters, strip.start.xMeters, strip.start.yMeters, strip.end.xMeters, strip.end.yMeters];
  return `strip-${values.map((value) => value.toFixed(3).replace(/-/g, "m").replace(/\./g, "p")).join("-")}`;
}

function pathPointPathLength(points: PathPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index].xMeters - points[index - 1].xMeters, points[index].yMeters - points[index - 1].yMeters);
  }
  return total;
}

function chooseNearestTraversalStep(
  candidates: MowingStrip[],
  preferredStartPoint: MowingInitialEntryPosition,
): TraversalStep {
  if (!Number.isFinite(preferredStartPoint.xMeters) || !Number.isFinite(preferredStartPoint.yMeters)) {
    throw new Error("preferred_start_point_must_be_finite");
  }
  const preferred = { x: preferredStartPoint.xMeters, y: preferredStartPoint.yMeters };
  let bestStep: TraversalStep | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    for (const reversed of [false, true] as const) {
      const candidateDistance = distance(preferred, stripTraversalStart(candidate, reversed));
      if (candidateDistance < bestDistance - EPSILON) {
        bestDistance = candidateDistance;
        bestStep = { strip: candidate, reversed };
      }
    }
  }
  if (!bestStep) {
    throw new Error("mowing_plan_has_no_first_strip");
  }
  return bestStep;
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
  currentStep: TraversalStep,
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
        currentStep,
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
  if (candidateEvaluation.requiresObstacleRouting !== bestEvaluation.requiresObstacleRouting) {
    return !candidateEvaluation.requiresObstacleRouting;
  }
  if (costDelta < -EPSILON) {
    return true;
  }

  if (costDelta > EPSILON) {
    return false;
  }

  return preferCandidate(candidate, reversed, currentBest, currentBestReversed, direction);
}

function buildStripConnectors(
  traversal: TraversalStep[],
  areaPolygon: Vector[],
  obstacles: Vector[][],
  mowingStandoffMeters: number,
): PathPoint[][] {
  const connectors: PathPoint[][] = [];
  const routingRoadmap = buildStripRoutingWaypoints(
    traversal.map((step) => step.strip),
    mowingStandoffMeters,
  );

  for (let index = 0; index < traversal.length - 1; index += 1) {
    const currentEnd = stripTraversalEnd(traversal[index].strip, traversal[index].reversed);
    const nextStart = stripTraversalStart(traversal[index + 1].strip, traversal[index + 1].reversed);
    const currentEndBoundary = stripTraversalEndBoundary(traversal[index].strip, traversal[index].reversed);
    const nextStartBoundary = stripTraversalStartBoundary(traversal[index + 1].strip, traversal[index + 1].reversed);
    const currentEndStandoff = stripTraversalEndStandoff(traversal[index].strip, traversal[index].reversed, mowingStandoffMeters);
    const nextStartStandoff = stripTraversalStartStandoff(traversal[index + 1].strip, traversal[index + 1].reversed, mowingStandoffMeters);
    try {
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
        routingRoadmap,
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}:transition_${index}_from_${currentEnd.x.toFixed(3)}_${currentEnd.y.toFixed(3)}_${currentEndStandoff.x.toFixed(3)}_${currentEndStandoff.y.toFixed(3)}_${currentEndBoundary.kind}_to_${nextStart.x.toFixed(3)}_${nextStart.y.toFixed(3)}_${nextStartStandoff.x.toFixed(3)}_${nextStartStandoff.y.toFixed(3)}_${nextStartBoundary.kind}`);
    }
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
  routingRoadmap: RoutingRoadmap = EMPTY_ROUTING_ROADMAP,
): PathPoint[] {
  const candidates: Array<{ points: PathPoint[]; ignoredObstacle?: Vector[] }> = [];
  const authoritativeAreaBoundaryCandidates: PathPoint[][] = [];
  const directConnector = [currentEndStandoff, nextStartStandoff].map(toPathPoint);
  if (pathStaysWithinAreaAndAvoidsObstacles(
    [currentEndStandoff, nextStartStandoff],
    areaPolygon,
    obstacles,
  )) {
    return directConnector;
  }

  if (sameBoundary(currentEndBoundary, nextStartBoundary)) {
    const boundary = boundaryPolygon(currentEndBoundary, areaPolygon, obstacles);
    // At acute/concave perimeter corners an inset polygon can fall outside the
    // recorded lawn even though both adjacent lanes are valid. Retain the
    // recorded boundary itself as the authoritative retrace route, joined to
    // each lane along that lane's already validated endpoint segment.
    for (const boundaryPoints of buildBoundaryStandoffConnectorCandidates(
      currentEnd,
      nextStart,
      currentEnd,
      nextStart,
      boundary,
      currentEndBoundary,
    )) {
      const points = [
        toPathPoint(currentEndStandoff),
        ...boundaryPoints,
        toPathPoint(nextStartStandoff),
      ];
      candidates.push({
        points,
        ...(currentEndBoundary.kind === "obstacle" ? { ignoredObstacle: boundary } : {}),
      });
      if (currentEndBoundary.kind === "area") {
        authoritativeAreaBoundaryCandidates.push(points);
      }
    }
    for (const points of buildBoundaryStandoffConnectorCandidates(
      currentEnd,
      nextStart,
      currentEndStandoff,
      nextStartStandoff,
      boundary,
      currentEndBoundary,
    )) {
      candidates.push({
        points,
        ...(currentEndBoundary.kind === "obstacle" ? { ignoredObstacle: boundary } : {}),
      });
    }
  }

  for (const routedObstacle of obstacles.filter((obstacle) => (
    segmentIntersectsPolygon(currentEndStandoff, nextStartStandoff, obstacle)
  ))) {
    for (const points of buildObstaclePerimeterConnectorCandidates(
      currentEndStandoff,
      nextStartStandoff,
      routedObstacle,
      mowingStandoffMeters,
    )) {
      candidates.push({ points, ignoredObstacle: routedObstacle });
    }
  }

  for (const points of buildAreaBoundaryConnectorCandidates(
    currentEndStandoff,
    nextStartStandoff,
    areaPolygon,
    mowingStandoffMeters,
  )) {
    candidates.push({ points });
  }

  const safeCandidates = candidates.filter((candidate) => pathStaysWithinAreaAndAvoidsObstacles(
    candidate.points.map((point) => ({ x: point.xMeters, y: point.yMeters })),
    areaPolygon,
    obstacles,
    candidate.ignoredObstacle,
  ));
  safeCandidates.sort((left, right) => pathPointPathLength(left.points) - pathPointPathLength(right.points));
  if (safeCandidates.length > 0) {
    return safeCandidates[0].points;
  }
  authoritativeAreaBoundaryCandidates.sort((left, right) => pathPointPathLength(left) - pathPointPathLength(right));
  if (authoritativeAreaBoundaryCandidates.length > 0) {
    return authoritativeAreaBoundaryCandidates[0];
  }

  const freeSpaceConnector = buildFreeSpaceConnector(
    currentEndStandoff,
    nextStartStandoff,
    areaPolygon,
    obstacles,
    mowingStandoffMeters,
    routingRoadmap,
  );
  if (freeSpaceConnector) {
    return freeSpaceConnector;
  }

  throw new Error("mowing_connector_no_safe_route");
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
  const effectiveStandoffMeters = effectiveMowingStripStandoffMeters(distance(start, end), standoffMeters);
  return {
    x: start.x + (direction.x * effectiveStandoffMeters),
    y: start.y + (direction.y * effectiveStandoffMeters),
  };
}

function stripTraversalEndStandoff(strip: MowingStrip, reversed: boolean, standoffMeters: number): Vector {
  const start = stripTraversalStart(strip, reversed);
  const end = stripTraversalEnd(strip, reversed);
  const direction = normalise({ x: end.x - start.x, y: end.y - start.y });
  const effectiveStandoffMeters = effectiveMowingStripStandoffMeters(distance(start, end), standoffMeters);
  return {
    x: end.x - (direction.x * effectiveStandoffMeters),
    y: end.y - (direction.y * effectiveStandoffMeters),
  };
}

function buildStripRoutingWaypoints(strips: MowingStrip[], standoffMeters: number): RoutingRoadmap {
  const segments: Array<readonly [Vector, Vector]> = [];
  const waypoints = strips.flatMap((strip) => {
    const start = { x: strip.start.xMeters, y: strip.start.yMeters };
    const end = { x: strip.end.xMeters, y: strip.end.yMeters };
    const direction = normalise({ x: end.x - start.x, y: end.y - start.y });
    const effectiveStandoffMeters = effectiveMowingStripStandoffMeters(distance(start, end), standoffMeters);
    const startStandoff = { x: start.x + (direction.x * effectiveStandoffMeters), y: start.y + (direction.y * effectiveStandoffMeters) };
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const endStandoff = { x: end.x - (direction.x * effectiveStandoffMeters), y: end.y - (direction.y * effectiveStandoffMeters) };
    segments.push(
      [start, startStandoff],
      [startStandoff, midpoint],
      [midpoint, endStandoff],
      [endStandoff, end],
    );
    return [start, startStandoff, midpoint, endStandoff, end];
  });
  const axisStrip = strips.find((strip) => distance(
    { x: strip.start.xMeters, y: strip.start.yMeters },
    { x: strip.end.xMeters, y: strip.end.yMeters },
  ) > EPSILON);
  if (!axisStrip) return { points: waypoints, segments };
  const direction = normalise({
    x: axisStrip.end.xMeters - axisStrip.start.xMeters,
    y: axisStrip.end.yMeters - axisStrip.start.yMeters,
  });
  const firstNormal = { x: -direction.y, y: direction.x };
  const normal = Math.abs(dot({ x: axisStrip.start.xMeters, y: axisStrip.start.yMeters }, firstNormal) - axisStrip.centerOffsetMeters)
    <= Math.abs(dot({ x: axisStrip.start.xMeters, y: axisStrip.start.yMeters }, { x: -firstNormal.x, y: -firstNormal.y }) - axisStrip.centerOffsetMeters)
    ? firstNormal
    : { x: -firstNormal.x, y: -firstNormal.y };
  const offsets = [...new Set(strips.map((strip) => strip.centerOffsetMeters))].sort((a, b) => a - b);
  const offsetStep = offsets.slice(1).reduce(
    (smallest, offset, index) => Math.min(smallest, offset - offsets[index]),
    Infinity,
  );
  if (!Number.isFinite(offsetStep)) return { points: waypoints, segments };

  for (const lower of strips) {
    for (const upper of strips) {
      if (Math.abs((upper.centerOffsetMeters - lower.centerOffsetMeters) - offsetStep) > EPSILON) continue;
      const lowerAlong = [
        dot({ x: lower.start.xMeters, y: lower.start.yMeters }, direction),
        dot({ x: lower.end.xMeters, y: lower.end.yMeters }, direction),
      ].sort((a, b) => a - b);
      const upperAlong = [
        dot({ x: upper.start.xMeters, y: upper.start.yMeters }, direction),
        dot({ x: upper.end.xMeters, y: upper.end.yMeters }, direction),
      ].sort((a, b) => a - b);
      const overlapStart = Math.max(lowerAlong[0], upperAlong[0]);
      const overlapEnd = Math.min(lowerAlong[1], upperAlong[1]);
      if (overlapEnd - overlapStart <= EPSILON) continue;
      const along = (overlapStart + overlapEnd) / 2;
      const lowerPoint = { x: (direction.x * along) + (normal.x * lower.centerOffsetMeters), y: (direction.y * along) + (normal.y * lower.centerOffsetMeters) };
      const upperPoint = { x: (direction.x * along) + (normal.x * upper.centerOffsetMeters), y: (direction.y * along) + (normal.y * upper.centerOffsetMeters) };
      waypoints.push(lowerPoint, upperPoint);
      segments.push([lowerPoint, upperPoint]);
    }
  }
  return { points: waypoints, segments };
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

function buildBoundaryStandoffConnectorCandidates(
  fromBoundaryPoint: Vector,
  toBoundaryPoint: Vector,
  fromStandoff: Vector,
  toStandoff: Vector,
  polygon: Vector[],
  boundary: MowingBoundaryReference,
): PathPoint[][] {
  if (polygon.length < 3) {
    return [[toPathPoint(fromStandoff), toPathPoint(toStandoff)]];
  }

  const fromSegmentIndex = findNearestSegmentIndex(polygon, fromBoundaryPoint);
  const toSegmentIndex = findNearestSegmentIndex(polygon, toBoundaryPoint);
  if (fromSegmentIndex === toSegmentIndex) {
    return [[toPathPoint(fromStandoff), toPathPoint(toStandoff)]];
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
  return [forward.map(toPathPoint), reverse.map(toPathPoint)];
}

function buildObstaclePerimeterConnector(from: Vector, to: Vector, obstacle: Vector[], standoffMeters: number = 0): PathPoint[] {
  const candidates = buildObstaclePerimeterConnectorCandidates(from, to, obstacle, standoffMeters);
  return candidates.sort((left, right) => pathPointPathLength(left) - pathPointPathLength(right))[0];
}

function buildObstaclePerimeterConnectorCandidates(
  from: Vector,
  to: Vector,
  obstacle: Vector[],
  standoffMeters: number = 0,
): PathPoint[][] {
  const offsetObstacle = buildOffsetBoundaryVertices(obstacle, { kind: "obstacle", obstacleIndex: 0 }, standoffMeters);
  if (offsetObstacle.length < 3) {
    return [[toPathPoint(from), toPathPoint(to)]];
  }

  const fromIndex = findNearestVertexIndex(obstacle, from);
  const toIndex = findNearestVertexIndex(obstacle, to);
  const forward = [from, ...walkObstacleVertices(offsetObstacle, fromIndex, toIndex, 1), to];
  const reverse = [from, ...walkObstacleVertices(offsetObstacle, fromIndex, toIndex, -1), to];
  return [forward.map(toPathPoint), reverse.map(toPathPoint)];
}

function buildAreaBoundaryConnectorCandidates(
  fromStandoff: Vector,
  toStandoff: Vector,
  areaPolygon: Vector[],
  standoffMeters: number,
): PathPoint[][] {
  const offsetArea = buildOffsetBoundaryVertices(areaPolygon, { kind: "area" }, standoffMeters);
  if (offsetArea.length < 3) {
    return [[toPathPoint(fromStandoff), toPathPoint(toStandoff)]];
  }

  const fromIndex = findNearestVertexIndex(offsetArea, fromStandoff);
  const toIndex = findNearestVertexIndex(offsetArea, toStandoff);
  const forward = [fromStandoff, ...walkObstacleVertices(offsetArea, fromIndex, toIndex, 1), toStandoff];
  const reverse = [fromStandoff, ...walkObstacleVertices(offsetArea, fromIndex, toIndex, -1), toStandoff];
  return [forward.map(toPathPoint), reverse.map(toPathPoint)];
}

export function buildMowingTransitPath(
  areaPoints: ReadonlyArray<PathPoint>,
  obstaclePointsArray: ReadonlyArray<ReadonlyArray<PathPoint>>,
  from: Pick<PathPoint, "xMeters" | "yMeters">,
  to: Pick<PathPoint, "xMeters" | "yMeters">,
  standoffMeters: number,
): PathPoint[] {
  const areaPolygon = areaPoints.map((point) => ({ x: point.xMeters, y: point.yMeters }));
  const obstacles = obstaclePointsArray.map((obstacle) => obstacle.map((point) => ({
    x: point.xMeters,
    y: point.yMeters,
  })));
  const fromVector = { x: from.xMeters, y: from.yMeters };
  const toVector = { x: to.xMeters, y: to.yMeters };
  if (pathStaysWithinAreaAndAvoidsObstacles([fromVector, toVector], areaPolygon, obstacles)) {
    const capturedAt = Date.now();
    return [{ ...from, capturedAt }, { ...to, capturedAt }];
  }
  const route = buildFreeSpaceConnector(
    fromVector,
    toVector,
    areaPolygon,
    obstacles,
    standoffMeters,
    EMPTY_ROUTING_ROADMAP,
  );
  if (!route) throw new Error("mowing_transit_no_safe_route");
  return route;
}

function buildFreeSpaceConnector(
  from: Vector,
  to: Vector,
  areaPolygon: Vector[],
  obstacles: Vector[][],
  standoffMeters: number,
  routingRoadmap: RoutingRoadmap,
): PathPoint[] | null {
  const offsetArea = buildOffsetBoundaryVertices(areaPolygon, { kind: "area" }, standoffMeters);
  const offsetObstacles = obstacles.map((obstacle, obstacleIndex) => buildOffsetBoundaryVertices(
    obstacle,
    { kind: "obstacle", obstacleIndex },
    standoffMeters,
  ));
  const candidateNodes = [
    from,
    to,
    ...offsetArea,
    ...offsetObstacles.flat(),
    ...routingRoadmap.points,
  ];
  const nodes: Vector[] = [];
  for (const candidate of candidateNodes) {
    if (!pointInPolygonOrOnBoundary(candidate, areaPolygon)) continue;
    if (obstacles.some((obstacle) => pointInPolygon(candidate, obstacle))) continue;
    if (nodes.some((node) => distance(node, candidate) <= 0.01)) continue;
    nodes.push(candidate);
  }
  if (nodes.length < 2) return null;

  const fromIndex = nodes.findIndex((node) => distance(node, from) <= 0.01);
  const toIndex = nodes.findIndex((node) => distance(node, to) <= 0.01);
  if (fromIndex < 0 || toIndex < 0) return null;

  const edges: Array<Array<{ toIndex: number; cost: number }>> = nodes.map(() => []);
  const addEdge = (leftIndex: number, rightIndex: number): void => {
    if (leftIndex < 0 || rightIndex < 0 || leftIndex === rightIndex) return;
    const cost = distance(nodes[leftIndex], nodes[rightIndex]);
    if (!edges[leftIndex].some((edge) => edge.toIndex === rightIndex)) {
      edges[leftIndex].push({ toIndex: rightIndex, cost });
      edges[rightIndex].push({ toIndex: leftIndex, cost });
    }
  };
  // A complete visibility graph becomes prohibitively expensive for a real
  // lawn containing hundreds of strip waypoints. Nearby visible neighbours
  // are sufficient to join the strip network, while the recorded perimeter
  // loop below guarantees a sparse long-distance route around the lawn.
  const nearestVisibleCandidateCount = 16;
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const nearby = nodes
      .map((node, rightIndex) => ({ rightIndex, distanceMeters: distance(nodes[leftIndex], node) }))
      .filter(({ rightIndex }) => rightIndex !== leftIndex)
      .sort((left, right) => left.distanceMeters - right.distanceMeters)
      .slice(0, nearestVisibleCandidateCount);
    for (const { rightIndex } of nearby) {
      if (!pathStaysWithinAreaAndAvoidsObstacles(
        [nodes[leftIndex], nodes[rightIndex]],
        areaPolygon,
        obstacles,
      )) continue;
      addEdge(leftIndex, rightIndex);
    }
  }
  // Transition endpoints are few, so test them against the entire sparse
  // roadmap. This prevents a dense cluster of strip points from hiding the
  // first visible route away from an obstacle or concave boundary.
  for (const endpointIndex of [fromIndex, toIndex]) {
    for (let otherIndex = 0; otherIndex < nodes.length; otherIndex += 1) {
      if (otherIndex === endpointIndex || !pathStaysWithinAreaAndAvoidsObstacles(
        [nodes[endpointIndex], nodes[otherIndex]],
        areaPolygon,
        obstacles,
      )) continue;
      addEdge(endpointIndex, otherIndex);
    }
  }
  // Every mowing strip is an already validated route through free space.
  // Preserve its explicit start-to-midpoint-to-end links so the connector can
  // retreat along completed work to the outer perimeter instead of relying on
  // incidental nearest-neighbour visibility.
  for (const [segmentStart, segmentEnd] of routingRoadmap.segments) {
    if (!pathStaysWithinAreaAndAvoidsObstacles(
      [segmentStart, segmentEnd],
      areaPolygon,
      obstacles,
    )) continue;
    addEdge(
      nodes.findIndex((node) => distance(node, segmentStart) <= 0.01),
      nodes.findIndex((node) => distance(node, segmentEnd) <= 0.01),
    );
  }
  // Expanded obstacle perimeters are authoritative standoff loops. Preserve
  // their consecutive edges while still validating the lawn boundary and all
  // other obstacles; the represented obstacle alone is intentionally ignored.
  for (let obstacleIndex = 0; obstacleIndex < offsetObstacles.length; obstacleIndex += 1) {
    const offsetObstacle = offsetObstacles[obstacleIndex];
    for (let index = 0; index < offsetObstacle.length; index += 1) {
      const nextIndex = (index + 1) % offsetObstacle.length;
      if (!pathStaysWithinAreaAndAvoidsObstacles(
        [offsetObstacle[index], offsetObstacle[nextIndex]],
        areaPolygon,
        obstacles,
        obstacles[obstacleIndex],
      )) continue;
      addEdge(
        nodes.findIndex((node) => distance(node, offsetObstacle[index]) <= 0.01),
        nodes.findIndex((node) => distance(node, offsetObstacle[nextIndex]) <= 0.01),
      );
    }
  }
  // The inward-offset area perimeter is the safe routing loop. Raw area
  // vertices describe the physical edge and must never be offered to the
  // shortest-path search: doing so can produce a mathematically in-bounds
  // route that runs the mower body along a wall or recorded lawn boundary.
  for (let index = 0; index < offsetArea.length; index += 1) {
    const nextIndex = (index + 1) % offsetArea.length;
    if (!pathStaysWithinAreaAndAvoidsObstacles(
      [offsetArea[index], offsetArea[nextIndex]],
      areaPolygon,
      obstacles,
    )) {
      continue;
    }
    addEdge(
      nodes.findIndex((node) => distance(node, offsetArea[index]) <= 0.01),
      nodes.findIndex((node) => distance(node, offsetArea[nextIndex]) <= 0.01),
    );
  }

  const costs = nodes.map(() => Infinity);
  const previous = nodes.map(() => -1);
  const visited = nodes.map(() => false);
  costs[fromIndex] = 0;
  for (let iteration = 0; iteration < nodes.length; iteration += 1) {
    let currentIndex = -1;
    for (let index = 0; index < nodes.length; index += 1) {
      if (!visited[index] && (currentIndex < 0 || costs[index] < costs[currentIndex])) currentIndex = index;
    }
    if (currentIndex < 0 || !Number.isFinite(costs[currentIndex])) break;
    if (currentIndex === toIndex) break;
    visited[currentIndex] = true;
    for (const edge of edges[currentIndex]) {
      const candidateCost = costs[currentIndex] + edge.cost;
      if (candidateCost < costs[edge.toIndex] - EPSILON) {
        costs[edge.toIndex] = candidateCost;
        previous[edge.toIndex] = currentIndex;
      }
    }
  }
  if (!Number.isFinite(costs[toIndex])) return null;

  const route: Vector[] = [];
  for (let index = toIndex; index >= 0; index = previous[index]) {
    route.push(nodes[index]);
    if (index === fromIndex) break;
  }
  route.reverse();
  return route.map(toPathPoint);
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
  currentStep: TraversalStep,
): TraversalEvaluation {
  const path = buildConnectorVectors(from, to, obstacles);
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    total += distance(path[index - 1], path[index]);
  }
  total += mownCrossingPenalty(path, mownCrossings);
  total += connectorTurnCost(path, currentStep, strip, reversed);
  total += Math.max(0, path.length - 2) * CONNECTOR_VERTEX_COST_METERS;

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

function connectorTurnCost(
  path: Vector[],
  currentStep: TraversalStep,
  candidate: MowingStrip,
  candidateReversed: boolean,
): number {
  if (path.length < 2) {
    return 0;
  }
  const currentStart = stripTraversalStart(currentStep.strip, currentStep.reversed);
  const currentEnd = stripTraversalEnd(currentStep.strip, currentStep.reversed);
  const candidateStart = stripTraversalStart(candidate, candidateReversed);
  const candidateEnd = stripTraversalEnd(candidate, candidateReversed);
  const exitHeading = Math.atan2(currentEnd.y - currentStart.y, currentEnd.x - currentStart.x);
  const connectorStartHeading = Math.atan2(path[1].y - path[0].y, path[1].x - path[0].x);
  const connectorEndHeading = Math.atan2(
    path[path.length - 1].y - path[path.length - 2].y,
    path[path.length - 1].x - path[path.length - 2].x,
  );
  const entryHeading = Math.atan2(candidateEnd.y - candidateStart.y, candidateEnd.x - candidateStart.x);
  return (
    absoluteAngleDifferenceRadians(exitHeading, connectorStartHeading)
    + absoluteAngleDifferenceRadians(connectorEndHeading, entryHeading)
  ) * TURN_COST_METERS_PER_RADIAN;
}

function absoluteAngleDifferenceRadians(left: number, right: number): number {
  let difference = right - left;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return Math.abs(difference);
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
