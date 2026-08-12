import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ManualDriveCoordinator } from '../dist/control/manualDriveCoordinator.js';
import { systemStop } from '../dist/control/systemStop.js';
import { MANUAL_DRIVE_RAMP_DOWN_TIME_MS, MANUAL_DRIVE_RAMP_UP_TIME_MS } from '../dist/constants.js';

function createLogger() {
  const logger = {
    child() {
      return logger;
    },
    transition() {},
    info() {},
    warn() {},
    error() {},
  };
  return logger;
}

function createSnapshot(overrides = {}) {
  return {
    connected: true,
    vendorId: 0,
    productId: 0,
    steeringByte: 128,
    speedByte: 64,
    angleDegrees: 0,
    speed: 0.6,
    buttons: {},
    lastPacketHex: '',
    lastUpdateMillis: 0,
    ...overrides,
  };
}

class FakeHidController extends EventEmitter {
  start() {}
  close() {}
}

function createSensorController() {
  const commands = [];
  return {
    commands,
    controller: {
      beginMotionSession() {},
      endMotionSession() {},
      async requestNeutralMotorOutputs() {
        commands.push(['stop']);
      },
      async emergencyStopMotors() {
        commands.push(['halt']);
      },
      async stopMotors() {
        commands.push(['stop']);
      },
      async setMotorWheelOutputs(left, right, options) {
        commands.push([left, right, options ?? null]);
      },
    },
  };
}

async function waitFor(predicate, timeoutMs = 100) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function stopCoordinatorSilently(coordinator) {
  try {
    await coordinator.stop();
  } catch {
    // Best-effort test cleanup. The original failure should remain visible.
  }
}

