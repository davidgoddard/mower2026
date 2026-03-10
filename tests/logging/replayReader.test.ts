import test from "node:test";
import assert from "node:assert/strict";
import { ArrayReplayReader } from "../../src/logging/replayReader.js";

test("ArrayReplayReader yields samples in order", async () => {
  const reader = new ArrayReplayReader([
    { tick: 1 },
    { tick: 2 },
    { tick: 3 },
  ]);

  const values: Array<{ tick: number }> = [];
  for await (const sample of reader.readAll()) {
    values.push(sample);
  }

  assert.deepEqual(values, [{ tick: 1 }, { tick: 2 }, { tick: 3 }]);
});
