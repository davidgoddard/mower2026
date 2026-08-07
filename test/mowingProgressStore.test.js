import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MowingProgressStore } from "../dist/pathfollowing/mowingProgressStore.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPose } from "../dist/geometry/positionTypes.js";

test("mowing progress persists sampled poses, survives continue, and clears only on fresh start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mower-progress-"));
  const filePath = join(directory, "mowing-progress.jsonl");
  const poses = new EventEmitter();
  let now = 1_000;
  const store = new MowingProgressStore(poses, {
    filePath,
    sampleIntervalMs: 1_000,
    now: () => now,
  });

  try {
    await store.startFresh();
    poses.emit("poseUpdate", createPose(1, 2, createInternalHeading(10), "gnss"));
    now = 1_500;
    poses.emit("poseUpdate", createPose(2, 3, createInternalHeading(20), "gnss"));
    now = 2_000;
    poses.emit("poseUpdate", createPose(3, 4, createInternalHeading(30), "dead-reckoning"));
    store.pause();
    await store.flush();

    assert.deepEqual(await store.readPoints(), [
      { sequence: 0, x: 1, y: 2, heading: 10, timestamp: 1_000 },
      { sequence: 1, x: 3, y: 4, heading: 30, timestamp: 2_000 },
    ]);

    await store.continueExisting();
    now = 3_000;
    poses.emit("poseUpdate", createPose(5, 6, createInternalHeading(40), "gnss"));
    store.pause();
    await store.flush();
    assert.equal((await store.readPoints()).at(-1).sequence, 2);

    await store.startFresh();
    store.pause();
    assert.equal(await readFile(filePath, "utf8"), "");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mowing progress reader ignores an incomplete final JSONL row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mower-progress-partial-"));
  const filePath = join(directory, "mowing-progress.jsonl");
  const poses = new EventEmitter();
  const store = new MowingProgressStore(poses, { filePath });

  try {
    await writeFile(filePath, '{"sequence":0,"x":1,"y":2,"heading":3,"timestamp":4}\n{"sequence":1', "utf8");
    assert.deepEqual(await store.readPoints(), [
      { sequence: 0, x: 1, y: 2, heading: 3, timestamp: 4 },
    ]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
