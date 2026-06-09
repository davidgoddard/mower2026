import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GeometryCalibration, ImuCalibration, PrimitivesStore, SensorController, SessionLogger } from '../dist/index.js';
import { systemStop } from '../dist/control/systemStop.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
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
          leftEncoderDelta: 200,
          rightEncoderDelta: 210,
          leftPwmAppliedPercent: 42,
          rightPwmAppliedPercent: 43,
          leftMotorCurrentAmps: 1.2,
          rightMotorCurrentAmps: 1.3,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs() {},
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
    await delay(20);

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

    const imuDiagnostics = controller.getRecentImuDiagnosticSummary();
    assert.ok(imuDiagnostics);
    assert.equal(imuDiagnostics.sampleCount, 3);
    assert.equal(imuDiagnostics.averageSampleDeltaMs, 1000);
    assert.equal(Math.round(imuDiagnostics.headingChangeDeg), 20);
    assert.equal(Math.round(imuDiagnostics.integratedYawDeltaDeg), 20);
    assert.equal(imuDiagnostics.recentSamples.at(-1)?.sampleDeltaMs, 1000);

    await controller.stop();
    await logger.close();
  });
});

test('SensorController only auto-recalibrates IMU bias after a long idle period', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'info',
    });

    let now = 0;
    const primitivesStore = new PrimitivesStore();
    const gateway = {
      async initialise() {},
      async readImu() {
        now += 100;
        return {
          timestampMillis: now,
          angularVelocity: { zDegreesPerSecond: 0 },
        };
      },
      async readGnss() {
        return {
          timestampMillis: now,
          xMeters: 0,
          yMeters: 0,
          positionAccuracyMeters: 0.02,
          headingAccuracyDegrees: 0.5,
          fixType: 'fixed',
          satellitesInUse: 24,
          sampleAgeMillis: 20,
        };
      },
      async readMotorFeedback() {
        return {
          timestampMillis: now,
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs() {},
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
      maxLoopCount: 25,
    });

    await controller.start();
    await controller.setMotorWheelOutputs(0, 0);
    now = 31 * 60 * 1000;
    await delay(50);

    await controller.stop();
    await logger.close();

    const logFileNames = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    const logText = (await Promise.all(
      logFileNames.map(async (name) => readFile(join(dir, name), 'utf8')),
    )).join('\n');

    assert.match(logText, /sensor\.imu\.bias_recalibration_auto_attempt/);
  });
});

test('SensorController sends a motor command once and does not replay unchanged values while sensor reads are slow', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    let now = 0;
    const commands = [];
    const primitivesStore = new PrimitivesStore();
    const gateway = {
      async initialise() {},
      async readImu() {
        await delay(120);
        now += 120;
        return {
          timestampMillis: now,
          angularVelocity: { zDegreesPerSecond: 0 },
        };
      },
      async readGnss() {
        await delay(120);
        now += 120;
        return {
          timestampMillis: now,
          xMeters: 0,
          yMeters: 0,
          positionAccuracyMeters: 0.02,
          headingAccuracyDegrees: 0.5,
          fixType: 'fixed',
          satellitesInUse: 24,
          sampleAgeMillis: 20,
        };
      },
      async readMotorFeedback() {
        await delay(120);
        now += 120;
        return {
          timestampMillis: now,
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs(left, right) {
        commands.push([left, right]);
      },
      async stopMotors() {
        commands.push(['stop']);
      },
      async close() {},
    };

    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      pollIntervalMs: 1000,
      sleep: async () => {},
      nowMillis: () => now,
      maxLoopCount: 1,
    });

    await controller.start();
    await controller.setMotorWheelOutputs(0.6, 0.6);
    await delay(260);

    assert.deepEqual(commands, [[0.6, 0.6]]);

    await controller.stop();
    await logger.close();
  });
});

