import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RunRecordWriter } from "../dist/control/runRecord.js";

function makeLogger() {
  const calls = [];
  const logger = {
    info: (...args) => calls.push(["info", ...args]),
    warn: (...args) => calls.push(["warn", ...args]),
    error: (...args) => calls.push(["error", ...args]),
    debug: (...args) => calls.push(["debug", ...args]),
    transition: (...args) => calls.push(["transition", ...args]),
    flush: () => {},
    close: () => {},
    child: () => logger,
  };
  return { logger, calls };
}

function makeRecord(overrides = {}) {
  return {
    runId: "run-test-1",
    startedAt: "2026-06-11T10:30:00.000Z",
    directionSign: 1,
    direction: "forward",
    plannedDistanceMeters: 1.0,
    fullPowerCommand: 1.0,
    calibrationFingerprintAtRun: null,
    params: { coastDistanceUsedMeters: 0.7, cteGainUsed: 0.3, shortBucketUsed: false },
    anchor: {
      xMeters: 0,
      yMeters: 0,
      headingDeg: 0,
      quality: "gnss",
      usingGnssHeading: true,
      gnssAgeMs: 0,
      tMs: 1717000000000,
    },
    lineEnd: { xMeters: 1, yMeters: 0 },
    brakeTrigger: {
      xMeters: 0.4,
      yMeters: 0.01,
      headingDeg: 0,
      quality: "gnss",
      usingGnssHeading: true,
      gnssAgeMs: 50,
      tMs: 1717000001000,
      remainingAlongTrackMeters: 0.6,
      reason: "brake_distance",
    },
    settled: {
      xMeters: 1.0,
      yMeters: 0.005,
      headingDeg: 0,
      quality: "gnss",
      usingGnssHeading: true,
      gnssAgeMs: 0,
      tMs: 1717000003000,
    },
    errorXMeters: 0.005,
    errorYMeters: 0.005,
    avgCteMeters: 0.01,
    maxCteMeters: 0.02,
    coastDistanceMeasuredMeters: 0.6,
    peakTickRate: 42,
    pitchAtAnchorDeg: 0,
    durationMs: 3000,
    status: "success",
    statusMessage: null,
    events: { obstruction: false, wheelSlip: false, gnssDemoted: false },
    heartbeat: [],
    learning: { applied: true, skipReason: null, outlier: false },
    ...overrides,
  };
}

test("RunRecordWriter writes a JSONL row to <logDir>/run-records/<date>.jsonl", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mower-runrecord-"));
  try {
    const { logger } = makeLogger();
    const writer = new RunRecordWriter({ logger, logDir: dir });
    const record = makeRecord();
    await writer.append(record);

    const expectedPath = join(dir, "run-records", "2026-06-11.jsonl");
    const content = await readFile(expectedPath, "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.runId, "run-test-1");
    assert.equal(parsed.direction, "forward");
    assert.equal(parsed.brakeTrigger.reason, "brake_distance");
    assert.equal(parsed.coastDistanceMeasuredMeters, 0.6);
    assert.equal(parsed.peakTickRate, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RunRecordWriter appends multiple rows in order to the same date file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mower-runrecord-"));
  try {
    const { logger } = makeLogger();
    const writer = new RunRecordWriter({ logger, logDir: dir });
    await writer.append(makeRecord({ runId: "run-1" }));
    await writer.append(makeRecord({ runId: "run-2" }));
    await writer.append(makeRecord({ runId: "run-3" }));

    const expectedPath = join(dir, "run-records", "2026-06-11.jsonl");
    const content = await readFile(expectedPath, "utf8");
    const ids = content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line).runId);
    assert.deepEqual(ids, ["run-1", "run-2", "run-3"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RunRecordWriter writes records on different dates to different files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mower-runrecord-"));
  try {
    const { logger } = makeLogger();
    const writer = new RunRecordWriter({ logger, logDir: dir });
    await writer.append(makeRecord({ runId: "june", startedAt: "2026-06-11T10:30:00.000Z" }));
    await writer.append(makeRecord({ runId: "july", startedAt: "2026-07-04T09:15:00.000Z" }));
    const juneContent = await readFile(join(dir, "run-records", "2026-06-11.jsonl"), "utf8");
    const julyContent = await readFile(join(dir, "run-records", "2026-07-04.jsonl"), "utf8");
    assert.equal(JSON.parse(juneContent.trim()).runId, "june");
    assert.equal(JSON.parse(julyContent.trim()).runId, "july");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
