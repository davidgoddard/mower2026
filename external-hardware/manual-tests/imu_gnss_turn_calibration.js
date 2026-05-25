// Interactive IMU/GNSS turn calibration utility.
// Run `npm run build` first so the built runtime modules in `dist/` exist.

import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import { LiveI2cTransport } from "../../dist/i2c/liveI2cTransport.js";
import { I2cBusController } from "../../dist/i2c/i2cBusController.js";
import { Bmi160ImuSensor } from "../../dist/imu/bmi160ImuSensor.js";
import { GnssNodeClient } from "../../dist/gnss/gnssNodeClient.js";
import {
  buildTurnCalibrationSummary,
  fieldHeadingToInternalDegrees,
  headingDeltaDegrees,
  internalHeadingToFieldDegrees,
  isGnssHeadingReady,
  normalizeInternalHeadingDegrees,
} from "./imu_gnss_turn_calibration_helpers.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_OUTPUT_PATH = resolve(REPO_ROOT, "logs", `imu-gnss-turn-calibration-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const DEFAULT_EXPORT_PATH = resolve(REPO_ROOT, "config", "imu-yaw-calibration.json");

const BUS_NUMBER = Number(process.env.MOWER_I2C_BUS_NUMBER ?? 1);
const GNSS_ADDRESS = Number(process.env.MOWER_GNSS_I2C_ADDRESS ?? 0x52);
const IMU_POLL_INTERVAL_MS = Number(process.env.MOWER_IMU_POLL_INTERVAL_MS ?? 33);
const GNSS_POLL_INTERVAL_MS = Number(process.env.MOWER_GNSS_POLL_INTERVAL_MS ?? 250);
const GNSS_MAX_HEADING_ACCURACY_DEGREES = Number(process.env.MOWER_GNSS_MAX_HEADING_ACCURACY_DEGREES ?? 1);
const GNSS_MAX_SAMPLE_AGE_MS = Number(process.env.MOWER_GNSS_MAX_SAMPLE_AGE_MS ?? 1000);
const OUTPUT_PATH = resolve(process.env.MOWER_IMU_GNSS_TURN_LOG_PATH ?? DEFAULT_OUTPUT_PATH);
const EXPORT_PATH = resolve(process.env.MOWER_IMU_YAW_CALIBRATION_PATH ?? DEFAULT_EXPORT_PATH);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDegrees(value) {
  return `${value.toFixed(1)}°`;
}

function formatNullableDegrees(value) {
  return value == null ? "—" : formatDegrees(value);
}

function formatNullableNumber(value, precision = 2) {
  return value == null ? "—" : value.toFixed(precision);
}

function formatSampleAge(value) {
  return value == null ? "—" : `${Math.round(value)}ms`;
}

function createState() {
  return {
    latestImuSample: null,
    latestGnssSample: null,
    latestGnssError: null,
    latestImuError: null,
    lastImuSampleMillis: null,
    rawImuHeadingInternalDeg: 0,
    sessionOffsetInternalDeg: 0,
    activeRun: null,
    completedRuns: [],
    running: true,
    runCounter: 1,
  };
}

function getGnssHeadingInternalDeg(sample) {
  if (sample?.headingDegrees == null) {
    return null;
  }

  return fieldHeadingToInternalDegrees(sample.headingDegrees);
}

function getAlignedImuHeadingInternalDeg(state) {
  return normalizeInternalHeadingDegrees(state.rawImuHeadingInternalDeg + state.sessionOffsetInternalDeg);
}

function isGnssReady(sample) {
  return isGnssHeadingReady(sample, {
    maxHeadingAccuracyDegrees: GNSS_MAX_HEADING_ACCURACY_DEGREES,
    maxSampleAgeMillis: GNSS_MAX_SAMPLE_AGE_MS,
  });
}

async function writeJsonLine(path, value) {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function getAverageYawScaleCorrection(runs) {
  const usableCorrections = runs
    .map((run) => run.summary.scaleCorrection)
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  if (usableCorrections.length === 0) {
    return null;
  }

  return {
    value: usableCorrections.reduce((sum, value) => sum + value, 0) / usableCorrections.length,
    sampleCount: usableCorrections.length,
  };
}

async function writeCalibrationExport(path, yawScaleFactor, sampleCount) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      version: 1,
      yawScaleFactor,
      sampleCount,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
}

