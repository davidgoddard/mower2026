import type { Pose2D } from "../estimation/estimatorTypes.js";
import type { SiteCaptureSample, SiteModel } from "../site/siteTypes.js";
import { candidateOrientationsDegrees } from "./orientationSearch.js";
import type { CoverageArea, CoverageLane, CoveragePlan, CoveragePlanMetrics } from "./coverageTypes.js";

export interface CoveragePlannerOptions {
  readonly stripeWidthMeters: number;
  readonly coarseStepDegrees: number;
}

const DEFAULT_OPTIONS: CoveragePlannerOptions = {
  stripeWidthMeters: 0.3,
  coarseStepDegrees: 15,
};

export class CoveragePlanner {
  private readonly options: CoveragePlannerOptions;

  public constructor(options?: Partial<CoveragePlannerOptions>) {
    this.options = {
      stripeWidthMeters: options?.stripeWidthMeters ?? DEFAULT_OPTIONS.stripeWidthMeters,
      coarseStepDegrees: options?.coarseStepDegrees ?? DEFAULT_OPTIONS.coarseStepDegrees,
    };
  }

  public plan(site: SiteModel): CoveragePlan {
    const warnings = [...site.warnings.map((warning) => warning.message)];

    const perimeter = uniqueVertices(site.perimeter.simplifiedPoints);
    const obstacles = site.obstacles.map((obstacle) => uniqueVertices(obstacle.simplifiedPoints));
    const candidateAngles = candidateOrientationsDegrees(site, {
      coarseStepDegrees: this.options.coarseStepDegrees,
    });

    let bestArea: CoverageArea | undefined;
    let bestMetrics: CoveragePlanMetrics | undefined;

    for (const angleDegrees of candidateAngles) {
      const area = buildCoverageArea(site, perimeter, obstacles, angleDegrees, this.options.stripeWidthMeters);
      const metrics = scoreArea(area, angleDegrees);
      if (bestMetrics === undefined || metrics.score > bestMetrics.score) {
        bestArea = area;
        bestMetrics = metrics;
      }
    }

    if (bestArea === undefined || bestMetrics === undefined) {
      throw new Error("Unable to generate a coverage plan.");
    }

    return {
      site,
      generatedAtMillis: Date.now(),
      areas: [bestArea],
      metrics: bestMetrics,
      warnings,
    };
  }
}

function buildCoverageArea(
  site: SiteModel,
  perimeter: readonly SiteCaptureSample[],
  obstacles: readonly (readonly SiteCaptureSample[])[],
  angleDegrees: number,
  stripeWidthMeters: number,
): CoverageArea {
  const rotated = perimeter.map((point) => rotatePoint(point, -angleDegrees));
  const rotatedObstacles = obstacles.map((obstacle) => obstacle.map((point) => rotatePoint(point, -angleDegrees)));
  const verticalCoordinates = [
    ...rotated.map((point) => point.yMeters),
    ...rotatedObstacles.flatMap((obstacle) => obstacle.map((point) => point.yMeters)),
  ];
  const minY = Math.min(...verticalCoordinates);
  const maxY = Math.max(...verticalCoordinates);
  const laneSegments: CoverageLane[] = [];

  let laneIndex = 0;
  for (let stripeCenter = minY + (stripeWidthMeters / 2); stripeCenter <= maxY + 1e-6; stripeCenter += stripeWidthMeters) {
    const perimeterIntervals = buildIntervalsFromIntersections(scanlineIntersections(rotated, stripeCenter).sort((a, b) => a - b));
    const obstacleIntervals = rotatedObstacles.flatMap((obstacle) =>
      buildIntervalsFromIntersections(scanlineIntersections(obstacle, stripeCenter).sort((a, b) => a - b)),
    );
    const freeIntervals = subtractIntervals(perimeterIntervals, obstacleIntervals);

    for (const interval of freeIntervals) {
      const startRotated = { xMeters: interval.startX, yMeters: stripeCenter, headingDegrees: angleDegrees };
      const endRotated = { xMeters: interval.endX, yMeters: stripeCenter, headingDegrees: angleDegrees };
      if ((endRotated.xMeters - startRotated.xMeters) < 0.05) {
        continue;
      }

      const start = rotatePoint(startRotated, angleDegrees);
      const end = rotatePoint(endRotated, angleDegrees);
      const travelForward = laneIndex % 2 === 0;
      const orientedStart = travelForward ? start : end;
      const orientedEnd = travelForward ? end : start;
      const headingDegreesForLane = travelForward ? normalizeHalfTurn(angleDegrees) : normalizeHalfTurn(angleDegrees + 180);

      laneSegments.push({
        id: `lane-${laneIndex + 1}`,
        start: {
          xMeters: orientedStart.xMeters,
          yMeters: orientedStart.yMeters,
          headingDegrees: headingDegreesForLane,
        },
        end: {
          xMeters: orientedEnd.xMeters,
          yMeters: orientedEnd.yMeters,
          headingDegrees: headingDegreesForLane,
        },
        lengthMeters: Math.hypot(orientedEnd.xMeters - orientedStart.xMeters, orientedEnd.yMeters - orientedStart.yMeters),
        headingDegrees: headingDegreesForLane,
      });
      laneIndex += 1;
    }
  }

  return {
    id: "area-1",
    orientationDegrees: angleDegrees,
    polygon: site.perimeter,
    lanes: laneSegments,
  };
}

