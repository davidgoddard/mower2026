// Core Pi app server.
// Default boot mode is manual drive. The landing page can switch between
// manual, site-capture, and autonomous modes while sharing the same live
// controller/sensor/estimator loop.
// Run `npm run build` first so the built TypeScript modules exist in `dist/`.

import http from "node:http";
import path from "node:path";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import i2c from "i2c-bus";
import { HidGameController } from "./hidGameController.js";
import { loadSystemParameters } from "./systemConfig.js";
import { Bmi160ImuSensor } from "../dist/src/hardware/bmi160ImuSensor.js";
import { PollingMotorNodeClient } from "../dist/src/nodes/motorNodeClient.js";
import { PollingGnssNodeClient } from "../dist/src/nodes/gnssNodeClient.js";
import { GnssAdapter } from "../dist/src/sensing/gnssAdapter.js";
import { MotorFeedbackAdapter } from "../dist/src/sensing/motorFeedbackAdapter.js";
import { ImuAdapter } from "../dist/src/sensing/imuAdapter.js";
import { PoseEstimator } from "../dist/src/estimation/poseEstimator.js";
import { CommandLimiter } from "../dist/src/control/commandLimiter.js";
import { mapPhysicalWheelTargetsToRaw } from "../dist/src/control/motorMapping.js";
import { NodeId } from "../dist/src/protocols/commonProtocol.js";
import { gnssPayloadLength } from "../dist/src/protocols/gnssCodec.js";
import { motorFeedbackSampleLength } from "../dist/src/protocols/motorCodec.js";
import { SiteCaptureRecorder } from "../dist/src/site/siteCaptureRecorder.js";
import { CoveragePlanner } from "../dist/src/planning/coveragePlanner.js";
import { MissionStartSelector } from "../dist/src/planning/missionStartSelector.js";
import { buildLaneMissionSequence } from "../dist/src/execution/laneMissionBuilder.js";
import { LaneExecutor } from "../dist/src/execution/laneExecutor.js";

