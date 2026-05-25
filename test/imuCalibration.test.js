import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImuCalibration, SessionLogger } from "../dist/index.js";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "mower-imu-calibration-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ImuCalibration persists and reloads the yaw scale factor", async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: "core-app",
      context: "test",
      source: "ImuCalibrationTest",
      logDir: dir,
      minLevel: "error",
    });

    const path = join(dir, "imu-yaw-calibration.json");
    const calibration = new ImuCalibration({
      logger,
      parametersPath: path,
    });

    calibration.setYawScaleFactor(1.0588, 5);
    await calibration.saveParameters();

    const reloaded = new ImuCalibration({
      logger,
      parametersPath: path,
    });
    await reloaded.loadParameters();

    const parameters = reloaded.getParameters();
    assert.equal(parameters.yawScaleFactor, 1.0588);
    assert.equal(parameters.sampleCount, 5);
    assert.equal(parameters.version, 1);

    await logger.close();
  });
});
