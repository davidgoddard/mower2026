import { normalizeAngleDegrees } from "../util/angles.js";
import type {
  ActiveCaptureState,
  SiteCaptureRecordResult,
  SiteCaptureRecorderOptions,
  SiteCaptureSample,
  SiteCaptureSnapshot,
  SiteCaptureWarning,
  SiteModel,
  SitePolygon,
} from "./siteTypes.js";

const DEFAULT_OPTIONS: SiteCaptureRecorderOptions = {
  sampling: {
    minPointSpacingMeters: 0.15,
    minHeadingChangeDegrees: 8,
    maxSampleIntervalMillis: 2_000,
  },
  polygonSimplificationToleranceMeters: 0.05,
  minimumPolygonAreaSquareMeters: 0.25,
};

interface MutableCaptureState {
  kind: "perimeter" | "obstacle";
  id: string;
  points: SiteCaptureSample[];
}

export class SiteCaptureRecorder {
  private readonly options: SiteCaptureRecorderOptions;
  private activeCapture: MutableCaptureState | undefined;
  private perimeter: SitePolygon | undefined;
  private readonly obstacles: SitePolygon[] = [];
  private nextPolygonIndex = 1;

  public constructor(options?: Partial<SiteCaptureRecorderOptions>) {
    this.options = {
      sampling: {
        minPointSpacingMeters: options?.sampling?.minPointSpacingMeters ?? DEFAULT_OPTIONS.sampling.minPointSpacingMeters,
        minHeadingChangeDegrees:
          options?.sampling?.minHeadingChangeDegrees ?? DEFAULT_OPTIONS.sampling.minHeadingChangeDegrees,
        maxSampleIntervalMillis:
          options?.sampling?.maxSampleIntervalMillis ?? DEFAULT_OPTIONS.sampling.maxSampleIntervalMillis,
      },
      polygonSimplificationToleranceMeters:
        options?.polygonSimplificationToleranceMeters ?? DEFAULT_OPTIONS.polygonSimplificationToleranceMeters,
      minimumPolygonAreaSquareMeters:
        options?.minimumPolygonAreaSquareMeters ?? DEFAULT_OPTIONS.minimumPolygonAreaSquareMeters,
    };
  }

  public startPerimeter(): ActiveCaptureState {
    this.ensureNoActiveCapture();
    const capture = this.createCapture("perimeter");
    this.activeCapture = capture;
    return this.toActiveCaptureState(capture);
  }

  public startObstacle(): ActiveCaptureState {
    this.ensureNoActiveCapture();
    if (this.perimeter === undefined) {
      throw new Error("Complete the perimeter before starting an obstacle.");
    }
    const capture = this.createCapture("obstacle");
    this.activeCapture = capture;
    return this.toActiveCaptureState(capture);
  }

  public recordSample(sample: SiteCaptureSample): SiteCaptureRecordResult {
    if (this.activeCapture === undefined) {
      return {
        recorded: false,
        reason: "ignored_no_active_capture",
        activeCapture: undefined,
      };
    }

    const reason = this.sampleReason(this.activeCapture.points, sample);
    if (reason === undefined) {
      return {
        recorded: false,
        reason: "threshold_not_met",
        activeCapture: this.toActiveCaptureState(this.activeCapture),
      };
    }

    this.activeCapture.points.push(sample);
    return {
      recorded: true,
      reason,
      activeCapture: this.toActiveCaptureState(this.activeCapture),
    };
  }

  public undoLastPoint(): ActiveCaptureState | undefined {
    if (this.activeCapture === undefined) {
      return undefined;
    }
    this.activeCapture.points.pop();
    return this.toActiveCaptureState(this.activeCapture);
  }

  public discardCurrentObstacle(): SiteCaptureSnapshot {
    if (this.activeCapture?.kind !== "obstacle") {
      throw new Error("No obstacle capture is active.");
    }
    this.activeCapture = undefined;
    return this.snapshot();
  }

  public finishObstacle(): SitePolygon {
    if (this.activeCapture?.kind !== "obstacle") {
      throw new Error("No obstacle capture is active.");
    }
    const polygon = this.finalizeActiveCapture();
    this.obstacles.push(polygon);
    return polygon;
  }

