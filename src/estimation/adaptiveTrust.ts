import type { MeasurementBundle } from "../sensing/measurementTypes.js";

export interface TrustLevels {
  readonly positionTrust: number;
  readonly headingTrust: number;
  readonly wheelTrust: number;
  readonly imuTrust: number;
}

export class AdaptiveTrust {
  public evaluate(bundle: MeasurementBundle): TrustLevels {
    let positionTrust = 0;
    let headingTrust = 0;
    let wheelTrust = 0;
    let imuTrust = 0;

    if (!bundle.stale && bundle.position !== undefined) {
      switch (bundle.position.fixQuality) {
        case "high":
          positionTrust = 0.9;
          break;
        case "medium":
          positionTrust = 0.6;
          break;
        case "low":
          positionTrust = 0.3;
          break;
        case "none":
        default:
          positionTrust = 0;
          break;
      }
    }

    if (!bundle.stale && bundle.heading !== undefined) {
      headingTrust = bundle.heading.source === "gnss" ? 0.8 : 0.6;
    }

    if (!bundle.stale && bundle.wheelOdometry !== undefined) {
      wheelTrust = bundle.faultFlags === 0 ? 0.8 : 0.4;
    }

    if (!bundle.stale && bundle.imu !== undefined) {
      imuTrust = 0.7;
    }

    return { positionTrust, headingTrust, wheelTrust, imuTrust };
  }
}