test('SensorController sends an explicit zero-output command for a normal stop', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    let now = 0;
    const commands = [];
    const primitivesStore = new PrimitivesStore();
    const gateway = {
      async initialise() {},
      async readImu() {
        await delay(120);
        now += 120;
        return {
          timestampMillis: now,
          angularVelocity: { zDegreesPerSecond: 0 },
        };
      },
      async readGnss() {
        await delay(120);
        now += 120;
        return {
          timestampMillis: now,
          xMeters: 0,
          yMeters: 0,
          positionAccuracyMeters: 0.02,
          headingAccuracyDegrees: 0.5,
          fixType: 'fixed',
          satellitesInUse: 24,
          sampleAgeMillis: 20,
        };
      },
      async readMotorFeedback() {
        await delay(120);
        now += 120;
        return {
          timestampMillis: now,
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs(left, right) {
        commands.push([left, right]);
      },
      async stopMotors() {
        commands.push(['stop']);
      },
      async close() {},
    };

    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      pollIntervalMs: 1000,
      sleep: async () => {},
      nowMillis: () => now,
      maxLoopCount: 1,
    });

    await controller.start();
    await controller.setMotorWheelOutputs(0.6, 0.6);
    await delay(30);
    await controller.stopMotors();
    await delay(30);

    const zeroCommands = commands.filter((command) => command.length === 2 && command[0] === 0 && command[1] === 0);
    assert.equal(zeroCommands.length >= 1, true);
    assert.equal(commands.some((command) => command[0] === 'stop'), false);

    await controller.stop();
    await logger.close();
  });
});

test('SensorController hard-disables motors when system stop is requested', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    systemStop.clearStop('sensor-controller-system-stop-test');
    let now = 0;
    const commands = [];
    const primitivesStore = new PrimitivesStore();
    const gateway = {
      async initialise() {},
      async readImu() {
        now += 1000;
        return {
          timestampMillis: now,
          angularVelocity: { zDegreesPerSecond: 0 },
        };
      },
      async readGnss() {
        return {
          timestampMillis: now,
          xMeters: 0,
          yMeters: 0,
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
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs(left, right) {
        commands.push(['speed', left, right]);
      },
      async stopMotors() {
        commands.push(['stop']);
      },
      async close() {},
    };

    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      pollIntervalMs: 0,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      nowMillis: () => now,
      maxLoopCount: null,
    });

    await controller.start();
    await controller.setMotorWheelOutputs(0.6, 0.6);
    await delay(20);

    systemStop.requestStop('test', 'panic');
    await waitFor(() => commands.some((command) => command[0] === 'stop'));
    await controller.stop();

    assert.equal(commands.some((command) => command[0] === 'stop'), true);
    await logger.close();
    systemStop.clearStop('sensor-controller-system-stop-test-cleanup');
  });
});

test('SensorController treats neutral requests as hard-disable while system stop is latched', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    systemStop.clearStop('sensor-controller-neutral-under-stop-test');
    const commands = [];
    const primitivesStore = new PrimitivesStore();
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
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs(left, right) {
        commands.push(['speed', left, right]);
      },
      async stopMotors() {
        commands.push(['stop']);
      },
      async close() {},
    };

    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      pollIntervalMs: 100,
      sleep: async () => {},
      nowMillis: () => 0,
      maxLoopCount: 1,
    });

    await controller.setMotorWheelOutputs(0.5, 0.5);
    systemStop.requestStop('test', 'panic');
    await controller.requestNeutralMotorOutputs();

    assert.deepEqual(commands, [
      ['speed', 0.5, 0.5],
      ['stop'],
    ]);

    systemStop.clearStop('sensor-controller-neutral-under-stop-test-cleanup');
    await logger.close();
  });
});

test('SensorController applies the persisted IMU yaw scale factor to heading integration', async () => {
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
    const imuCalibration = new ImuCalibration({ logger });
    imuCalibration.setYawScaleFactor(2);
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
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs() {},
      async stopMotors() {},
      async close() {},
    };

    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      imuCalibration,
      pollIntervalMs: 0,
      sleep: async () => {},
      nowMillis: () => now,
      maxLoopCount: 3,
    });

    await controller.start();
    await delay(0);

    const snapshot = primitivesStore.snapshot();
    assert.equal(Math.round(snapshot.imu.headingDeg ?? 0), 40);

    await controller.stop();
    await logger.close();
  });
});

