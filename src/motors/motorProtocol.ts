export interface WheelSpeedCommand {
  readonly timestampMillis: number;
  readonly leftWheelTargetPercent: number;
  readonly rightWheelTargetPercent: number;
  readonly enableDrive: boolean;
  readonly commandTimeoutMillis: number;
  readonly maxAccelerationPercentPerSecond?: number;
  readonly maxDecelerationPercentPerSecond?: number;
}

export interface MotorFeedbackSample {
  readonly timestampMillis: number;
  readonly leftEncoderDelta: number;
  readonly rightEncoderDelta: number;
  readonly leftPwmAppliedPercent: number;
  readonly rightPwmAppliedPercent: number;
  readonly leftMotorCurrentAmps?: number;
  readonly rightMotorCurrentAmps?: number;
  readonly watchdogHealthy: boolean;
  readonly faultFlags: number;
}