const PORT = Number(process.env.MOWER_CORE_APP_PORT ?? 8090);
const BUS_NUMBER = Number(process.env.MOWER_I2C_BUS_NUMBER ?? 1);
const GNSS_I2C_ADDRESS = Number(process.env.MOWER_GNSS_I2C_ADDRESS ?? 0x52);
const MOTOR_I2C_ADDRESS = Number(process.env.MOWER_MOTOR_I2C_ADDRESS ?? 0x66);
const CONTROL_LOOP_MS = Number(process.env.MOWER_CORE_APP_INTERVAL_MS ?? 100);
const GNSS_REFRESH_INTERVAL_MS = Number(process.env.MOWER_GNSS_REFRESH_INTERVAL_MS ?? 400);
const TELEMETRY_LOG_INTERVAL_MS = Number(process.env.MOWER_TELEMETRY_LOG_INTERVAL_MS ?? 250);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardPath = path.join(__dirname, "web", "core_dashboard.html");
const dataDirectoryPath = path.join(__dirname, "data");
const siteDirectoryPath = path.join(dataDirectoryPath, "sites");
const planDirectoryPath = path.join(dataDirectoryPath, "plans");
const logDirectoryPath = path.join(dataDirectoryPath, "logs");
const sessionLogPath = path.join(
  logDirectoryPath,
  `core-app-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);

const FRAME_HEADER_SIZE = 9;
const FRAME_CRC_SIZE = 2;
const gnssFrameLength = FRAME_HEADER_SIZE + gnssPayloadLength() + FRAME_CRC_SIZE;
const motorFeedbackFrameLength = FRAME_HEADER_SIZE + motorFeedbackSampleLength() + FRAME_CRC_SIZE;

let controller;
const sensor = new Bmi160ImuSensor();
const clients = new Set();
const recorder = new SiteCaptureRecorder();
const coveragePlanner = new CoveragePlanner();
const missionStartSelector = new MissionStartSelector();

let parameters;
let i2cBus;
let motorNodeClient;
let gnssNodeClient;
let gnssAdapter;
let motorFeedbackAdapter;
let imuAdapter;
let poseEstimator;
let commandLimiter;
let activeLaneExecutor = null;
let manualDriveEnabled = false;
let lastGnssRefreshMillis = 0;
let lastTelemetryLogMillis = 0;
let lastWheelTargets = { leftMetersPerSecond: 0, rightMetersPerSecond: 0 };
let gnssNodeNowMillis = 0;
let motorNodeNowMillis = 0;
let shuttingDown = false;

const state = {
  serverTimestampMillis: Date.now(),
  sessionLogPath,
  lastSavedSitePath: null,
  app: {
    currentMode: "manual",
    availableModes: ["manual", "site_capture", "autonomous"],
    autonomousStatus: "idle",
    autonomousMessage: "Autonomous mission execution is not implemented yet.",
  },
  controller: {
    connected: false,
    product: "unavailable",
    angleDegrees: 0,
    speed: 0,
    buttons: {},
    manualDriveEnabled: false,
    lastButtonEvents: [],
  },
  command: {
    mode: "stopped",
    requestedLeftMetersPerSecond: 0,
    requestedRightMetersPerSecond: 0,
    limitedLeftMetersPerSecond: 0,
    limitedRightMetersPerSecond: 0,
  },
  gnss: {
    ok: false,
    error: "not_started",
  },
  motor: {
    ok: false,
    error: "not_started",
  },
  imu: {
    ok: false,
    error: "not_started",
  },
  estimate: {
    ok: false,
    error: "not_started",
  },
  capture: {
    perimeter: null,
    obstacles: [],
    activeCapture: null,
    warnings: [],
    lastRecordResult: null,
  },
  review: {
    savedSiteFiles: [],
    selectedSitePath: null,
    selectedSite: null,
  },
  planning: {
    currentPlanPath: null,
    currentPlan: null,
    lastMissionStartSelection: null,
    laneExecution: null,
  },
  notes: [
    "Core app boots in manual mode.",
    "Press controller top or right-top to enable manual drive.",
    "Press controller cross or left-top to stop and disable drive.",
  ],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function deriveImuState(sample) {
  const ax = sample.acceleration.xMetersPerSecondSquared;
  const ay = sample.acceleration.yMetersPerSecondSquared;
  const az = sample.acceleration.zMetersPerSecondSquared;
  const gravityMagnitude = Math.sqrt((ax * ax) + (ay * ay) + (az * az));
  const rollDegrees = Math.atan2(ay, az) * (180 / Math.PI);
  const pitchDegrees = Math.atan2(-ax, Math.sqrt((ay * ay) + (az * az))) * (180 / Math.PI);
  return {
    sample,
    derived: {
      rollDegrees,
      pitchDegrees,
      gravityMagnitude,
    },
  };
}

function deriveMotorState(sample) {
  const leftPhysical = sample.leftWheelActualMetersPerSecond * parameters.leftMotorForwardSign;
  const rightPhysical = sample.rightWheelActualMetersPerSecond * parameters.rightMotorForwardSign;
  return {
    sample,
    derived: {
      leftPhysicalMetersPerSecond: leftPhysical,
      rightPhysicalMetersPerSecond: rightPhysical,
      speedMetersPerSecond: (leftPhysical + rightPhysical) / 2,
      turnBiasMetersPerSecond: rightPhysical - leftPhysical,
    },
  };
}

function deriveGnssState(sample) {
  return {
    sample,
    derived: {
      headingDegrees: sample.headingDegrees ?? null,
      groundSpeedMetersPerSecond: sample.groundSpeedMetersPerSecond ?? 0,
    },
  };
}

function addNote(note) {
  state.notes.unshift(note);
  state.notes = state.notes.slice(0, 12);
}

function refreshCaptureState() {
  const snapshot = recorder.snapshot();
  state.capture = {
    ...state.capture,
    perimeter: snapshot.perimeter,
    obstacles: snapshot.obstacles,
    activeCapture: snapshot.activeCapture,
    warnings: snapshot.warnings,
  };
}

function currentModeAllowsManualDrive() {
  return state.app.currentMode === "manual" || state.app.currentMode === "site_capture";
}

function currentModeAllowsAutonomousDrive() {
  return state.app.currentMode === "autonomous" && activeLaneExecutor !== null;
}

function computeManualDemand() {
  const speedDemand = clamp(state.controller.speed, -1, 1);
  const turnDemand = clamp(state.controller.angleDegrees / 45, -1, 1);
  const maxWheelSpeed = parameters.maxWheelSpeedMetersPerSecond;

  if (!currentModeAllowsManualDrive() || !state.controller.connected || !manualDriveEnabled) {
    return {
      mode: "stopped",
      requestedLeftMetersPerSecond: 0,
      requestedRightMetersPerSecond: 0,
    };
  }

  if (Math.abs(speedDemand) < 0.05 && Math.abs(turnDemand) > 0.12) {
    const spinSpeed = turnDemand * maxWheelSpeed * 0.45;
    return {
      mode: "spin",
      requestedLeftMetersPerSecond: -spinSpeed,
      requestedRightMetersPerSecond: spinSpeed,
    };
  }

  const baseSpeed = speedDemand * maxWheelSpeed;
  const steeringDelta = turnDemand * maxWheelSpeed * 0.5;
  return {
    mode: Math.abs(turnDemand) > 0.15 ? "arc" : "straight",
    requestedLeftMetersPerSecond: clamp(baseSpeed - steeringDelta, -maxWheelSpeed, maxWheelSpeed),
    requestedRightMetersPerSecond: clamp(baseSpeed + steeringDelta, -maxWheelSpeed, maxWheelSpeed),
  };
}

function computeAutonomousDemand() {
  if (!currentModeAllowsAutonomousDrive() || !state.estimate.ok) {
    return null;
  }

  const snapshot = activeLaneExecutor.step(state.estimate.sample, Date.now());
  state.planning.laneExecution = snapshot;
  if (snapshot.completed) {
    activeLaneExecutor = null;
    state.app.autonomousStatus = "lane_complete";
    state.app.autonomousMessage = "Selected lane completed. Multi-lane mission flow is not implemented yet.";
    addNote("Autonomous lane execution completed.");
  }

  return {
    mode: snapshot.completed ? "stopped" : "autonomous_lane",
    requestedLeftMetersPerSecond: snapshot.wheelTargets.leftMetersPerSecond,
    requestedRightMetersPerSecond: snapshot.wheelTargets.rightMetersPerSecond,
  };
}

function pushButtonEvent(label) {
  state.controller.lastButtonEvents.unshift({
    label,
    timestampMillis: Date.now(),
  });
  state.controller.lastButtonEvents = state.controller.lastButtonEvents.slice(0, 8);
}

function publishState() {
  refreshCaptureState();
  state.serverTimestampMillis = Date.now();
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

async function logTelemetryIfDue() {
  if (Date.now() - lastTelemetryLogMillis < TELEMETRY_LOG_INTERVAL_MS) {
    return;
  }
  lastTelemetryLogMillis = Date.now();
  await appendFile(sessionLogPath, `${JSON.stringify(state)}\n`, "utf8");
}

function requestLengthForNode(nodeId) {
  if (nodeId === NodeId.Gnss) {
    return gnssFrameLength;
  }
  if (nodeId === NodeId.Motor) {
    return motorFeedbackFrameLength;
  }
  throw new Error(`Unknown node ${nodeId}`);
}

function addressForNode(nodeId) {
  if (nodeId === NodeId.Gnss) {
    return GNSS_I2C_ADDRESS;
  }
  if (nodeId === NodeId.Motor) {
    return MOTOR_I2C_ADDRESS;
  }
  throw new Error(`Unknown node ${nodeId}`);
}

class LiveI2cBusAdapter {
  constructor(bus) {
    this.bus = bus;
  }

  async send(nodeId, payload) {
    const address = addressForNode(nodeId);
    const buffer = Buffer.from(payload);
    await this.bus.i2cWrite(address, buffer.length, buffer);
  }

  async request(nodeId, payload) {
    const address = addressForNode(nodeId);
    const request = Buffer.from(payload);
    let lastError;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.bus.i2cWrite(address, request.length, request);
        const response = Buffer.alloc(requestLengthForNode(nodeId));
        const result = await this.bus.i2cRead(address, response.length, response);
        if (result.bytesRead !== response.length) {
          throw new Error(`short read ${result.bytesRead}/${response.length}`);
        }
        return new Uint8Array(response);
      } catch (error) {
        lastError = error;
        await sleep(40);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async close() {
    await this.bus.close();
  }
}

async function refreshGnssIfDue() {
  if (Date.now() - lastGnssRefreshMillis < GNSS_REFRESH_INTERVAL_MS) {
    return;
  }
  lastGnssRefreshMillis = Date.now();

  try {
    const sample = await gnssNodeClient.refresh();
    gnssNodeNowMillis = sample.timestampMillis;
    state.gnss = {
      ok: true,
      ...deriveGnssState(sample),
      adapted: gnssAdapter.adapt(sample),
      health: gnssNodeClient.health(),
    };
    poseEstimator.ingest(state.gnss.adapted);
  } catch (error) {
    state.gnss = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function refreshImu() {
  try {
    const sample = await sensor.read();
    const adapted = imuAdapter.adapt(sample);
    state.imu = {
      ok: true,
      ...deriveImuState(sample),
      adapted,
    };
    poseEstimator.ingest(adapted);
  } catch (error) {
    state.imu = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function recordCaptureSampleIfActive(estimate) {
  if (state.app.currentMode !== "site_capture" || !state.capture.activeCapture) {
    return;
  }

  state.capture.lastRecordResult = recorder.recordSample({
    xMeters: estimate.xMeters,
    yMeters: estimate.yMeters,
    headingDegrees: estimate.headingDegrees,
    timestampMillis: estimate.timestampMillis,
  });
}

async function refreshMotorAndDrive() {
  const requested = computeAutonomousDemand() ?? computeManualDemand();
  state.command.mode = requested.mode;
  state.command.requestedLeftMetersPerSecond = requested.requestedLeftMetersPerSecond;
  state.command.requestedRightMetersPerSecond = requested.requestedRightMetersPerSecond;

  const mapped = mapPhysicalWheelTargetsToRaw(parameters, {
    leftMetersPerSecond: requested.requestedLeftMetersPerSecond,
    rightMetersPerSecond: requested.requestedRightMetersPerSecond,
  });

  const limited = commandLimiter.limit(lastWheelTargets, mapped);
  lastWheelTargets = limited;
  state.command.limitedLeftMetersPerSecond = limited.leftMetersPerSecond;
  state.command.limitedRightMetersPerSecond = limited.rightMetersPerSecond;

  try {
    await motorNodeClient.sendWheelSpeedCommand({
      timestampMillis: Date.now() >>> 0,
      leftWheelTargetMetersPerSecond: limited.leftMetersPerSecond,
      rightWheelTargetMetersPerSecond: limited.rightMetersPerSecond,
      enableDrive:
        (currentModeAllowsManualDrive() && manualDriveEnabled && state.controller.connected)
        || currentModeAllowsAutonomousDrive(),
      commandTimeoutMillis: 300,
      maxAccelerationMetersPerSecondSquared: parameters.maxWheelAccelerationMetersPerSecondSquared,
      maxDecelerationMetersPerSecondSquared: parameters.maxWheelDecelerationMetersPerSecondSquared,
    });

    const feedback = await motorNodeClient.refreshFeedback();
    motorNodeNowMillis = feedback.timestampMillis;
    const adapted = motorFeedbackAdapter.adapt(feedback);
    state.motor = {
      ok: true,
      ...deriveMotorState(feedback),
      adapted,
      health: motorNodeClient.health(),
    };
    const estimate = poseEstimator.ingest(adapted);
    state.estimate = {
      ok: true,
      sample: estimate,
    };
    recordCaptureSampleIfActive(estimate);
  } catch (error) {
    state.motor = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function controlLoop() {
  while (!shuttingDown) {
    await refreshImu();
    await refreshGnssIfDue();
    await refreshMotorAndDrive();
    await logTelemetryIfDue();
    publishState();
    await sleep(CONTROL_LOOP_MS);
  }
}

async function handlePage(response) {
  const html = await readFile(dashboardPath, "utf8");
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function handleEvents(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  response.write("\n");
  response.write(`data: ${JSON.stringify(state)}\n\n`);
  clients.add(response);
  response.on("close", () => clients.delete(response));
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function setMode(mode) {
  if (!state.app.availableModes.includes(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }
  if (state.capture.activeCapture && mode !== "site_capture") {
    throw new Error("Finish or discard the active site capture before leaving site-capture mode.");
  }

  state.app.currentMode = mode;
  if (mode === "autonomous") {
    manualDriveEnabled = false;
    state.controller.manualDriveEnabled = false;
    state.app.autonomousStatus = "ready_for_plan";
    state.app.autonomousMessage = "Autonomous mode selected. Mission start logic is not implemented yet.";
  } else {
    activeLaneExecutor = null;
    state.planning.laneExecution = null;
    state.app.autonomousStatus = "idle";
    state.app.autonomousMessage = "Autonomous mission execution is not implemented yet.";
  }
  addNote(`Switched mode to ${mode}.`);
}

async function saveSiteModel(site) {
  await mkdir(siteDirectoryPath, { recursive: true });
  const filePath = path.join(
    siteDirectoryPath,
    `site-${new Date(site.capturedAtMillis).toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(filePath, `${JSON.stringify(site, null, 2)}\n`, "utf8");
  state.lastSavedSitePath = filePath;
  await refreshSavedSiteState();
  return filePath;
}

async function refreshSavedSiteState() {
  const entries = await readdir(siteDirectoryPath, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(siteDirectoryPath, entry.name))
    .sort((a, b) => b.localeCompare(a));

  state.review.savedSiteFiles = files;
  if (files.length === 0) {
    state.review.selectedSitePath = null;
    state.review.selectedSite = null;
    return;
  }

  const selectedPath = files.includes(state.review.selectedSitePath) ? state.review.selectedSitePath : files[0];
  state.review.selectedSitePath = selectedPath;
  state.review.selectedSite = JSON.parse(await readFile(selectedPath, "utf8"));
}

async function selectSite(sitePath) {
  if (typeof sitePath !== "string" || sitePath.length === 0) {
    throw new Error("A site path is required.");
  }
  state.review.selectedSitePath = sitePath;
  await refreshSavedSiteState();
  if (state.review.selectedSitePath !== sitePath) {
    throw new Error(`Saved site not found: ${sitePath}`);
  }
}

async function saveCoveragePlan(plan) {
  await mkdir(planDirectoryPath, { recursive: true });
  const filePath = path.join(
    planDirectoryPath,
    `plan-${new Date(plan.generatedAtMillis).toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(filePath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  state.planning.currentPlanPath = filePath;
  state.planning.currentPlan = plan;
  return filePath;
}

async function generateCoveragePlanForSelectedSite() {
  await refreshSavedSiteState();
  if (state.review.selectedSite === null) {
    throw new Error("No saved site is available.");
  }

  const plan = coveragePlanner.plan(state.review.selectedSite);
  await saveCoveragePlan(plan);
  return plan;
}

function selectMissionStartFromCurrentPose() {
  if (!state.estimate.ok) {
    throw new Error("A live pose estimate is required before mission-start selection.");
  }
  if (state.planning.currentPlan === null) {
    throw new Error("Generate a coverage plan before selecting a mission start.");
  }

  const selection = missionStartSelector.select(state.planning.currentPlan, state.estimate.sample);
  state.planning.lastMissionStartSelection = selection;
  return selection;
}

function startSelectedLaneExecution() {
  if (!state.estimate.ok) {
    throw new Error("A live pose estimate is required before lane execution.");
  }
  if (state.planning.currentPlan === null) {
    throw new Error("Generate a coverage plan before lane execution.");
  }

  const selection = state.planning.lastMissionStartSelection ?? selectMissionStartFromCurrentPose();
  const lane = state.planning.currentPlan.areas
    .flatMap((area) => area.lanes)
    .find((candidate) => candidate.id === selection.laneId);

  if (lane === undefined) {
    throw new Error(`Selected lane not found: ${selection.laneId}`);
  }

  const orientedLane = selection.endpoint === "start"
    ? lane
    : {
        ...lane,
        start: lane.end,
        end: lane.start,
        headingDegrees: lane.end.headingDegrees,
      };

  activeLaneExecutor = new LaneExecutor(buildLaneMissionSequence(state.estimate.sample, orientedLane), {
    maxWheelSpeedMetersPerSecond: parameters.maxWheelSpeedMetersPerSecond,
    headingToleranceDegrees: parameters.headingArrivalToleranceDegrees,
    arrivalToleranceMeters: parameters.waypointArrivalToleranceMeters,
    settleDurationMillis: 250,
    turnGain: parameters.maxWheelSpeedMetersPerSecond * 0.5,
    lineNominalSpeedMetersPerSecond: Math.min(parameters.maxWheelSpeedMetersPerSecond * 0.7, 0.5),
    lineMaxSpeedMetersPerSecond: Math.min(parameters.maxWheelSpeedMetersPerSecond, 0.65),
    lineCrossTrackGain: 1.2,
    lineHeadingGain: 0.8,
    lineMaxYawRateDegreesPerSecond: 90,
    wheelBaseMeters: parameters.wheelBaseMeters,
  });

  state.planning.laneExecution = null;
  state.app.autonomousStatus = "executing_lane";
  state.app.autonomousMessage = `Executing ${selection.laneId} from its ${selection.endpoint} endpoint.`;
}

async function handleAppAction(request, response) {
  const bodyText = await readRequestBody(request);
  const body = bodyText.length === 0 ? {} : JSON.parse(bodyText);

  try {
    switch (body.action) {
      case "set_mode":
        setMode(body.mode);
        break;
      case "refresh_sites":
        await refreshSavedSiteState();
        addNote("Saved site list refreshed.");
        break;
      case "select_site":
        await selectSite(body.sitePath);
        addNote(`Selected site ${body.sitePath}.`);
        break;
      case "generate_plan":
        await generateCoveragePlanForSelectedSite();
        addNote("Coverage plan generated from the selected site.");
        break;
      case "select_mission_start": {
        const selection = selectMissionStartFromCurrentPose();
        state.app.autonomousStatus = "start_selected";
        state.app.autonomousMessage =
          `Selected ${selection.laneId} ${selection.endpoint} at distance ${selection.distanceMeters.toFixed(2)} m.`;
        addNote(`Mission start selected: ${selection.laneId} ${selection.endpoint}.`);
        break;
      }
      case "start_autonomous":
        if (state.app.currentMode !== "autonomous") {
          throw new Error("Switch to autonomous mode before starting mowing.");
        }
        startSelectedLaneExecution();
        addNote("Autonomous start requested. Executing the selected lane.");
        break;
      case "stop_autonomous":
        activeLaneExecutor = null;
        state.planning.laneExecution = null;
        state.app.autonomousStatus = "idle";
        state.app.autonomousMessage = "Autonomous mission execution is not implemented yet.";
        addNote("Autonomous mode returned to idle.");
        break;
      default:
        throw new Error(`Unknown app action: ${String(body.action)}`);
    }

    publishState();
    sendJson(response, 200, { ok: true, state });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      state,
    });
  }
}

async function handleCaptureAction(request, response) {
  const bodyText = await readRequestBody(request);
  const body = bodyText.length === 0 ? {} : JSON.parse(bodyText);

  try {
    if (state.app.currentMode !== "site_capture") {
      throw new Error("Capture actions are only available in site-capture mode.");
    }

    switch (body.action) {
      case "start_perimeter":
        recorder.startPerimeter();
        state.capture.lastRecordResult = null;
        addNote("Perimeter capture started.");
        break;
      case "finish_perimeter":
        recorder.finishPerimeter();
        addNote("Perimeter capture finished.");
        break;
      case "start_obstacle":
        recorder.startObstacle();
        state.capture.lastRecordResult = null;
        addNote("Obstacle capture started.");
        break;
      case "finish_obstacle":
        recorder.finishObstacle();
        addNote("Obstacle capture finished.");
        break;
      case "undo_last_point":
        recorder.undoLastPoint();
        addNote("Last capture point removed.");
        break;
      case "discard_current_obstacle":
        recorder.discardCurrentObstacle();
        addNote("Active obstacle capture discarded.");
        break;
      case "discard_capture":
        recorder.discardCapture();
        state.capture.lastRecordResult = null;
        state.lastSavedSitePath = null;
        addNote("Full capture discarded.");
        break;
      case "finish_capture": {
        const site = recorder.finishCapture(Date.now());
        const filePath = await saveSiteModel(site);
        addNote(`Site capture saved to ${filePath}.`);
        break;
      }
      default:
        throw new Error(`Unknown capture action: ${String(body.action)}`);
    }

    refreshCaptureState();
    publishState();
    sendJson(response, 200, { ok: true, state });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      state,
    });
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/" || request.url === "/index.html") {
      await handlePage(response);
      return;
    }
    if (request.url === "/events") {
      handleEvents(response);
      return;
    }
    if (request.url === "/api/state") {
      sendJson(response, 200, state);
      return;
    }
    if (request.url === "/api/app" && request.method === "POST") {
      await handleAppAction(request, response);
      return;
    }
    if (request.url === "/api/capture" && request.method === "POST") {
      await handleCaptureAction(request, response);
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.stack ?? error.message : String(error));
  }
});

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  try {
    controller.close();
  } catch {}
  try {
    await motorNodeClient?.sendWheelSpeedCommand({
      timestampMillis: Date.now() >>> 0,
      leftWheelTargetMetersPerSecond: 0,
      rightWheelTargetMetersPerSecond: 0,
      enableDrive: false,
      commandTimeoutMillis: 300,
    });
  } catch {}
  try {
    await sensor.close();
  } catch {}
  try {
    await i2cBus?.close();
  } catch {}
  for (const client of clients) {
    client.end();
  }
  clients.clear();
  await new Promise((resolve) => server.close(resolve));
  process.exitCode = exitCode;
}

async function main() {
  await mkdir(siteDirectoryPath, { recursive: true });
  await mkdir(planDirectoryPath, { recursive: true });
  await mkdir(logDirectoryPath, { recursive: true });
  await refreshSavedSiteState();

  const config = await loadSystemParameters();
  parameters = config.parameters;
  controller = new HidGameController({
    steeringSign: parameters.controllerSteeringSign,
    speedSign: parameters.controllerSpeedSign,
  });
  i2cBus = await i2c.openPromisified(BUS_NUMBER);
  const busAdapter = new LiveI2cBusAdapter(i2cBus);

  gnssNodeClient = new PollingGnssNodeClient(busAdapter);
  motorNodeClient = new PollingMotorNodeClient(busAdapter);
  gnssAdapter = new GnssAdapter({ staleAfterMillis: 1000, now: () => gnssNodeNowMillis });
  motorFeedbackAdapter = new MotorFeedbackAdapter({
    leftMetersPerEncoderCount: parameters.wheelCircumferenceMeters / parameters.encoderCountsPerWheelRevolution,
    rightMetersPerEncoderCount: parameters.wheelCircumferenceMeters / parameters.encoderCountsPerWheelRevolution,
    staleAfterMillis: 500,
    now: () => motorNodeNowMillis,
  });
  imuAdapter = new ImuAdapter({ staleAfterMillis: 500 });
  poseEstimator = new PoseEstimator({ wheelBaseMeters: parameters.wheelBaseMeters });
  commandLimiter = new CommandLimiter({
    maxWheelSpeedMetersPerSecond: parameters.maxWheelSpeedMetersPerSecond,
    maxWheelAccelerationStepMetersPerSecond: parameters.maxWheelAccelerationMetersPerSecondSquared * (CONTROL_LOOP_MS / 1000),
    maxWheelDecelerationStepMetersPerSecond: parameters.maxWheelDecelerationMetersPerSecondSquared * (CONTROL_LOOP_MS / 1000),
  });

  console.log("Initialising BMI160 IMU sensor on I2C bus 1 address 0x69...");
  await sensor.initialise();
  console.log("Calibrating gyro bias. Keep the mower still...");
  await sensor.calibrateGyro();

  controller.on("update", (snapshot) => {
    state.controller = {
      ...state.controller,
      ...snapshot,
      manualDriveEnabled,
    };
  });
  controller.on("top", () => {
    manualDriveEnabled = true;
    state.controller.manualDriveEnabled = true;
    pushButtonEvent("top");
  });
  controller.on("right-top", () => {
    manualDriveEnabled = true;
    state.controller.manualDriveEnabled = true;
    pushButtonEvent("right-top");
  });
  controller.on("cross", () => {
    manualDriveEnabled = false;
    state.controller.manualDriveEnabled = false;
    pushButtonEvent("cross");
  });
  controller.on("left-top", () => {
    manualDriveEnabled = false;
    state.controller.manualDriveEnabled = false;
    pushButtonEvent("left-top");
  });
  for (const label of ["triangle", "circle", "square", "select", "start", "analog", "left", "right", "bottom"]) {
    controller.on(label, () => pushButtonEvent(label));
  }
  controller.on("error", (error) => {
    addNote(`Controller error: ${error instanceof Error ? error.message : String(error)}`);
  });
  controller.start();

  server.listen(PORT, () => {
    console.log(`Core mower app ready at http://0.0.0.0:${PORT}`);
    console.log(`Session telemetry log: ${sessionLogPath}`);
  });

  await controlLoop();
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
