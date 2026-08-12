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
  /** ESP-owned sequence of the generated 20Hz feedback snapshot. */
  readonly sequence: number;
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
