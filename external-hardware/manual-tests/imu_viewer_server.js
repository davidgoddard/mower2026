// Minimal local IMU visualizer server for manual BMI160 bring-up.
// Run `npm run build` first so the built hardware layer exists in `dist/`.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bmi160ImuSensor } from "../../dist/src/hardware/bmi160ImuSensor.js";

const PORT = Number(process.env.IMU_VIEWER_PORT ?? 8091);
const SAMPLE_INTERVAL_MS = Number(process.env.IMU_SAMPLE_INTERVAL_MS ?? 100);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAGE_PATH = path.join(__dirname, "imu_viewer.html");

const sensor = new Bmi160ImuSensor();
const clients = new Set();
let latestState = undefined;
let previousTimestampMillis = undefined;
let yawDegrees = 0;
let shuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function toOrientationState(sample) {
  const { xMetersPerSecondSquared: ax, yMetersPerSecondSquared: ay, zMetersPerSecondSquared: az } = sample.acceleration;
  const gravityMagnitude = Math.sqrt((ax * ax) + (ay * ay) + (az * az));
  const rollDegrees = Math.atan2(ay, az) * (180 / Math.PI);
  const pitchDegrees = Math.atan2(-ax, Math.sqrt((ay * ay) + (az * az))) * (180 / Math.PI);

  if (previousTimestampMillis !== undefined) {
    const deltaSeconds = Math.max(0, sample.timestampMillis - previousTimestampMillis) / 1000;
    yawDegrees = normalizeAngleDegrees(yawDegrees + (sample.angularVelocity.zDegreesPerSecond * deltaSeconds));
  }
  previousTimestampMillis = sample.timestampMillis;

  return {
    ...sample,
    derived: {
      rollDegrees,
      pitchDegrees,
      yawDegrees,
      gravityMagnitude,
    },
  };
}

function broadcastState(state) {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

async function sampleLoop() {
  while (!shuttingDown) {
    const sample = await sensor.read();
    latestState = toOrientationState(sample);
    broadcastState(latestState);
    await sleep(SAMPLE_INTERVAL_MS);
  }
}

function handleEventsRequest(_request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  response.write("\n");

  if (latestState !== undefined) {
    response.write(`data: ${JSON.stringify(latestState)}\n\n`);
  }

  clients.add(response);
  response.on("close", () => {
    clients.delete(response);
  });
}

async function handlePageRequest(response) {
  const html = await readFile(PAGE_PATH, "utf8");
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function handleLatestRequest(response) {
  if (latestState === undefined) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "imu_not_ready" }));
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(latestState));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/" || request.url === "/imu_viewer.html") {
      await handlePageRequest(response);
      return;
    }

    if (request.url === "/events") {
      handleEventsRequest(request, response);
      return;
    }

    if (request.url === "/latest") {
      handleLatestRequest(response);
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(String(error));
  }
});

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const client of clients) {
    client.end();
  }
  clients.clear();

  await sensor.close();
  await new Promise((resolve) => server.close(resolve));
  process.exitCode = exitCode;
}

async function main() {
  console.log("Initialising BMI160 IMU sensor on I2C bus 1 address 0x69...");
  await sensor.initialise();
  console.log("Calibrating gyro bias. Keep the mower still...");
  await sensor.calibrateGyro();
  console.log(`Starting IMU viewer at http://localhost:${PORT}`);

  server.listen(PORT);
  await sampleLoop();
}

process.on("SIGINT", async () => {
  await shutdown(0);
});

process.on("SIGTERM", async () => {
  await shutdown(0);
});

main().catch(async (error) => {
  console.error(error);
  await shutdown(1);
});
