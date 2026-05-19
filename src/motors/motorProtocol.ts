export interface WheelSpeedCommand {
  readonly timestampMillis: number;
  readonly leftWheelTargetMetersPerSecond: number;
  readonly rightWheelTargetMetersPerSecond: number;
  readonly enableDrive: boolean;
  readonly commandTimeoutMillis: number;
  readonly maxAccelerationMetersPerSecondSquared?: number;
  readonly maxDecelerationMetersPerSecondSquared?: number;
}

export interface MotorFeedbackSample {
  readonly timestampMillis: number;
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

