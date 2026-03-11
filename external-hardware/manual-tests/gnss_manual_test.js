// Pi-side GNSS node poller for manual bring-up.
// Requires the `i2c-bus` package on the Pi.

import i2c from "i2c-bus";

const BUS_NUMBER = 1;
const I2C_ADDRESS = 0x52;

const PROTOCOL_START_OF_FRAME = 0x4d;
const PROTOCOL_VERSION = 0x01;
const NODE_ID_GNSS = 0x10;
const MESSAGE_TYPE_GNSS_SAMPLE = 0x01;
const FRAME_LENGTH = 9 + 26 + 2;
const SAMPLE_INTERVAL_MS = 500;
const MAX_FRAME_ATTEMPTS = 4;
const RETRY_DELAY_MS = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (frame[1] !== PROTOCOL_VERSION) {
    throw new Error(`bad protocol version: ${frame[1]}`);
  }
  if (frame[2] !== NODE_ID_GNSS) {
    throw new Error(`bad node id: ${frame[2]}`);
  }
  if (frame[3] !== MESSAGE_TYPE_GNSS_SAMPLE) {
    throw new Error(`bad message type: ${frame[3]}`);
  }
  const payloadLength = frame.readUInt16LE(7);
  if (payloadLength !== 26) {
    throw new Error(`bad payload length: ${payloadLength}`);
  }
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

function describeFixType(fixType) {
  switch (fixType) {
    case 0:
      return "none";
    case 1:
      return "single";
    case 2:
      return "float";
    case 3:
      return "fixed";
    default:
      return `unknown(${fixType})`;
  }
}

function classifySample(sample) {
  const notes = [];

  if (sample.fixType <= 1) {
    notes.push("Indoor testing may legitimately show no fix or only single-point GNSS.");
  }

  if (sample.headingDegrees == null) {
    notes.push("Missing heading is expected indoors or when dual-antenna heading is not currently usable.");
  }

  if (sample.sampleAgeMillis > 2000) {
    notes.push(`GNSS sample age is high (${sample.sampleAgeMillis} ms).`);
  }

  return {
    commsHealthy: sample.timestampMillis > 0,
    notes,
  };
}

async function requestSample(bus, sequence) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_FRAME_ATTEMPTS; attempt += 1) {
    try {
      const request = encodeFrame(sequence);
      await bus.i2cWrite(I2C_ADDRESS, request.length, request);
      const response = Buffer.alloc(FRAME_LENGTH);
      const { bytesRead } = await bus.i2cRead(I2C_ADDRESS, response.length, response);
      if (bytesRead !== response.length) {
        throw new Error(`short read: expected ${response.length}, got ${bytesRead}`);
      }
      const decoded = decodeFrame(response);
      return {
        flags: decoded.flags,
        sample: decodeGnssPayload(decoded.payload),
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FRAME_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  const bus = await i2c.openPromisified(BUS_NUMBER);
  let sequence = 1;
  let invalidReads = 0;
  try {
    console.log("Running GNSS comms test.");
    console.log("Indoor operation is expected to have weak or unusable GNSS fix quality. This test is primarily checking framed sample comms from the GNSS node.\n");

    while (true) {
      try {
        const result = await requestSample(bus, sequence++);
        const classification = classifySample(result.sample);
        console.log({
          flags: result.flags,
          commsHealthy: classification.commsHealthy,
          fixTypeLabel: describeFixType(result.sample.fixType),
          sample: result.sample,
          notes: classification.notes,
          invalidReads,
        });
      } catch (error) {
        invalidReads += 1;
        console.warn(`Discarded invalid GNSS sample: ${error instanceof Error ? error.message : String(error)}`);
      }

      await sleep(SAMPLE_INTERVAL_MS);
    }
  } finally {
    await bus.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
