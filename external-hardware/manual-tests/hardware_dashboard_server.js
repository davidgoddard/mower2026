// Phone-friendly hardware dashboard server.
// Reads the existing manual-test log files and serves a compact mobile page.

import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.MOWER_DASHBOARD_PORT ?? 8092);
const POLL_INTERVAL_MS = 1000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const paths = {
  page: path.join(__dirname, "hardware_dashboard.html"),
  imuLog: path.join(__dirname, "imu.log"),
  gnssLog: path.join(__dirname, "gps.log"),
  motorLog: path.join(__dirname, "motor_test.log"),
};

function normalizeAngleDegrees(angleDegrees) {
  let angle = angleDegrees;
  while (angle > 180) {
    angle -= 360;
  }
  while (angle <= -180) {
    angle += 360;
  }
  return angle;
}

function describeFixType(fixType) {
  switch (fixType) {
    case 0:
      return "none";
    case 1:
      return "single";
    case 2:
      return "float";
    case 3:
      return "fixed";
    default:
      return `unknown(${fixType})`;
  }
}

function makeMissingState(message) {
  return {
    ok: false,
    message,
  };
}

function evaluateInVm(objectLiteral) {
  return vm.runInNewContext(`(${objectLiteral})`, Object.create(null), { timeout: 100 });
}

function extractObjectBlocks(text) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quote !== "") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) {
        quote = "";
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (character === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const objectLiteral = text.slice(start, index + 1);
        const lineStart = text.lastIndexOf("\n", start) + 1;
        const prefix = text.slice(lineStart, start).trim();
        blocks.push({ prefix, objectLiteral });
        start = -1;
      }
    }
  }

  return blocks;
}

function deriveImuState(sample) {
  const ax = sample.acceleration.xMetersPerSecondSquared;
  const ay = sample.acceleration.yMetersPerSecondSquared;
  const az = sample.acceleration.zMetersPerSecondSquared;
  const gravityMagnitude = Math.sqrt((ax * ax) + (ay * ay) + (az * az));
  const rollDegrees = Math.atan2(ay, az) * (180 / Math.PI);
  const pitchDegrees = Math.atan2(-ax, Math.sqrt((ay * ay) + (az * az))) * (180 / Math.PI);

  return {
    ...sample,
    derived: {
      gravityMagnitude,
      gravityError: gravityMagnitude - 9.80665,
      rollDegrees,
      pitchDegrees,
      yawDegrees: 0,
      stationaryGyroLikely: Math.abs(sample.angularVelocity.xDegreesPerSecond) < 1
        && Math.abs(sample.angularVelocity.yDegreesPerSecond) < 1
        && Math.abs(sample.angularVelocity.zDegreesPerSecond) < 1,
    },
  };
}

function deriveGnssState(entry) {
  const sample = entry.sample;
  const headingDegrees = sample.headingDegrees == null ? null : normalizeAngleDegrees(sample.headingDegrees);
  return {
    ...entry,
    sample: {
      ...sample,
      headingDegrees,
    },
    derived: {
      fixTypeLabel: describeFixType(sample.fixType),
      headingUsable: sample.headingDegrees != null,
      speedMetersPerSecond: sample.groundSpeedMetersPerSecond ?? 0,
    },
  };
}

function deriveMotorState(entry) {
  const left = entry.leftWheelActualPhysicalMetersPerSecond ?? entry.leftWheelActualMetersPerSecond ?? 0;
  const right = entry.rightWheelActualPhysicalMetersPerSecond ?? entry.rightWheelActualMetersPerSecond ?? 0;
  const speedMetersPerSecond = (left + right) / 2;
  const turnRateIndicator = right - left;

  return {
    ...entry,
    derived: {
      speedMetersPerSecond,
      turnRateIndicator,
      directionLabel:
        Math.abs(speedMetersPerSecond) < 0.02
          ? "stopped"
          : speedMetersPerSecond > 0
            ? "forward"
            : "reverse",
      turningLabel:
        Math.abs(turnRateIndicator) < 0.03
          ? "straight"
          : turnRateIndicator > 0
            ? "left bias"
            : "right bias",
    },
  };
}

