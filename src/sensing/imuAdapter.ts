import { ImuFaultFlag } from "../protocols/faultFlags.js";
import type { MeasurementBundle, ImuMeasurement } from "./measurementTypes.js";
import type { RawImuSample } from "./imuSensor.js";

export interface ImuAdapterOptions {
  readonly staleAfterMillis: number;
  readonly now?: () => number;
}

export class ImuAdapter {
  private readonly now: () => number;

  public constructor(private readonly options: ImuAdapterOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  public adapt(sample: RawImuSample): MeasurementBundle {
    const stale = this.now() - sample.timestampMillis > this.options.staleAfterMillis;

    const imu: ImuMeasurement = {
      timestampMillis: sample.timestampMillis,
      angularVelocity: sample.angularVelocity,
      acceleration: sample.acceleration,
    };

    return {
      imu,
      faultFlags: stale ? ImuFaultFlag.StaleSample : 0,
      stale,
    };
  }
}
