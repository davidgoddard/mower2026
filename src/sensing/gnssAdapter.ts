import type { GnssSample } from "../protocols/gnssProtocol.js";
import { GnssFaultFlag } from "../protocols/faultFlags.js";
import type { HeadingMeasurement, MeasurementBundle, PositionMeasurement } from "./measurementTypes.js";

export interface GnssAdapterOptions {
  readonly staleAfterMillis: number;
  readonly now?: () => number;
}

function mapFixQuality(sample: GnssSample): PositionMeasurement["fixQuality"] {
  switch (sample.fixType) {
    case "fixed":
      return "high";
    case "float":
      return "medium";
    case "single":
      return "low";
    case "none":
    default:
      return "none";
  }
}

export class GnssAdapter {
  private readonly now: () => number;

  public constructor(private readonly options: GnssAdapterOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  public adapt(sample: GnssSample): MeasurementBundle {
    const ageMillis = this.now() - sample.timestampMillis;
    const stale = ageMillis > this.options.staleAfterMillis || sample.sampleAgeMillis > this.options.staleAfterMillis;

    let faultFlags = 0;
    if (stale) {
      faultFlags |= GnssFaultFlag.StaleSample;
    }
    if (sample.fixType === "none") {
      faultFlags |= GnssFaultFlag.InvalidFix;
    }
    if (sample.headingDegrees === undefined) {
      faultFlags |= GnssFaultFlag.HeadingUnavailable;
    }

    const position = this.buildPositionMeasurement(sample);
    const heading = this.buildHeadingMeasurement(sample);

    return {
      ...(position === undefined ? {} : { position }),
      ...(heading === undefined ? {} : { heading }),
      faultFlags,
      stale,
    };
  }

  private buildPositionMeasurement(sample: GnssSample): PositionMeasurement | undefined {
    if (sample.fixType === "none") {
      return undefined;
    }

    return {
      xMeters: sample.xMeters,
      yMeters: sample.yMeters,
      accuracyMeters: sample.positionAccuracyMeters,
      timestampMillis: sample.timestampMillis,
      fixQuality: mapFixQuality(sample),
    };
  }

  private buildHeadingMeasurement(sample: GnssSample): HeadingMeasurement | undefined {
    if (sample.headingDegrees === undefined || sample.headingAccuracyDegrees === undefined) {
      return undefined;
    }

    return {
      headingDegrees: sample.headingDegrees,
      accuracyDegrees: sample.headingAccuracyDegrees,
      timestampMillis: sample.timestampMillis,
      source: "gnss",
    };
  }
}
