import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeometryCalibration, SessionLogger } from "../dist/index.js";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "mower-geometry-calibration-"));
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
    source: "GeometryCalibrationTest",
    logDir: dir,
    minLevel: "error",
  });
}

test("GeometryCalibration defaults to zero offsets when file is missing", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const calibration = new GeometryCalibration({
      logger,
      parametersPath: join(dir, "missing.json"),
    });
    await calibration.loadParameters();

    assert.equal(calibration.getPositionOffsetForwardMeters(), 0);
    assert.equal(calibration.getPositionOffsetRightMeters(), 0);

    await logger.close();
  });
});

test("GeometryCalibration round-trips offsets through save/load", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "geom.json");

    const writer = new GeometryCalibration({ logger, parametersPath: path });
    await writer.loadParameters();
    writer.setPositionOffset(0.13, -0.07);
    await writer.saveParameters();

    const reader = new GeometryCalibration({ logger, parametersPath: path });
    await reader.loadParameters();
    assert.equal(reader.getPositionOffsetForwardMeters(), 0.13);
    assert.equal(reader.getPositionOffsetRightMeters(), -0.07);

    await logger.close();
  });
});

test("GeometryCalibration falls back to defaults on malformed file", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not valid json", "utf8");

    const calibration = new GeometryCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();

    assert.equal(calibration.getPositionOffsetForwardMeters(), 0);
    assert.equal(calibration.getPositionOffsetRightMeters(), 0);

    await logger.close();
  });
});

test("GeometryCalibration ignores non-numeric offsets in stored file", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "garbage.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      positionOffsetForwardMeters: "front",
      positionOffsetRightMeters: NaN,
    }), "utf8");

    const calibration = new GeometryCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();

    assert.equal(calibration.getPositionOffsetForwardMeters(), 0);
    assert.equal(calibration.getPositionOffsetRightMeters(), 0);

    await logger.close();
  });
});

test("GeometryCalibration resetToDefaults clears any stored offsets", async () => {
  await withTempDir(async (dir) => {
    const logger = await makeLogger(dir);
    const path = join(dir, "reset.json");

    const calibration = new GeometryCalibration({ logger, parametersPath: path });
    await calibration.loadParameters();
    calibration.setPositionOffset(0.5, 0.5);
    await calibration.saveParameters();
    await calibration.resetToDefaults();

    const reader = new GeometryCalibration({ logger, parametersPath: path });
    await reader.loadParameters();
    assert.equal(reader.getPositionOffsetForwardMeters(), 0);
    assert.equal(reader.getPositionOffsetRightMeters(), 0);

    await logger.close();
  });
});
