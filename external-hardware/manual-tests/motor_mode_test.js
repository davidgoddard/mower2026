// Direct motor mode test for confirming inversion and per-wheel direction.
//
// Modes use physical wheel directions:
// - F = physical wheel forward
// - R = physical wheel reverse
// - 0 = stop
//
// Examples:
// - `node motor_mode_test.js FF`  both wheels physical forward
// - `node motor_mode_test.js FR`  left forward, right reverse
// - `node motor_mode_test.js F0`  left forward only
// - `node motor_mode_test.js 0F`  right forward only
//
// Optional arguments:
// - speed in m/s, default `0.25`
// - duration in ms, default `2000`
//
// Direction mapping is controlled by env vars:
// - `LEFT_FORWARD_SIGN` default `1`
// - `RIGHT_FORWARD_SIGN` default `-1`

import i2c from "i2c-bus";
import { loadSystemParameters } from "./systemConfig.js";

const I2C_ADDRESS = 0x66;
const BUS_NUMBER = 1;

const PROTOCOL_START_OF_FRAME = 0x4d;
const PROTOCOL_VERSION = 0x01;
const NODE_ID_MOTOR = 0x20;
const MESSAGE_TYPE_WHEEL_SPEED_COMMAND = 0x21;
const MESSAGE_TYPE_MOTOR_FEEDBACK = 0x22;

const FEEDBACK_FRAME_SIZE = 9 + 26 + 2;
const SAMPLE_INTERVAL_MS = 200;
const MAX_FRAME_ATTEMPTS = 4;
const RETRY_DELAY_MS = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function encodeFrame(messageType, sequence, payload) {
  const frame = Buffer.alloc(9 + payload.length + 2);
  frame[0] = PROTOCOL_START_OF_FRAME;
  frame[1] = PROTOCOL_VERSION;
  frame[2] = NODE_ID_MOTOR;
  frame[3] = messageType;
  frame[4] = 0;
  frame.writeUInt16LE(sequence, 5);
  frame.writeUInt16LE(payload.length, 7);
  payload.copy(frame, 9);
  frame.writeUInt16LE(crc16Ccitt(frame.subarray(1, 9 + payload.length)), 9 + payload.length);
  return frame;
}

function decodeFrame(frame) {
  if (frame[0] !== PROTOCOL_START_OF_FRAME) {
    throw new Error("bad start-of-frame");
  }
  if (frame[1] !== PROTOCOL_VERSION) {
    throw new Error(`bad protocol version: ${frame[1]}`);
  }
  if (frame[2] !== NODE_ID_MOTOR) {
    throw new Error(`bad node id: ${frame[2]}`);
  }
  if (frame[3] !== MESSAGE_TYPE_MOTOR_FEEDBACK) {
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
    payload: frame.subarray(9, 9 + payloadLength),
  };
}

function encodeWheelSpeedCommand({
  timestampMillis,
  leftWheelTargetMetersPerSecond,
  rightWheelTargetMetersPerSecond,
  enableDrive,
  commandTimeoutMillis,
}) {
  const payload = Buffer.alloc(15);
  payload.writeUInt32LE(timestampMillis >>> 0, 0);
  payload.writeInt16LE(Math.round(leftWheelTargetMetersPerSecond * 1000), 4);
  payload.writeInt16LE(Math.round(rightWheelTargetMetersPerSecond * 1000), 6);
  payload[8] = enableDrive ? 1 : 0;
  payload.writeUInt16LE(commandTimeoutMillis, 9);
  payload.writeUInt16LE(0xffff, 11);
  payload.writeUInt16LE(0xffff, 13);
  return payload;
}

function decodeMotorFeedbackPayload(payload) {
  return {
    timestampMillis: payload.readUInt32LE(0),
    leftWheelActualMetersPerSecond: payload.readInt16LE(4) / 1000,
    rightWheelActualMetersPerSecond: payload.readInt16LE(6) / 1000,
    leftEncoderDelta: payload.readInt32LE(8),
    rightEncoderDelta: payload.readInt32LE(12),
    leftPwmAppliedPercent: payload.readInt8(16),
    rightPwmAppliedPercent: payload.readInt8(17),
    watchdogHealthy: payload[22] === 1,
    faultFlags: payload.readUInt16LE(23),
  };
}

function physicalDirectionToSpeed(direction, speed) {
  if (direction === "F") {
    return speed;
  }
  if (direction === "R") {
    return -speed;
  }
  if (direction === "0") {
    return 0;
  }
  throw new Error(`unsupported direction token: ${direction}`);
}

function toRawWheelTarget(physicalMetersPerSecond, forwardSign) {
  return physicalMetersPerSecond * forwardSign;
}

function toPhysicalWheelSpeed(rawMetersPerSecond, forwardSign) {
  return rawMetersPerSecond * forwardSign;
}

