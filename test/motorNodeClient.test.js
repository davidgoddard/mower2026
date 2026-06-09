import test from 'node:test';
import assert from 'node:assert/strict';
import { MotorNodeClient, I2C_PRIORITY } from '../dist/index.js';
import { systemStop } from '../dist/control/systemStop.js';

test.beforeEach(() => {
  systemStop.clearStop('motor-node-client-test');
});

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
  const payload = new Uint8Array(22);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 1000, true);
  view.setInt32(4, 123, true);
  view.setInt32(8, -456, true);
  view.setInt8(12, 40);
  view.setInt8(13, -42);
  view.setUint16(14, 15, true);
  view.setUint16(16, 17, true);
  view.setUint8(18, 1);
  view.setUint16(19, 0x0004, true);
  view.setUint8(21, 0);
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

  const commandView = new DataView(writes[0].payload.buffer, writes[0].payload.byteOffset, writes[0].payload.byteLength);
  assert.equal(commandView.getInt16(13, true), 500);
  assert.equal(commandView.getInt16(15, true), -500);
  // Acceleration / deceleration rates are derived from the configured ramp-up
  // (460ms) and ramp-down (700ms) defaults that match the firmware spec.
  // Encoded value = round((1 / rampSeconds) * 1000).
  assert.equal(commandView.getUint16(20, true), 2174);
  assert.equal(commandView.getUint16(22, true), 1429);

  // Motor wheel-speed command frame type.
  assert.equal(writes[0].payload[3], 0x21);
  assert.equal(writes[1].payload[3], 0x21);
});

test('MotorNodeClient suppresses duplicate unchanged commands', async () => {
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
  await client.sendWheelSpeedCommand(0.5, -0.5);
  await client.stop();
  await client.stop();

  assert.equal(writes.length, 2);
  assert.equal(writes[0].key, 'motor.speed');
  assert.equal(writes[1].key, 'motor.stop');
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
  assert.equal(queueReadCalls[0].responseLength, 33);

  assert.equal(feedback.timestampMillis, 1000);
  assert.equal(feedback.leftEncoderDelta, 123);
  assert.equal(feedback.rightEncoderDelta, -456);
  assert.equal(feedback.leftPwmAppliedPercent, 40);
  assert.equal(feedback.rightPwmAppliedPercent, -42);
  assert.equal(feedback.leftMotorCurrentAmps, 1.5);
  assert.equal(feedback.rightMotorCurrentAmps, 1.7);
  assert.equal(feedback.watchdogHealthy, true);
  assert.equal(feedback.faultFlags, 4);
});

test('MotorNodeClient treats same-key motor write replacement as benign coalescing', async () => {
  const writes = [];
  let firstCall = true;
  const fakeController = {
    async queueWrite(request) {
      writes.push(request);
      if (firstCall) {
        firstCall = false;
        throw new Error(`i2c task replaced: ${request.key}`);
      }
    },
    async queueRead() {
      throw new Error('not used in this test');
    },
  };

  const client = new MotorNodeClient(fakeController, {
    address: 0x66,
    nowMillis: () => 100,
  });

  await client.sendWheelSpeedCommand(0.5, 0.5);
  await client.stop();

  assert.equal(writes.length, 2);
  assert.equal(writes[0].key, 'motor.speed');
  assert.equal(writes[1].key, 'motor.stop');
});
