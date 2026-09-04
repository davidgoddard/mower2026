#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPegLayout } from "./peg-layout-geometry.mjs";

const DEFAULTS = Object.freeze({
  areaName: "Rear Lawn",
  headingDeg: 23,
  targetAreaSquareMeters: 83.25,
  pauseSeconds: 10,
  baseUrl: "http://127.0.0.1:8090",
});

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const areaPath = path.join(
  projectRoot,
  "area-perimeters",
  `${sanitizePathName(options.areaName)}.area.path.json`,
);
const pathsDirectory = path.join(projectRoot, "paths");
const pathFollowingConfigPath = path.join(projectRoot, "config", "path-following-parameters.json");

const [areaRecord, pathFollowingConfig, productionGeometry] = await Promise.all([
  readJson(areaPath),
  readJson(pathFollowingConfigPath),
  loadProductionGeometry(projectRoot),
]);
const obstacleRecords = await loadObstacleRecords(pathsDirectory);
const areaPoints = productionGeometry.shapeAreaRecordedPath(areaRecord.points);
const obstaclePointsArray = obstacleRecords.map((obstacle) => (
  productionGeometry.shapeObstacleRecordedPath(obstacle.points)
));
const operationalStandoffMeters = options.standoffMeters
  ?? positiveFinite(pathFollowingConfig.mowingStandoffMeters, "mowingStandoffMeters");

const layout = buildPegLayout({
  areaPoints,
  obstaclePointsArray,
  headingDeg: options.headingDeg,
  targetAreaSquareMeters: options.targetAreaSquareMeters,
  edgeInsetMeters: options.edgeInsetMeters ?? operationalStandoffMeters,
  endpointStandoffMeters: operationalStandoffMeters,
});
const interPegRoutes = validateInterPegRoutes({
  layout,
  areaPoints,
  obstaclePointsArray,
  operationalStandoffMeters,
  productionGeometry,
});

printLayout(
  layout,
  areaRecord.name ?? options.areaName,
  obstacleRecords.map((record) => record.name),
  interPegRoutes,
);

if (!options.execute) {
  console.log("\nPreview only: no motor commands were sent.");
  console.log("Run with --execute when the mower is inside the lawn near the top edge.");
  process.exit(0);
}

let stopping = false;
let activeRequestController = null;
const stopAndExit = async (signal, exitCode = 130) => {
  if (stopping) return;
  stopping = true;
  activeRequestController?.abort();
  console.error(`\n${signal}: requesting an immediate mower stop...`);
  try {
    await postJson(`${options.baseUrl}/api/stop`, {}, { timeoutMs: 5_000 });
  } catch (error) {
    console.error(`Stop request failed: ${describeError(error)}`);
  }
  process.exit(exitCode);
};
process.once("SIGINT", () => void stopAndExit("SIGINT"));
process.once("SIGTERM", () => void stopAndExit("SIGTERM", 143));

try {
  const initialPose = await requireReadyMower(options.baseUrl);
  console.log(
    `\nStarting from live GNSS pose (${fixed(initialPose.xMeters, 2)}, ${fixed(initialPose.yMeters, 2)}).`,
  );
  console.log("Keep the Drive & Paths STOP control available throughout the run.\n");

  for (const peg of layout.pegs) {
    if (stopping) break;
    const primitives = await getJson(`${options.baseUrl}/api/primitives`, { timeoutMs: 5_000 });
    const livePose = requireGnssPose(primitives);
    const from = { xMeters: livePose.xMeters, yMeters: livePose.yMeters };
    const route = productionGeometry.buildMowingTransitPath(
      areaPoints,
      obstaclePointsArray,
      from,
      peg.point,
      operationalStandoffMeters,
    );
    if (!productionGeometry.isMowingExecutionPathSafe(route, areaPoints, obstaclePointsArray)) {
      throw new Error(`unsafe_route_to_peg_${peg.index + 1}`);
    }

    console.log(
      `Peg ${peg.index + 1}/${layout.pegs.length}: boundary ${peg.boundaryIndex + 1} ${peg.side}`
      + ` at (${fixed(peg.point.xMeters, 3)}, ${fixed(peg.point.yMeters, 3)})`
      + `${route.length > 2 ? ` via ${route.length - 2} safe detour point(s)` : ""}.`,
    );

    for (const target of route.slice(1)) {
      const latestPrimitives = await getJson(`${options.baseUrl}/api/primitives`, { timeoutMs: 5_000 });
      requireGnssPose(latestPrimitives);
      activeRequestController = new AbortController();
      const driveResult = await postJson(`${options.baseUrl}/api/drive/execute`, {
        targetX: target.xMeters,
        targetY: target.yMeters,
        learningEnabled: false,
      }, { signal: activeRequestController.signal });
      activeRequestController = null;
      if (driveResult.status !== "success") {
        throw new Error(
          `drive_to_peg_${peg.index + 1}_${driveResult.status ?? "unknown"}`
          + `${driveResult.errorMessage ? `:${driveResult.errorMessage}` : ""}`,
        );
      }
    }

    await pegPause(options.pauseSeconds, peg.index + 1);
  }

  if (!stopping) {
    console.log("\nPeg layout complete. The mower remains stopped at the final peg.");
  }
} catch (error) {
  if (!stopping) {
    console.error(`\nPeg layout aborted: ${describeError(error)}`);
    try {
      await postJson(`${options.baseUrl}/api/stop`, {}, { timeoutMs: 5_000 });
    } catch (stopError) {
      console.error(`Emergency stop request also failed: ${describeError(stopError)}`);
    }
    process.exitCode = 1;
  }
}

