// Manual calibration utility for estimating the GNSS reference point to vehicle-centre offset.
// Run this on the Pi after `npm run build` so the runtime modules in `dist/` are available.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MotorCalibration,
  PrimitivesStore,
  SessionLogger,
  SensorController,
  createPiSensorHardwareGateway,
  headingDifference,
  unwrapRelativeAngle,
  unwrapInternalHeading,
  systemStop,
} from "../../dist/index.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_CALIBRATION_PATH = resolve(REPO_ROOT, "config/geometry-calibration.json");
const DEFAULT_LOG_DIR = resolve(REPO_ROOT, "logs");

const BUS_NUMBER = Number(process.env.MOWER_I2C_BUS_NUMBER ?? 1);
const GNSS_ADDRESS = Number(process.env.MOWER_GNSS_I2C_ADDRESS ?? 0x52);
const MOTOR_ADDRESS = Number(process.env.MOWER_MOTOR_I2C_ADDRESS ?? 0x66);
const LEFT_FORWARD_SIGN = Number(process.env.MOWER_LEFT_FORWARD_SIGN ?? -1);
const RIGHT_FORWARD_SIGN = Number(process.env.MOWER_RIGHT_FORWARD_SIGN ?? -1);
const SPIN_POWER = Number(process.env.MOWER_GEOMETRY_SPIN_POWER ?? 0.5);
const MINIMUM_VALID_FIX_ACCURACY_METERS = Number(process.env.MOWER_GEOMETRY_MAX_ACCURACY_METERS ?? 0.05);
const MAX_SECONDS = Number(process.env.MOWER_GEOMETRY_MAX_SECONDS ?? 180);
const OUTPUT_PATH = resolve(process.env.MOWER_GEOMETRY_CALIBRATION_PATH ?? DEFAULT_CALIBRATION_PATH);

if (LEFT_FORWARD_SIGN !== -1 && LEFT_FORWARD_SIGN !== 1) {
  throw new Error("MOWER_LEFT_FORWARD_SIGN must be -1 or 1.");
}

if (RIGHT_FORWARD_SIGN !== -1 && RIGHT_FORWARD_SIGN !== 1) {
  throw new Error("MOWER_RIGHT_FORWARD_SIGN must be -1 or 1.");
}

if (SPIN_POWER < 0.5) {
  throw new Error("MOWER_GEOMETRY_SPIN_POWER must be at least 0.5.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGoodGnssFix(sample) {
  const goodFixType =
    sample.fixType === "fixed" ||
    sample.fixType === "float" ||
    sample.fixType === "rtk-fixed" ||
    sample.fixType === "rtk-float";

  return goodFixType && sample.positionAccuracyMeters !== null && sample.positionAccuracyMeters <= MINIMUM_VALID_FIX_ACCURACY_METERS;
}

function solve3x3(matrix, vector) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let pivot = 0; pivot < 3; pivot += 1) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[bestRow][pivot])) {
        bestRow = row;
      }
    }

    if (Math.abs(augmented[bestRow][pivot]) < 1e-12) {
      throw new Error("circle fit failed: insufficient movement diversity");
    }

    if (bestRow !== pivot) {
      const swap = augmented[pivot];
      augmented[pivot] = augmented[bestRow];
      augmented[bestRow] = swap;
    }

    const pivotValue = augmented[pivot][pivot];
    for (let column = pivot; column < 4; column += 1) {
      augmented[pivot][column] /= pivotValue;
    }

    for (let row = 0; row < 3; row += 1) {
      if (row === pivot) {
        continue;
      }
      const factor = augmented[row][pivot];
      for (let column = pivot; column < 4; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }

  return [augmented[0][3], augmented[1][3], augmented[2][3]];
}

