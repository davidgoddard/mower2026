import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("GNSS firmware broadcast, parsing and I2C failure scenarios", (t) => {
  const compiler = process.env.CXX || "c++";
  const available = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") {
    t.skip("C++17 compiler required for native firmware tests");
    return;
  }
  assert.equal(available.status, 0, available.stderr);
  const temporary = mkdtempSync(join(tmpdir(), "mower-gnss-test-"));
  try {
    const executable = join(temporary, "gnss-firmware-test");
    const compiled = spawnSync(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror",
      "-I", fileURLToPath(new URL("./firmware/stubs", import.meta.url)),
      fileURLToPath(new URL("./firmware/gnss-firmware.cpp", import.meta.url)),
      "-o", executable,
    ], { encoding: "utf8", timeout: 120_000 });
    assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    t.diagnostic(result.stdout.trim());
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