  public finishPerimeter(): SitePolygon {
    if (this.activeCapture?.kind !== "perimeter") {
      throw new Error("No perimeter capture is active.");
    }
    this.perimeter = this.finalizeActiveCapture();
    return this.perimeter;
  }

  public finishCapture(capturedAtMillis: number): SiteModel {
    if (this.activeCapture?.kind === "perimeter") {
      this.perimeter = this.finishPerimeter();
    } else if (this.activeCapture !== undefined) {
      throw new Error("Finish the active obstacle before finishing the site capture.");
    }

    if (this.perimeter === undefined) {
      throw new Error("Perimeter capture has not been completed.");
    }

    return {
      capturedAtMillis,
      perimeter: this.perimeter,
      obstacles: [...this.obstacles],
      warnings: this.buildWarnings(this.perimeter, this.obstacles),
    };
  }

  public discardCapture(): void {
    this.activeCapture = undefined;
    this.perimeter = undefined;
    this.obstacles.length = 0;
    this.nextPolygonIndex = 1;
  }

  public snapshot(): SiteCaptureSnapshot {
    return {
      perimeter: this.perimeter,
      obstacles: [...this.obstacles],
      activeCapture: this.activeCapture === undefined ? undefined : this.toActiveCaptureState(this.activeCapture),
      warnings: this.perimeter === undefined ? [] : this.buildWarnings(this.perimeter, this.obstacles),
    };
  }

  private ensureNoActiveCapture(): void {
    if (this.activeCapture !== undefined) {
      throw new Error("Finish or discard the current capture before starting a new one.");
    }
  }

  private createCapture(kind: "perimeter" | "obstacle"): MutableCaptureState {
    const id = `${kind}-${this.nextPolygonIndex}`;
    this.nextPolygonIndex += 1;
    return {
      kind,
      id,
      points: [],
    };
  }

  private sampleReason(points: readonly SiteCaptureSample[], sample: SiteCaptureSample): SiteCaptureRecordResult["reason"] | undefined {
    const last = points[points.length - 1];
    if (last === undefined) {
      return "first_point";
    }

    const distanceMeters = Math.hypot(sample.xMeters - last.xMeters, sample.yMeters - last.yMeters);
    if (distanceMeters >= this.options.sampling.minPointSpacingMeters) {
      return "distance";
    }

    const headingChangeDegrees = Math.abs(normalizeAngleDegrees(sample.headingDegrees - last.headingDegrees));
    if (headingChangeDegrees >= this.options.sampling.minHeadingChangeDegrees) {
      return "heading";
    }

    const elapsedMillis = sample.timestampMillis - last.timestampMillis;
    if (elapsedMillis >= this.options.sampling.maxSampleIntervalMillis) {
      return "timeout";
    }

    return undefined;
  }

  private finalizeActiveCapture(): SitePolygon {
    if (this.activeCapture === undefined) {
      throw new Error("No capture is active.");
    }

    const polygon = this.buildPolygon(this.activeCapture.id, this.activeCapture.kind, this.activeCapture.points);
    this.activeCapture = undefined;
    return polygon;
  }

  private buildPolygon(
    id: string,
    kind: "perimeter" | "obstacle",
    samples: readonly SiteCaptureSample[],
  ): SitePolygon {
    const uniquePoints = collapseConsecutiveDuplicates(samples);
    const closedRawPoints = closePolygon(uniquePoints);
    const simplifiedPoints = closePolygon(
      simplifyPolygon(uniquePoints, this.options.polygonSimplificationToleranceMeters),
    );

    return {
      id,
      kind,
      rawPoints: closedRawPoints,
      simplifiedPoints,
      rawAreaSquareMeters: polygonAreaSquareMeters(closedRawPoints),
      simplifiedAreaSquareMeters: polygonAreaSquareMeters(simplifiedPoints),
    };
  }

  private buildWarnings(perimeter: SitePolygon, obstacles: readonly SitePolygon[]): SiteCaptureWarning[] {
    const warnings: SiteCaptureWarning[] = [];
    this.appendPolygonWarnings(warnings, perimeter);
    for (const obstacle of obstacles) {
      this.appendPolygonWarnings(warnings, obstacle);
    }
    return warnings;
  }

