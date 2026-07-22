import test from "node:test";
import assert from "node:assert/strict";
import { LearningPolicyConfig } from "../dist/config/learningPolicyConfig.js";

const logger = { child: () => ({ info() {}, warn() {}, error() {} }) };

test("LearningPolicyConfig defaults to training-only learning", () => {
  const policy = new LearningPolicyConfig({ logger });

  assert.equal(policy.allows("operation"), false);
  assert.equal(policy.allows("training"), true);
  assert.equal(policy.allows(), false);
});