function summariseExpectations(state) {
  const items = [];

  if (state.imu.ok) {
    const gravityMagnitude = state.imu.data.derived.gravityMagnitude;
    items.push({
      name: "IMU gravity",
      status: Math.abs(gravityMagnitude - 9.80665) < 0.6 ? "ok" : "warn",
      detail: `gravity magnitude ${gravityMagnitude.toFixed(2)} m/s^2`,
    });
  }

  if (state.gnss.ok) {
    items.push({
      name: "GNSS sample age",
      status: state.gnss.data.sample.sampleAgeMillis <= 1000 ? "ok" : "warn",
      detail: `sample age ${state.gnss.data.sample.sampleAgeMillis} ms`,
    });
  }

  if (state.motor.ok) {
    items.push({
      name: "Motor watchdog",
      status: state.motor.data.watchdogHealthy ? "ok" : "warn",
      detail: state.motor.data.watchdogHealthy ? "watchdog healthy" : `faultFlags ${state.motor.data.faultFlags}`,
    });
  }

  return items;
}

async function parseLatestObject(logPath, predicate, derive) {
  let content;
  try {
    content = await readFile(logPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return makeMissingState(`Missing log file: ${path.basename(logPath)}`);
    }
    throw error;
  }

  const blocks = extractObjectBlocks(content);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    try {
      const parsed = evaluateInVm(block.objectLiteral);
      if (predicate(parsed)) {
        return {
          ok: true,
          data: derive({ ...parsed, _label: block.prefix }),
        };
      }
    } catch {
      // Skip malformed partial log blocks.
    }
  }

  return makeMissingState(`No matching sample found in ${path.basename(logPath)}`);
}

async function readLogTail(logPath, maxLines) {
  try {
    const content = await readFile(logPath, "utf8");
    return content.trim().split("\n").slice(-maxLines).join("\n");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return `Missing log file: ${path.basename(logPath)}`;
    }
    throw error;
  }
}

async function buildDashboardState() {
  const [imu, gnss, motor, imuTail, gnssTail, motorTail] = await Promise.all([
    parseLatestObject(
      paths.imuLog,
      (value) => value && typeof value === "object" && "angularVelocity" in value && "acceleration" in value,
      deriveImuState,
    ),
    parseLatestObject(
      paths.gnssLog,
      (value) => value && typeof value === "object" && "sample" in value && "fixTypeLabel" in value,
      deriveGnssState,
    ),
    parseLatestObject(
      paths.motorLog,
      (value) => value && typeof value === "object" && "timestampMillis" in value && "leftWheelActualMetersPerSecond" in value,
      deriveMotorState,
    ),
    readLogTail(paths.imuLog, 24),
    readLogTail(paths.gnssLog, 24),
    readLogTail(paths.motorLog, 36),
  ]);

  const state = {
    serverTimestampMillis: Date.now(),
    refreshIntervalMillis: POLL_INTERVAL_MS,
    imu,
    gnss,
    motor,
    expectations: [],
    logs: {
      imu: imuTail,
      gnss: gnssTail,
      motor: motorTail,
    },
  };

  state.expectations = summariseExpectations(state);
  return state;
}

async function handlePage(response) {
  const html = await readFile(paths.page, "utf8");
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

async function handleState(response) {
  const state = await buildDashboardState();
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(state));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/" || request.url === "/hardware_dashboard.html") {
      await handlePage(response);
      return;
    }

    if (request.url === "/api/state") {
      await handleState(response);
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.stack ?? error.message : String(error));
  }
});

server.listen(PORT, () => {
  console.log(`Hardware dashboard ready at http://0.0.0.0:${PORT}`);
  console.log("This dashboard reads gps.log, imu.log, and motor_test.log.");
});
