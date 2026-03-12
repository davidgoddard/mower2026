import type { PoseEstimate } from "../estimation/estimatorTypes.js";
import type { CoverageLane } from "../planning/coverageTypes.js";
import { targetHeadingDegrees } from "../guidance/lineGeometry.js";
import type { LaneMissionSequence } from "./missionTypes.js";

export function buildLaneMissionSequence(currentPose: PoseEstimate, lane: CoverageLane): LaneMissionSequence {
  const approachHeadingDegrees = targetHeadingDegrees({
    start: currentPose,
    end: lane.start,
  });

  return {
    lane,
    segments: [
      {
        id: "turn_to_start",
        kind: "turn",
        targetHeadingDegrees: approachHeadingDegrees,
      },
      {
        id: "drive_to_start",
        kind: "drive",
        line: {
          start: currentPose,
          end: lane.start,
        },
        targetPose: lane.start,
      },
      {
        id: "align_to_lane",
        kind: "turn",
        targetHeadingDegrees: lane.headingDegrees,
      },
      {
        id: "drive_lane",
        kind: "drive",
        line: {
          start: lane.start,
          end: lane.end,
        },
        targetPose: lane.end,
      },
      {
        id: "arrive_lane_end",
        kind: "arrive",
        targetPose: lane.end,
      },
    ],
  };
}
