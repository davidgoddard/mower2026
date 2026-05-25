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

test("PathFollowingConfig persists and reloads obstacle path safety parameters", async () => {
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
    assert.equal(defaults.obstacleOutwardOffsetMeters, 0.5);
    assert.equal(defaults.purePursuitMinLookaheadMeters, 0.5);
    assert.equal(defaults.purePursuitBaseLookaheadMeters, 1);
    assert.equal(defaults.purePursuitMaxLookaheadMeters, 2);

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
        obstacleOutwardOffsetMeters: reloaded.getParameters().obstacleOutwardOffsetMeters,
        purePursuitMinLookaheadMeters: reloaded.getParameters().purePursuitMinLookaheadMeters,
        purePursuitBaseLookaheadMeters: reloaded.getParameters().purePursuitBaseLookaheadMeters,
        purePursuitMaxLookaheadMeters: reloaded.getParameters().purePursuitMaxLookaheadMeters,
      },
      {
        closedLoopToleranceMeters: 0.05,
        closedLoopDetectionToleranceMeters: 0.35,
        verificationApproachStandoffMeters: 0.1,
        verificationTurnOnlyDistanceMeters: 0.3,
        obstacleOutwardOffsetMeters: 0.5,
        purePursuitMinLookaheadMeters: 0.5,
        purePursuitBaseLookaheadMeters: 1,
        purePursuitMaxLookaheadMeters: 2,
      },
    );

    await logger.close();
  });
});