test('manual drive sends an unchanged held moving command only once', async () => {
  systemStop.clearStop('manual-drive-test');
  let now = 0;
  const hidController = new FakeHidController();
  const { commands, controller: sensorController } = createSensorController();
  const coordinator = new ManualDriveCoordinator({
    logger: createLogger(),
    sensorController,
    hidController,
    controlIntervalMs: 100,
    nowMillis: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
      hidController.emit('update', createSnapshot({ lastUpdateMillis: now }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });

  try {
    coordinator.start();
    hidController.emit('update', createSnapshot());
    hidController.emit('right-top');

    await waitFor(() => commands.filter((command) => command.length >= 2 && typeof command[0] === 'number').length >= 1);
    await waitFor(() => now >= 500);

    const wheelCommands = commands.filter((command) => command.length >= 2 && typeof command[0] === 'number');
    assert.equal(wheelCommands.length, 1);
    assert.deepEqual(wheelCommands[0], [0.6, 0.6, { rampUpTimeMs: MANUAL_DRIVE_RAMP_UP_TIME_MS, rampDownTimeMs: MANUAL_DRIVE_RAMP_DOWN_TIME_MS }]);
  } finally {
    await stopCoordinatorSilently(coordinator);
  }
});

test('manual drive coalesces tiny held-stick output jitter', async () => {
  systemStop.clearStop('manual-drive-test');
  let now = 0;
  const hidController = new FakeHidController();
  const { commands, controller: sensorController } = createSensorController();
  const coordinator = new ManualDriveCoordinator({
    logger: createLogger(),
    sensorController,
    hidController,
    controlIntervalMs: 100,
    commandRefreshIntervalMs: 10_000,
    outputQuantizationPercent: 0.02,
    nowMillis: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });

  try {
    coordinator.start();
    hidController.emit('update', createSnapshot({ speed: 0.601 }));
    hidController.emit('right-top');
    await waitFor(() => commands.some((command) => command.length >= 2 && typeof command[0] === 'number'));

    hidController.emit('update', createSnapshot({ speed: 0.609 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await stopCoordinatorSilently(coordinator);
  }

  const wheelCommands = commands.filter((command) => command.length >= 2 && typeof command[0] === 'number');
  assert.equal(wheelCommands.length, 1);
  assert.deepEqual(wheelCommands[0], [0.6, 0.6, { rampUpTimeMs: MANUAL_DRIVE_RAMP_UP_TIME_MS, rampDownTimeMs: MANUAL_DRIVE_RAMP_DOWN_TIME_MS }]);
});

test('manual drive gentle-halts on controller disconnect and stays armed within the grace window', async () => {
  systemStop.clearStop('manual-drive-test');
  let now = 0;
  const hidController = new FakeHidController();
  const { commands, controller: sensorController } = createSensorController();
  const coordinator = new ManualDriveCoordinator({
    logger: createLogger(),
    sensorController,
    hidController,
    controlIntervalMs: 50,
    commandRefreshIntervalMs: 10_000,
    controllerDisconnectGraceMs: 2_000,
    nowMillis: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });

  try {
    coordinator.start();
    hidController.emit('update', createSnapshot({ speed: 0.6 }));
    hidController.emit('right-top');

    await waitFor(() => commands.some((command) => command.length >= 2 && command[0] !== 0));
    const beforeDisconnect = commands.length;

    hidController.emit('update', createSnapshot({ connected: false, speed: 0.6 }));

    await waitFor(() => commands.slice(beforeDisconnect).some((command) => command[0] === 'stop'));
    const stopIndex = commands.findIndex((command, idx) => idx >= beforeDisconnect && command[0] === 'stop');
    assert.notEqual(stopIndex, -1);

    hidController.emit('update', createSnapshot({ speed: 0.6 }));

    await waitFor(() => {
      const wheelCommandsAfterReconnect = commands
        .slice(stopIndex + 1)
        .filter((command) => command.length >= 2 && typeof command[0] === 'number');
      return wheelCommandsAfterReconnect.some((command) => command[0] !== 0 || command[1] !== 0);
    });
  } finally {
    await stopCoordinatorSilently(coordinator);
  }
});

test('manual drive disarms after the controller disconnect grace window expires', async () => {
  systemStop.clearStop('manual-drive-test');
  let now = 0;
  const hidController = new FakeHidController();
  const { commands, controller: sensorController } = createSensorController();
  const coordinator = new ManualDriveCoordinator({
    logger: createLogger(),
    sensorController,
    hidController,
    controlIntervalMs: 50,
    commandRefreshIntervalMs: 10_000,
    controllerDisconnectGraceMs: 200,
    nowMillis: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });

  try {
    coordinator.start();
    hidController.emit('update', createSnapshot({ speed: 0.6 }));
    hidController.emit('right-top');
    await waitFor(() => commands.some((command) => command.length >= 2 && command[0] !== 0));

    hidController.emit('update', createSnapshot({ connected: false, speed: 0.6 }));

    await waitFor(() => commands.filter((command) => command[0] === 'stop').length >= 2, 500);
  } finally {
    await stopCoordinatorSilently(coordinator);
  }

  const stopCount = commands.filter((command) => command[0] === 'stop').length;
  assert.equal(stopCount >= 2, true);
});

test('manual drive requests a normal stop when HID updates go stale and resumes on recovery', async () => {
  systemStop.clearStop('manual-drive-test');
  let now = 0;
  const hidController = new FakeHidController();
  const { commands, controller: sensorController } = createSensorController();
  const coordinator = new ManualDriveCoordinator({
    logger: createLogger(),
    sensorController,
    hidController,
    controlIntervalMs: 50,
    commandRefreshIntervalMs: 100,
    controllerDisconnectGraceMs: 500,
    nowMillis: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });

  try {
    coordinator.start();
    hidController.emit('update', createSnapshot({ speed: 0.6, lastUpdateMillis: now }));
    hidController.emit('right-top');

    await waitFor(() => commands.some((command) => command.length >= 2 && command[0] !== 0));
    const beforeStale = commands.length;

    await waitFor(() => commands.slice(beforeStale).some((command) => command[0] === 'stop'), 500);

    hidController.emit('update', createSnapshot({ speed: 0.6, lastUpdateMillis: now }));

    await waitFor(() => {
      const wheelCommandsAfterRecovery = commands
        .slice(beforeStale)
        .filter((command) => command.length >= 2 && typeof command[0] === 'number');
      return wheelCommandsAfterRecovery.some((command) => command[0] !== 0 || command[1] !== 0);
    }, 500);
  } finally {
    await stopCoordinatorSilently(coordinator);
  }
});

test('manual drive sends a normal zero command when the stick centres', async () => {
  systemStop.clearStop('manual-drive-test');
  let now = 0;
  const hidController = new FakeHidController();
  const { commands, controller: sensorController } = createSensorController();
  const coordinator = new ManualDriveCoordinator({
    logger: createLogger(),
    sensorController,
    hidController,
    controlIntervalMs: 100,
    commandRefreshIntervalMs: 10_000,
    nowMillis: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });

  try {
    coordinator.start();
    hidController.emit('update', createSnapshot({ speed: 0.6 }));
    hidController.emit('right-top');

    await waitFor(() => commands.some((command) => command.length >= 2 && typeof command[0] === 'number'));

    hidController.emit('update', createSnapshot({ speed: 0 }));
    await waitFor(() => commands.some((command) => command.length >= 2 && command[0] === 0 && command[1] === 0));
  } finally {
    await stopCoordinatorSilently(coordinator);
  }

  const wheelCommands = commands.filter((command) => command.length >= 2 && typeof command[0] === 'number');
  assert.equal(wheelCommands.some((command) => command[0] === 0 && command[1] === 0), true);
  assert.deepEqual(
    wheelCommands.find((command) => command[0] === 0 && command[1] === 0),
    [0, 0, { rampUpTimeMs: MANUAL_DRIVE_RAMP_UP_TIME_MS, rampDownTimeMs: MANUAL_DRIVE_RAMP_DOWN_TIME_MS }],
  );
});

test('manual drive clears a latched global stop on live HID drive input', async () => {
  systemStop.clearStop('manual-drive-test');
  let now = 0;
  const hidController = new FakeHidController();
  const { controller: sensorController } = createSensorController();
  const coordinator = new ManualDriveCoordinator({
    logger: createLogger(),
    sensorController,
    hidController,
    controlIntervalMs: 50,
    commandRefreshIntervalMs: 150,
    nowMillis: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });

  try {
    coordinator.start();
    hidController.emit('update', createSnapshot({ speed: 0.6, lastUpdateMillis: now }));
    hidController.emit('right-top');
    systemStop.requestStop('test', 'stall');
    assert.equal(systemStop.isStopped(), true);

    hidController.emit('update', createSnapshot({ speed: 0.6, lastUpdateMillis: now + 1 }));
    await waitFor(() => systemStop.isStopped() === false);
  } finally {
    await stopCoordinatorSilently(coordinator);
  }
  assert.equal(systemStop.isStopped(), false);
});
