export interface SiteCaptureSample {
  readonly xMeters: number;
  readonly yMeters: number;
  readonly headingDegrees: number;
  readonly timestampMillis: number;
}

export interface SitePolygon {
  readonly id: string;
  readonly kind: "perimeter" | "obstacle";
  readonly rawPoints: readonly SiteCaptureSample[];
  readonly simplifiedPoints: readonly SiteCaptureSample[];
  readonly rawAreaSquareMeters: number;
  readonly simplifiedAreaSquareMeters: number;
}

export interface SiteCaptureWarning {
  readonly code:
    | "PERIMETER_TOO_FEW_POINTS"
    | "PERIMETER_TOO_SMALL"
    | "OBSTACLE_TOO_FEW_POINTS"
    | "OBSTACLE_TOO_SMALL";
  readonly message: string;
  readonly polygonId?: string;
}

export interface SiteModel {
  readonly capturedAtMillis: number;
  readonly perimeter: SitePolygon;
  readonly obstacles: readonly SitePolygon[];
  readonly warnings: readonly SiteCaptureWarning[];
}

export interface CaptureSamplingThresholds {
  readonly minPointSpacingMeters: number;
  readonly minHeadingChangeDegrees: number;
  readonly maxSampleIntervalMillis: number;
}

export interface SiteCaptureRecorderOptions {
  readonly sampling: CaptureSamplingThresholds;
  readonly polygonSimplificationToleranceMeters: number;
  readonly minimumPolygonAreaSquareMeters: number;
}

export interface ActiveCaptureState {
  readonly kind: "perimeter" | "obstacle";
  readonly id: string;
  readonly points: readonly SiteCaptureSample[];
}

export interface SiteCaptureSnapshot {
  readonly perimeter: SitePolygon | undefined;
  readonly obstacles: readonly SitePolygon[];
  readonly activeCapture: ActiveCaptureState | undefined;
  readonly warnings: readonly SiteCaptureWarning[];
}

export interface SiteCaptureRecordResult {
  readonly recorded: boolean;
  readonly reason: "first_point" | "distance" | "heading" | "timeout" | "threshold_not_met" | "ignored_no_active_capture";
  readonly activeCapture: ActiveCaptureState | undefined;
}
