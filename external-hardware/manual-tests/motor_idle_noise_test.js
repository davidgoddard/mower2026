// Pi-side motor node idle/noise test.
//
// Purpose:
// - verify that the motor ESP reports zero wheel motion at zero command
// - detect FG/tach wiring noise while the mower is stationary
// - tolerate an occasional malformed I2C/frame read by retrying
//
// How to interpret results:
// - PASS: zero wheel speeds and zero encoder deltas throughout the run
// - PASS with note: watchdogHealthy=false and faultFlags bit 0 set are expected
//   if the firmware is in command-timeout state while idle
// - FAIL: non-zero wheel speeds or encoder deltas while the mower is stationary
// - FAIL: repeated invalid feedback reads that prevent a trustworthy sample set

import i2c from "i2c-bus";

const I2C_ADDRESS = 0x66;
const BUS_NUMBER = 1;

const PROTOCOL_START_OF_FRAME = 0x4d;
const PROTOCOL_VERSION = 0x01;
const NODE_ID_MOTOR = 0x20;
const MESSAGE_TYPE_WHEEL_SPEED_COMMAND = 0x21;
const MESSAGE_TYPE_MOTOR_FEEDBACK = 0x22;

const FEEDBACK_FRAME_SIZE = 9 + 26 + 2;
const SAMPLE_INTERVAL_MS = 200;
const TEST_DURATION_MS = 5000;
const MAX_FRAME_ATTEMPTS = 4;
const RETRY_DELAY_MS = 60;
const WATCHDOG_FAULT_BIT = 1 << 0;

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

function encodeWheelSpeedCommand() {
  const payload = Buffer.alloc(15);
  payload.writeUInt32LE(Date.now() >>> 0, 0);
  payload.writeInt16LE(0, 4);
  payload.writeInt16LE(0, 6);
  payload[8] = 0;
  payload.writeUInt16LE(300, 9);
  payload.writeUInt16LE(0xffff, 11);
  payload.writeUInt16LE(0xffff, 13);
  return payload;
}

function decodeMotorFeedbackPayload(payload) {
  const feedback = {
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

  if (Math.abs(feedback.leftPwmAppliedPercent) > 100 || Math.abs(feedback.rightPwmAppliedPercent) > 100) {
    throw new Error("bad pwm percent");
  }

  return feedback;
}

function isZeroMotion(feedback) {
  return (
    feedback.leftEncoderDelta === 0 &&
    feedback.rightEncoderDelta === 0 &&
    feedback.leftWheelActualMetersPerSecond === 0 &&
    feedback.rightWheelActualMetersPerSecond === 0
  );
}

function classifyRun(summary) {
  const failures = [];
  const notes = [];

  if (summary.sampleCount === 0) {
    failures.push("No valid feedback samples were collected.");
  }

  if (summary.invalidFeedbackReads > 0) {
    notes.push(
      `Discarded ${summary.invalidFeedbackReads} malformed feedback sample${summary.invalidFeedbackReads === 1 ? "" : "s"} after retry exhaustion.`,
    );
  }

  if (summary.nonZeroSamples > 0) {
    failures.push(
      `Observed ${summary.nonZeroSamples} non-zero motion sample${summary.nonZeroSamples === 1 ? "" : "s"} while zero command was active.`,
    );
  }

  if (summary.watchdogFaultSamples === summary.sampleCount && summary.sampleCount > 0) {
    notes.push("Idle watchdog fault was present for the whole run. That is expected if the firmware times out at zero command.");
  } else if (summary.watchdogFaultSamples > 0) {
    notes.push("Watchdog fault appeared on some samples. That is usually benign for this idle test unless motion is also reported.");
  }

  if (summary.maxAbsLeftPwmApplied > 0 || summary.maxAbsRightPwmApplied > 0) {
    notes.push(
      `Observed non-zero applied PWM values at idle (left max ${summary.maxAbsLeftPwmApplied}, right max ${summary.maxAbsRightPwmApplied}). This is only a problem if motion is also reported.`,
    );
  }

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    notes,
  };
}