test('SensorController preserves IMU integration timing when heading is reset with a timestamp', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    let now = 0;
    let readCount = 0;
    let resetApplied = false;
    let controller;
    const primitivesStore = new PrimitivesStore();
    const gateway = {
      async initialise() {},
      async readImu() {
        readCount += 1;
        now = readCount * 1000;
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
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs() {},
      async stopMotors() {},
      async close() {},
    };

    controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      pollIntervalMs: 0,
      sleep: async () => {
        if (now === 2000 && !resetApplied) {
          const { createInternalHeading } = await import('../dist/index.js');
          controller.setHeading(createInternalHeading(100), 2500);
          resetApplied = true;
        }
      },
      nowMillis: () => now,
      maxLoopCount: 3,
    });

    await controller.start();
    await delay(0);

    const snapshot = primitivesStore.snapshot();
    assert.equal(Math.round(snapshot.imu.headingDeg ?? 0), 105);

    await controller.stop();
    await logger.close();
  });
});

test('SensorController tilt-compensates yaw integration using pitch and roll', async () => {
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
          angularVelocity: { xDegreesPerSecond: 0, yDegreesPerSecond: 10, zDegreesPerSecond: 0 },
          pitchDeg: 0,
          rollDeg: 90,
        };
      },
      async readGnss() {
        return {
          timestampMillis: now,
          xMeters: 0,
          yMeters: 0,
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
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs() {},
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
    assert.equal(Math.round(snapshot.imu.headingDeg ?? 0), 20);

    const imuDiagnostics = controller.getRecentImuDiagnosticSummary();
    assert.ok(imuDiagnostics);
    assert.equal(Math.round(imuDiagnostics.averageRawYawRateDegPerSec ?? 0), 0);
    assert.equal(Math.round(imuDiagnostics.averageYawRateDegPerSec ?? 0), 10);
    assert.equal(Math.round(imuDiagnostics.integratedYawDeltaDeg), 20);

    await controller.stop();
    await logger.close();
  });
});

test('SensorController adjusts GNSS position to the calibrated vehicle reference point', async () => {
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
    const geometryCalibration = new GeometryCalibration({ logger });
    geometryCalibration.setPositionOffset(1, 0.5);
    const gateway = {
      async initialise() {},
      async readImu() {
        now += 1000;
        return {
          timestampMillis: now,
          angularVelocity: { zDegreesPerSecond: 0 },
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
          satellitesInUse: 18,
          sampleAgeMillis: 40,
        };
      },
      async readMotorFeedback() {
        return {
          timestampMillis: now,
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs() {},
      async stopMotors() {},
      async close() {},
    };

    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      geometryCalibration,
      pollIntervalMs: 0,
      sleep: async () => {},
      nowMillis: () => now,
      maxLoopCount: 1,
    });

    await controller.start();
    await delay(0);

    const snapshot = primitivesStore.snapshot();
    // Body-frame offset (forward=1, right=0.5) at IMU heading 0 (along +X):
    // forward axis is (+1, 0) → +1 in world X
    // right axis is (0, -1) at heading 0 → -0.5 in world Y
    assert.equal(snapshot.gnss.xMeters, 13.34);
    assert.equal(snapshot.gnss.yMeters, 56.28);

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
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs() {},
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
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs(left, right) {
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

    await controller.setMotorWheelOutputs(0.5, -0.5);
    const afterSpeedCommand = primitivesStore.snapshot();
    assert.equal(afterSpeedCommand.motors.commandedLeftWheelOutputPercent, 0.5);
    assert.equal(afterSpeedCommand.motors.commandedRightWheelOutputPercent, -0.5);
    assert.equal(controller.getHeadingRebaseReadiness().safe, false);
    assert.equal(controller.getHeadingRebaseReadiness().motorCommandActive, true);
    await controller.stopMotors();
    const afterStop = primitivesStore.snapshot();
    assert.equal(afterStop.motors.commandedLeftWheelOutputPercent, 0);
    assert.equal(afterStop.motors.commandedRightWheelOutputPercent, 0);
    assert.equal(controller.getMotorZeroCommandSinceMillis(), 0);
    assert.equal(controller.getHeadingRebaseReadiness().safe, true);

    // stopMotors() now issues a normalised zero-output speed command rather
    // than asserting motor disable. Hard disable is reserved for haltMotors.
    assert.deepEqual(calls, [
      { type: 'speed', left: 0.5, right: -0.5 },
      { type: 'speed', left: 0, right: 0 },
    ]);

    await logger.close();
  });
});

