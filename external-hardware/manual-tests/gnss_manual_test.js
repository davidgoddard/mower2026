// Pi-side GNSS node poller for manual bring-up.
// Requires the `i2c-bus` package on the Pi.

import i2c from "i2c-bus";
import { decodeGnssSample, gnssPayloadLength } from "../../dist/gnss/gnssCodec.js";

const BUS_NUMBER = 1;
const I2C_ADDRESS = 0x52;

const PROTOCOL_START_OF_FRAME = 0x4d;
const PROTOCOL_VERSION = 0x01;
const NODE_ID_GNSS = 0x10;
const MESSAGE_TYPE_GNSS_SAMPLE = 0x01;
const FRAME_HEADER_SIZE = 9;
const FRAME_CRC_SIZE = 2;
const GNSS_PAYLOAD_LENGTH_V1 = 36;
const VALID_PAYLOAD_LENGTHS = new Set([GNSS_PAYLOAD_LENGTH_V1, gnssPayloadLength()]);
const FRAME_LENGTH = FRAME_HEADER_SIZE + Math.max(...VALID_PAYLOAD_LENGTHS) + FRAME_CRC_SIZE;
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
  if (!VALID_PAYLOAD_LENGTHS.has(payloadLength)) {
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

function optionalAge(value) {
  return value == null || value === 0xffff ? null : value;
}

function describeFixType(fixType) {
  switch (fixType) {
    case "none":
    case "single":
    case "float":
    case "fixed":
      return fixType;
    default:
      return `unknown(${fixType})`;
  }
}

function classifySample(sample) {
  const notes = [];
  const debug = sample.debug ?? {};

  if (sample.fixType === "none" || sample.fixType === "single") {
    notes.push("Indoor testing may legitimately show no fix or only single-point GNSS.");
  }

  if (sample.headingDegrees === undefined) {
    notes.push("Missing heading is expected indoors or when dual-antenna heading is not currently usable.");
  }

  if (sample.sampleAgeMillis > 2000) {
    notes.push(`GNSS sample age is high (${sample.sampleAgeMillis} ms).`);
  }

  const receiverLineAgeMillis = optionalAge(debug.receiverLineAgeMillis);
  const pvtslnaAgeMillis = optionalAge(debug.pvtslnaAgeMillis);
  const uniheadingAgeMillis = optionalAge(debug.uniheadingAgeMillis);
  const rtcmAgeMillis = optionalAge(debug.rtcmAgeMillis);
  const logConfigMask = debug.logConfigMask ?? 0;

  if (receiverLineAgeMillis == null) {
    notes.push("No receiver lines have been seen by the rover ESP.");
  } else if (receiverLineAgeMillis > 2000) {
    notes.push(`Receiver output is stale (${receiverLineAgeMillis} ms since any UM982 line).`);
  }

  if (pvtslnaAgeMillis == null) {
    notes.push("No PVTSLNA position logs have been parsed yet.");
  }

  if (uniheadingAgeMillis == null) {
    notes.push("No UNIHEADINGA heading logs have been parsed yet.");
  }

  if (rtcmAgeMillis == null) {
    notes.push("No RTCM corrections have been forwarded to the rover receiver yet.");
  }

  if ((logConfigMask & 0x07) === 0x07) {
    notes.push("Receiver log verification passed: PVTSLNA, RECTIMEA, and UNIHEADINGA are active on COM2.");
  } else if (logConfigMask !== 0) {
    notes.push(`Receiver log verification is partial (mask 0x${logConfigMask.toString(16)}).`);
  } else {
    notes.push("Receiver log verification has not yet confirmed the expected COM2 logs.");
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
        sample: decodeGnssSample(decoded.payload),
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
        const debug = result.sample.debug ?? {};
        console.log({
          flags: result.flags,
          commsHealthy: classification.commsHealthy,
          fixTypeLabel: describeFixType(result.sample.fixType),
          sample: {
            ...result.sample,
            debug: {
              receiverLineAgeMillis: optionalAge(debug.receiverLineAgeMillis),
              pvtslnaAgeMillis: optionalAge(debug.pvtslnaAgeMillis),
              uniheadingAgeMillis: optionalAge(debug.uniheadingAgeMillis),
              rtcmAgeMillis: optionalAge(debug.rtcmAgeMillis),
              logConfigMask: debug.logConfigMask,
            },
          },
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
