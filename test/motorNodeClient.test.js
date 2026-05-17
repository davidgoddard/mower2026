import test from 'node:test';
import assert from 'node:assert/strict';
import { MotorNodeClient, I2C_PRIORITY } from '../dist/index.js';

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
  const frame = new Uint8Array(9 + payload.length + 2);
  const view = new DataView(frame.buffer);
  frame[0] = 0x4d;
  frame[1] = 0x01;
  frame[2] = 0x20;
  frame[3] = messageType;
  frame[4] = 0;
  view.setUint16(5, sequence, true);
  view.setUint16(7, payload.length, true);
  frame.set(payload, 9);
  view.setUint16(9 + payload.length, crc16Ccitt(frame.subarray(1, 9 + payload.length)), true);
  return frame;
}

function encodeFeedbackPayload() {
  const payload = new Uint8Array(26);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 1000, true);
  view.setInt16(4, 250, true);
  view.setInt16(6, -300, true);
  view.setInt32(8, 123, true);
  view.setInt32(12, -456, true);
  view.setInt8(16, 40);
  view.setInt8(17, -42);
  view.setUint16(18, 15, true);
  view.setUint16(20, 17, true);
  view.setUint8(22, 1);
  view.setUint16(23, 0x0004, true);
  view.setUint8(25, 0);
  return payload;
}

test('MotorNodeClient sends speed and stop with expected i2c priorities', async () => {
  const writes = [];
  const fakeController = {
    async queueWrite(request) {
      writes.push(request);
    },
    async queueRead() {
      throw new Error('not used in this test');
    },
  };

  const client = new MotorNodeClient(fakeController, {
    address: 0x66,
    nowMillis: () => 100,
  });

  await client.sendWheelSpeedCommand(0.5, -0.5);
  await client.stop();

  assert.equal(writes.length, 2);
  assert.equal(writes[0].key, 'motor.speed');
  assert.equal(writes[0].priority, I2C_PRIORITY.motorSpeed);
  assert.equal(writes[1].key, 'motor.stop');
  assert.equal(writes[1].priority, I2C_PRIORITY.stop);

  // Motor wheel-speed command frame type.
  assert.equal(writes[0].payload[3], 0x21);
  assert.equal(writes[1].payload[3], 0x21);
});

test('MotorNodeClient decodes motor feedback sample frame', async () => {
  const queueReadCalls = [];
  const fakeController = {
    async queueWrite() {},
    async queueRead(request) {
      queueReadCalls.push(request);
      return encodeFrame(0x22, 5, encodeFeedbackPayload());
    },
  };

  const client = new MotorNodeClient(fakeController, {
    address: 0x66,
  });

  const feedback = await client.refreshFeedback();
  assert.equal(queueReadCalls.length, 1);
  assert.equal(queueReadCalls[0].priority, I2C_PRIORITY.motorSpeed);
  assert.equal(queueReadCalls[0].responseLength, 37);

  assert.equal(feedback.timestampMillis, 1000);
  assert.equal(feedback.leftWheelActualMetersPerSecond, 0.25);
  assert.equal(feedback.rightWheelActualMetersPerSecond, -0.3);
  assert.equal(feedback.leftEncoderDelta, 123);
  assert.equal(feedback.rightEncoderDelta, -456);
  assert.equal(feedback.leftPwmApplied, 40);
  assert.equal(feedback.rightPwmApplied, -42);
  assert.equal(feedback.leftMotorCurrentAmps, 1.5);
  assert.equal(feedback.rightMotorCurrentAmps, 1.7);
  assert.equal(feedback.watchdogHealthy, true);
  assert.equal(feedback.faultFlags, 4);
});

