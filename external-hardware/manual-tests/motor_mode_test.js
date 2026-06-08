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
// - `LEFT_FORWARD_SIGN` default `-1`
// - `RIGHT_FORWARD_SIGN` default `-1`
//
// Optional ramp-limit env vars:
// - `MOTOR_MODE_MAX_ACCEL`  acceleration limit in normalized output per second
// - `MOTOR_MODE_MAX_DECEL`  deceleration limit in normalized output per second

import i2c from "i2c-bus";

const I2C_ADDRESS = 0x66;
const BUS_NUMBER = 1;

const PROTOCOL_START_OF_FRAME = 0x4d;
const PROTOCOL_VERSION = 0x01;
const NODE_ID_MOTOR = 0x20;
const MESSAGE_TYPE_WHEEL_SPEED_COMMAND = 0x21;
const MESSAGE_TYPE_MOTOR_FEEDBACK = 0x22;

const FEEDBACK_PAYLOAD_SIZE = 22;
const FEEDBACK_FRAME_SIZE = 9 + FEEDBACK_PAYLOAD_SIZE + 2;
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
  if (payloadLength !== FEEDBACK_PAYLOAD_SIZE) {
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
  maxAccelerationMetersPerSecondSquared,
  maxDecelerationMetersPerSecondSquared,
}) {
  const payload = Buffer.alloc(15);
  payload.writeUInt32LE(timestampMillis >>> 0, 0);
  payload.writeInt16LE(Math.round(leftWheelTargetMetersPerSecond * 1000), 4);
  payload.writeInt16LE(Math.round(rightWheelTargetMetersPerSecond * 1000), 6);
  payload[8] = enableDrive ? 1 : 0;
  payload.writeUInt16LE(commandTimeoutMillis, 9);
  payload.writeUInt16LE(
    maxAccelerationMetersPerSecondSquared == null
      ? 0xffff
      : clamp(Math.round(maxAccelerationMetersPerSecondSquared * 1000), 0, 0xffff),
    11,
  );
  payload.writeUInt16LE(
    maxDecelerationMetersPerSecondSquared == null
      ? 0xffff
      : clamp(Math.round(maxDecelerationMetersPerSecondSquared * 1000), 0, 0xffff),
    13,
  );
  return payload;
}

function decodeMotorFeedbackPayload(payload) {
  return {
    timestampMillis: payload.readUInt32LE(0),
    leftEncoderDelta: payload.readInt32LE(4),
    rightEncoderDelta: payload.readInt32LE(8),
    leftPwmAppliedPercent: payload.readInt8(12),
    rightPwmAppliedPercent: payload.readInt8(13),
    leftMotorCurrentAmps: payload.readUInt16LE(14) === 0xffff ? null : payload.readUInt16LE(14) / 10,
    rightMotorCurrentAmps: payload.readUInt16LE(16) === 0xffff ? null : payload.readUInt16LE(16) / 10,
    watchdogHealthy: payload[18] === 1,
    faultFlags: payload.readUInt16LE(19),
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

function parseMotorSign(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (parsed !== -1 && parsed !== 1) {
    throw new Error(`Invalid ${name}="${raw}". Expected -1 or 1.`);
  }
  return parsed;
}

function parseOptionalPositiveNumber(name) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return undefined;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}="${raw}". Expected a positive number.`);
  }
  return parsed;
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

async function sendCommand(bus, sequence, left, right, enableDrive = true, limits = {}) {
  const payload = encodeWheelSpeedCommand({
    timestampMillis: Date.now() >>> 0,
    leftWheelTargetMetersPerSecond: left,
    rightWheelTargetMetersPerSecond: right,
    enableDrive,
    commandTimeoutMillis: 600,
    ...limits,
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
  const mode = (process.argv[2] ?? "FF").toUpperCase();
  const speed = Number.parseFloat(process.argv[3] ?? "0.25");
  const durationMs = Number.parseInt(process.argv[4] ?? "2000", 10);
  const parameters = {
    leftMotorForwardSign: parseMotorSign("LEFT_FORWARD_SIGN", -1),
    rightMotorForwardSign: parseMotorSign("RIGHT_FORWARD_SIGN", -1),
  };
  const maxAccelerationMetersPerSecondSquared = parseOptionalPositiveNumber("MOTOR_MODE_MAX_ACCEL");
  const maxDecelerationMetersPerSecondSquared = parseOptionalPositiveNumber("MOTOR_MODE_MAX_DECEL");
  const limits = {
    ...(maxAccelerationMetersPerSecondSquared === undefined ? {} : { maxAccelerationMetersPerSecondSquared }),
    ...(maxDecelerationMetersPerSecondSquared === undefined ? {} : { maxDecelerationMetersPerSecondSquared }),
  };
  const bus = await i2c.openPromisified(BUS_NUMBER);
  const mapping = parseMode(mode, speed, parameters);
  let sequence = 1;

  try {
    console.log("Motor mode test");
    console.log({
      mode,
      speed,
      durationMs,
      LEFT_FORWARD_SIGN: parameters.leftMotorForwardSign,
      RIGHT_FORWARD_SIGN: parameters.rightMotorForwardSign,
      leftPhysicalMetersPerSecond: mapping.leftPhysical,
      rightPhysicalMetersPerSecond: mapping.rightPhysical,
      leftRawMetersPerSecond: mapping.leftRaw,
      rightRawMetersPerSecond: mapping.rightRaw,
      ...limits,
    });

    const started = Date.now();
    while (Date.now() - started < durationMs) {
      await sendCommand(
        bus,
        sequence++,
        mapping.leftRaw,
        mapping.rightRaw,
        true,
        limits,
      );
      await sleep(SAMPLE_INTERVAL_MS);
      const feedback = await requestFeedback(bus, sequence++);
      console.log({
        ...feedback,
        leftEncoderDirection: Math.sign(feedback.leftEncoderDelta) * parameters.leftMotorForwardSign,
        rightEncoderDirection: Math.sign(feedback.rightEncoderDelta) * parameters.rightMotorForwardSign,
      });
    }
  } finally {
    console.log("\n=== stop ===");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sendCommand(bus, sequence++, 0, 0, true, limits);
      await sleep(120);
      const feedback = await requestFeedback(bus, sequence++);
      console.log("stop", {
        ...feedback,
        leftEncoderDirection: Math.sign(feedback.leftEncoderDelta) * parameters.leftMotorForwardSign,
        rightEncoderDirection: Math.sign(feedback.rightEncoderDelta) * parameters.rightMotorForwardSign,
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
