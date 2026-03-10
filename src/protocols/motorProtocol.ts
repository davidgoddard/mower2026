import type { TimestampedPayload } from "./commonProtocol.js";

export interface WheelSpeedCommand extends TimestampedPayload {
  readonly leftWheelTargetMetersPerSecond: number;
  readonly rightWheelTargetMetersPerSecond: number;
  readonly enableDrive: boolean;
  readonly commandTimeoutMillis: number;
  readonly maxAccelerationMetersPerSecondSquared?: number;
  readonly maxDecelerationMetersPerSecondSquared?: number;
}

export interface MotorFeedbackSample extends TimestampedPayload {
  readonly leftWheelActualMetersPerSecond: number;
  readonly rightWheelActualMetersPerSecond: number;
  readonly leftEncoderDelta: number;
  readonly rightEncoderDelta: number;
  readonly leftPwmApplied: number;
  readonly rightPwmApplied: number;
  readonly leftMotorCurrentAmps?: number;
  readonly rightMotorCurrentAmps?: number;
  readonly watchdogHealthy: boolean;
  readonly faultFlags: number;
}
