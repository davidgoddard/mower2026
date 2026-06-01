import type { GnssFixType, GnssSample } from "./gnssProtocol.js";

/**
 * Optional decode-time context.  When provided, `nowMillis` is used to stamp
 * the GNSS sample's `timestampMillis` against the Pi wallclock — keeping
 * GNSS, IMU and encoder timestamps in the same clock domain.
 *
 * The receiver-supplied `gpsTimeMillis` (UTC ms since Unix epoch) is the
 * canonical fix time when present and is exposed separately on the sample.
 * If `nowMillis` is omitted the codec uses the receiver UTC where available
 * and otherwise falls back to zero — callers should always supply one in
 * production so staleness detection works regardless of receiver UTC state.
 */
export interface GnssDecodeContext {
  readonly nowMillis: number;
}

// Single payload layout — see gnss-node-v2.ino buildGnssPayload for the
// authoritative definition.  Total length 40 bytes:
//
//   off 0 .. 7 : gpsTimeMillis  uint64 LE (Unix epoch ms; 0 when UTC invalid)
//   off 8 .. 11: xMeters x 1000 int32 LE mm
//   off 12..15 : yMeters x 1000 int32 LE mm
//   off 16..19 : heading deg x 100 int32 LE; sentinel 0x7FFFFFFF
//   off 20..21 : pitch deg x 100   int16 LE; sentinel 0x7FFF
//   off 22..23 : ground speed mps x 1000 uint16 LE; sentinel 0xFFFF
//   off 24..25 : position accuracy m x 1000 uint16 LE mm
//   off 26..27 : heading accuracy deg x 100 uint16 LE; sentinel 0xFFFF
//   off 28..29 : heading baseline length m x 1000 uint16 LE; sentinel 0xFFFF
//   off 30..31 : sample age ms uint16 LE
//   off 32     : fix type uint8
//   off 33     : satellites in use uint8
//   off 34     : flags
//   off 35     : log config mask
//   off 36..39 : reserved
const GNSS_PAYLOAD_LENGTH = 40;

const POSITION_SCALE_MM_TO_M = 1000;
const HEADING_SCALE_CENTIDEG_TO_DEG = 100;
const SPEED_SCALE_MM_PER_S_TO_MPS = 1000;
const BASELINE_SCALE_MM_TO_M = 1000;
const MAX_REASONABLE_LOCAL_POSITION_METERS = 10_000;

const HEADING_INT32_SENTINEL = 0x7FFFFFFF;
const HEADING_INT16_SENTINEL = 0x7FFF;
const UINT16_SENTINEL = 0xFFFF;

const FLAG_UTC_VALID         = 0x01;
const FLAG_HEADING_VALID     = 0x02;
const FLAG_BASELINE_VALID    = 0x04;

const codeToFixType: Record<number, GnssFixType> = {
  0: "none",
  1: "single",
  2: "float",
  3: "fixed",
};

export function gnssPayloadLength(): number {
  return GNSS_PAYLOAD_LENGTH;
}

function readUint64LE(view: DataView, offset: number): bigint {
  const lo = BigInt(view.getUint32(offset, true));
  const hi = BigInt(view.getUint32(offset + 4, true));
  return (hi << 32n) | lo;
}

export function decodeGnssSample(payload: Uint8Array, context?: GnssDecodeContext): GnssSample {
  if (payload.length !== GNSS_PAYLOAD_LENGTH) {
    throw new Error(`Invalid GNSS payload length ${payload.length}, expected ${GNSS_PAYLOAD_LENGTH}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  const fixCode = view.getUint8(32);
  const fixType = codeToFixType[fixCode];
  if (fixType === undefined) {
    throw new Error(`Unknown GNSS fix code ${fixCode}`);
  }

  const xMillimeters = view.getInt32(8, true);
  const yMillimeters = view.getInt32(12, true);
  const xMeters = xMillimeters / POSITION_SCALE_MM_TO_M;
  const yMeters = yMillimeters / POSITION_SCALE_MM_TO_M;
  if (
    Math.abs(xMeters) > MAX_REASONABLE_LOCAL_POSITION_METERS ||
    Math.abs(yMeters) > MAX_REASONABLE_LOCAL_POSITION_METERS
  ) {
    throw new Error(`Invalid GNSS local position x=${xMeters} y=${yMeters}`);
  }

  const headingRaw = view.getInt32(16, true);
  const headingDegrees = headingRaw === HEADING_INT32_SENTINEL
    ? undefined
    : headingRaw / HEADING_SCALE_CENTIDEG_TO_DEG;

  const pitchRaw = view.getInt16(20, true);
  const pitchDegrees = pitchRaw === HEADING_INT16_SENTINEL
    ? undefined
    : pitchRaw / HEADING_SCALE_CENTIDEG_TO_DEG;

  const groundSpeedRaw = view.getUint16(22, true);
  const groundSpeedMetersPerSecond = groundSpeedRaw === UINT16_SENTINEL
    ? undefined
    : groundSpeedRaw / SPEED_SCALE_MM_PER_S_TO_MPS;

  const positionAccuracyMeters = view.getUint16(24, true) / POSITION_SCALE_MM_TO_M;

  const headingAccRaw = view.getUint16(26, true);
  const headingAccuracyDegrees = headingAccRaw === UINT16_SENTINEL
    ? undefined
    : headingAccRaw / HEADING_SCALE_CENTIDEG_TO_DEG;

  const baselineRaw = view.getUint16(28, true);
  const headingBaselineMeters = baselineRaw === UINT16_SENTINEL
    ? undefined
    : baselineRaw / BASELINE_SCALE_MM_TO_M;

  const sampleAgeMillis = view.getUint16(30, true);
  const satellitesInUse = view.getUint8(33);
  const flags = view.getUint8(34);
  const logConfigMask = view.getUint8(35);

  const utcValid = (flags & FLAG_UTC_VALID) !== 0;
  const headingValid = (flags & FLAG_HEADING_VALID) !== 0;
  const baselineFlag = (flags & FLAG_BASELINE_VALID) !== 0;

  // GPS UTC: read uint64 only if the flag is set; otherwise omit so consumers
  // know the field is absent rather than zero.
  let gpsTimeMillis: number | undefined;
  if (utcValid) {
    const utcBig = readUint64LE(view, 0);
    if (utcBig <= BigInt(Number.MAX_SAFE_INTEGER) && utcBig > 0n) {
      gpsTimeMillis = Number(utcBig);
    }
  }

  // Pi-side wallclock arrival time keeps GNSS, IMU and encoder samples in the
  // same clock domain.  Falls back to gpsTimeMillis when the caller doesn't
  // supply a context, then to 0 — callers should always supply nowMillis in
  // production.
  const piTimestampMillis = context?.nowMillis ?? gpsTimeMillis ?? 0;

  return {
    timestampMillis: piTimestampMillis,
    xMeters,
    yMeters,
    positionAccuracyMeters,
    fixType,
    satellitesInUse,
    sampleAgeMillis,
    ...(headingDegrees === undefined ? {} : { headingDegrees }),
    ...(pitchDegrees === undefined ? {} : { pitchDegrees }),
    ...(groundSpeedMetersPerSecond === undefined ? {} : { groundSpeedMetersPerSecond }),
    ...(headingAccuracyDegrees === undefined ? {} : { headingAccuracyDegrees }),
    ...(headingBaselineMeters === undefined || !baselineFlag ? {} : { headingBaselineMeters }),
    ...(gpsTimeMillis === undefined ? {} : { gpsTimeMillis }),
    headingValid,
    ...(logConfigMask === 0 ? {} : { debug: { logConfigMask } }),
  };
}
