interface ManualDriveDemandInput {
  readonly speedDemand: number;
  readonly turnDemand: number;
  readonly maxWheelSpeedMetersPerSecond: number;
}

export interface ManualDriveDemand {
  readonly mode: "stopped" | "straight" | "arc" | "spin";
  readonly requestedLeftMetersPerSecond: number;
  readonly requestedRightMetersPerSecond: number;
}

const MANUAL_DRIVE_SPIN_THRESHOLD = 0.995;
const MANUAL_DRIVE_SPIN_SPEED_DEMAND_THRESHOLD = 0.15;
const MANUAL_DRIVE_MAX_INNER_WHEEL_TRIM = 0.50;
const MANUAL_DRIVE_ARC_RESPONSE_EXPONENT = 1.15;
const MANUAL_DRIVE_MIN_SPIN_SPEED_SCALE = 0.22;
const MANUAL_DRIVE_MAX_SPIN_SPEED_SCALE = 0.65;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(value: number, min: number, max: number): number {
  if (max <= min) {
    return 1;
  }

  return clamp((value - min) / (max - min), 0, 1);
}

export function normalizeManualTurnDemand(angleDegrees: number): number {
  const deadbandDegrees = 6;
  const fullLockDegrees = 84;
  const magnitudeDegrees = Math.abs(angleDegrees);

  if (magnitudeDegrees <= deadbandDegrees) {
    return 0;
  }

  const normalizedMagnitude = Math.max(
    0,
    Math.min((magnitudeDegrees - deadbandDegrees) / (fullLockDegrees - deadbandDegrees), 1),
  );

  return Math.sign(angleDegrees) * Math.pow(normalizedMagnitude, 2);
}

export function computeManualDriveDemand(input: ManualDriveDemandInput): ManualDriveDemand {
  const speedDemand = clamp(input.speedDemand, -1, 1);
  const turnDemand = clamp(input.turnDemand, -1, 1);
  const maxWheelSpeed = input.maxWheelSpeedMetersPerSecond;

  if (Math.abs(speedDemand) < 0.05 && Math.abs(turnDemand) < 0.05) {
    return {
      mode: "stopped",
      requestedLeftMetersPerSecond: 0,
      requestedRightMetersPerSecond: 0,
    };
  }

  const turnMagnitude = Math.abs(turnDemand);
  if (
    turnMagnitude >= MANUAL_DRIVE_SPIN_THRESHOLD
    && Math.abs(speedDemand) <= MANUAL_DRIVE_SPIN_SPEED_DEMAND_THRESHOLD
  ) {
    const spinBlend = normalize(turnMagnitude, MANUAL_DRIVE_SPIN_THRESHOLD, 1);
    const spinScale =
      MANUAL_DRIVE_MIN_SPIN_SPEED_SCALE
      + (MANUAL_DRIVE_MAX_SPIN_SPEED_SCALE - MANUAL_DRIVE_MIN_SPIN_SPEED_SCALE) * spinBlend;
    const spinSpeed = Math.sign(turnDemand) * maxWheelSpeed * spinScale;
    return {
      mode: "spin",
      requestedLeftMetersPerSecond: -spinSpeed,
      requestedRightMetersPerSecond: spinSpeed,
    };
  }

  const baseSpeed = speedDemand * maxWheelSpeed;
  const gentleTurn = turnMagnitude / MANUAL_DRIVE_SPIN_THRESHOLD;
  const innerWheelTrimFraction = MANUAL_DRIVE_MAX_INNER_WHEEL_TRIM * Math.pow(gentleTurn, MANUAL_DRIVE_ARC_RESPONSE_EXPONENT);
  const innerWheelSpeed = baseSpeed * (1 - innerWheelTrimFraction);

  if (turnDemand >= 0) {
    return {
      mode: turnMagnitude > 0.12 ? "arc" : "straight",
      requestedLeftMetersPerSecond: innerWheelSpeed,
      requestedRightMetersPerSecond: baseSpeed,
    };
  }

  return {
    mode: turnMagnitude > 0.12 ? "arc" : "straight",
    requestedLeftMetersPerSecond: baseSpeed,
    requestedRightMetersPerSecond: innerWheelSpeed,
  };
}

