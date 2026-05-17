import test from 'node:test';
import assert from 'node:assert/strict';
import { I2cBusController, I2C_PRIORITY } from '../dist/index.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('I2cBusController executes higher-priority queued tasks before lower-priority tasks', async () => {
  const callOrder = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const transport = {
    async write() {},
    async read() { return new Uint8Array(0); },
    async writeRead(_address, requestPayload, responseLength) {
      const marker = requestPayload[0];
      callOrder.push(marker);
      if (marker === 1) {
        await firstGate;
      }
      return new Uint8Array(responseLength).fill(marker);
    },
    async close() {},
  };

  const controller = new I2cBusController(transport);

  const first = controller.queueRead({
    key: 'first',
    priority: I2C_PRIORITY.imuRead,
    address: 0x69,
    requestPayload: new Uint8Array([1]),
    responseLength: 1,
  });

  await delay(0);

  const lowPriority = controller.queueRead({
    key: 'low',
    priority: I2C_PRIORITY.imuRead,
    address: 0x69,
    requestPayload: new Uint8Array([4]),
    responseLength: 1,
  });

  const highPriority = controller.queueRead({
    key: 'high',
    priority: I2C_PRIORITY.stop,
    address: 0x69,
    requestPayload: new Uint8Array([2]),
    responseLength: 1,
  });

  releaseFirst();

  const [firstResponse, highResponse, lowResponse] = await Promise.all([first, highPriority, lowPriority]);
  assert.equal(firstResponse[0], 1);
  assert.equal(highResponse[0], 2);
  assert.equal(lowResponse[0], 4);
  assert.deepEqual(callOrder, [1, 2, 4]);

  await controller.close();
});

test('I2cBusController replaces stale queued task for same key', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const transport = {
    async write() {},
    async read() { return new Uint8Array(0); },
    async writeRead(_address, requestPayload, responseLength) {
      if (requestPayload[0] === 1) {
        await firstGate;
      }
      return new Uint8Array(responseLength).fill(requestPayload[0]);
    },
    async close() {},
  };

  const controller = new I2cBusController(transport);

  const blocking = controller.queueRead({
    key: 'blocking',
    priority: I2C_PRIORITY.imuRead,
    address: 0x69,
    requestPayload: new Uint8Array([1]),
    responseLength: 1,
  });

  await delay(0);

  const stale = controller.queueRead({
    key: 'imu.read_gyro_z',
    priority: I2C_PRIORITY.imuRead,
    address: 0x69,
    requestPayload: new Uint8Array([10]),
    responseLength: 1,
  });

  const replacement = controller.queueRead({
    key: 'imu.read_gyro_z',
    priority: I2C_PRIORITY.imuRead,
    address: 0x69,
    requestPayload: new Uint8Array([20]),
    responseLength: 1,
  });

  releaseFirst();

  await blocking;
  await assert.rejects(stale, /i2c task replaced/);
  const replacementResponse = await replacement;
  assert.equal(replacementResponse[0], 20);

  await controller.close();
});
