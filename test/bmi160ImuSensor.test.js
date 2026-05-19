import test from 'node:test';
import assert from 'node:assert/strict';
import { Bmi160ImuSensor } from '../dist/index.js';

function buildFakeController() {
  const writes = [];
  const gyroRawReadings = [164, 164, 328];

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
      if (register === 0x10) {
        const raw = gyroRawReadings.shift() ?? 0;
        const value = raw < 0 ? (0x10000 + raw) : raw;
        return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
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
  assert.equal(Math.round(sample.angularVelocity.zDegreesPerSecond), 10);

  assert.deepEqual(fakeController.writes, [
    [0x7e, 0x15],
    [0x43, 0x00],
  ]);
});
