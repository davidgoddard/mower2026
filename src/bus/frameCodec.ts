import { crc16Ccitt } from "./crc.js";
import type { FrameHeader } from "../protocols/commonProtocol.js";
import { PROTOCOL_VERSION } from "../protocols/commonProtocol.js";

const START_OF_FRAME = 0x4d;
const HEADER_SIZE = 9;
const CRC_SIZE = 2;

export interface EncodedFrame {
  readonly header: FrameHeader;
  readonly payload: Uint8Array;
}

export function encodeFrame(header: Omit<FrameHeader, "version"> & { version?: number }, payload: Uint8Array): Uint8Array {
  const version = header.version ?? PROTOCOL_VERSION;
  const frame = new Uint8Array(HEADER_SIZE + payload.length + CRC_SIZE);
  const view = new DataView(frame.buffer);

  frame[0] = START_OF_FRAME;
  frame[1] = version;
  frame[2] = header.nodeId;
  frame[3] = header.messageType;
  frame[4] = header.flags;
  view.setUint16(5, header.sequence, true);
  view.setUint16(7, payload.length, true);
  frame.set(payload, HEADER_SIZE);

  const crc = crc16Ccitt(frame.subarray(1, HEADER_SIZE + payload.length));
  view.setUint16(HEADER_SIZE + payload.length, crc, true);

  return frame;
}

export function decodeFrame(frame: Uint8Array): EncodedFrame {
  if (frame.length < HEADER_SIZE + CRC_SIZE) {
    throw new Error("Frame too short");
  }

  if (frame[0] !== START_OF_FRAME) {
    throw new Error("Invalid start of frame");
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const payloadLength = view.getUint16(7, true);
  const expectedLength = HEADER_SIZE + payloadLength + CRC_SIZE;

  if (frame.length !== expectedLength) {
    throw new Error("Frame length mismatch");
  }

  const actualCrc = view.getUint16(HEADER_SIZE + payloadLength, true);
  const expectedCrc = crc16Ccitt(frame.subarray(1, HEADER_SIZE + payloadLength));
  if (actualCrc !== expectedCrc) {
    throw new Error("CRC mismatch");
  }

  return {
    header: {
      version: view.getUint8(1),
      nodeId: view.getUint8(2),
      messageType: view.getUint8(3),
      flags: view.getUint8(4),
      sequence: view.getUint16(5, true),
    },
    payload: frame.slice(HEADER_SIZE, HEADER_SIZE + payloadLength),
  };
}
