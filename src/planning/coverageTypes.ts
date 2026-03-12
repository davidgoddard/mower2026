import type { Pose2D } from "../estimation/estimatorTypes.js";
import type { SiteModel } from "../site/siteTypes.js";

export interface CoverageLane {
  readonly id: string;
  readonly start: Pose2D;
  readonly end: Pose2D;
  readonly lengthMeters: number;
  readonly headingDegrees: number;
}

export interface CoverageArea {
  readonly id: string;
  readonly orientationDegrees: number;
  readonly polygon: SiteModel["perimeter"];
  readonly lanes: readonly CoverageLane[];
}

export interface CoveragePlanMetrics {
  readonly candidateOrientationDegrees: number;
  readonly totalLaneLengthMeters: number;
  readonly averageLaneLengthMeters: number;
  readonly fragmentCount: number;
  readonly turnCount: number;
  readonly score: number;
}

export interface CoveragePlan {
  readonly site: SiteModel;
  readonly generatedAtMillis: number;
  readonly areas: readonly CoverageArea[];
  readonly metrics: CoveragePlanMetrics;
  readonly warnings: readonly string[];
}

export interface MissionStartSelection {
  readonly laneId: string;
  readonly endpoint: "start" | "end";
  readonly approachPose: Pose2D;
  readonly distanceMeters: number;
  readonly headingPenaltyDegrees: number;
  readonly score: number;
}
