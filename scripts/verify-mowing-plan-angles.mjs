#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAreaPerimeterGeometry } from "../dist/pathfollowing/areaPerimeterPathCleaner.js";
import { buildMowingPlan } from "../dist/pathfollowing/mowingPlanner.js";
import { shapeObstacleRecordedPath } from "../dist/pathfollowing/obstaclePathShaper.js";

const DEFAULT_AREA_FILE = "area-perimeters/Rear_Lawn.area.path.json";
const DEFAULT_STRIP_SPACING_METERS = 0.38;
const DEFAULT_STANDOFF_METERS = 0.15;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function verifyMowingPlanAngles(options = {}) {
  const areaFile = options.areaFile ?? DEFAULT_AREA_FILE;
  const stripSpacingMeters = options.stripSpacingMeters ?? DEFAULT_STRIP_SPACING_METERS;
  const mowingStandoffMeters = options.mowingStandoffMeters ?? DEFAULT_STANDOFF_METERS;
  const obstacleDirectory = options.obstacleDirectory ?? "paths";
  const headings = options.headings ?? Array.from({ length: 180 }, (_, headingDeg) => headingDeg);
  const onProgress = options.onProgress ?? (() => {});
  const areaRecord = await readJson(areaFile);
  const areaGeometry = buildAreaPerimeterGeometry(areaRecord.points);
  const obstacleFiles = (await readdir(obstacleDirectory))
    .filter((name) => !name.startsWith(".") && name.endsWith(".path.json"))
    .sort();
  const obstacles = await Promise.all(obstacleFiles.map(async (name) => {
    const record = await readJson(resolve(obstacleDirectory, name));
    return shapeObstacleRecordedPath(record.points);
  }));
  const failures = [];
  const timings = [];

  for (const headingDeg of headings) {
    const startedAtMs = Date.now();
    try {
      const plan = buildMowingPlan(areaGeometry.chosenPoints, {
        headingDeg,
        stripSpacingMeters,
        bladeWidthMeters: 0.4,
        mowingStandoffMeters,
        obstacles,
      });
      if (plan.strips.length === 0) throw new Error("mowing_plan_has_no_strips");
      timings.push(Date.now() - startedAtMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ headingDeg, message });
      timings.push(Date.now() - startedAtMs);
    }
    onProgress({ headingDeg, failureCount: failures.length, elapsedMs: timings.at(-1) ?? 0 });
  }

  return {
    areaName: areaRecord.name ?? basename(areaFile),
    stripSpacingMeters,
    mowingStandoffMeters,
    checkedAngleCount: headings.length,
    failures,
    totalMs: timings.reduce((sum, value) => sum + value, 0),
    slowestAngleMs: Math.max(...timings),
  };
}

async function main() {
  const areaFile = process.argv[2] ?? DEFAULT_AREA_FILE;
  const stripSpacingMeters = Number(process.argv[3] ?? DEFAULT_STRIP_SPACING_METERS);
  const result = await verifyMowingPlanAngles({
    areaFile,
    stripSpacingMeters,
    onProgress: ({ headingDeg, failureCount, elapsedMs }) => {
      if (headingDeg % 10 === 0 || failureCount > 0) {
        console.log(`${headingDeg}°: ${elapsedMs} ms; failures=${failureCount}`);
      }
    },
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
