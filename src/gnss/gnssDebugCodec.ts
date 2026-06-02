import { Buffer } from "node:buffer";
import type { GnssFixType } from "./gnssProtocol.js";

/**
 * Compact debug payload for the latest low-satellite receiver sentence.
 *
 * Layout:
 *   off 0     : flags
 *                bit0 = sentence present
 *                bit1 = raw text truncated to fit the transport payload
 *   off 1     : satellites in use
 *   off 2     : fix type code (same mapping as GnssSample)
 *   off 3     : raw text length in bytes (capped to the transport payload)
 *   off 4..   : UTF-8 raw receiver payload text (the text after the
 *               semicolon, before the checksum), NUL-padded
 */
const GNSS_DEBUG_PAYLOAD_LENGTH = 116;
const GNSS_DEBUG_TEXT_OFFSET = 4;

const codeToFixType: Record<number, GnssFixType> = {
  0: "none",
  1: "single",
  2: "float",
  3: "fixed",
};

export interface GnssDebugLine {
  readonly satellitesInUse: number;
  readonly fixType: GnssFixType;
  readonly rawPayload: string;
  readonly truncated: boolean;
}

export function gnssDebugPayloadLength(): number {
  return GNSS_DEBUG_PAYLOAD_LENGTH;
}

export function decodeGnssDebugLine(payload: Uint8Array): GnssDebugLine | null {
  if (payload.length !== GNSS_DEBUG_PAYLOAD_LENGTH) {
    throw new Error(`Invalid GNSS debug payload length ${payload.length}, expected ${GNSS_DEBUG_PAYLOAD_LENGTH}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = view.getUint8(0);
  if ((flags & 0x01) === 0) {
    return null;
  }

  const satellitesInUse = view.getUint8(1);
  const fixType = codeToFixType[view.getUint8(2)];
  if (fixType === undefined) {
    throw new Error(`Unknown GNSS debug fix code ${view.getUint8(2)}`);
  }

  const rawLength = Math.min(view.getUint8(3), GNSS_DEBUG_PAYLOAD_LENGTH - GNSS_DEBUG_TEXT_OFFSET);
  const rawTextBytes = payload.subarray(GNSS_DEBUG_TEXT_OFFSET, GNSS_DEBUG_TEXT_OFFSET + rawLength);
  const rawPayload = Buffer.from(rawTextBytes).toString("utf8").replace(/\0.*$/, "");

  return {
    satellitesInUse,
    fixType,
    rawPayload,
    truncated: (flags & 0x02) !== 0,
  };
}
