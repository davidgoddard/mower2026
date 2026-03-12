import type { MotorFeedbackSample } from "../protocols/motorProtocol.js";
import { MotorFaultFlag } from "../protocols/faultFlags.js";
import type { MeasurementBundle, WheelOdometryMeasurement } from "./measurementTypes.js";

export interface MotorFeedbackAdapterOptions {
  readonly leftMetersPerEncoderCount: number;
  readonly rightMetersPerEncoderCount: number;
  readonly staleAfterMillis: number;
  readonly now?: () => number;
}

export class MotorFeedbackAdapter {
  private readonly now: () => number;

  public constructor(private readonly options: MotorFeedbackAdapterOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  public adapt(sample: MotorFeedbackSample): MeasurementBundle {
    const stale = this.now() - sample.timestampMillis > this.options.staleAfterMillis;
    let faultFlags = sample.faultFlags;
    if (stale) {
      faultFlags |= MotorFaultFlag.WatchdogExpired;
    }
    if (!sample.watchdogHealthy) {
      faultFlags |= MotorFaultFlag.WatchdogExpired;
    }

    return {
      ...(this.shouldUseWheelOdometry(faultFlags) ? { wheelOdometry: this.buildWheelOdometryMeasurement(sample) } : {}),
      faultFlags,
      stale,
    };
  }

  private shouldUseWheelOdometry(faultFlags: number): boolean {
    const odometryInvalidMask = MotorFaultFlag.WatchdogExpired
      | MotorFaultFlag.LeftEncoderFault
      | MotorFaultFlag.RightEncoderFault;
    return (faultFlags & odometryInvalidMask) === 0;
  }

  private buildWheelOdometryMeasurement(sample: MotorFeedbackSample): WheelOdometryMeasurement {
    return {
      leftDistanceMeters: sample.leftEncoderDelta * this.options.leftMetersPerEncoderCount,
      rightDistanceMeters: sample.rightEncoderDelta * this.options.rightMetersPerEncoderCount,
      leftSpeedMetersPerSecond: sample.leftWheelActualMetersPerSecond,
      rightSpeedMetersPerSecond: sample.rightWheelActualMetersPerSecond,
      timestampMillis: sample.timestampMillis,
    };
  }
}