function fitCircle(points) {
  if (points.length < 6) {
    throw new Error("circle fit requires at least 6 samples");
  }

  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let sumXZ = 0;
  let sumYZ = 0;

  for (const point of points) {
    const { xMeters: x, yMeters: y } = point;
    const z = (x * x) + (y * y);
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
    sumX += x;
    sumY += y;
    sumZ += z;
    sumXZ += x * z;
    sumYZ += y * z;
  }

  const [u, v, w] = solve3x3(
    [
      [sumXX, sumXY, sumX],
      [sumXY, sumYY, sumY],
      [sumX, sumY, points.length],
    ],
    [sumXZ, sumYZ, sumZ],
  );

  const centerX = u / 2;
  const centerY = v / 2;
  const radius = Math.sqrt(Math.max(0, w + (centerX * centerX) + (centerY * centerY)));

  return { centerX, centerY, radius };
}

function computeBodyFrameOffset(points, centerX, centerY) {
  let sumForward = 0;
  let sumRight = 0;

  for (const point of points) {
    const headingRadians = (point.headingDeg * Math.PI) / 180;
    const deltaX = centerX - point.xMeters;
    const deltaY = centerY - point.yMeters;
    const forward = (deltaX * Math.cos(headingRadians)) + (deltaY * Math.sin(headingRadians));
    const right = (deltaX * Math.sin(headingRadians)) - (deltaY * Math.cos(headingRadians));
    sumForward += forward;
    sumRight += right;
  }

  return {
    positionOffsetForwardMeters: sumForward / points.length,
    positionOffsetRightMeters: sumRight / points.length,
  };
}

function formatNumber(value) {
  return Number(value.toFixed(4));
}

