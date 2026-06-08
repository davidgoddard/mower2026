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
    assert.equal(params.version, 1);
    assert.equal(typeof params.motorRampDownTimeMs, "number");
    assert.equal(typeof params.motorRampUpTimeMs, "number");
    assert.ok(params.motorRampDownTimeMs > 0);
    assert.ok(params.motorRampUpTimeMs > 0);

    await logger.close();
  });
});

test("MotorCalibration round-trips ramp times through save/load", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "motor.json");

    const writer = new MotorCalibration({ logger, parametersPath: path });
    await writer.loadParameters();
    writer.getParameters();
    writer["parameters"].motorRampDownTimeMs = 723;
    writer["parameters"].motorRampUpTimeMs = 461;
    await writer.saveParameters();

    const reader = new MotorCalibration({ logger, parametersPath: path });
    await reader.loadParameters();
    assert.equal(reader.getRampDownTime(), 723);
    assert.equal(reader.getRampUpTime(), 461);

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
    assert.ok(Number.isFinite(params.motorRampDownTimeMs));
    assert.ok(Number.isFinite(params.motorRampUpTimeMs));

    await logger.close();
  });
});

test("MotorCalibration ignores non-numeric fields in stored file", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "garbage-motor.json");
    await writeFile(path, JSON.stringify({
      version: "one",
      motorRampDownTimeMs: "slow",
      motorRampUpTimeMs: null,
    }), "utf8");

    const calibration = new MotorCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();

    const params = calibration.getParameters();
    assert.ok(Number.isFinite(params.motorRampDownTimeMs));
    assert.ok(Number.isFinite(params.motorRampUpTimeMs));
    assert.ok(params.motorRampDownTimeMs > 0);
    assert.ok(params.motorRampUpTimeMs > 0);

    await logger.close();
  });
});

test("MotorCalibration resetToDefaults persists default values", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "reset-motor.json");

    const calibration = new MotorCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();
    calibration["parameters"].motorRampDownTimeMs = 9999;
    await calibration.saveParameters();
    await calibration.resetToDefaults();

    const reader = new MotorCalibration({ logger, parametersPath: path });
    await reader.loadParameters();
    assert.notEqual(reader.getRampDownTime(), 9999);

    await logger.close();
  });
});
