export type GnssFixType = "none" | "single" | "float" | "fixed";

export interface GnssDebugAges {
  readonly receiverLineAgeMillis?: number;
  readonly pvtslnaAgeMillis?: number;
  readonly uniheadingAgeMillis?: number;
  readonly rtcmAgeMillis?: number;
  readonly logConfigMask?: number;
}

export interface GnssSample {
  readonly timestampMillis: number;
  readonly xMeters: number;
  readonly yMeters: number;
  readonly headingDegrees?: number;
  readonly pitchDegrees?: number;
  readonly groundSpeedMetersPerSecond?: number;
  readonly positionAccuracyMeters: number;
  readonly headingAccuracyDegrees?: number;
  readonly fixType: GnssFixType;
  readonly satellitesInUse: number;
  readonly sampleAgeMillis: number;
  readonly debug?: GnssDebugAges;
}
