import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let temporaryFileSequence = 0;

export async function readJsonFile(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8");
  return JSON.parse(content) as unknown;
}

/**
 * Write `value` to `path` atomically: serialize to a sibling `.tmp` file then
 * rename into place, so a power loss mid-write cannot leave a half-written file
 * at the canonical path. The directory is created if missing.
 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${temporaryFileSequence++}`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
    await rename(tmpPath, path);
  } finally {
    try {
      await unlink(tmpPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
}

/**
 * Move a corrupt config file aside instead of overwriting it. The target name
 * embeds an iso-style timestamp (no colons, filesystem-safe) so multiple
 * generations can coexist for diagnosis. Returns the quarantine path on
 * success, or `null` if the move could not be performed (e.g. source missing).
 */
export async function quarantineCorruptFile(path: string, isoTimestamp: string): Promise<string | null> {
  const safeStamp = isoTimestamp.replace(/[:.]/g, "-");
  const quarantinedPath = `${path}.broken-${safeStamp}`;
  try {
    await rename(path, quarantinedPath);
    return quarantinedPath;
  } catch {
    return null;
  }
}