test('SensorController treats sub-10-percent wheel outputs as a zero command', async () => {
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
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs(left, right) {
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
      nowMillis: () => 1234,
      maxLoopCount: 1,
    });

    await controller.setMotorWheelOutputs(0.08, -0.08);

    const snapshot = primitivesStore.snapshot();
    assert.equal(snapshot.motors.commandedLeftWheelOutputPercent, 0);
    assert.equal(snapshot.motors.commandedRightWheelOutputPercent, 0);
    assert.equal(controller.getMotorZeroCommandSinceMillis(), 1234);
    assert.deepEqual(calls, [{ type: 'speed', left: 0, right: 0 }]);

    await logger.close();
  });
});

test('SensorController waits for motor feedback to show an actual stop before auto-recalibrating IMU bias', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

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
          positionAccuracyMeters: 0.01,
          fixType: 'fixed',
          satellitesInUse: 22,
          sampleAgeMillis: 0,
        };
      },
      async readMotorFeedback() {
        return {
          timestampMillis: 0,
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs() {},
      async stopMotors() {},
      async close() {},
    };

    const primitivesStore = new PrimitivesStore();
    // Auto-recalibration requires 30 minutes of motion-session idleness plus
    // a 2 second motor-stopped settle. Pick a now() well past both so the
    // gate is open and the test only validates the motor-stopped check.
    const NOW_MS = 30 * 60 * 1000 + 5_000;
    const controller = new SensorController({
      logger,
      primitivesStore,
      gateway,
      pollIntervalMs: 100,
      sleep: async () => {},
      nowMillis: () => NOW_MS,
      maxLoopCount: 1,
    });

    let recalibrateCalls = 0;
    controller.recalibrateImuYawBias = () => {
      recalibrateCalls += 1;
      return true;
    };

    controller['lastMotorCommand'] = { kind: 'stop' };
    controller['motorZeroCommandSinceMillis'] = 0;
    controller['motorStoppedSinceMillis'] = null;
    controller['imuBiasAutoRecalibratedForCurrentStop'] = false;
    // Open the idle-duration gate by anchoring the motion-session idle time
    // to 0 so idleDurationMs = NOW_MS comfortably exceeds the 30-minute threshold.
    controller['motionSessionIdleSinceMillis'] = 0;

    controller['maybeAutoRecalibrateImuYawBias']();
    assert.equal(recalibrateCalls, 0);

    controller['motorStoppedSinceMillis'] = 0;
    controller['maybeAutoRecalibrateImuYawBias']();
    assert.equal(recalibrateCalls, 1);

    await logger.close();
  });
});

test('SensorController raises active wheel outputs to the minimum active motor command', async () => {
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
          leftEncoderDelta: 0,
          rightEncoderDelta: 0,
          leftPwmAppliedPercent: 0,
          rightPwmAppliedPercent: 0,
          watchdogHealthy: true,
          faultFlags: 0,
        };
      },
      async setMotorWheelOutputs(left, right) {
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
      nowMillis: () => 1234,
      maxLoopCount: 1,
    });

    await controller.setMotorWheelOutputs(0.8, 0);
    await controller.setMotorWheelOutputs(0.2, -0.2);

    assert.deepEqual(calls, [
      { type: 'speed', left: 0.8, right: 0.3 },
      { type: 'speed', left: 0.3, right: -0.3 },
    ]);

    await logger.close();
  });
});

test('SensorController suppresses duplicate stop logs while still sending stop commands', async () => {
  const warnCalls = [];
  const logger = {
    child: () => logger,
    info: () => {},
    warn: (...args) => {
      warnCalls.push(args);
    },
    error: () => {},
  };

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
        leftEncoderDelta: 0,
        rightEncoderDelta: 0,
        leftPwmAppliedPercent: 0,
        rightPwmAppliedPercent: 0,
        watchdogHealthy: true,
        faultFlags: 0,
      };
    },
    async setMotorWheelOutputs(left, right) {
      calls.push({ type: "speed", left, right });
    },
    async stopMotors() {
      calls.push({ type: "stop" });
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

  await controller.stopMotors();
  await controller.stopMotors();

  assert.equal(calls.length, 1);
  assert.equal(warnCalls.filter((call) => call[0] === "motors.stop_requested").length, 1);
});

