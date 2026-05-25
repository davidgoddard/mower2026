import test from 'node:test';
import assert from 'node:assert/strict';
import { Bmi160ImuSensor } from '../dist/index.js';

function buildFakeController() {
  const writes = [];
  const gyroRawReadings = [
    [0, 0, 164],
    [0, 0, 164],
    [0, 0, 328],
  ];
  const accelerometerRawReadings = [
    [0, 0, 16384],
    [0, 0, 16384],
    [0, 0, 16384],
  ];

  return {
    writes,
    async queueWrite(request) {
      writes.push(Array.from(request.payload));
    },
    async queueRead(request) {
      const register = request.requestPayload[0];
      if (register === 0x00) {
        return new Uint8Array([0xd1]);
      }
      if (register === 0x0c) {
        const raw = gyroRawReadings.shift() ?? [0, 0, 0];
        return new Uint8Array([
          raw[0] & 0xff, (raw[0] >> 8) & 0xff,
          raw[1] & 0xff, (raw[1] >> 8) & 0xff,
          raw[2] & 0xff, (raw[2] >> 8) & 0xff,
        ]);
      }
      if (register === 0x12) {
        const raw = accelerometerRawReadings.shift() ?? [0, 0, 16384];
        return new Uint8Array([
          raw[0] & 0xff, (raw[0] >> 8) & 0xff,
          raw[1] & 0xff, (raw[1] >> 8) & 0xff,
          raw[2] & 0xff, (raw[2] >> 8) & 0xff,
        ]);
      }
      throw new Error(`unexpected register read 0x${register.toString(16)}`);
    },
  };
}

test('Bmi160ImuSensor initialises, calibrates and reads bias-corrected gyro z', async () => {
  const fakeController = buildFakeController();
  const sensor = new Bmi160ImuSensor(fakeController, {
    nowMillis: () => 123456,
    sleep: async () => {},
  });

  await sensor.initialise();
  await sensor.calibrateGyro(2);
  const sample = await sensor.read();

  assert.equal(sample.timestampMillis, 123456);
  assert.equal(sample.angularVelocity.xDegreesPerSecond, 0);
  assert.equal(sample.angularVelocity.yDegreesPerSecond, 0);
  assert.equal(Math.round(sample.angularVelocity.zDegreesPerSecond), 10);
  assert.ok(Math.abs(sample.pitchDeg ?? 0) < 0.0001);
  assert.ok(Math.abs(sample.rollDeg ?? 0) < 0.0001);

  assert.deepEqual(fakeController.writes, [
    [0x7e, 0x11],
    [0x41, 0x03],
    [0x7e, 0x15],
    [0x43, 0x00],
  ]);
});
