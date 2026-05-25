import { PathPoint } from "./pathFollowerApi.js";

export interface MowingStrip {
  readonly start: PathPoint;
  readonly end: PathPoint;
  readonly centerOffsetMeters: number;
  readonly sequenceIndex: number;
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
  readonly obstacles?: ReadonlyArray<ReadonlyArray<PathPoint>>;
}

const DEFAULT_STRIP_SPACING_METERS = 0.3;
const DEFAULT_BLADE_WIDTH_METERS = 0.4;
const EPSILON = 1e-9;

interface Vector {
  readonly x: number;
  readonly y: number;
}

interface Intersection {
  readonly along: number;
  readonly point: Vector;
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
  if (!Number.isFinite(stripSpacingMeters) || stripSpacingMeters <= 0) {
    throw new Error("strip_spacing_must_be_positive");
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
    .map((obstacle) => normalizePolygon(obstacle))
    .filter((obstacle) => obstacle.length >= 3);
  const strips: MowingStrip[] = [];

  for (let offset = firstOffset; offset <= maxOffset + EPSILON; offset += stripSpacingMeters) {
    const areaIntervals = buildLineIntervals(polygon, direction, normal, offset);
    const obstacleIntervals = obstacles.flatMap((obstacle) => buildLineIntervals(obstacle, direction, normal, offset));
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
        centerOffsetMeters: offset,
        sequenceIndex: strips.length,
      });
    }
  }

  const traversal = sequenceStripsForMowing(strips, direction, obstacles);
  const sequencedStrips = traversal.map((step, index) => ({
    ...step.strip,
    sequenceIndex: index,
  }));
  const connectors = buildStripConnectors(traversal, obstacles);

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
): Intersection[] {
  const intersections: Intersection[] = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentOffset = dot(current, normal) - offset;
    const nextOffset = dot(next, normal) - offset;

    if (Math.abs(currentOffset) <= EPSILON && Math.abs(nextOffset) <= EPSILON) {
      addUniqueIntersection(intersections, current, direction);
      addUniqueIntersection(intersections, next, direction);
      continue;
    }

    if (Math.abs(currentOffset) <= EPSILON) {
      addUniqueIntersection(intersections, current, direction);
      continue;
    }

    if (currentOffset * nextOffset < 0 || Math.abs(nextOffset) <= EPSILON) {
      const t = currentOffset / (currentOffset - nextOffset);
      const point = {
        x: current.x + ((next.x - current.x) * t),
        y: current.y + ((next.y - current.y) * t),
      };
      addUniqueIntersection(intersections, point, direction);
    }
  }

  return intersections.sort((a, b) => a.along - b.along);
}

function buildLineIntervals(
  polygon: Vector[],
  direction: Vector,
  normal: Vector,
  offset: number,
): Interval[] {
  const intersections = findLinePolygonIntersections(polygon, direction, normal, offset);
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
      end: interpolateIntersection(clear.start, clear.end, start),
    });
  }
  if (clear.end.along - end > EPSILON) {
    intervals.push({
      start: interpolateIntersection(clear.start, clear.end, end),
      end: clear.end,
    });
  }

  return intervals;
}

function interpolateIntersection(start: Intersection, end: Intersection, along: number): Intersection {
  const span = end.along - start.along;
  if (Math.abs(span) <= EPSILON) {
    return start;
  }

  const t = (along - start.along) / span;
  return {
    along,
    point: {
      x: start.point.x + ((end.point.x - start.point.x) * t),
      y: start.point.y + ((end.point.y - start.point.y) * t),
    },
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
  let currentPoint: Vector | null = null;

  if (remaining.length === 0) {
    return traversal;
  }

  const firstOffset = offsets[0];
  const firstCandidates = remaining.filter((strip) => Math.abs(strip.centerOffsetMeters - firstOffset) <= EPSILON);
  const firstStrip = firstCandidates.sort((a, b) => dot(stripTraversalStart(b, false), direction) - dot(stripTraversalStart(a, false), direction))[0];
  traversal.push({ strip: firstStrip, reversed: false });
  removeStrip(remaining, firstStrip);
  currentPoint = stripTraversalEnd(firstStrip, false);

  while (remaining.length > 0 && currentPoint !== null) {
    let bestIndex = 0;
    let bestReversed = false;
    let bestCost = Infinity;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      for (const reversed of [false, true] as const) {
        const candidateStart = stripTraversalStart(candidate, reversed);
        const cost = connectorCost(currentPoint, candidateStart, obstacles);
        if (cost < bestCost - EPSILON || (Math.abs(cost - bestCost) <= EPSILON && preferCandidate(candidate, reversed, remaining[bestIndex], bestReversed, direction))) {
          bestCost = cost;
          bestIndex = index;
          bestReversed = reversed;
        }
      }
    }

    const nextStrip = remaining[bestIndex];
    traversal.push({ strip: nextStrip, reversed: bestReversed });
    currentPoint = stripTraversalEnd(nextStrip, bestReversed);
    remaining.splice(bestIndex, 1);
  }

  return traversal;
}

function buildStripConnectors(traversal: TraversalStep[], obstacles: Vector[][]): PathPoint[][] {
  const connectors: PathPoint[][] = [];

  for (let index = 0; index < traversal.length - 1; index += 1) {
    const currentEnd = stripTraversalEnd(traversal[index].strip, traversal[index].reversed);
    const nextStart = stripTraversalStart(traversal[index + 1].strip, traversal[index + 1].reversed);
    const routedObstacle = obstacles.find((obstacle) => segmentIntersectsPolygon(currentEnd, nextStart, obstacle));
    if (routedObstacle) {
      connectors.push(buildObstaclePerimeterConnector(currentEnd, nextStart, routedObstacle));
    } else {
      connectors.push([toPathPoint(currentEnd), toPathPoint(nextStart)]);
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

function buildObstaclePerimeterConnector(from: Vector, to: Vector, obstacle: Vector[]): PathPoint[] {
  const fromIndex = findNearestVertexIndex(obstacle, from);
  const toIndex = findNearestVertexIndex(obstacle, to);
  const forward = walkObstacleVertices(obstacle, fromIndex, toIndex, 1);
  const reverse = walkObstacleVertices(obstacle, fromIndex, toIndex, -1);
  const chosen = pathLength(forward) <= pathLength(reverse) ? forward : reverse;

  return [
    toPathPoint(from),
    ...chosen.map(toPathPoint),
    toPathPoint(to),
  ];
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

function pathLength(points: Vector[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
  }
  return total;
}

function connectorCost(from: Vector, to: Vector, obstacles: Vector[][]): number {
  const obstacle = obstacles.find((candidate) => segmentIntersectsPolygon(from, to, candidate));
  if (!obstacle) {
    return distance(from, to);
  }

  const connector = buildObstaclePerimeterConnector(from, to, obstacle);
  let total = 0;
  for (let index = 1; index < connector.length; index += 1) {
    total += distance(
      { x: connector[index - 1].xMeters, y: connector[index - 1].yMeters },
      { x: connector[index].xMeters, y: connector[index].yMeters },
    );
  }

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

function addUniqueIntersection(intersections: Intersection[], point: Vector, direction: Vector): void {
  const along = dot(point, direction);
  if (intersections.some((existing) => distance(existing.point, point) <= 1e-7)) {
    return;
  }

  intersections.push({ along, point });
}

function dot(a: Vector, b: Vector): number {
  return (a.x * b.x) + (a.y * b.y);
}

function distance(a: Vector, b: Vector): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
