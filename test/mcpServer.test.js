import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildNodeTestArgs,
  resolveOutputPath,
  resolveRepoPath,
  sanitizeSavedOutputName,
  scanTextFile,
} from "../tools/mcp-server/server.js";

test("sanitizeSavedOutputName rejects traversal and keeps safe names", () => {
  assert.equal(sanitizeSavedOutputName("results/failures.txt"), "results/failures.txt");
  assert.throws(() => sanitizeSavedOutputName("../secret.txt"), /must not contain '\.\.'/);
});

test("resolveRepoPath rejects absolute paths and traversal", () => {
  assert.equal(resolveRepoPath("README.md").endsWith("/README.md"), true);
  assert.throws(() => resolveRepoPath("/etc/passwd"), /relative to the mower repo/);
  assert.throws(() => resolveRepoPath("../outside"), /escapes the mower repo/);
});

test("resolveOutputPath keeps saved outputs inside the configured output directory", () => {
  const outputPath = resolveOutputPath("tests/server-failure.txt");
  assert.equal(outputPath.includes("/logs/mcp/tests/server-failure.txt"), true);
  assert.throws(() => resolveOutputPath("../../escape.txt"), /must not contain '\.\.'/);
});

test("buildNodeTestArgs supports targeted test files and name filters", () => {
  assert.deepEqual(buildNodeTestArgs({}), ["--test"]);
  assert.deepEqual(
    buildNodeTestArgs({
      files: ["test/server.test.js"],
      testNamePattern: "tuning pages",
    }),
    ["--test", "--test-name-pattern=tuning pages", "test/server.test.js"],
  );
});

test("scanTextFile returns the tail when no grep is provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-server-tail-"));
  try {
    const file = join(dir, "sample.log");
    await writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");
    const result = await scanTextFile(file, { tailLines: 2 });
    assert.equal(result.text.includes("     3 | three"), true);
    assert.equal(result.text.includes("     4 | four"), true);
    assert.equal(result.text.includes("     1 | one"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanTextFile filters by regex with surrounding context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-server-grep-"));
  try {
    const file = join(dir, "sample.log");
    await mkdir(dir, { recursive: true });
    await writeFile(
      file,
      [
        "alpha",
        "beta problem here",
        "gamma",
        "delta",
        "epsilon problem there",
        "zeta",
      ].join("\n"),
      "utf8",
    );
    const result = await scanTextFile(file, {
      grep: "problem",
      contextLines: 1,
      maxMatches: 10,
    });
    assert.equal(result.totalMatches, 2);
    assert.equal(result.shownMatches, 2);
    assert.equal(result.text.includes("     1 | alpha"), true);
    assert.equal(result.text.includes("     2 | beta problem here"), true);
    assert.equal(result.text.includes("     3 | gamma"), true);
    assert.equal(result.text.includes("     4 | delta"), true);
    assert.equal(result.text.includes("     5 | epsilon problem there"), true);
    assert.equal(result.text.includes("     6 | zeta"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
