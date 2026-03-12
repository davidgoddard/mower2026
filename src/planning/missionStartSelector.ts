import type { PoseEstimate } from "../estimation/estimatorTypes.js";
import { normalizeAngleDegrees } from "../util/angles.js";
import type { CoverageLane, CoveragePlan, MissionStartSelection } from "./coverageTypes.js";

export interface MissionStartSelectorOptions {
  readonly headingPenaltyPerDegree: number;
}

const DEFAULT_OPTIONS: MissionStartSelectorOptions = {
  headingPenaltyPerDegree: 0.02,
};

export class MissionStartSelector {
  private readonly options: MissionStartSelectorOptions;

  public constructor(options?: Partial<MissionStartSelectorOptions>) {
    this.options = {
      headingPenaltyPerDegree: options?.headingPenaltyPerDegree ?? DEFAULT_OPTIONS.headingPenaltyPerDegree,
    };
  }

  public select(plan: CoveragePlan, currentPose: PoseEstimate): MissionStartSelection {
    const lanes = plan.areas.flatMap((area) => area.lanes);
    if (lanes.length === 0) {
      throw new Error("Coverage plan has no lanes.");
    }

    let best: MissionStartSelection | undefined;
    for (const lane of lanes) {
      for (const endpoint of ["start", "end"] as const) {
        const candidate = this.scoreCandidate(lane, endpoint, currentPose);
        if (best === undefined || candidate.score < best.score) {
          best = candidate;
        }
      }
    }

    return best!;
  }

  private scoreCandidate(
    lane: CoverageLane,
    endpoint: "start" | "end",
    currentPose: PoseEstimate,
  ): MissionStartSelection {
    const approachPose = endpoint === "start" ? lane.start : lane.end;
    const distanceMeters = Math.hypot(
      approachPose.xMeters - currentPose.xMeters,
      approachPose.yMeters - currentPose.yMeters,
    );
    const headingPenaltyDegrees = Math.abs(normalizeAngleDegrees(approachPose.headingDegrees - currentPose.headingDegrees));
    const score = distanceMeters + (headingPenaltyDegrees * this.options.headingPenaltyPerDegree);

    return {
      laneId: lane.id,
      endpoint,
      approachPose,
      distanceMeters,
      headingPenaltyDegrees,
      score,
    };
  }
}