test('SensorController detects a stall after a startup grace period and requests system stop', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    systemStop.clearStop('sensor-controller-test');
    try {
      let now = 0;
      const calls = [];
      const primitivesStore = new PrimitivesStore();
      const gateway = {
        async initialise() {},
        async readImu() {
          now += 100;
          return {
            timestampMillis: now,
            angularVelocity: { zDegreesPerSecond: 0 },
          };
        },
        async readGnss() {
          now += 100;
          return {
            timestampMillis: now,
            xMeters: 1,
            yMeters: 1,
            positionAccuracyMeters: 0.01,
            fixType: 'fixed',
            satellitesInUse: 22,
            sampleAgeMillis: 20,
          };
        },
        async readMotorFeedback() {
          now += 100;
          return {
            timestampMillis: now,
            leftEncoderDelta: 0,
            rightEncoderDelta: 0,
            leftPwmAppliedPercent: 80,
            rightPwmAppliedPercent: 80,
            leftMotorCurrentAmps: 2.4,
            rightMotorCurrentAmps: 2.5,
            watchdogHealthy: true,
            faultFlags: 0,
          };
        },
        async setMotorWheelOutputs(left, right) {
          calls.push({ type: 'speed', left, right });
        },
        async stopMotors() {
          calls.push({ type: 'stop' });
        },
        async close() {},
      };

      const controller = new SensorController({
        logger,
        primitivesStore,
        gateway,
        pollIntervalMs: 0,
        sleep: async () => {
          await delay(0);
        },
        nowMillis: () => now,
        // Generous loop count: stall needs the GNSS observation window
        // (4000ms mocked) to elapse before consecutive-sample accumulation
        // even begins. Each cycle advances mock time by ~300ms.
        maxLoopCount: 60,
      });

      await controller.start();
      await controller.setMotorWheelOutputs(0.8, 0.8);

      await delay(50);

      assert.equal(systemStop.isStopped(), true);
      assert.equal(calls.some((call) => call.type === 'speed' && call.left === 0 && call.right === 0), true);
      assert.equal(calls.some((call) => call.type === 'stop'), false);

      await controller.stop();
    } finally {
      systemStop.clearStop('sensor-controller-test-cleanup');
      await logger.close();
    }
  });
});

test('SensorController detects a stall when a commanded wheel stops moving after the startup grace period', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    systemStop.clearStop('sensor-controller-single-wheel-stall-test');
    try {
      let now = 0;
      const calls = [];
      const primitivesStore = new PrimitivesStore();
      const gateway = {
        async initialise() {},
        async readImu() {
          now += 100;
          return {
            timestampMillis: now,
            angularVelocity: { zDegreesPerSecond: 0 },
          };
        },
        async readGnss() {
          now += 100;
          return {
            timestampMillis: now,
            xMeters: 1,
            yMeters: 1,
            positionAccuracyMeters: 0.01,
            fixType: 'fixed',
            satellitesInUse: 22,
            sampleAgeMillis: 20,
          };
        },
        async readMotorFeedback() {
          now += 100;
          return {
            timestampMillis: now,
            leftEncoderDelta: 16,
            rightEncoderDelta: 0,
            leftPwmAppliedPercent: 80,
            rightPwmAppliedPercent: 0,
            leftMotorCurrentAmps: 2.4,
            rightMotorCurrentAmps: 0.4,
            watchdogHealthy: true,
            faultFlags: 0,
          };
        },
        async setMotorWheelOutputs(left, right) {
          calls.push({ type: 'speed', left, right });
        },
        async stopMotors() {
          calls.push({ type: 'stop' });
        },
        async close() {},
      };

      const controller = new SensorController({
        logger,
        primitivesStore,
        gateway,
        pollIntervalMs: 0,
        sleep: async () => {
          await delay(0);
        },
        nowMillis: () => now,
        maxLoopCount: 60,
      });

      await controller.start();
      await controller.setMotorWheelOutputs(0.8, 0);

      await delay(50);

      assert.equal(systemStop.isStopped(), true);
      assert.equal(calls.some((call) => call.type === 'speed' && call.left === 0 && call.right === 0), true);
      assert.equal(calls.some((call) => call.type === 'stop'), false);

      await controller.stop();
    } finally {
      systemStop.clearStop('sensor-controller-single-wheel-stall-cleanup');
      await logger.close();
    }
  });
});