  private appendPolygonWarnings(warnings: SiteCaptureWarning[], polygon: SitePolygon): void {
    const minimumCode = polygon.kind === "perimeter" ? "PERIMETER_TOO_FEW_POINTS" : "OBSTACLE_TOO_FEW_POINTS";
    const areaCode = polygon.kind === "perimeter" ? "PERIMETER_TOO_SMALL" : "OBSTACLE_TOO_SMALL";
    const pointCount = countDistinctVertices(polygon.simplifiedPoints);

    if (pointCount < 3) {
      warnings.push({
        code: minimumCode,
        polygonId: polygon.id,
        message: `${polygon.kind} requires at least three distinct points.`,
      });
    }

    if (polygon.simplifiedAreaSquareMeters < this.options.minimumPolygonAreaSquareMeters) {
      warnings.push({
        code: areaCode,
        polygonId: polygon.id,
        message: `${polygon.kind} area is below the minimum usable threshold.`,
      });
    }
  }

  private toActiveCaptureState(capture: MutableCaptureState): ActiveCaptureState {
    return {
      kind: capture.kind,
      id: capture.id,
      points: [...capture.points],
    };
  }
}

function collapseConsecutiveDuplicates(points: readonly SiteCaptureSample[]): SiteCaptureSample[] {
  const collapsed: SiteCaptureSample[] = [];
  for (const point of points) {
    const previous = collapsed[collapsed.length - 1];
    if (
      previous !== undefined &&
      previous.xMeters === point.xMeters &&
      previous.yMeters === point.yMeters
    ) {
      continue;
    }
    collapsed.push(point);
  }
  return collapsed;
}

function closePolygon(points: readonly SiteCaptureSample[]): SiteCaptureSample[] {
  if (points.length === 0) {
    return [];
  }
  if (points.length === 1) {
    return [points[0]!, points[0]!];
  }

  const closed = [...points];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first.xMeters !== last.xMeters || first.yMeters !== last.yMeters) {
    closed.push(first);
  }
  return closed;
}

function simplifyPolygon(points: readonly SiteCaptureSample[], toleranceMeters: number): SiteCaptureSample[] {
  if (points.length <= 3) {
    return [...points];
  }

  const simplified = [...points];
  let removedPoint = true;
  while (removedPoint && simplified.length > 3) {
    removedPoint = false;
    for (let index = 0; index < simplified.length; index += 1) {
      const previous = simplified[(index - 1 + simplified.length) % simplified.length]!;
      const current = simplified[index]!;
      const next = simplified[(index + 1) % simplified.length]!;
      const distance = pointToSegmentDistanceMeters(current, previous, next);
      if (distance <= toleranceMeters) {
        simplified.splice(index, 1);
        removedPoint = true;
        break;
      }
    }
  }
  return simplified;
}

function pointToSegmentDistanceMeters(
  point: SiteCaptureSample,
  start: SiteCaptureSample,
  end: SiteCaptureSample,
): number {
  const dx = end.xMeters - start.xMeters;
  const dy = end.yMeters - start.yMeters;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared === 0) {
    return Math.hypot(point.xMeters - start.xMeters, point.yMeters - start.yMeters);
  }

  const projection =
    (((point.xMeters - start.xMeters) * dx) + ((point.yMeters - start.yMeters) * dy)) / lengthSquared;
  const clampedProjection = Math.min(Math.max(projection, 0), 1);
  const closestX = start.xMeters + (clampedProjection * dx);
  const closestY = start.yMeters + (clampedProjection * dy);
  return Math.hypot(point.xMeters - closestX, point.yMeters - closestY);
}

function polygonAreaSquareMeters(points: readonly SiteCaptureSample[]): number {
  if (points.length < 4) {
    return 0;
  }

  let twiceArea = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    twiceArea += (current.xMeters * next.yMeters) - (next.xMeters * current.yMeters);
  }
  return Math.abs(twiceArea) / 2;
}

function countDistinctVertices(points: readonly SiteCaptureSample[]): number {
  if (points.length === 0) {
    return 0;
  }
  const last = points[points.length - 1]!;
  const duplicateClosure =
    points.length > 1 &&
    points[0]!.xMeters === last.xMeters &&
    points[0]!.yMeters === last.yMeters;
  return duplicateClosure ? points.length - 1 : points.length;
}