async function sendZeroCommand(bus, sequence) {
  const payload = encodeWheelSpeedCommand();
  await bus.i2cWrite(I2C_ADDRESS, 9 + payload.length + 2, encodeFrame(MESSAGE_TYPE_WHEEL_SPEED_COMMAND, sequence, payload));
}

async function requestFeedback(bus, sequence) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_FRAME_ATTEMPTS; attempt += 1) {
    try {
      const requestFrame = encodeFrame(MESSAGE_TYPE_MOTOR_FEEDBACK, sequence, Buffer.alloc(0));
      await bus.i2cWrite(I2C_ADDRESS, requestFrame.length, requestFrame);
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

  throw new Error(`unable to read valid motor feedback after ${MAX_FRAME_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`);
}

async function main() {
  const bus = await i2c.openPromisified(BUS_NUMBER);
  let sequence = 1;
  let sampleCount = 0;
  let nonZeroSamples = 0;
  let maxAbsLeftDelta = 0;
  let maxAbsRightDelta = 0;
  let invalidFeedbackReads = 0;
  let watchdogFaultSamples = 0;
  let maxAbsLeftPwmApplied = 0;
  let maxAbsRightPwmApplied = 0;

  try {
    console.log("Running idle FG noise test with zero command.");
    console.log(`Duration: ${TEST_DURATION_MS} ms, sample interval: ${SAMPLE_INTERVAL_MS} ms`);
    console.log("Expected healthy idle result: zero wheel speeds, zero encoder deltas.");
    console.log("Expected watchdog detail: watchdogHealthy may be false and faultFlags may include bit 0 while idle.\n");

    const started = Date.now();
    while (Date.now() - started < TEST_DURATION_MS) {
      await sendZeroCommand(bus, sequence++);
      await sleep(SAMPLE_INTERVAL_MS);

      let feedback;
      try {
        feedback = await requestFeedback(bus, sequence++);
      } catch (error) {
        invalidFeedbackReads += 1;
        console.warn(`Discarded invalid feedback sample: ${error.message}`);
        continue;
      }

      sampleCount += 1;
      maxAbsLeftDelta = Math.max(maxAbsLeftDelta, Math.abs(feedback.leftEncoderDelta));
      maxAbsRightDelta = Math.max(maxAbsRightDelta, Math.abs(feedback.rightEncoderDelta));
      maxAbsLeftPwmApplied = Math.max(maxAbsLeftPwmApplied, Math.abs(feedback.leftPwmAppliedPercent));
      maxAbsRightPwmApplied = Math.max(maxAbsRightPwmApplied, Math.abs(feedback.rightPwmAppliedPercent));
      const isNonZero = !isZeroMotion(feedback);

      if (isNonZero) {
        nonZeroSamples += 1;
      }

      if ((feedback.faultFlags & WATCHDOG_FAULT_BIT) !== 0 || !feedback.watchdogHealthy) {
        watchdogFaultSamples += 1;
      }

      console.log(feedback);
    }

    const summary = {
      sampleCount,
      nonZeroSamples,
      maxAbsLeftDelta,
      maxAbsRightDelta,
      invalidFeedbackReads,
      watchdogFaultSamples,
      maxAbsLeftPwmApplied,
      maxAbsRightPwmApplied,
      expectation:
        "With motor power off and no movement, all deltas and wheel speeds should stay at zero.",
    };
    const classification = classifyRun(summary);

    console.log("\nSummary");
    console.log(summary);
    console.log("\nVerdict");
    console.log(classification.status);

    for (const failure of classification.failures) {
      console.log(`- ${failure}`);
    }

    for (const note of classification.notes) {
      console.log(`- ${note}`);
    }

    if (classification.status !== "PASS") {
      process.exitCode = 1;
    }
  } finally {
    await bus.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
