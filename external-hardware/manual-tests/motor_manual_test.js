// Manual Pi-side exerciser for the second-generation motor ESP protocol.
// Requires the `i2c-bus` Node package on the Pi.
//
// This script works in physical wheel directions rather than raw motor signs.
// Configure the sign mapping below so a positive physical wheel target means
// "vehicle forward" for each side even if the motors are mirrored.

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
const STEADY_STATE_IGNORE_SAMPLES = 2;
const MAX_FRAME_ATTEMPTS = 4;
const RETRY_DELAY_MS = 60;

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
    messageType: frame[3],
    sequence: frame.readUInt16LE(5),
    flags: frame[4],
    payload: frame.subarray(9, 9 + payloadLength),
  };
}

function formatHex(buffer, length = buffer.length) {
  return Array.from(buffer.subarray(0, length))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRawWheelTarget(physicalMetersPerSecond, forwardSign) {
  return physicalMetersPerSecond * forwardSign;
}

function toPhysicalWheelSpeed(rawMetersPerSecond, forwardSign) {
  return rawMetersPerSecond * forwardSign;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summariseStep(label, leftTargetPhysical, rightTargetPhysical, samples) {
  const steadySamples = samples.slice(Math.min(STEADY_STATE_IGNORE_SAMPLES, samples.length));

  if (steadySamples.length === 0) {
    return {
      label,
      leftTargetPhysical,
      rightTargetPhysical,
      sampleCount: samples.length,
      steadySampleCount: 0,
      note: "No steady-state samples collected.",
    };
  }

  const leftActualAverage = average(steadySamples.map((sample) => sample.leftWheelActualPhysicalMetersPerSecond));
  const rightActualAverage = average(steadySamples.map((sample) => sample.rightWheelActualPhysicalMetersPerSecond));
  const leftPwmAverage = average(steadySamples.map((sample) => sample.leftPwmAppliedPercent));
  const rightPwmAverage = average(steadySamples.map((sample) => sample.rightPwmAppliedPercent));
  const leftAbsActual = Math.abs(leftActualAverage);
  const rightAbsActual = Math.abs(rightActualAverage);

  return {
    label,
    leftTargetPhysical,
    rightTargetPhysical,
    sampleCount: samples.length,
    steadySampleCount: steadySamples.length,
    leftActualPhysicalAverage: Number(leftActualAverage.toFixed(3)),
    rightActualPhysicalAverage: Number(rightActualAverage.toFixed(3)),
    leftError: Number((leftActualAverage - leftTargetPhysical).toFixed(3)),
    rightError: Number((rightActualAverage - rightTargetPhysical).toFixed(3)),
    leftPwmAverage: Number(leftPwmAverage.toFixed(1)),
    rightPwmAverage: Number(rightPwmAverage.toFixed(1)),
    achievedSpeedRatio:
      leftAbsActual > 0 && rightAbsActual > 0 ? Number((rightAbsActual / leftAbsActual).toFixed(3)) : null,
    pwmRatio:
      Math.abs(leftPwmAverage) > 0 && Math.abs(rightPwmAverage) > 0
        ? Number((Math.abs(rightPwmAverage) / Math.abs(leftPwmAverage)).toFixed(3))
        : null,
    suggestedRightScaleVsLeft:
      leftAbsActual > 0 && rightAbsActual > 0 ? Number((leftAbsActual / rightAbsActual).toFixed(3)) : null,
  };
}

function printStepSummary(summary) {
  console.log(`\n${summary.label} summary`);
  console.log(summary);
  if (summary.suggestedRightScaleVsLeft != null) {
    console.log(
      `Suggested right-side feed-forward scale relative to left: ${summary.suggestedRightScaleVsLeft} (1.000 means balanced).`,
    );
  }
}

async function writeFrame(bus, frame) {
  await bus.i2cWrite(I2C_ADDRESS, frame.length, frame);
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
        throw new Error(`short read from motor node: expected ${response.length}, got ${bytesRead}; bytes=${formatHex(response, bytesRead)}`);
      }

      let decoded;
      try {
        decoded = decodeFrame(response);
      } catch (error) {
        throw new Error(`invalid response frame from motor node: bytes=${formatHex(response)}; ${error instanceof Error ? error.message : String(error)}`);
      }
      return decodeMotorFeedbackPayload(decoded.payload);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FRAME_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

async function runStep(bus, sequenceStart, mapping, label, leftTargetPhysical, rightTargetPhysical, durationMs) {
  console.log(`\n=== ${label} ===`);
  const leftTargetRaw = toRawWheelTarget(leftTargetPhysical, mapping.leftMotorForwardSign);
  const rightTargetRaw = toRawWheelTarget(rightTargetPhysical, mapping.rightMotorForwardSign);
  const started = Date.now();
  let sequence = sequenceStart;
  const samples = [];
  while (Date.now() - started < durationMs) {
    await sendCommand(bus, sequence++, leftTargetRaw, rightTargetRaw, true);
    await sleep(SAMPLE_INTERVAL_MS);
    const feedback = await requestFeedback(bus, sequence++);
    const sample = {
      ...feedback,
      leftWheelTargetPhysicalMetersPerSecond: leftTargetPhysical,
      rightWheelTargetPhysicalMetersPerSecond: rightTargetPhysical,
      leftWheelTargetRawMetersPerSecond: leftTargetRaw,
      rightWheelTargetRawMetersPerSecond: rightTargetRaw,
      leftWheelActualPhysicalMetersPerSecond: toPhysicalWheelSpeed(feedback.leftWheelActualMetersPerSecond, mapping.leftMotorForwardSign),
      rightWheelActualPhysicalMetersPerSecond: toPhysicalWheelSpeed(feedback.rightWheelActualMetersPerSecond, mapping.rightMotorForwardSign),
    };
    samples.push(sample);
    console.log(label, sample);
  }
  printStepSummary(summariseStep(label, leftTargetPhysical, rightTargetPhysical, samples));
  return sequence;
}

async function stop(bus, sequence) {
  let activeSequence = sequence;
  console.log("\n=== stop ===");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sendCommand(bus, activeSequence++, 0, 0, false);
    await sleep(120);
    const feedback = await requestFeedback(bus, activeSequence++);
    console.log("stop", feedback);
  }
  return activeSequence;
}

async function main() {
  const { filePath, parameters } = await loadSystemParameters();
  const bus = await i2c.openPromisified(BUS_NUMBER);
  let sequence = 1;
  try {
    console.log("Physical wheel direction mapping:");
    console.log({
      configPath: filePath,
      LEFT_FORWARD_SIGN: parameters.leftMotorForwardSign,
      RIGHT_FORWARD_SIGN: parameters.rightMotorForwardSign,
      note: "Raw command = physical wheel target * forward sign",
    });

    sequence = await runStep(bus, sequence, parameters, "spin-right", 0.30, -0.30, 2000);
    sequence = await runStep(bus, sequence, parameters, "spin-left", -0.30, 0.30, 2000);
    sequence = await runStep(bus, sequence, parameters, "vehicle-forward", 0.35, 0.35, 2500);
    sequence = await runStep(bus, sequence, parameters, "vehicle-backward", -0.25, -0.25, 2000);
    sequence = await runStep(bus, sequence, parameters, "swap-forward-back", 0.25, 0.25, 1200);
    sequence = await runStep(bus, sequence, parameters, "swap-backward-forward", -0.25, -0.25, 1200);
    sequence = await runStep(bus, sequence, parameters, "arc-left", 0.35, 0.20, 2500);
    sequence = await runStep(bus, sequence, parameters, "arc-right", 0.20, 0.35, 2500);
  } finally {
    sequence = await stop(bus, sequence++);
    await bus.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