function scoreArea(area: CoverageArea, candidateOrientationDegrees: number): CoveragePlanMetrics {
  const totalLaneLengthMeters = area.lanes.reduce((sum, lane) => sum + lane.lengthMeters, 0);
  const averageLaneLengthMeters = area.lanes.length === 0 ? 0 : totalLaneLengthMeters / area.lanes.length;
  const fragmentCount = area.lanes.length;
  const turnCount = Math.max(0, area.lanes.length - 1);
  const score = (totalLaneLengthMeters * 3) + averageLaneLengthMeters - (fragmentCount * 0.8) - (turnCount * 0.15);

  return {
    candidateOrientationDegrees,
    totalLaneLengthMeters,
    averageLaneLengthMeters,
    fragmentCount,
    turnCount,
    score,
  };
}

function scanlineIntersections(points: readonly Pose2D[], scanY: number): number[] {
  const intersections: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const minY = Math.min(current.yMeters, next.yMeters);
    const maxY = Math.max(current.yMeters, next.yMeters);
    if (scanY < minY || scanY >= maxY || current.yMeters === next.yMeters) {
      continue;
    }

    const fraction = (scanY - current.yMeters) / (next.yMeters - current.yMeters);
    intersections.push(current.xMeters + ((next.xMeters - current.xMeters) * fraction));
  }
  return intersections;
}

function buildIntervalsFromIntersections(intersections: readonly number[]): Array<{ startX: number; endX: number }> {
  const intervals: Array<{ startX: number; endX: number }> = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    intervals.push({
      startX: intersections[index]!,
      endX: intersections[index + 1]!,
    });
  }
  return intervals;
}

function subtractIntervals(
  baseIntervals: ReadonlyArray<{ startX: number; endX: number }>,
  subtractingIntervals: ReadonlyArray<{ startX: number; endX: number }>,
): Array<{ startX: number; endX: number }> {
  let remaining = [...baseIntervals];

  for (const subtracting of subtractingIntervals) {
    const next: Array<{ startX: number; endX: number }> = [];
    for (const interval of remaining) {
      if (subtracting.endX <= interval.startX || subtracting.startX >= interval.endX) {
        next.push(interval);
        continue;
      }
      if (subtracting.startX > interval.startX) {
        next.push({
          startX: interval.startX,
          endX: Math.min(subtracting.startX, interval.endX),
        });
      }
      if (subtracting.endX < interval.endX) {
        next.push({
          startX: Math.max(subtracting.endX, interval.startX),
          endX: interval.endX,
        });
      }
    }
    remaining = next.filter((interval) => (interval.endX - interval.startX) > 1e-6);
  }

  return remaining;
}

function rotatePoint(point: Pose2D, angleDegrees: number): Pose2D {
  const radians = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    xMeters: (point.xMeters * cos) - (point.yMeters * sin),
    yMeters: (point.xMeters * sin) + (point.yMeters * cos),
    headingDegrees: normalizeHalfTurn(point.headingDegrees + angleDegrees),
  };
}

function normalizeHalfTurn(degrees: number): number {
  let normalized = degrees % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return Number(normalized.toFixed(3));
}

function uniqueVertices(points: readonly SiteCaptureSample[]): SiteCaptureSample[] {
  if (points.length <= 1) {
    return [...points];
  }

  const last = points[points.length - 1]!;
  const first = points[0]!;
  const closed = first.xMeters === last.xMeters && first.yMeters === last.yMeters;
  return closed ? points.slice(0, -1) : [...points];
}
