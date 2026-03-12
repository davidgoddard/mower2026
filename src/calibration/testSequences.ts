import type { CalibrationArea, CalibrationTrialDefinition } from "./calibrationTypes.js";

const DEFAULT_PROFILE = {
  speedScale: 1,
  turnScale: 1,
  lineGainScale: 1,
} as const;

export function buildCalibrationSequence(area: CalibrationArea): ReadonlyArray<CalibrationTrialDefinition> {
  const straightDistance = Math.min(area.straightRunDistanceMeters, area.safeRadiusMeters * 0.75);
  const arrivalDistance = Math.min(area.arrivalTargetDistanceMeters, area.safeRadiusMeters * 0.7);

  return [
    {
      id: "static-hold",
      stage: "static_sensing",
      motion: "hold",
      description: "Hold still to measure sensor drift and noise floors.",
      holdDurationMillis: 8_000,
      maxDurationMillis: 10_000,
      profile: DEFAULT_PROFILE,
    },
    {
      id: "spin-left-90",
      stage: "spin_left",
      motion: "spin",
      description: "Spin left by 90 degrees and observe overshoot and antenna excursion.",
      direction: "left",
      targetHeadingChangeDegrees: 90,
      maxDurationMillis: 12_000,
      profile: { ...DEFAULT_PROFILE, turnScale: 0.55 },
    },
    {
      id: "spin-right-90",
      stage: "spin_right",
      motion: "spin",
      description: "Spin right by 90 degrees and observe overshoot and antenna excursion.",
      direction: "right",
      targetHeadingChangeDegrees: -90,
      maxDurationMillis: 12_000,
      profile: { ...DEFAULT_PROFILE, turnScale: 0.55 },
    },
    {
      id: "spin-left-180",
      stage: "spin_left",
      motion: "spin",
      description: "Spin left by 180 degrees to measure larger-angle turn response.",
      direction: "left",
      targetHeadingChangeDegrees: 180,
      maxDurationMillis: 16_000,
      profile: { ...DEFAULT_PROFILE, turnScale: 0.65 },
    },
    {
      id: "spin-right-180",
      stage: "spin_right",
      motion: "spin",
      description: "Spin right by 180 degrees to measure larger-angle turn response.",
      direction: "right",
      targetHeadingChangeDegrees: -180,
      maxDurationMillis: 16_000,
      profile: { ...DEFAULT_PROFILE, turnScale: 0.65 },
    },
    {
      id: "straight-forward",
      stage: "straight_forward",
      motion: "drive_line",
      description: "Drive a straight forward line to measure cross-track bias and oscillation.",
      direction: "forward",
      distanceMeters: straightDistance,
      maxDurationMillis: 20_000,
      profile: { ...DEFAULT_PROFILE, speedScale: 0.6, lineGainScale: 1.0 },
    },
    {
      id: "straight-reverse",
      stage: "straight_reverse",
      motion: "drive_line",
      description: "Drive a straight reverse line to measure reverse asymmetry and bias.",
      direction: "reverse",
      distanceMeters: Math.min(straightDistance, Math.max(0.8, straightDistance * 0.8)),
      maxDurationMillis: 18_000,
      profile: { ...DEFAULT_PROFILE, speedScale: 0.5, lineGainScale: 1.0 },
    },
    {
      id: "arrival-forward",
      stage: "target_arrival",
      motion: "arrive_target",
      description: "Pivot and drive to a target position to measure combined arrival accuracy.",
      targetPose: {
        xMeters: arrivalDistance,
        yMeters: 0,
        headingDegrees: 0,
      },
      maxDurationMillis: 24_000,
      profile: { ...DEFAULT_PROFILE, speedScale: 0.55, turnScale: 0.55, lineGainScale: 1.0 },
    },
  ];
}