function renderStatus(state) {
  const gnssSample = state.latestGnssSample;
  const gnssReady = isGnssReady(gnssSample);
  const gnssHeadingInternalDeg = getGnssHeadingInternalDeg(gnssSample);
  const alignedImuHeadingInternalDeg = getAlignedImuHeadingInternalDeg(state);
  const activeRun = state.activeRun;

  console.log("\nStatus");
  console.log(
    `GNSS: ${gnssSample == null ? "waiting" : gnssReady ? "ready" : "not ready"} | `
    + `fix ${gnssSample?.fixType ?? "—"} | `
    + `heading ${formatNullableDegrees(gnssSample?.headingDegrees)} | `
    + `heading accuracy ${formatNullableDegrees(gnssSample?.headingAccuracyDegrees)} | `
    + `position accuracy ${formatNullableNumber(gnssSample?.positionAccuracyMeters, 3)}m | `
    + `satellites ${gnssSample?.satellitesInUse ?? "—"} | `
    + `sample age ${formatSampleAge(gnssSample?.sampleAgeMillis)}`,
  );
  if (state.latestGnssError != null) {
    console.log(`GNSS error: ${state.latestGnssError}`);
  }
  if (state.latestImuError != null) {
    console.log(`IMU error: ${state.latestImuError}`);
  }
  console.log(
    `IMU: raw ${formatDegrees(state.rawImuHeadingInternalDeg)} internal / ${formatDegrees(internalHeadingToFieldDegrees(state.rawImuHeadingInternalDeg))} field | `
    + `aligned ${formatDegrees(alignedImuHeadingInternalDeg)} internal / ${formatDegrees(internalHeadingToFieldDegrees(alignedImuHeadingInternalDeg))} field`,
  );

  if (gnssHeadingInternalDeg != null) {
    const rawDelta = headingDeltaDegrees(state.rawImuHeadingInternalDeg, gnssHeadingInternalDeg);
    const alignedDelta = headingDeltaDegrees(alignedImuHeadingInternalDeg, gnssHeadingInternalDeg);
    console.log(
      `IMU-GNSS delta: raw ${formatDegrees(rawDelta)} | aligned ${formatDegrees(alignedDelta)} | `
      + `ready ${gnssReady ? "yes" : "no"}`,
    );
  }

  if (activeRun != null) {
    console.log(
      `Run ${activeRun.runId} active: start IMU ${formatDegrees(activeRun.startRawImuHeadingInternalDeg)} internal / `
      + `${formatDegrees(internalHeadingToFieldDegrees(activeRun.startRawImuHeadingInternalDeg))} field, `
      + `start GNSS ${formatDegrees(internalHeadingToFieldDegrees(activeRun.startGnssHeadingInternalDeg))} field`,
    );
  } else {
    console.log("No active run.");
  }

  console.log("Keys: S=start and align IMU to current GNSS, E=end and save sample, Q=quit");
}

function printRunSummary(run, summary) {
  console.log(`\nSaved run ${run.runId}`);
  console.log({
    runId: run.runId,
    start: {
      imuInternalDeg: Number(run.startRawImuHeadingInternalDeg.toFixed(3)),
      imuFieldDeg: Number(internalHeadingToFieldDegrees(run.startRawImuHeadingInternalDeg).toFixed(3)),
      gnssInternalDeg: Number(run.startGnssHeadingInternalDeg.toFixed(3)),
      gnssFieldDeg: Number(internalHeadingToFieldDegrees(run.startGnssHeadingInternalDeg).toFixed(3)),
    },
    end: {
      imuInternalDeg: Number(run.endRawImuHeadingInternalDeg.toFixed(3)),
      imuFieldDeg: Number(internalHeadingToFieldDegrees(run.endRawImuHeadingInternalDeg).toFixed(3)),
      gnssInternalDeg: Number(run.endGnssHeadingInternalDeg.toFixed(3)),
      gnssFieldDeg: Number(internalHeadingToFieldDegrees(run.endGnssHeadingInternalDeg).toFixed(3)),
    },
    turn: {
      imuDeg: Number(summary.imuTurnInternalDeg.toFixed(3)),
      gnssDeg: Number(summary.gnssTurnInternalDeg.toFixed(3)),
      correctionFactor: summary.scaleCorrection == null ? null : Number(summary.scaleCorrection.toFixed(5)),
      endAlignmentErrorDeg: Number(summary.endAlignmentErrorInternalDeg.toFixed(3)),
    },
  });
  if (summary.scaleCorrection != null) {
    console.log(`Suggested yaw scale correction: ${summary.scaleCorrection.toFixed(5)}`);
  } else {
    console.log("Suggested yaw scale correction unavailable because the turn was too small.");
  }
}

