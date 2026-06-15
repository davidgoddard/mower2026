import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MotorCalibration, SessionLogger } from "../dist/index.js";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "mower-motor-calibration-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeLogger(dir) {
  return SessionLogger.create({
    app: "core-app",
    context: "test",
    source: "MotorCalibrationTest",
    logDir: dir,
    minLevel: "error",
  });
}

test("MotorCalibration uses defaults when no file exists", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "missing-motor.json");
    const calibration = new MotorCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();

    const params = calibration.getParameters();
    assert.equal(params.version, 2);
    assert.equal(typeof params.motorDecelPercentPerSecond, "number");
    assert.equal(typeof params.motorAccelPercentPerSecond, "number");
    assert.ok(params.motorDecelPercentPerSecond > 0);
    assert.ok(params.motorAccelPercentPerSecond > 0);

    await logger.close();
  });
});

test("MotorCalibration round-trips decel/accel rates through save/load", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "motor.json");

    const writer = new MotorCalibration({ logger, parametersPath: path });
    await writer.loadParameters();
    writer["parameters"].motorDecelPercentPerSecond = 300;
    writer["parameters"].motorAccelPercentPerSecond = 200;
    await writer.saveParameters();

    const reader = new MotorCalibration({ logger, parametersPath: path });
    await reader.loadParameters();
    assert.equal(reader.getDecelPercentPerSecond(), 300);
    assert.equal(reader.getAccelPercentPerSecond(), 200);

    await logger.close();
  });
});

test("MotorCalibration getRampDownTime() computes correctly from decel rate", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "motor.json");
    const calibration = new MotorCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();
    calibration["parameters"].motorDecelPercentPerSecond = 250;
    // 100% / 250 %/s = 0.4s = 400 ms
    assert.equal(calibration.getRampDownTime(), 400);

    await logger.close();
  });
});

test("MotorCalibration falls back to defaults on malformed file", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "broken-motor.json");
    await writeFile(path, "this is not json", "utf8");

    const calibration = new MotorCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();

    const params = calibration.getParameters();
    assert.ok(Number.isFinite(params.motorDecelPercentPerSecond));
    assert.ok(Number.isFinite(params.motorAccelPercentPerSecond));

    await logger.close();
  });
});

test("MotorCalibration ignores non-numeric fields in stored file", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "garbage-motor.json");
    await writeFile(path, JSON.stringify({
      version: "one",
      motorDecelPercentPerSecond: "slow",
      motorAccelPercentPerSecond: null,
    }), "utf8");

    const calibration = new MotorCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();

    const params = calibration.getParameters();
    assert.ok(Number.isFinite(params.motorDecelPercentPerSecond));
    assert.ok(Number.isFinite(params.motorAccelPercentPerSecond));
    assert.ok(params.motorDecelPercentPerSecond > 0);
    assert.ok(params.motorAccelPercentPerSecond > 0);

    await logger.close();
  });
});

test("MotorCalibration resetToDefaults persists default values", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "reset-motor.json");

    const calibration = new MotorCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();
    calibration["parameters"].motorDecelPercentPerSecond = 9999;
    await calibration.saveParameters();
    await calibration.resetToDefaults();

    const reader = new MotorCalibration({ logger, parametersPath: path });
    await reader.loadParameters();
    assert.notEqual(reader.getDecelPercentPerSecond(), 9999);

    await logger.close();
  });
});

test("MotorCalibration migrates legacy motorRampDownTimeMs field on load", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "legacy-motor.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      motorRampDownTimeMs: 400,
      motorRampUpTimeMs: 600,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }), "utf8");

    const calibration = new MotorCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();

    // 400 ms → 100/0.4 = 250 %/s; 600 ms → 100/0.6 ≈ 167 %/s
    assert.equal(calibration.getDecelPercentPerSecond(), 250);
    assert.equal(calibration.getRampDownTime(), 400);

    await logger.close();
  });
});
