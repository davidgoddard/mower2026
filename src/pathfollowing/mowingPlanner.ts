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

export function buildMowingPlan(points: PathPoint[], options: MowingPlanOptions): MowingPlan {
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
  if (polygon.length < 3) {
    return {
      headingDeg: normalizeAxisHeading(options.headingDeg),
      stripSpacingMeters,
      bladeWidthMeters,
      stripCount: 0,
      strips: [],
      connectors: [],
    };
  }

  const headingDeg = normalizeAxisHeading(options.headingDeg);
  const headingRadians = (headingDeg * Math.PI) / 180;
  const direction = { x: Math.cos(headingRadians), y: Math.sin(headingRadians) };
  const normal = { x: -direction.y, y: direction.x };
  const projectedOffsets = polygon.map((point) => dot(point, normal));
  const minOffset = Math.min(...projectedOffsets);
  const maxOffset = Math.max(...projectedOffsets);
  const firstOffset = Math.ceil((minOffset - EPSILON) / stripSpacingMeters) * stripSpacingMeters;
  const obstacles = (options.obstacles ?? [])
    .map((obstacle, obstacleIndex) => ({
      obstacleIndex,
      polygon: normalizePolygon(obstacle),
    }))
    .filter((obstacle) => obstacle.polygon.length >= 3);
  const strips: MowingStrip[] = [];

  for (let offset = firstOffset; offset <= maxOffset + EPSILON; offset += stripSpacingMeters) {
    const areaIntervals = buildLineIntervals(polygon, direction, normal, offset, { kind: "area" });
    const obstacleIntervals = obstacles.flatMap((obstacle) => buildLineIntervals(
      obstacle.polygon,
      direction,
      normal,
      offset,
      { kind: "obstacle", obstacleIndex: obstacle.obstacleIndex },
    ));
    const clearIntervals = areaIntervals.flatMap((interval) => subtractIntervals(interval, obstacleIntervals));

    for (const interval of clearIntervals) {
      const start = interval.start;
      const end = interval.end;
      if (distance(start.point, end.point) <= EPSILON) {
        continue;
      }

      const capturedAt = Date.now();
      strips.push({
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
        sequenceIndex: strips.length,
        traversalReversed: false,
      });
    }
  }

  const obstaclePolygons = obstacles.map((obstacle) => obstacle.polygon);
  const traversal = reanchorTraversalToPreferredStart(
    sequenceStripsForMowing(strips, direction, obstaclePolygons),
    options.preferredStartPoint,
  );
  const sequencedStrips = traversal.map((step, index) => ({
    ...step.strip,
    sequenceIndex: index,
    traversalReversed: step.reversed,
  }));
  const connectors = buildStripConnectors(traversal, polygon, obstaclePolygons, mowingStandoffMeters);

  return {
    headingDeg,
    stripSpacingMeters,
    bladeWidthMeters,
    stripCount: sequencedStrips.length,
    strips: sequencedStrips,
    connectors,
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
  let bestPlan: MowingInitialEntryPlan | null = null;

  for (let segmentIndex = 0; segmentIndex < areaPolygon.length; segmentIndex += 1) {
    const segmentStart = areaPolygon[segmentIndex];
    const segmentEnd = areaPolygon[(segmentIndex + 1) % areaPolygon.length];
    const entry = nearestPointOnSegment(current, segmentStart, segmentEnd);
    if (!isAreaEntryLineOfSight(current, entry, areaPolygon, obstacles)) {
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
): TraversalStep[] {
  const offsets = [...new Set(strips.map((strip) => strip.centerOffsetMeters))].sort((a, b) => a - b);
  const remaining = strips.slice();
  const traversal: TraversalStep[] = [];
  const mownCrossings = new Map<MowingStrip, number>();
  let currentPoint: Vector | null = null;
  let lockedOffsetDirection: -1 | 1 | null = null;

  if (remaining.length === 0) {
    return traversal;
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
    const bestStep = chooseBestTraversalStep(candidates, currentPoint, direction, obstacles, mownCrossings);
    const nextStrip = bestStep.strip;
    const nextOffsetDelta = nextStrip.centerOffsetMeters - currentOffset;
    if (lockedOffsetDirection === null && Math.abs(nextOffsetDelta) > EPSILON) {
      lockedOffsetDirection = nextOffsetDelta > 0 ? 1 : -1;
    }

    const connectorPath = buildConnectorVectors(currentPoint, stripTraversalStart(nextStrip, bestStep.reversed), obstacles);
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

    traversal.push(bestStep);
    mownCrossings.set(nextStrip, 0);
    currentPoint = stripTraversalEnd(nextStrip, bestStep.reversed);
    removeStrip(remaining, nextStrip);
  }

  return traversal;
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
    return sameOffset;
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
  direction: Vector,
  obstacles: Vector[][],
  mownCrossings: ReadonlyMap<MowingStrip, number>,
): TraversalStep {
  let bestStep: TraversalStep | null = null;
  let bestCost = Infinity;

  for (const candidate of candidates) {
    for (const reversed of [false, true] as const) {
      const candidateStart = stripTraversalStart(candidate, reversed);
      const cost = connectorCost(currentPoint, candidateStart, obstacles, mownCrossings);
      if (cost < bestCost - EPSILON || (Math.abs(cost - bestCost) <= EPSILON && (!bestStep || preferCandidate(candidate, reversed, bestStep.strip, bestStep.reversed, direction)))) {
        bestStep = { strip: candidate, reversed };
        bestCost = cost;
      }
    }
  }

  if (!bestStep) {
    throw new Error("mowing_plan_has_no_next_strip");
  }
  return bestStep;
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
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let index = 0; index < traversal.length; index += 1) {
    const step = traversal[index];
    const start = stripTraversalStart(step.strip, step.reversed);
    const currentDistance = distance(preferred, start);
    if (currentDistance < bestDistance - EPSILON) {
      bestDistance = currentDistance;
      bestIndex = index;
    }
  }

  return traversal.slice(bestIndex).concat(traversal.slice(0, bestIndex));
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

    if (sameBoundary(currentEndBoundary, nextStartBoundary)) {
      connectors.push(buildBoundaryStandoffConnector(
        currentEnd,
        nextStart,
        currentEndStandoff,
        nextStartStandoff,
        boundaryPolygon(currentEndBoundary, areaPolygon, obstacles),
        currentEndBoundary,
      ));
      continue;
    }

    const routedObstacle = obstacles.find((obstacle) => segmentIntersectsPolygon(currentEndStandoff, nextStartStandoff, obstacle));
    if (routedObstacle) {
      connectors.push(buildObstaclePerimeterConnector(currentEndStandoff, nextStartStandoff, routedObstacle, mowingStandoffMeters));
    } else {
      connectors.push([toPathPoint(currentEndStandoff), toPathPoint(nextStartStandoff)]);
    }
  }

  return connectors;
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
  const segment = { x: end.x - start.x, y: end.y - start.y };
  const lengthSquared = dot(segment, segment);
  if (lengthSquared <= EPSILON) {
    return start;
  }

  const t = Math.max(0, Math.min(1, dot({ x: point.x - start.x, y: point.y - start.y }, segment) / lengthSquared));
  return {
    x: start.x + (segment.x * t),
    y: start.y + (segment.y * t),
  };
}

function isAreaEntryLineOfSight(current: Vector, entry: Vector, areaPolygon: Vector[], obstacles: Vector[][]): boolean {
  if (obstacles.some((obstacle) => segmentIntersectsPolygon(current, entry, obstacle))) {
    return false;
  }

  if (areaApproachCrossesBoundary(current, entry, areaPolygon)) {
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

function connectorCost(from: Vector, to: Vector, obstacles: Vector[][], mownCrossings: ReadonlyMap<MowingStrip, number>): number {
  const path = buildConnectorVectors(from, to, obstacles);
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    total += distance(path[index - 1], path[index]);
  }
  total += mownCrossingPenalty(path, mownCrossings);
  return total;
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

function normalise(v: Vector): Vector {
  const len = Math.hypot(v.x, v.y);
  return len < EPSILON ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}

function distance(a: Vector, b: Vector): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
