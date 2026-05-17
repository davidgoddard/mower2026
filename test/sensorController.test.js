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
      async readGnss() {
        return {
          timestampMillis: now,
          xMeters: 12.34,
          yMeters: 56.78,
          headingDegrees: 0,
          positionAccuracyMeters: 0.02,
          headingAccuracyDegrees: 0.5,
          fixType: 'fixed',
          satellitesInUse: 22,
          sampleAgeMillis: 90,
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
    assert.equal(snapshot.gnss.status, 'running');
    assert.equal(snapshot.gnss.headingDeg, 90);
    assert.equal(snapshot.gnss.fixType, 'fixed');

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
      async readGnss() {
        return {
          timestampMillis: now,
          xMeters: 0,
          yMeters: 0,
          positionAccuracyMeters: 0.03,
          fixType: 'float',
          satellitesInUse: 15,
          sampleAgeMillis: 120,
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
    assert.equal(headingAfterReset <= 180, true);
    assert.equal(headingAfterReset > -180, true);

    await controller.stop();

    const snapshot = primitivesStore.snapshot();
    assert.equal((snapshot.imu.headingDeg ?? 0) <= 180, true);
    assert.equal((snapshot.imu.headingDeg ?? 0) > -180, true);

    await logger.close();
  });
});