async function main() {
  if (!process.stdin.isTTY) {
    throw new Error("This utility needs an interactive TTY so you can press S and E.");
  }

  const state = createState();
  const outputPath = OUTPUT_PATH;

  await mkdir(dirname(outputPath), { recursive: true });

  const transport = await LiveI2cTransport.create(BUS_NUMBER);
  const controller = new I2cBusController(transport);
  const imuSensor = new Bmi160ImuSensor(controller);
  const gnssClient = new GnssNodeClient(controller, { address: GNSS_ADDRESS });

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let stopRequested = false;
  let statusTimer = null;

  async function requestStop() {
    stopRequested = true;
    state.running = false;
  }

  async function pollImuLoop() {
    while (!stopRequested) {
      try {
        const sample = await imuSensor.read();
        state.latestImuSample = sample;
        if (state.lastImuSampleMillis !== null) {
          const deltaSeconds = Math.max(0, sample.timestampMillis - state.lastImuSampleMillis) / 1000;
          state.rawImuHeadingInternalDeg = normalizeInternalHeadingDegrees(
            state.rawImuHeadingInternalDeg + (sample.angularVelocity.zDegreesPerSecond * deltaSeconds),
          );
        }
        state.lastImuSampleMillis = sample.timestampMillis;
        state.latestImuError = null;
      } catch (error) {
        state.latestImuError = error instanceof Error ? error.message : String(error);
      }

      await sleep(IMU_POLL_INTERVAL_MS);
    }
  }

  async function pollGnssLoop() {
    while (!stopRequested) {
      try {
        state.latestGnssSample = await gnssClient.refresh();
        state.latestGnssError = null;
      } catch (error) {
        state.latestGnssError = error instanceof Error ? error.message : String(error);
      }

      await sleep(GNSS_POLL_INTERVAL_MS);
    }
  }

  async function handleStart() {
    if (state.activeRun != null) {
      console.log("Run already active. Press E to finish it first.");
      return;
    }

    const sample = state.latestGnssSample;
    if (!isGnssReady(sample)) {
      console.log("GNSS is not ready yet. Wait for a fixed lock and about 1 degree heading accuracy.");
      return;
    }

    const startGnssHeadingInternalDeg = fieldHeadingToInternalDegrees(sample.headingDegrees);
    const startRawImuHeadingInternalDeg = state.rawImuHeadingInternalDeg;
    const startOffsetInternalDeg = normalizeInternalHeadingDegrees(
      startGnssHeadingInternalDeg - startRawImuHeadingInternalDeg,
    );

    state.sessionOffsetInternalDeg = startOffsetInternalDeg;
    const startAlignedImuHeadingInternalDeg = getAlignedImuHeadingInternalDeg(state);
    const run = {
      runId: state.runCounter++,
      startedAt: new Date().toISOString(),
      startRawImuHeadingInternalDeg,
      startAlignedImuHeadingInternalDeg,
      startGnssHeadingInternalDeg,
      startOffsetInternalDeg,
      startGnssFixType: sample.fixType,
      startGnssHeadingAccuracyDeg: sample.headingAccuracyDegrees ?? null,
      startGnssPositionAccuracyMeters: sample.positionAccuracyMeters,
      startGnssSampleAgeMillis: sample.sampleAgeMillis,
      startGnssSatellitesInUse: sample.satellitesInUse,
      startGnssFieldHeadingDeg: sample.headingDegrees,
      startImuTimestampMillis: state.latestImuSample?.timestampMillis ?? null,
    };

    state.activeRun = run;

    await writeJsonLine(outputPath, {
      event: "start",
      ...run,
      startRawImuHeadingFieldDeg: internalHeadingToFieldDegrees(run.startRawImuHeadingInternalDeg),
      startAlignedImuHeadingFieldDeg: internalHeadingToFieldDegrees(run.startAlignedImuHeadingInternalDeg),
      startGnssHeadingFieldDeg: internalHeadingToFieldDegrees(run.startGnssHeadingInternalDeg),
    });

    console.log(`Started run ${run.runId}. IMU aligned to GNSS heading ${formatDegrees(sample.headingDegrees)} field.`);
  }

  async function handleEnd() {
    const run = state.activeRun;
    if (run == null) {
      console.log("No active run. Press S to start one.");
      return;
    }

    const sample = state.latestGnssSample;
    if (!isGnssReady(sample)) {
      console.log("GNSS is not ready at the end point. Keep holding the turn until it is fixed and accurate again.");
      return;
    }

    run.endRawImuHeadingInternalDeg = state.rawImuHeadingInternalDeg;
    run.endAlignedImuHeadingInternalDeg = getAlignedImuHeadingInternalDeg(state);
    run.endGnssHeadingInternalDeg = fieldHeadingToInternalDegrees(sample.headingDegrees);
    run.endGnssFixType = sample.fixType;
    run.endGnssHeadingAccuracyDeg = sample.headingAccuracyDegrees ?? null;
    run.endGnssPositionAccuracyMeters = sample.positionAccuracyMeters;
    run.endGnssSampleAgeMillis = sample.sampleAgeMillis;
    run.endGnssSatellitesInUse = sample.satellitesInUse;
    run.endGnssFieldHeadingDeg = sample.headingDegrees;
    run.endedAt = new Date().toISOString();

    const summary = buildTurnCalibrationSummary(run);
    const record = {
      event: "end",
      ...run,
      summary: {
        imuTurnInternalDeg: summary.imuTurnInternalDeg,
        gnssTurnInternalDeg: summary.gnssTurnInternalDeg,
        startAlignmentErrorInternalDeg: summary.startAlignmentErrorInternalDeg,
        endAlignmentErrorInternalDeg: summary.endAlignmentErrorInternalDeg,
        scaleCorrection: summary.scaleCorrection,
      },
      endRawImuHeadingFieldDeg: internalHeadingToFieldDegrees(run.endRawImuHeadingInternalDeg),
      endAlignedImuHeadingFieldDeg: internalHeadingToFieldDegrees(run.endAlignedImuHeadingInternalDeg),
      endGnssHeadingFieldDeg: internalHeadingToFieldDegrees(run.endGnssHeadingInternalDeg),
    };

    await writeJsonLine(outputPath, record);
    state.completedRuns.push({ ...run, summary });
    state.activeRun = null;
    state.sessionOffsetInternalDeg = 0;

    const averageCorrection = getAverageYawScaleCorrection(state.completedRuns);
    if (averageCorrection != null) {
      try {
        await writeCalibrationExport(EXPORT_PATH, averageCorrection.value, averageCorrection.sampleCount);
        console.log(`Exported IMU yaw calibration to ${EXPORT_PATH} (factor ${averageCorrection.value.toFixed(5)} from ${averageCorrection.sampleCount} usable runs)`);
      } catch (error) {
        console.error(`Failed to export IMU yaw calibration: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    printRunSummary(run, summary);
    console.log(`Saved sample to ${outputPath}`);
  }

  async function handleKeypress(str, key) {
    const keyName = key?.name?.toLowerCase?.() ?? "";
    if (key.ctrl && keyName === "c") {
      await requestStop();
      return;
    }

    if (keyName === "s") {
      await handleStart();
      return;
    }

    if (keyName === "e") {
      await handleEnd();
      return;
    }

    if (keyName === "q") {
      await requestStop();
      return;
    }
  }

  process.stdin.on("keypress", (str, key) => {
    void handleKeypress(str, key).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
  });

  process.on("SIGINT", () => {
    void requestStop();
  });

  process.on("SIGTERM", () => {
    void requestStop();
  });

  try {
    console.log("Initialising IMU and GNSS...");
    console.log(`Output file: ${outputPath}`);
    console.log(`Calibration export: ${EXPORT_PATH}`);
    console.log(`GNSS ready when fix is fixed, heading accuracy <= ${GNSS_MAX_HEADING_ACCURACY_DEGREES}°, and sample age <= ${GNSS_MAX_SAMPLE_AGE_MS}ms.`);
    console.log("Keep the mower still while the IMU gyro bias calibration runs.");

    await imuSensor.initialise();
    await imuSensor.calibrateGyro();
    console.log("Sensors ready. Press S to start a run, E to end it, or Q to quit.");

    statusTimer = setInterval(() => {
      renderStatus(state);
    }, 1000);

    renderStatus(state);

    await Promise.all([
      pollImuLoop(),
      pollGnssLoop(),
    ]);
  } finally {
    if (statusTimer !== null) {
      clearInterval(statusTimer);
    }
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Ignore TTY cleanup issues on exit.
    }
    process.stdin.pause();
    await imuSensor.close();
    await controller.close();
  }

  if (state.completedRuns.length > 0) {
    const averageCorrection = getAverageYawScaleCorrection(state.completedRuns);
    if (averageCorrection != null) {
      console.log(`Average suggested yaw scale correction from ${averageCorrection.sampleCount} usable runs: ${averageCorrection.value.toFixed(5)}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
