import {
  MANUAL_TURN_DEADBAND_DEGREES,
  MANUAL_TURN_FULL_LOCK_DEGREES,
  MANUAL_SPEED_DEADBAND,
  MANUAL_TURN_DEADBAND,
  MANUAL_DRIVE_SPIN_THRESHOLD,
  MANUAL_DRIVE_SPIN_SPEED_THRESHOLD,
  MANUAL_DRIVE_MAX_INNER_WHEEL_TRIM,
  MANUAL_DRIVE_ARC_RESPONSE_EXPONENT,
  MANUAL_DRIVE_MIN_SPIN_SPEED_SCALE,
  MANUAL_DRIVE_MAX_SPIN_SPEED_SCALE,
  MANUAL_DRIVE_ARC_STRAIGHT_THRESHOLD,
  MANUAL_TURN_RESPONSE_EXPONENT,
} from "../constants.js";

// Normalized range constants (implementation details)
const NORMALIZED_MIN = 0;
const NORMALIZED_MAX = 1;
const SIGNED_NORMALIZED_MIN = -1;
const SIGNED_NORMALIZED_MAX = 1;

interface ManualDriveDemandInput {
  readonly speedDemand: number;
  readonly turnDemand: number;
  readonly maxWheelOutputPercent: number;
}

export interface ManualDriveDemand {
  readonly mode: "stopped" | "straight" | "arc" | "spin";
  readonly requestedLeftWheelOutputPercent: number;
  readonly requestedRightWheelOutputPercent: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(value: number, min: number, max: number): number {
  if (max <= min) {
    return 1;
  }

  return clamp((value - min) / (max - min), NORMALIZED_MIN, NORMALIZED_MAX);
}

export function normalizeManualTurnDemand(angleDegrees: number): number {
  const magnitudeDegrees = Math.abs(angleDegrees);

  if (magnitudeDegrees <= MANUAL_TURN_DEADBAND_DEGREES) {
    return 0;
  }

  const normalizedMagnitude = Math.max(
    NORMALIZED_MIN,
    Math.min(
      (magnitudeDegrees - MANUAL_TURN_DEADBAND_DEGREES) / (MANUAL_TURN_FULL_LOCK_DEGREES - MANUAL_TURN_DEADBAND_DEGREES),
      NORMALIZED_MAX,
    ),
  );

  return Math.sign(angleDegrees) * Math.pow(normalizedMagnitude, MANUAL_TURN_RESPONSE_EXPONENT);
}

export function computeManualDriveDemand(input: ManualDriveDemandInput): ManualDriveDemand {
  const speedDemand = clamp(input.speedDemand, SIGNED_NORMALIZED_MIN, SIGNED_NORMALIZED_MAX);
  const turnDemand = clamp(input.turnDemand, SIGNED_NORMALIZED_MIN, SIGNED_NORMALIZED_MAX);
  const maxWheelOutputPercent = clamp(input.maxWheelOutputPercent, SIGNED_NORMALIZED_MIN, SIGNED_NORMALIZED_MAX);

  if (Math.abs(speedDemand) < MANUAL_SPEED_DEADBAND && Math.abs(turnDemand) < MANUAL_TURN_DEADBAND) {
    return {
      mode: "stopped",
      requestedLeftWheelOutputPercent: 0,
      requestedRightWheelOutputPercent: 0,
    };
  }

  const turnMagnitude = Math.abs(turnDemand);
  if (
    turnMagnitude >= MANUAL_DRIVE_SPIN_THRESHOLD
    && Math.abs(speedDemand) <= MANUAL_DRIVE_SPIN_SPEED_THRESHOLD
  ) {
    const spinBlend = normalize(turnMagnitude, MANUAL_DRIVE_SPIN_THRESHOLD, NORMALIZED_MAX);
    const spinScale =
      MANUAL_DRIVE_MIN_SPIN_SPEED_SCALE
      + (MANUAL_DRIVE_MAX_SPIN_SPEED_SCALE - MANUAL_DRIVE_MIN_SPIN_SPEED_SCALE) * spinBlend;
    const spinOutputPercent = Math.sign(turnDemand) * maxWheelOutputPercent * spinScale;
    return {
      mode: "spin",
      requestedLeftWheelOutputPercent: -spinOutputPercent,
      requestedRightWheelOutputPercent: spinOutputPercent,
    };
  }

  const baseOutputPercent = speedDemand * maxWheelOutputPercent;
  const gentleTurn = turnMagnitude / MANUAL_DRIVE_SPIN_THRESHOLD;
  const innerWheelTrimFraction = MANUAL_DRIVE_MAX_INNER_WHEEL_TRIM * Math.pow(gentleTurn, MANUAL_DRIVE_ARC_RESPONSE_EXPONENT);
  const innerWheelOutputPercent = baseOutputPercent * (1 - innerWheelTrimFraction);

  if (turnDemand >= 0) {
    return {
      mode: turnMagnitude > MANUAL_DRIVE_ARC_STRAIGHT_THRESHOLD ? "arc" : "straight",
      requestedLeftWheelOutputPercent: innerWheelOutputPercent,
      requestedRightWheelOutputPercent: baseOutputPercent,
    };
  }

  return {
    mode: turnMagnitude > MANUAL_DRIVE_ARC_STRAIGHT_THRESHOLD ? "arc" : "straight",
    requestedLeftWheelOutputPercent: baseOutputPercent,
    requestedRightWheelOutputPercent: innerWheelOutputPercent,
  };
}
