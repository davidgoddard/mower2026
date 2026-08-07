import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MowingResumeStore } from "../dist/pathfollowing/mowingResumeStore.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  transition() {},
};

function state(savedAt) {
  return {
    version: 2,
    areaName: "test-area",
    savedAt,
    currentStripIndex: savedAt,
    totalStrips: 1,
    tracedBoundaryKeys: [],
    plan: {
      strips: [],
      regions: [],
      regionOrder: [],
      routeCost: {
        mowingDistanceMeters: 0,
        connectorDistanceMeters: 0,
        startAndReturnDistanceMeters: 0,
        estimatedCombinedWheelTravelMeters: 0,
        regionTransitionCount: 0,
      },
    },
    areaPoints: [],
    obstaclePointsArray: [],
    initialEntryPlan: null,
    activeOperation: {
      kind: "turn",
      phase: "mowing_strip",
      stripIndex: savedAt,
      targetHeadingDeg: 0,
      continuation: { stage: "complete", stripIndex: savedAt },
    },
  };
}

test("MowingResumeStore serializes saves and clears in request order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mower-resume-store-"));
  try {
    const store = new MowingResumeStore({
      filePath: join(dir, "resume.json"),
      logger,
    });

    const operations = [
      store.saveState(state(1)),
      store.saveState(state(2)),
      store.clear(),
      store.saveState(state(3)),
    ];
    await Promise.all(operations);

    const loaded = await store.loadState();
    assert.equal(loaded?.savedAt, 3);
    assert.equal(loaded?.currentStripIndex, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