function parseMode(mode, speed, parameters) {
  if (!/^[FR0]{2}$/.test(mode)) {
    throw new Error(`invalid mode "${mode}". Use two characters from F, R, or 0, e.g. FF, FR, F0, 0F.`);
  }

  const leftPhysical = physicalDirectionToSpeed(mode[0], speed);
  const rightPhysical = physicalDirectionToSpeed(mode[1], speed);

  return {
    leftPhysical,
    rightPhysical,
    leftRaw: toRawWheelTarget(leftPhysical, parameters.leftMotorForwardSign),
    rightRaw: toRawWheelTarget(rightPhysical, parameters.rightMotorForwardSign),
  };
}

async function writeFrame(bus, frame) {
  await bus.i2cWrite(I2C_ADDRESS, frame.length, frame);
}

async function sendCommand(bus, sequence, left, right, enableDrive = true) {
  const payload = encodeWheelSpeedCommand({
    timestampMillis: Date.now() >>> 0,
    leftWheelTargetMetersPerSecond: left,
    rightWheelTargetMetersPerSecond: right,
    enableDrive,
    commandTimeoutMillis: 300,
  });
  await writeFrame(bus, encodeFrame(MESSAGE_TYPE_WHEEL_SPEED_COMMAND, sequence, payload));
}

async function requestFeedback(bus, sequence) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_FRAME_ATTEMPTS; attempt += 1) {
    try {
      const requestFrame = encodeFrame(MESSAGE_TYPE_MOTOR_FEEDBACK, sequence, Buffer.alloc(0));
      await writeFrame(bus, requestFrame);
      const response = Buffer.alloc(FEEDBACK_FRAME_SIZE);
      const { bytesRead } = await bus.i2cRead(I2C_ADDRESS, response.length, response);
      if (bytesRead !== response.length) {
        throw new Error(`short read: expected ${response.length}, got ${bytesRead}`);
      }
      return decodeMotorFeedbackPayload(decodeFrame(response).payload);
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
  const { filePath, parameters } = await loadSystemParameters();
  const mode = (process.argv[2] ?? "FF").toUpperCase();
  const speed = Number.parseFloat(process.argv[3] ?? "0.25");
  const durationMs = Number.parseInt(process.argv[4] ?? "2000", 10);
  const rampUpMillis = Math.min(parameters.motorRampUpMillis ?? 0, durationMs);
  const bus = await i2c.openPromisified(BUS_NUMBER);
  const mapping = parseMode(mode, speed, parameters);
  let sequence = 1;

  try {
    console.log("Motor mode test");
    console.log({
      mode,
      speed,
      durationMs,
      rampUpMillis,
      configPath: filePath,
      LEFT_FORWARD_SIGN: parameters.leftMotorForwardSign,
      RIGHT_FORWARD_SIGN: parameters.rightMotorForwardSign,
      leftPhysicalMetersPerSecond: mapping.leftPhysical,
      rightPhysicalMetersPerSecond: mapping.rightPhysical,
      leftRawMetersPerSecond: mapping.leftRaw,
      rightRawMetersPerSecond: mapping.rightRaw,
    });

    const started = Date.now();
    while (Date.now() - started < durationMs) {
      const elapsedMillis = Date.now() - started;
      const rampFactor = rampUpMillis <= 0 ? 1 : clamp(elapsedMillis / rampUpMillis, 0, 1);
      await sendCommand(
        bus,
        sequence++,
        mapping.leftRaw * rampFactor,
        mapping.rightRaw * rampFactor,
        true,
      );
      await sleep(SAMPLE_INTERVAL_MS);
      const feedback = await requestFeedback(bus, sequence++);
      console.log({
        rampFactor: Number(rampFactor.toFixed(2)),
        ...feedback,
        leftWheelActualPhysicalMetersPerSecond: toPhysicalWheelSpeed(feedback.leftWheelActualMetersPerSecond, parameters.leftMotorForwardSign),
        rightWheelActualPhysicalMetersPerSecond: toPhysicalWheelSpeed(feedback.rightWheelActualMetersPerSecond, parameters.rightMotorForwardSign),
      });
    }
  } finally {
    console.log("\n=== stop ===");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sendCommand(bus, sequence++, 0, 0, false);
      await sleep(120);
      const feedback = await requestFeedback(bus, sequence++);
      console.log("stop", {
        ...feedback,
        leftWheelActualPhysicalMetersPerSecond: toPhysicalWheelSpeed(feedback.leftWheelActualMetersPerSecond, parameters.leftMotorForwardSign),
        rightWheelActualPhysicalMetersPerSecond: toPhysicalWheelSpeed(feedback.rightWheelActualMetersPerSecond, parameters.rightMotorForwardSign),
      });
    }
    await bus.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
