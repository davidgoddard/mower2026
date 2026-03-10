import type { GnssFixType, GnssSample } from "./gnssProtocol.js";
import { decodeOptionalInt16, decodeOptionalUint16, encodeOptionalInt16, encodeOptionalUint16 } from "./codecPrimitives.js";

const GNSS_PAYLOAD_LENGTH = 26;

const fixTypeToCode: Record<GnssFixType, number> = {
  none: 0,
  single: 1,
  float: 2,
  fixed: 3,
};

const codeToFixType: Record<number, GnssFixType> = {
  0: "none",
  1: "single",
  2: "float",
  3: "fixed",
};

export function gnssPayloadLength(): number {
  return GNSS_PAYLOAD_LENGTH;
}

export function encodeGnssSample(sample: GnssSample): Uint8Array {
  const payload = new Uint8Array(GNSS_PAYLOAD_LENGTH);
  const view = new DataView(payload.buffer);

  view.setUint32(0, sample.timestampMillis, true);
  view.setInt32(4, Math.round(sample.xMeters * 1000), true);
  view.setInt32(8, Math.round(sample.yMeters * 1000), true);
  encodeOptionalInt16(view, 12, sample.headingDegrees, 100);
  encodeOptionalInt16(view, 14, sample.pitchDegrees, 100);
  encodeOptionalUint16(view, 16, sample.groundSpeedMetersPerSecond, 1000);
  view.setUint16(18, Math.round(sample.positionAccuracyMeters * 1000), true);
  encodeOptionalUint16(view, 20, sample.headingAccuracyDegrees, 100);
  view.setUint8(22, fixTypeToCode[sample.fixType]);
  view.setUint8(23, sample.satellitesInUse);
  view.setUint16(24, sample.sampleAgeMillis, true);

  return payload;
}

export function decodeGnssSample(payload: Uint8Array): GnssSample {
  if (payload.length !== GNSS_PAYLOAD_LENGTH) {
    throw new Error(`Invalid GNSS payload length ${payload.length}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const fixCode = view.getUint8(22);
  const fixType = codeToFixType[fixCode];
  if (fixType === undefined) {
    throw new Error(`Unknown GNSS fix code ${fixCode}`);
  }

  const headingDegrees = decodeOptionalInt16(view, 12, 100);
  const pitchDegrees = decodeOptionalInt16(view, 14, 100);
  const groundSpeedMetersPerSecond = decodeOptionalUint16(view, 16, 1000);
  const headingAccuracyDegrees = decodeOptionalUint16(view, 20, 100);

  return {
    timestampMillis: view.getUint32(0, true),
    xMeters: view.getInt32(4, true) / 1000,
    yMeters: view.getInt32(8, true) / 1000,
    positionAccuracyMeters: view.getUint16(18, true) / 1000,
    fixType,
    satellitesInUse: view.getUint8(23),
    sampleAgeMillis: view.getUint16(24, true),
    ...(headingDegrees === undefined ? {} : { headingDegrees }),
    ...(pitchDegrees === undefined ? {} : { pitchDegrees }),
    ...(groundSpeedMetersPerSecond === undefined ? {} : { groundSpeedMetersPerSecond }),
    ...(headingAccuracyDegrees === undefined ? {} : { headingAccuracyDegrees }),
  };
}