function parseArguments(args) {
  const parsed = { ...DEFAULTS, execute: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute") {
      parsed.execute = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing_value_for_${argument}`);
    }
    index += 1;
    if (argument === "--area") parsed.areaName = value;
    else if (argument === "--heading") parsed.headingDeg = finite(value, "heading");
    else if (argument === "--target-area") parsed.targetAreaSquareMeters = positiveFinite(value, "target-area");
    else if (argument === "--pause-seconds") parsed.pauseSeconds = nonNegativeFinite(value, "pause-seconds");
    else if (argument === "--standoff") parsed.standoffMeters = positiveFinite(value, "standoff");
    else if (argument === "--edge-inset") parsed.edgeInsetMeters = nonNegativeFinite(value, "edge-inset");
    else if (argument === "--base-url") parsed.baseUrl = value.replace(/\/$/, "");
    else throw new Error(`unknown_argument_${argument}`);
  }
  return parsed;
}

async function loadProductionGeometry(rootDirectory) {
  try {
    const [areaCleaner, obstacleShaper, mowingPlanner, mowingExecutor] = await Promise.all([
      import(pathToFileURL(path.join(rootDirectory, "dist/pathfollowing/areaPerimeterPathCleaner.js"))),
      import(pathToFileURL(path.join(rootDirectory, "dist/pathfollowing/obstaclePathShaper.js"))),
      import(pathToFileURL(path.join(rootDirectory, "dist/pathfollowing/mowingPlanner.js"))),
      import(pathToFileURL(path.join(rootDirectory, "dist/pathfollowing/mowingExecutor.js"))),
    ]);
    return {
      shapeAreaRecordedPath: areaCleaner.shapeAreaRecordedPath,
      shapeObstacleRecordedPath: obstacleShaper.shapeObstacleRecordedPath,
      buildMowingTransitPath: mowingPlanner.buildMowingTransitPath,
      isMowingExecutionPathSafe: mowingExecutor.isMowingExecutionPathSafe,
    };
  } catch (error) {
    throw new Error(`production_dist_unavailable:${describeError(error)}`);
  }
}

async function loadObstacleRecords(directory) {
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith(".path.json") && !filename.startsWith("."))
    .sort();
  return Promise.all(filenames.map((filename) => readJson(path.join(directory, filename))));
}

async function requireReadyMower(baseUrl) {
  const [health, primitives, drive, segment, mowing] = await Promise.all([
    getJson(`${baseUrl}/health`, { timeoutMs: 5_000 }),
    getJson(`${baseUrl}/api/primitives`, { timeoutMs: 5_000 }),
    getJson(`${baseUrl}/api/drive/status`, { timeoutMs: 5_000 }),
    getJson(`${baseUrl}/api/segment/status`, { timeoutMs: 5_000 }),
    getJson(`${baseUrl}/api/mowing/status`, { timeoutMs: 5_000 }),
  ]);
  if (!health.ok || health.state !== "running") throw new Error("mower_service_not_running");
  if (!["idle", "stopped"].includes(drive.state?.status)) throw new Error("drive_controller_busy");
  if (segment.state?.running) throw new Error("segment_test_active");
  if (!["idle", "complete", "stopped", "error"].includes(mowing.phase)) {
    throw new Error(`mowing_operation_active:${mowing.phase}`);
  }
  return requireGnssPose(primitives);
}

function requireGnssPose(response) {
  const pose = response?.primitives?.poseFusion;
  if (
    pose?.quality !== "gnss"
    || !Number.isFinite(pose.xMeters)
    || !Number.isFinite(pose.yMeters)
  ) {
    throw new Error("trusted_gnss_pose_required");
  }
  return pose;
}

function validateInterPegRoutes(context) {
  const routes = [];
  for (let index = 1; index < context.layout.pegs.length; index += 1) {
    const route = context.productionGeometry.buildMowingTransitPath(
      context.areaPoints,
      context.obstaclePointsArray,
      context.layout.pegs[index - 1].point,
      context.layout.pegs[index].point,
      context.operationalStandoffMeters,
    );
    if (!context.productionGeometry.isMowingExecutionPathSafe(
      route,
      context.areaPoints,
      context.obstaclePointsArray,
    )) {
      throw new Error(`unsafe_inter_peg_route_${index}_to_${index + 1}`);
    }
    routes.push(route);
  }
  return routes;
}

async function pegPause(seconds, pegNumber) {
  const wholeSeconds = Math.max(0, Math.ceil(seconds));
  process.stdout.write(`  Reached peg ${pegNumber}. Place the peg: ${wholeSeconds}s`);
  for (let remaining = wholeSeconds; remaining > 0; remaining -= 1) {
    await sleep(1_000);
    process.stdout.write(` ${remaining - 1}s`);
  }
  process.stdout.write("\x07\n");
}

function printLayout(layout, areaName, obstacleNames, interPegRoutes) {
  console.log(`Peg layout for ${areaName}`);
  console.log(
    `Pattern axis ${fixed(layout.headingDeg, 1)} degrees; target ${fixed(layout.targetAreaSquareMeters, 2)} m².`,
  );
  console.log(
    `Usable marked area ${fixed(layout.usableAreaSquareMeters, 2)} m² after exclusions`
    + ` (${obstacleNames.length > 0 ? obstacleNames.join(", ") : "none"}).`,
  );
  console.log(
    `${layout.boundaries.length} cross-lawn lines, ${layout.pegs.length} peg stops;`
    + ` edge inset ${fixed(layout.edgeInsetMeters, 2)} m and endpoint standoff`
    + ` ${fixed(layout.endpointStandoffMeters, 2)} m.`,
  );
  console.log(
    `${interPegRoutes.length} inter-peg routes validated;`
    + ` ${interPegRoutes.filter((route) => route.length > 2).length} require safe detours.`,
  );
  console.table(layout.boundaries.map((boundary) => ({
    line: boundary.index + 1,
    actualWidthM: fixed(boundary.spanMeters, 2),
    pegToPegM: fixed(boundary.pegSpanMeters, 2),
    leftX: fixed(boundary.left.xMeters, 3),
    leftY: fixed(boundary.left.yMeters, 3),
    rightX: fixed(boundary.right.xMeters, 3),
    rightY: fixed(boundary.right.yMeters, 3),
  })));
  console.table(layout.bands.map((band) => ({
    band: band.index + 1,
    depthM: fixed(band.depthMeters, 2),
    usableAreaM2: fixed(band.usableAreaSquareMeters, 2),
    targetBand: band.isFullTargetBand ? "yes" : "remainder",
  })));
}

async function getJson(url, options = {}) {
  return requestJson(url, { ...options, method: "GET" });
}

async function postJson(url, body, options = {}) {
  return requestJson(url, {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function requestJson(url, options) {
  const timeoutController = options.timeoutMs ? new AbortController() : null;
  const timeout = timeoutController
    ? setTimeout(() => timeoutController.abort(), options.timeoutMs)
    : null;
  const signal = options.signal ?? timeoutController?.signal;
  try {
    const response = await fetch(url, { ...options, signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${response.status}:${payload.error ?? response.statusText}`);
    }
    return payload;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function sanitizePathName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function fixed(value, digits) {
  return Number(value.toFixed(digits));
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}_must_be_finite`);
  return number;
}

function positiveFinite(value, label) {
  const number = finite(value, label);
  if (number <= 0) throw new Error(`${label}_must_be_positive`);
  return number;
}

function nonNegativeFinite(value, label) {
  const number = finite(value, label);
  if (number < 0) throw new Error(`${label}_must_be_non_negative`);
  return number;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  console.log(`Usage: npm run measure:peg-layout -- [options]

Defaults to a read-only preview of Rear Lawn using Pattern A.

  --execute               Send segment-drive commands after safety checks
  --area NAME             Stored mowing area (default: Rear Lawn)
  --heading DEGREES       Long-side axis (default: 23)
  --target-area M2        Usable area per full band (default: 83.25)
  --pause-seconds SECONDS Peg-placement pause (default: 10)
  --standoff METERS       Override configured endpoint/routing standoff
  --edge-inset METERS     Override top and bottom cross-line inset
  --base-url URL          Mower service URL (default: http://127.0.0.1:8090)
  --help                   Show this help
`);
}
