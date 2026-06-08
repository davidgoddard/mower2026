import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readJsonFile, writeJsonFile } from "../dist/config/jsonFileStore.js";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "mower-jsonfilestore-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readJsonFile parses a valid JSON file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "ok.json");
    await writeFile(path, JSON.stringify({ a: 1, b: "two" }), "utf8");
    const value = await readJsonFile(path);
    assert.deepEqual(value, { a: 1, b: "two" });
  });
});

test("readJsonFile throws ENOENT for a missing file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nope.json");
    await assert.rejects(readJsonFile(path), (err) => err && err.code === "ENOENT");
  });
});

test("readJsonFile throws SyntaxError on malformed JSON", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json", "utf8");
    await assert.rejects(readJsonFile(path), SyntaxError);
  });
});

test("writeJsonFile creates intermediate directories", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "deep", "file.json");
    await writeJsonFile(path, { ok: true });

    const reread = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(reread, { ok: true });
    assert.ok((await stat(path)).isFile());
  });
});

test("writeJsonFile overwrites existing files atomically from a caller's perspective", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "file.json");
    await writeJsonFile(path, { v: 1 });
    await writeJsonFile(path, { v: 2 });

    const value = await readJsonFile(path);
    assert.deepEqual(value, { v: 2 });
  });
});

test("writeJsonFile then readJsonFile round-trips deeply nested structures", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "deep.json");
    const original = {
      version: 3,
      list: [1, 2, { nested: true, val: -3.14 }],
      flag: false,
      text: "hello world",
    };
    await writeJsonFile(path, original);
    const reloaded = await readJsonFile(path);
    assert.deepEqual(reloaded, original);
  });
});
