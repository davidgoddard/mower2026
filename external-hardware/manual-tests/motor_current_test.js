import i2c from "i2c-bus";
import { loadSystemParameters } from "./systemConfig.js";

const I2C_ADDRESS = 0x66;
const BUS_NUMBER = 1;

const PROTOCOL_START_OF_FRAME = 0x4d;
const PROTOCOL_VERSION = 0x01;
const NODE_ID_MOTOR = 0x20;
const MESSAGE_TYPE_WHEEL_SPEED_COMMAND = 0x21;
const MESSAGE_TYPE_MOTOR_FEEDBACK = 0x22;

const FEEDBACK_PAYLOAD_SIZE = 22;
const FEEDBACK_FRAME_SIZE = 9 + FEEDBACK_PAYLOAD_SIZE + 2;
const SAMPLE_INTERVAL_MS = 100;
const MAX_FRAME_ATTEMPTS = 4;
const RETRY_DELAY_MS = 60;
const DEFAULT_FORWARD_DURATION_MS = 3000;
const DEFAULT_TURN_DURATION_MS = 2000;
const DEFAULT_SETTLE_DURATION_MS = 300;

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
  const rightCurrentRaw = payload.readUInt16LE(16);
  return {
    timestampMillis: payload.readUInt32LE(0),
    leftEncoderDelta: payload.readInt32LE(4),
    rightEncoderDelta: payload.readInt32LE(8),
    leftPwmAppliedPercent: payload.readInt8(12),
    rightPwmAppliedPercent: payload.readInt8(13),
    leftMotorCurrentAmps: payload.readUInt16LE(14) === 0xffff ? null : payload.readUInt16LE(14) / 10,
    rightMotorCurrentAmps: rightCurrentRaw === 0xffff ? null : rightCurrentRaw / 10,
    watchdogHealthy: payload[18] === 1,
    faultFlags: payload.readUInt16LE(19),
  };
}

function toRawWheelTarget(physicalMetersPerSecond, forwardSign) {
  return physicalMetersPerSecond * forwardSign;
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function peak(values) {
  return values.length === 0 ? 0 : Math.max(...values);
}

function summarisePhase(label, leftCurrents, rightCurrents, samples) {
  return {
    label,
    sampleCount: samples,
    leftMeanCurrentAmps: Number(average(leftCurrents).toFixed(3)),
    rightMeanCurrentAmps: Number(average(rightCurrents).toFixed(3)),
    leftPeakCurrentAmps: Number(peak(leftCurrents).toFixed(3)),
    rightPeakCurrentAmps: Number(peak(rightCurrents).toFixed(3)),
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

async function runPhase(bus, startSequence, phase) {
  let sequence = startSequence;
  const leftCurrents = [];
  const rightCurrents = [];
  let samples = 0;
  const started = Date.now();

  while ((Date.now() - started) < phase.durationMs) {
    await sendCommand(bus, sequence++, phase.leftRaw, phase.rightRaw, true);
    const feedback = await requestFeedback(bus, sequence++);
    if (feedback.leftMotorCurrentAmps != null) {
      leftCurrents.push(feedback.leftMotorCurrentAmps);
    }
    if (feedback.rightMotorCurrentAmps != null) {
      rightCurrents.push(feedback.rightMotorCurrentAmps);
    }
    samples += 1;
    await sleep(SAMPLE_INTERVAL_MS);
  }

  await sendCommand(bus, sequence++, 0, 0, false);
  await sleep(DEFAULT_SETTLE_DURATION_MS);

  return {
    sequence,
    summary: summarisePhase(phase.label, leftCurrents, rightCurrents, samples),
    leftCurrents,
    rightCurrents,
  };
}

async function main() {
  const { filePath, parameters } = await loadSystemParameters();
  const forwardDurationMs = Number.parseInt(process.argv[2] ?? `${DEFAULT_FORWARD_DURATION_MS}`, 10);
  const turnDurationMs = Number.parseInt(process.argv[3] ?? `${DEFAULT_TURN_DURATION_MS}`, 10);
  const speed = parameters.maxWheelSpeedMetersPerSecond;
  const bus = await i2c.openPromisified(BUS_NUMBER);
  let sequence = 1;
  const allLeftCurrents = [];
  const allRightCurrents = [];
  const phaseSummaries = [];

  const phases = [
    {
      label: "forward-1",
      durationMs: forwardDurationMs,
      leftRaw: toRawWheelTarget(speed, parameters.leftMotorForwardSign),
      rightRaw: toRawWheelTarget(speed, parameters.rightMotorForwardSign),
    },
    {
      label: "turn-left-180-ish",
      durationMs: turnDurationMs,
      leftRaw: toRawWheelTarget(-speed, parameters.leftMotorForwardSign),
      rightRaw: toRawWheelTarget(speed, parameters.rightMotorForwardSign),
    },
    {
      label: "forward-2",
      durationMs: forwardDurationMs,
      leftRaw: toRawWheelTarget(speed, parameters.leftMotorForwardSign),
      rightRaw: toRawWheelTarget(speed, parameters.rightMotorForwardSign),
    },
    {
      label: "turn-right-180-ish",
      durationMs: turnDurationMs,
      leftRaw: toRawWheelTarget(speed, parameters.leftMotorForwardSign),
      rightRaw: toRawWheelTarget(-speed, parameters.rightMotorForwardSign),
    },
  ];

  try {
    console.log("Motor current test");
    console.log({
      configPath: filePath,
      maxWheelSpeedMetersPerSecond: speed,
      forwardDurationMs,
      turnDurationMs,
      phases,
    });

    for (const phase of phases) {
      console.log(`\n=== ${phase.label} ===`);
      const result = await runPhase(bus, sequence, phase);
      sequence = result.sequence;
      phaseSummaries.push(result.summary);
      allLeftCurrents.push(...result.leftCurrents);
      allRightCurrents.push(...result.rightCurrents);
      console.log(result.summary);
    }
  } finally {
    try {
      await sendCommand(bus, sequence++, 0, 0, false);
      await sleep(100);
    } finally {
      await bus.close();
    }
  }

  const summary = {
    forwardDurationMs,
    turnDurationMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    leftSamples: allLeftCurrents.length,
    rightSamples: allRightCurrents.length,
    leftMeanCurrentAmps: Number(average(allLeftCurrents).toFixed(3)),
    rightMeanCurrentAmps: Number(average(allRightCurrents).toFixed(3)),
    leftPeakCurrentAmps: Number(peak(allLeftCurrents).toFixed(3)),
    rightPeakCurrentAmps: Number(peak(allRightCurrents).toFixed(3)),
    phases: phaseSummaries,
  };

  console.log("\nCurrent summary");
  console.log(summary);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
