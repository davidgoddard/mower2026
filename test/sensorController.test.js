import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrimitivesStore, SensorController, SessionLogger } from '../dist/index.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mower-sensors-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('SensorController polls IMU and stores latest integrated heading state', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    let now = 0;
    const primitivesStore = new PrimitivesStore();
    const gateway = {
      async initialise() {},
      async readImu() {
        now += 1000;
        return {
          timestampMillis: now,
          angularVelocity: { zDegreesPerSecond: 10 },
        };
      },
      async close() {},
    };

    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      pollIntervalMs: 0,
      sleep: async () => {},
      nowMillis: () => now,
      maxLoopCount: 3,
    });

    await controller.start();
    await delay(0);

    const snapshot = primitivesStore.snapshot();
    assert.equal(snapshot.sensorController.status, 'running');
    assert.equal(snapshot.imu.status, 'running');
    assert.equal(Math.round(snapshot.imu.headingDeg ?? 0), 20);

    await controller.stop();
    await logger.close();
  });
});

test('SensorController allows heading reset and continues integration from new base', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    let now = 0;
    const primitivesStore = new PrimitivesStore();
    const gateway = {
      async initialise() {},
      async readImu() {
        now += 1000;
        return {
          timestampMillis: now,
          angularVelocity: { zDegreesPerSecond: 10 },
        };
      },
      async close() {},
    };

    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      pollIntervalMs: 1,
      sleep: async () => {
        await delay(1);
      },
      nowMillis: () => now,
      maxLoopCount: 8,
    });

    await controller.start();
    await delay(4);
    controller.setHeadingDegrees(200);
    await delay(20);
    const headingAfterReset = controller.getHeadingDegrees();
    assert.equal(headingAfterReset > 200, true);

    await controller.stop();

    const snapshot = primitivesStore.snapshot();
    assert.equal((snapshot.imu.headingDeg ?? 0) > 200, true);

    await logger.close();
  });
});
