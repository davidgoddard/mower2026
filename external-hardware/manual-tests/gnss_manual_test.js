"use strict";

// Pi-side GNSS node poller for manual bring-up.
// Requires the `i2c-bus` package on the Pi.

const i2c = require("i2c-bus");

const BUS_NUMBER = 1;
const I2C_ADDRESS = 0x52;

const PROTOCOL_START_OF_FRAME = 0x4d;
const PROTOCOL_VERSION = 0x01;
const NODE_ID_GNSS = 0x10;
const MESSAGE_TYPE_GNSS_SAMPLE = 0x01;
const FRAME_LENGTH = 9 + 26 + 2;

function crc16Ccitt(data) {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function encodeFrame(sequence) {
  const frame = Buffer.alloc(9 + 2);
  frame[0] = PROTOCOL_START_OF_FRAME;
  frame[1] = PROTOCOL_VERSION;
  frame[2] = NODE_ID_GNSS;
  frame[3] = MESSAGE_TYPE_GNSS_SAMPLE;
  frame[4] = 0;
  frame.writeUInt16LE(sequence, 5);
  frame.writeUInt16LE(0, 7);
  frame.writeUInt16LE(crc16Ccitt(frame.subarray(1, 9)), 9);
  return frame;
}

function decodeFrame(frame) {
  if (frame[0] !== PROTOCOL_START_OF_FRAME) {
    throw new Error("bad start-of-frame");
  }
  const payloadLength = frame.readUInt16LE(7);
  const crc = frame.readUInt16LE(9 + payloadLength);
  const expected = crc16Ccitt(frame.subarray(1, 9 + payloadLength));
  if (crc !== expected) {
    throw new Error("bad crc");
  }
  return {
    flags: frame[4],
    sequence: frame.readUInt16LE(5),
    payload: frame.subarray(9, 9 + payloadLength),
  };
}

function decodeGnssPayload(payload) {
  const headingRaw = payload.readInt16LE(12);
  const pitchRaw = payload.readInt16LE(14);
  const speedRaw = payload.readUInt16LE(16);
  const headingAccuracyRaw = payload.readUInt16LE(20);
  return {
    timestampMillis: payload.readUInt32LE(0),
    xMeters: payload.readInt32LE(4) / 1000,
    yMeters: payload.readInt32LE(8) / 1000,
    headingDegrees: headingRaw === 0x7fff ? null : headingRaw / 100,
    pitchDegrees: pitchRaw === 0x7fff ? null : pitchRaw / 100,
    groundSpeedMetersPerSecond: speedRaw === 0xffff ? null : speedRaw / 1000,
    positionAccuracyMeters: payload.readUInt16LE(18) / 1000,
    headingAccuracyDegrees: headingAccuracyRaw === 0xffff ? null : headingAccuracyRaw / 100,
    fixType: payload[22],
    satellitesInUse: payload[23],
    sampleAgeMillis: payload.readUInt16LE(24),
  };
}

async function main() {
  const bus = await i2c.openPromisified(BUS_NUMBER);
  let sequence = 1;
  try {
    while (true) {
      const request = encodeFrame(sequence++);
      await bus.i2cWrite(I2C_ADDRESS, request.length, request);
      const response = Buffer.alloc(FRAME_LENGTH);
      await bus.i2cRead(I2C_ADDRESS, response.length, response);
      const decoded = decodeFrame(response);
      const sample = decodeGnssPayload(decoded.payload);
      console.log({ flags: decoded.flags, sample });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await bus.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