test('SensorController obstruction event reports the latest wheel speeds, not literal zero', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    systemStop.clearStop('obstruction-wheel-speeds-test');
    try {
      let now = 0;
      const primitivesStore = new PrimitivesStore();
      const gateway = {
        async initialise() {},
        async readImu() {
          now += 100;
          return { timestampMillis: now, angularVelocity: { zDegreesPerSecond: 0 } };
        },
        async readGnss() {
          now += 100;
          return {
            timestampMillis: now,
            xMeters: 1,
            yMeters: 1,
            positionAccuracyMeters: 0.01,
            fixType: 'fixed',
            satellitesInUse: 22,
            sampleAgeMillis: 20,
          };
        },
        async readMotorFeedback() {
          now += 100;
          return {
            timestampMillis: now,
            leftEncoderDelta: 16,
            rightEncoderDelta: 0,
            leftPwmAppliedPercent: 80,
            rightPwmAppliedPercent: 0,
            leftMotorCurrentAmps: 2.4,
            rightMotorCurrentAmps: 0.4,
            watchdogHealthy: true,
            faultFlags: 0,
          };
        },
        async setMotorWheelOutputs() {},
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
        maxLoopCount: 20,
      });

      const obstructionEvents = [];
      controller.on('obstructionDetected', (event) => obstructionEvents.push(event));

      await controller.start();
      await controller.setMotorWheelOutputs(0.8, 0);
      await delay(20);

      const stallEvent = obstructionEvents.find((e) => e.type === 'stall');
      assert.ok(stallEvent, 'expected a stall obstruction event');
      // Left wheel is moving (encoder delta 16 ticks per cycle). The event must
      // reflect the observed wheel speed, not a hardcoded zero.
      assert.notEqual(stallEvent.leftWheelSpeedMetersPerSecond, 0,
        'left wheel speed in obstruction event should not be zero when encoder ticks are non-zero');
      assert.equal(typeof stallEvent.rightWheelSpeedMetersPerSecond, 'number');

      await controller.stop();
    } finally {
      systemStop.clearStop('obstruction-wheel-speeds-test-cleanup');
      await logger.close();
    }
  });
});

test('SensorController does not stall while commanded motion keeps making GNSS progress', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'test',
      source: 'SensorControllerTest',
      logDir: dir,
      minLevel: 'error',
    });

    systemStop.clearStop('sensor-controller-progress-test');
    try {
      let now = 0;
      let xMeters = 0;
      const stopCalls = [];
      const primitivesStore = new PrimitivesStore();
      const gateway = {
        async initialise() {},
        async readImu() {
          now += 100;
          return {
            timestampMillis: now,
            angularVelocity: { zDegreesPerSecond: 0 },
          };
        },
        async readGnss() {
          now += 100;
          xMeters += 0.03;
          return {
            timestampMillis: now,
            xMeters,
            yMeters: 0,
            positionAccuracyMeters: 0.01,
            fixType: 'fixed',
            satellitesInUse: 22,
            sampleAgeMillis: 20,
          };
        },
        async readMotorFeedback() {
          now += 100;
          return {
            timestampMillis: now,
            leftEncoderDelta: 16,
            rightEncoderDelta: 0,
            leftPwmAppliedPercent: 0,
            rightPwmAppliedPercent: 80,
            leftMotorCurrentAmps: 0.8,
            rightMotorCurrentAmps: 0.9,
            watchdogHealthy: true,
            faultFlags: 0,
          };
        },
        async setMotorWheelOutputs() {},
        async stopMotors() {
          stopCalls.push('stop');
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
        maxLoopCount: 20,
      });

      await controller.start();
      await controller.setMotorWheelOutputs(0, 0.8);

      await delay(20);

      assert.equal(systemStop.isStopped(), false);
      assert.equal(stopCalls.length, 0);

      await controller.stop();
    } finally {
      systemStop.clearStop('sensor-controller-progress-test-cleanup');
      await logger.close();
    }
  });
});