async function writeCalibrationFile(path, parameters) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parameters, null, 2)}\n`, "utf8");
}

async function main() {
  const logger = await SessionLogger.create({
    app: "mower",
    context: "manual-test",
    source: "RotationCenterCalibration",
    logDir: DEFAULT_LOG_DIR,
    minLevel: "info",
  });

  const motorCalibration = new MotorCalibration({ logger });
  await motorCalibration.loadParameters();

  const gateway = await createPiSensorHardwareGateway(BUS_NUMBER, {
    gnssAddress: GNSS_ADDRESS,
    motorAddress: MOTOR_ADDRESS,
    leftMotorForwardSign: LEFT_FORWARD_SIGN,
    rightMotorForwardSign: RIGHT_FORWARD_SIGN,
    motorCalibration,
  });

  const primitivesStore = new PrimitivesStore();
  const sensorController = new SensorController({
    logger,
    primitivesStore,
    gateway,
  });

  const samples = [];
  let latestHeading = null;
  let fixReady = false;
  let collectingSamples = false;
  let headingChangeDeg = 0;
  let lastRecordedHeading = null;
  let stopRequested = false;

  function requestStop() {
    stopRequested = true;
  }

  const onImuHeadingUpdate = (event) => {
    latestHeading = event.heading;
  };

  const onGnssPositionUpdate = (event) => {
    const heading = event.heading ?? latestHeading;
    if (heading === null) {
      return;
    }

    const sample = {
      xMeters: event.xMeters,
      yMeters: event.yMeters,
      headingDeg: unwrapInternalHeading(heading),
      timestampMillis: event.timestampMillis,
      fixType: event.fixType,
      positionAccuracyMeters: event.positionAccuracyMeters,
    };

    if (!isGoodGnssFix(sample)) {
      return;
    }

    if (!collectingSamples) {
      fixReady = true;
      lastRecordedHeading = heading;
      return;
    }

    samples.push(sample);

    if (lastRecordedHeading !== null) {
      headingChangeDeg += unwrapRelativeAngle(headingDifference(lastRecordedHeading, heading));
    }
    lastRecordedHeading = heading;
  };

  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  try {
    sensorController.on("imuHeadingUpdate", onImuHeadingUpdate);
    sensorController.on("gnssPositionUpdate", onGnssPositionUpdate);
    await sensorController.start();

    // Clear any system-stop latch left over from a previous session and
    // issue a fresh zero-output command. The ESP32 latches the last
    // command it accepted, so a stale disable from an earlier run will
    // otherwise keep the H-bridges off even though the script believes
    // it is sending a spin command.
    if (systemStop.isStopped()) {
      const previousState = systemStop.snapshot();
      systemStop.clearStop("rotation-center-calibration-start");
      console.log(
        `Cleared a latched system stop before starting (was set by ${previousState.source ?? "unknown"}: ${previousState.reason ?? "unknown"}).`,
      );
    }
    await sensorController.setMotorWheelOutputs(0, 0);

    console.log("Waiting for a reliable GNSS fix before starting the spin.");
    const waitStarted = Date.now();
    while (!fixReady) {
      if (stopRequested) {
        throw new Error("calibration interrupted before spin started");
      }
      if ((Date.now() - waitStarted) / 1000 > MAX_SECONDS) {
        throw new Error("timed out waiting for a reliable GNSS fix");
      }
      await sleep(100);
    }

    console.log(`Spinning in place at ${SPIN_POWER.toFixed(2)} output until at least 360 degrees of heading change is collected.`);

    // If anything raised a stop between the initial clear and the spin,
    // surface it explicitly rather than silently sending a spin command
    // that the gateway will mark as enableDrive=false.
    if (systemStop.isStopped()) {
      const stale = systemStop.snapshot();
      throw new Error(
        `system stop is latched (source=${stale.source ?? "?"}, reason=${stale.reason ?? "?"}); aborting before spin command`,
      );
    }

    sensorController.beginMotionSession();
    await sensorController.setMotorWheelOutputs(-SPIN_POWER, SPIN_POWER);
    collectingSamples = true;
    console.log(
      `Spin underway (commanded left=${(-SPIN_POWER).toFixed(2)}, right=${SPIN_POWER.toFixed(2)}, enableDrive=true). Collecting GNSS samples.`,
    );

    const spinStarted = Date.now();
    while (Math.abs(headingChangeDeg) < 360) {
      if (stopRequested) {
        throw new Error("calibration interrupted during spin");
      }
      if ((Date.now() - spinStarted) / 1000 > MAX_SECONDS) {
        throw new Error("timed out waiting for 360 degrees of rotation");
      }
      await sleep(200);
    }

    await sensorController.stopMotors();
    sensorController.endMotionSession();

    const { centerX, centerY, radius } = fitCircle(samples);
    const bodyFrameOffset = computeBodyFrameOffset(samples, centerX, centerY);
    const parameters = {
      version: 1,
      ...bodyFrameOffset,
      updatedAt: new Date().toISOString(),
    };

    console.log("Rotation centre estimate:");
    console.log({
      sampleCount: samples.length,
      headingChangeDeg: formatNumber(headingChangeDeg),
      estimatedCenterXMeters: formatNumber(centerX),
      estimatedCenterYMeters: formatNumber(centerY),
      estimatedRadiusMeters: formatNumber(radius),
      positionOffsetForwardMeters: formatNumber(parameters.positionOffsetForwardMeters),
      positionOffsetRightMeters: formatNumber(parameters.positionOffsetRightMeters),
    });

    await writeCalibrationFile(OUTPUT_PATH, parameters);
    console.log(`Saved geometry calibration to ${OUTPUT_PATH}`);
  } finally {
    try {
      await sensorController.stopMotors();
    } catch {
      // Best-effort stop while cleaning up.
    }

    try {
      sensorController.off("imuHeadingUpdate", onImuHeadingUpdate);
      sensorController.off("gnssPositionUpdate", onGnssPositionUpdate);
    } catch {
      // Ignore listener cleanup failures during shutdown.
    }

    try {
      sensorController.endMotionSession();
    } catch {
      // Ignore shutdown errors and continue closing hardware.
    }

    await sensorController.stop();
    await gateway.close();
    await logger.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
