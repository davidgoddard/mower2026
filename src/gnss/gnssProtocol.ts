export type GnssFixType = "none" | "single" | "float" | "fixed";

export interface GnssDebugAges {
  readonly receiverLineAgeMillis?: number;
  readonly pvtslnaAgeMillis?: number;
  readonly uniheadingAgeMillis?: number;
  readonly rtcmAgeMillis?: number;
  readonly logConfigMask?: number;
}

export interface GnssSample {
  /**
   * Pi-side wallclock arrival time (ms since Unix epoch) — populated by the
   * sensor controller when the frame is decoded.  Used for staleness checks
   * and clock-domain consistency with IMU/encoder samples.  Not the receiver
   * timestamp, which is `gpsTimeMillis` (UTC) when the firmware provides it.
   */
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
  /** Receiver-claimed sample age (ms since the GNSS receiver computed the fix). */
  readonly sampleAgeMillis: number;
  /**
   * UTC time of the GNSS fix in ms since Unix epoch, sourced from RECTIMEA.
   * 0 (or absent) when the receiver reports UTC as not yet valid.
   */
  readonly gpsTimeMillis?: number;
  /**
   * Measured antenna baseline length (m) reported by the dual-antenna
   * heading solution (UNIHEADINGA `length` field).
   */
  readonly headingBaselineMeters?: number;
  /**
   * Receiver heading-valid flag from UNIHEADINGA solution status.
   * Independent of fixType — the position can be RTK Fixed while the
   * heading solution is still INSUFFICIENT_OBS or NONE.
   */
  readonly headingValid?: boolean;
  readonly debug?: GnssDebugAges;
}
