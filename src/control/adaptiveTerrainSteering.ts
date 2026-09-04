import {
  DRIVE_TERRAIN_EVIDENCE_GAIN,
  DRIVE_TERRAIN_MAX_TRIM_PERCENT,
  DRIVE_TERRAIN_MIN_APPLIED_PWM_FRACTION,
  DRIVE_TERRAIN_TRIM_DECAY,
  DRIVE_TERRAIN_TRIM_SLEW_PER_SAMPLE,
  MOTOR_FEEDBACK_MOTION_START_MAX_AGE_MS,
} from "../constants.js";
import type { MotorFeedbackUpdateEvent } from "../sensing/sensorEvents.js";

export interface TerrainSteeringSnapshot {
  /** Forward-command trim; DriveLineController reverses it for reverse travel. */
  readonly trimPercent: number;
  readonly currentAsymmetry: number;
  readonly responseAsymmetry: number;
  readonly evidenceAccepted: boolean;
}

export class AdaptiveTerrainSteering {
  private trimPercent = 0;
  private lastObservationMillis: number | null = null;
  private snapshot: TerrainSteeringSnapshot = {
    trimPercent: 0,
    currentAsymmetry: 0,
    responseAsymmetry: 0,
    evidenceAccepted: false,
  };

  reset(): void {
    this.trimPercent = 0;
    this.lastObservationMillis = null;
    this.snapshot = {
      trimPercent: 0,
      currentAsymmetry: 0,
      responseAsymmetry: 0,
      evidenceAccepted: false,
    };
  }

  observe(
    event: MotorFeedbackUpdateEvent,
    enabled: boolean,
    observedAtMillis = Date.now(),
  ): TerrainSteeringSnapshot {
    this.lastObservationMillis = observedAtMillis;
    const leftApplied = Math.abs(event.leftPwmAppliedPercent) / 100;
    const rightApplied = Math.abs(event.rightPwmAppliedPercent) / 100;
    const currentsAvailable = event.leftMotorCurrentAmps !== null && event.rightMotorCurrentAmps !== null;
    if (
      !enabled
      || !event.watchdogHealthy
      || event.faultFlags !== 0
    ) {
      return this.clear();
    }
    if (
      !currentsAvailable
      || leftApplied < DRIVE_TERRAIN_MIN_APPLIED_PWM_FRACTION
      || rightApplied < DRIVE_TERRAIN_MIN_APPLIED_PWM_FRACTION
    ) {
      return this.decay(0, 0);
    }

    const leftCurrent = Math.max(0, event.leftMotorCurrentAmps!);
    const rightCurrent = Math.max(0, event.rightMotorCurrentAmps!);
    const currentAsymmetry = normalizedDifference(leftCurrent, rightCurrent);
    const leftResponse = Math.abs(event.leftEncoderDelta) / Math.max(0.05, leftApplied);
    const rightResponse = Math.abs(event.rightEncoderDelta) / Math.max(0.05, rightApplied);
    // Positive means the left side is more heavily loaded: it draws more
    // current and produces fewer ticks per unit of applied PWM.
    const responseAsymmetry = normalizedDifference(rightResponse, leftResponse);
    const corroborated = Math.abs(currentAsymmetry) >= 0.03
      && Math.abs(responseAsymmetry) >= 0.03
      && Math.sign(currentAsymmetry) === Math.sign(responseAsymmetry);
    if (!corroborated) {
      return this.decay(currentAsymmetry, responseAsymmetry);
    }

    const loadAsymmetry = (currentAsymmetry + responseAsymmetry) / 2;
    // DriveLineController's positive trim slows the left wheel and keeps the
    // right wheel high. A left-loaded mower therefore needs negative trim.
    const targetTrim = clamp(
      -loadAsymmetry * DRIVE_TERRAIN_EVIDENCE_GAIN,
      -DRIVE_TERRAIN_MAX_TRIM_PERCENT,
      DRIVE_TERRAIN_MAX_TRIM_PERCENT,
    );
    this.trimPercent = slew(this.trimPercent, targetTrim, DRIVE_TERRAIN_TRIM_SLEW_PER_SAMPLE);
    this.snapshot = {
      trimPercent: this.trimPercent,
      currentAsymmetry,
      responseAsymmetry,
      evidenceAccepted: true,
    };
    return this.snapshot;
  }

  getSnapshot(nowMillis = Date.now()): TerrainSteeringSnapshot {
    if (
      this.lastObservationMillis === null
      || nowMillis - this.lastObservationMillis > MOTOR_FEEDBACK_MOTION_START_MAX_AGE_MS
    ) {
      return this.clear();
    }
    return this.snapshot;
  }

  private clear(): TerrainSteeringSnapshot {
    this.trimPercent = 0;
    this.snapshot = {
      trimPercent: 0,
      currentAsymmetry: 0,
      responseAsymmetry: 0,
      evidenceAccepted: false,
    };
    return this.snapshot;
  }

  private decay(currentAsymmetry: number, responseAsymmetry: number): TerrainSteeringSnapshot {
    this.trimPercent *= DRIVE_TERRAIN_TRIM_DECAY;
    if (Math.abs(this.trimPercent) < 1e-4) this.trimPercent = 0;
    this.snapshot = {
      trimPercent: this.trimPercent,
      currentAsymmetry,
      responseAsymmetry,
      evidenceAccepted: false,
    };
    return this.snapshot;
  }
}

function normalizedDifference(left: number, right: number): number {
  return (left - right) / Math.max(1e-6, left + right);
}

function slew(current: number, target: number, maximumDelta: number): number {
  return current + clamp(target - current, -maximumDelta, maximumDelta);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
