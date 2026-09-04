import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LearningPolicyConfig } from "../dist/config/learningPolicyConfig.js";

const logger = { child: () => ({ info() {}, warn() {}, error() {} }) };

test("LearningPolicyConfig defaults to training-only learning", () => {
  const policy = new LearningPolicyConfig({ logger });

  assert.equal(policy.allows("operation"), false);
  assert.equal(policy.allows("training"), true);
  assert.equal(policy.allows("mowing_strip"), false);
  assert.equal(policy.allows(), false);
});

test("mowing-and-training learns strips but not turns or ordinary transit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mower-learning-policy-"));
  const path = join(dir, "learning-policy.json");
  try {
    await writeFile(path, JSON.stringify({ mode: "mowing_and_training" }));
    const policy = new LearningPolicyConfig({ logger, path });
    await policy.load();

    assert.equal(policy.allows("training"), true);
    assert.equal(policy.allows("mowing_strip"), true);
    assert.equal(policy.allows("operation"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
