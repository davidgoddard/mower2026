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
      async readMotorFeedback() {
        return {
          timestampMillis: now,
          leftWheelActualMetersPerSecond: 0.2,
          rightWheelActualMetersPerSecond: 0.21,
          leftEncoderDelta: 10,
          rightEncoderDelta: 11,
          leftPwmApplied: 42,
          rightPwmApplied: 43,
          leftMotorCurrentAmps: 1.2,
          rightMotorCurrentAmps: 1.3,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelSpeeds() {},
      async stopMotors() {},
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
    assert.equal(snapshot.motors.status, 'running');
    assert.equal(snapshot.motors.leftWheelSpeedMetersPerSecond, 0.2);
    assert.equal(snapshot.motors.rightWheelSpeedMetersPerSecond, 0.21);

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
      async readMotorFeedback() {
        return {
          timestampMillis: now,
          leftWheelActualMetersPerSecond: 0,
          rightWheelActualMetersPerSecond: 0,
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmApplied: 0,
          rightPwmApplied: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelSpeeds() {},
      async stopMotors() {},
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
    const { createInternalHeading, unwrapInternalHeading } = await import('../dist/index.js');
    controller.setHeading(createInternalHeading(200));
    await delay(20);
    const headingAfterReset = unwrapInternalHeading(controller.getHeading());
    assert.equal(headingAfterReset <= 180, true);
    assert.equal(headingAfterReset > -180, true);

    await controller.stop();

    const snapshot = primitivesStore.snapshot();
    assert.equal((snapshot.imu.headingDeg ?? 0) <= 180, true);
    assert.equal((snapshot.imu.headingDeg ?? 0) > -180, true);

    await logger.close();
  });
});

test('SensorController requires an active motor operation for speed commands and still passes stop through', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    const calls = [];
    const gateway = {
      async initialise() {},
      async readImu() {
        return { timestampMillis: 0, angularVelocity: { zDegreesPerSecond: 0 } };
      },
      async readGnss() {
        return {
          timestampMillis: 0,
          xMeters: 0,
          yMeters: 0,
          positionAccuracyMeters: 1,
          fixType: 'none',
          satellitesInUse: 0,
          sampleAgeMillis: 0,
        };
      },
      async readMotorFeedback() {
        return {
          timestampMillis: 0,
          leftWheelActualMetersPerSecond: 0,
          rightWheelActualMetersPerSecond: 0,
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmApplied: 0,
          rightPwmApplied: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelSpeeds(left, right) {
        calls.push({ type: 'speed', left, right });
      },
      async stopMotors() {
        calls.push({ type: 'stop' });
      },
      async close() {},
    };

    const primitivesStore = new PrimitivesStore();
    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      pollIntervalMs: 100,
      sleep: async () => {},
      nowMillis: () => 0,
      maxLoopCount: 1,
    });

    await assert.rejects(
      controller.setMotorWheelSpeeds(0.5, -0.5),
      /motor operation not active/,
    );

    controller.beginMotorOperation();
    await controller.setMotorWheelSpeeds(0.5, -0.5);
    const afterSpeedCommand = primitivesStore.snapshot();
    assert.equal(afterSpeedCommand.motors.commandedLeftWheelSpeedMetersPerSecond, 0.5);
    assert.equal(afterSpeedCommand.motors.commandedRightWheelSpeedMetersPerSecond, -0.5);
    await controller.stopMotors();
    await controller.endMotorOperation();
    const afterStop = primitivesStore.snapshot();
    assert.equal(afterStop.motors.commandedLeftWheelSpeedMetersPerSecond, 0);
    assert.equal(afterStop.motors.commandedRightWheelSpeedMetersPerSecond, 0);

    assert.deepEqual(calls, [
      { type: 'speed', left: 0.5, right: -0.5 },
      { type: 'stop' },
    ]);

    await logger.close();
  });
});
