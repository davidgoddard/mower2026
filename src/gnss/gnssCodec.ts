import type { GnssFixType, GnssSample } from "./gnssProtocol.js";
import {
  decodeOptionalInt16,
  decodeOptionalInt32,
  decodeOptionalUint16,
} from "../protocols/codecPrimitives.js";

const GNSS_PAYLOAD_LENGTH_V1 = 36;
const GNSS_PAYLOAD_LENGTH_V2 = 38;

const codeToFixType: Record<number, GnssFixType> = {
  0: "none",
  1: "single",
  2: "float",
  3: "fixed",
};

export function gnssPayloadLength(): number {
  // Request enough bytes to support both known payload variants.
  return GNSS_PAYLOAD_LENGTH_V2;
}

export function decodeGnssSample(payload: Uint8Array): GnssSample {
  if (payload.length !== GNSS_PAYLOAD_LENGTH_V1 && payload.length !== GNSS_PAYLOAD_LENGTH_V2) {
    throw new Error(`Invalid GNSS payload length ${payload.length}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const usesV2Layout = payload.length === GNSS_PAYLOAD_LENGTH_V2;
  const fixCode = view.getUint8(usesV2Layout ? 24 : 22);
  const fixType = codeToFixType[fixCode];
  if (fixType === undefined) {
    throw new Error(`Unknown GNSS fix code ${fixCode}`);
  }

  const headingDegrees = usesV2Layout
    ? decodeOptionalInt32(view, 12, 100)
    : decodeOptionalInt16(view, 12, 100);
  const pitchDegrees = decodeOptionalInt16(view, usesV2Layout ? 16 : 14, 100);
  const groundSpeedMetersPerSecond = decodeOptionalUint16(view, usesV2Layout ? 18 : 16, 1000);
  const headingAccuracyDegrees = decodeOptionalUint16(view, usesV2Layout ? 22 : 20, 100);
  const receiverLineAgeMillis = decodeOptionalUint16(view, usesV2Layout ? 28 : 26, 1);
  const pvtslnaAgeMillis = decodeOptionalUint16(view, usesV2Layout ? 30 : 28, 1);
  const uniheadingAgeMillis = decodeOptionalUint16(view, usesV2Layout ? 32 : 30, 1);
  const rtcmAgeMillis = decodeOptionalUint16(view, usesV2Layout ? 34 : 32, 1);
  const logConfigMask = view.getUint8(usesV2Layout ? 36 : 34);

  return {
    timestampMillis: view.getUint32(0, true),
    xMeters: view.getInt32(4, true) / 1000,
    yMeters: view.getInt32(8, true) / 1000,
    positionAccuracyMeters: view.getUint16(usesV2Layout ? 20 : 18, true) / 1000,
    fixType,
    satellitesInUse: view.getUint8(usesV2Layout ? 25 : 23),
    sampleAgeMillis: view.getUint16(usesV2Layout ? 26 : 24, true),
    ...(headingDegrees === undefined ? {} : { headingDegrees }),
    ...(pitchDegrees === undefined ? {} : { pitchDegrees }),
    ...(groundSpeedMetersPerSecond === undefined ? {} : { groundSpeedMetersPerSecond }),
    ...(headingAccuracyDegrees === undefined ? {} : { headingAccuracyDegrees }),
    ...(
      receiverLineAgeMillis === undefined
      && pvtslnaAgeMillis === undefined
      && uniheadingAgeMillis === undefined
      && rtcmAgeMillis === undefined
      && logConfigMask === 0
        ? {}
        : {
            debug: {
              ...(receiverLineAgeMillis === undefined ? {} : { receiverLineAgeMillis }),
              ...(pvtslnaAgeMillis === undefined ? {} : { pvtslnaAgeMillis }),
              ...(uniheadingAgeMillis === undefined ? {} : { uniheadingAgeMillis }),
              ...(rtcmAgeMillis === undefined ? {} : { rtcmAgeMillis }),
              ...(logConfigMask === 0 ? {} : { logConfigMask }),
            },
          }
    ),
  };
}
