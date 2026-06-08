import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PathFollowingConfig, SessionLogger } from "../dist/index.js";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "mower-path-following-config-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("PathFollowingConfig persists and reloads segmented-drive perimeter follow parameters", async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: "core-app",
      context: "test",
      source: "PathFollowingConfigTest",
      logDir: dir,
      minLevel: "error",
    });

    const parametersPath = join(dir, "path-following-parameters.json");
    const config = new PathFollowingConfig({
      logger,
      parametersPath,
    });
    await config.loadParameters();

    const defaults = config.getParameters();
    assert.equal(defaults.closedLoopToleranceMeters, 0.05);
    assert.equal(defaults.closedLoopDetectionToleranceMeters, 0.35);
    assert.equal(defaults.verificationApproachStandoffMeters, 0.1);
    assert.equal(defaults.verificationTurnOnlyDistanceMeters, 0.3);
    assert.equal(defaults.segmentedDriveSimplificationToleranceMeters, 0.05);
    assert.equal(defaults.segmentedDriveMaxVertexTurnDeg, 10);
    assert.equal(defaults.segmentedDriveMaxSegmentLengthMeters, 0.5);
    assert.equal(defaults.segmentedDriveMinSegmentLengthMeters, 0.05);
    assert.equal(defaults.segmentedDriveMaxCteMeters, 0.05);
    assert.equal(defaults.pathRetryReverseDistanceMeters, 0.5);
    assert.equal(defaults.turnAlignmentThresholdDeg, 2);
    assert.equal(defaults.obstacleOutwardOffsetMeters, undefined);
    assert.equal(defaults.purePursuitMinLookaheadMeters, undefined);

    const reloaded = new PathFollowingConfig({
      logger,
      parametersPath,
    });
    await reloaded.loadParameters();

    assert.deepEqual(
      {
        closedLoopToleranceMeters: reloaded.getParameters().closedLoopToleranceMeters,
        closedLoopDetectionToleranceMeters: reloaded.getParameters().closedLoopDetectionToleranceMeters,
        verificationApproachStandoffMeters: reloaded.getParameters().verificationApproachStandoffMeters,
        verificationTurnOnlyDistanceMeters: reloaded.getParameters().verificationTurnOnlyDistanceMeters,
        segmentedDriveSimplificationToleranceMeters: reloaded.getParameters().segmentedDriveSimplificationToleranceMeters,
        segmentedDriveMaxVertexTurnDeg: reloaded.getParameters().segmentedDriveMaxVertexTurnDeg,
      },
      {
        closedLoopToleranceMeters: 0.05,
        closedLoopDetectionToleranceMeters: 0.35,
        verificationApproachStandoffMeters: 0.1,
        verificationTurnOnlyDistanceMeters: 0.3,
        segmentedDriveSimplificationToleranceMeters: 0.05,
        segmentedDriveMaxVertexTurnDeg: 10,
      },
    );

    await logger.close();
  });
});
