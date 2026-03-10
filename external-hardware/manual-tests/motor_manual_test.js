"use strict";

// Manual Pi-side exerciser for the second-generation motor ESP protocol.
// Requires the `i2c-bus` Node package on the Pi.

const i2c = require("i2c-bus");

const I2C_ADDRESS = 0x66;
const BUS_NUMBER = 1;

const PROTOCOL_START_OF_FRAME = 0x4d;
const PROTOCOL_VERSION = 0x01;
const NODE_ID_MOTOR = 0x20;
const MESSAGE_TYPE_WHEEL_SPEED_COMMAND = 0x21;
const MESSAGE_TYPE_MOTOR_FEEDBACK = 0x22;

const FEEDBACK_FRAME_SIZE = 9 + 26 + 2;

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
  const payloadLength = frame.readUInt16LE(7);
  const crc = frame.readUInt16LE(9 + payloadLength);
  const expected = crc16Ccitt(frame.subarray(1, 9 + payloadLength));
  if (crc !== expected) {
    throw new Error("bad crc");
  }
  return {
    messageType: frame[3],
    sequence: frame.readUInt16LE(5),
    flags: frame[4],
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
    maxAccelerationMetersPerSecondSquared == null ? 0xffff : Math.round(maxAccelerationMetersPerSecondSquared * 1000),
    11,
  );
  payload.writeUInt16LE(
    maxDecelerationMetersPerSecondSquared == null ? 0xffff : Math.round(maxDecelerationMetersPerSecondSquared * 1000),
    13,
  );
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

async function writeFrame(bus, frame) {
  await bus.i2cWrite(I2C_ADDRESS, frame.length, frame);
}

async function requestFeedback(bus, sequence) {
  const requestFrame = encodeFrame(MESSAGE_TYPE_MOTOR_FEEDBACK, sequence, Buffer.alloc(0));
  await writeFrame(bus, requestFrame);
  const response = Buffer.alloc(FEEDBACK_FRAME_SIZE);
  await bus.i2cRead(I2C_ADDRESS, response.length, response);
  const decoded = decodeFrame(response);
  return decodeMotorFeedbackPayload(decoded.payload);
}

async function sendCommand(bus, sequence, left, right, enableDrive = true) {
  const payload = encodeWheelSpeedCommand({
    timestampMillis: Date.now() >>> 0,
    leftWheelTargetMetersPerSecond: left,
    rightWheelTargetMetersPerSecond: right,
    enableDrive,
    commandTimeoutMillis: 300,
    maxAccelerationMetersPerSecondSquared: 0.5,
    maxDecelerationMetersPerSecondSquared: 1.0,
  });
  await writeFrame(bus, encodeFrame(MESSAGE_TYPE_WHEEL_SPEED_COMMAND, sequence, payload));
}

async function runStep(bus, sequenceStart, label, left, right, durationMs) {
  console.log(`\n=== ${label} ===`);
  const started = Date.now();
  let sequence = sequenceStart;
  while (Date.now() - started < durationMs) {
    await sendCommand(bus, sequence++, left, right, true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const feedback = await requestFeedback(bus, sequence++);
    console.log(label, feedback);
  }
  return sequence;
}

async function stop(bus, sequence) {
  await sendCommand(bus, sequence, 0, 0, false);
}

async function main() {
  const bus = await i2c.openPromisified(BUS_NUMBER);
  let sequence = 1;
  try {
    sequence = await runStep(bus, sequence, "spin-right", 0.30, -0.30, 2000);
    sequence = await runStep(bus, sequence, "spin-left", -0.30, 0.30, 2000);
    sequence = await runStep(bus, sequence, "forward", 0.35, 0.35, 2500);
    sequence = await runStep(bus, sequence, "backward", -0.25, -0.25, 2000);
    sequence = await runStep(bus, sequence, "swap-forward-back", 0.25, 0.25, 1200);
    sequence = await runStep(bus, sequence, "swap-backward-forward", -0.25, -0.25, 1200);
    sequence = await runStep(bus, sequence, "arc-left", 0.35, 0.20, 2500);
    sequence = await runStep(bus, sequence, "arc-right", 0.20, 0.35, 2500);
  } finally {
    await stop(bus, sequence++);
    await bus.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
