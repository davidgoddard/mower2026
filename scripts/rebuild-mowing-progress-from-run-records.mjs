#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const [, , inputPath, outputPath, startTime, endTime] = process.argv;
if (!inputPath || !outputPath || !startTime || !endTime) {
  console.error("Usage: rebuild-mowing-progress-from-run-records.mjs <run-records.jsonl> <mowing-progress.jsonl> <start-iso> <end-iso>");
  process.exitCode = 1;
} else {
  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new Error("invalid_time_range");
  }

  const snapshots = [];
  const lines = createInterface({
    input: createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    const recordStartedAt = Date.parse(record.startedAt);
    if (!Number.isFinite(recordStartedAt) || recordStartedAt < startMs || recordStartedAt > endMs) {
      continue;
    }
    snapshots.push(record.anchor, ...(record.heartbeat ?? []), record.brakeTrigger, record.settled);
  }

  snapshots.sort((left, right) => Number(left?.tMs ?? 0) - Number(right?.tMs ?? 0));
  const points = [];
  let lastTimestamp = Number.NEGATIVE_INFINITY;
  for (const snapshot of snapshots) {
    const timestamp = Number(snapshot?.tMs);
    const x = Number(snapshot?.xMeters);
    const y = Number(snapshot?.yMeters);
    const heading = Number(snapshot?.headingDeg);
    if (![timestamp, x, y, heading].every(Number.isFinite) || timestamp - lastTimestamp < 1_000) {
      continue;
    }
    points.push({ sequence: points.length, x, y, heading, timestamp });
    lastTimestamp = timestamp;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, points.map((point) => JSON.stringify(point)).join("\n") + (points.length ? "\n" : ""), "utf8");
  console.log(`Wrote ${points.length} mowing-progress points to ${outputPath}`);
}
