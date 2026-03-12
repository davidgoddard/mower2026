import http from "node:http";
import path from "node:path";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import i2c from "i2c-bus";
import { loadSystemParameters, saveSystemParameters } from "./systemConfig.js";
import { Bmi160ImuSensor } from "../../dist/src/hardware/bmi160ImuSensor.js";
import { PollingMotorNodeClient } from "../../dist/src/nodes/motorNodeClient.js";
import { PollingGnssNodeClient } from "../../dist/src/nodes/gnssNodeClient.js";
import { GnssAdapter } from "../../dist/src/sensing/gnssAdapter.js";
import { MotorFeedbackAdapter } from "../../dist/src/sensing/motorFeedbackAdapter.js";
import { ImuAdapter } from "../../dist/src/sensing/imuAdapter.js";
import { PoseEstimator } from "../../dist/src/estimation/poseEstimator.js";
import { CommandLimiter } from "../../dist/src/control/commandLimiter.js";
import { mapPhysicalWheelTargetsToRaw } from "../../dist/src/control/motorMapping.js";
import { CalibrationApp } from "../../dist/src/app/calibrationApp.js";
import { AutomaticCalibrationController } from "../../dist/src/calibration/automaticCalibrationController.js";
import { NodeId } from "../../dist/src/protocols/commonProtocol.js";
import { gnssPayloadLength } from "../../dist/src/protocols/gnssCodec.js";
import { motorFeedbackSampleLength } from "../../dist/src/protocols/motorCodec.js";

const PORT = 8094;
const BUS_NUMBER = 1;
const GNSS_I2C_ADDRESS = 0x52;
const MOTOR_I2C_ADDRESS = 0x66;
const IDLE_LOOP_MS = 200;
const ACTIVE_LOOP_MS = 100;
const GNSS_REFRESH_INTERVAL_MS = 200;

const DEFAULT_AREA = {
  safeRadiusMeters: 2.0,
  straightRunDistanceMeters: 1.5,
  arrivalTargetDistanceMeters: 1.2,
};

const ZERO_WHEELS = {
  leftMetersPerSecond: 0,
  rightMetersPerSecond: 0,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardPath = path.join(__dirname, "calibration_dashboard.html");
const sessionStamp = new Date().toISOString().replace(/[:.]/g, "-");
const telemetryLogPath = path.join(__dirname, `calibration-telemetry-${sessionStamp}.jsonl`);
const eventLogPath = path.join(__dirname, `calibration-events-${sessionStamp}.jsonl`);
const learningStatePath = path.join(__dirname, `calibration-learning-${sessionStamp}.jsonl`);

const FRAME_HEADER_SIZE = 9;
const FRAME_CRC_SIZE = 2;
const gnssFrameLength = FRAME_HEADER_SIZE + gnssPayloadLength() + FRAME_CRC_SIZE;
const motorFeedbackFrameLength = FRAME_HEADER_SIZE + motorFeedbackSampleLength() + FRAME_CRC_SIZE;

let parameters;
let parameterFilePath;
let i2cBus;
let motorNodeClient;
let gnssNodeClient;
let gnssAdapter;
let motorFeedbackAdapter;
let imuAdapter;
let poseEstimator;
let commandLimiter;
const sensor = new Bmi160ImuSensor();
let shuttingDown = false;
let gnssNodeNowMillis = 0;
let motorNodeNowMillis = 0;
let lastGnssRefreshMillis = 0;
let lastWheelTargets = ZERO_WHEELS;
let controlOwnedByCalibration = false;
let calibrationAbortRequested = false;
let calibrationPromise = null;
let learnedProfile;
const clients = new Set();

const state = {
  serverTimestampMillis: Date.now(),
  telemetryLogPath,
  eventLogPath,
  learningStatePath,
  readiness: {
    ready: false,
    reasons: ["starting"],
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
  command: {
    enableDrive: false,
    requestedLeftMetersPerSecond: 0,
    requestedRightMetersPerSecond: 0,
    limitedLeftMetersPerSecond: 0,
    limitedRightMetersPerSecond: 0,
  },
  calibration: {
    running: false,
    iteration: 0,
    abortRequested: false,
    currentTrialId: null,
    currentStage: null,
    currentDescription: null,
    phase: "idle",
    targetHeadingDegrees: null,
    headingErrorDegrees: null,
    crossTrackErrorMeters: null,
    remainingDistanceMeters: null,
    targetPose: null,
    report: null,
    goals: null,
    history: [],
    learnedProfile: null,
    startedAtMillis: null,
    completedAtMillis: null,
    lastError: null,
  },
  notes: [
    "Wait for RTK float or fixed and a stable heading before starting calibration.",
    "Calibration assumes at least 2 m of clear space around the mower.",
  ],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendJsonl(pathname, record) {
  return appendFile(pathname, `${JSON.stringify(record)}\n`, "utf8");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class JsonlTelemetryLogger {
  append(streamName, sample) {
    void appendJsonl(telemetryLogPath, {
      timestampMillis: Date.now(),
      streamName,
      sample,
    }).catch(() => {});
  }
}

class JsonlEventLogger {
  log(eventName, fields) {
    void appendJsonl(eventLogPath, {
      timestampMillis: Date.now(),
      eventName,
      fields,
    }).catch(() => {});
  }
}

class StaticParameterStore {
  async load() {}

  get() {
    return parameters;
  }

  currentRevision() {
    return "config/system-parameters.json";
  }
}

function qualityRank(quality) {
  if (quality === "green") {
    return 3;
  }
  if (quality === "orange") {
    return 2;
  }
  return 1;
}

function summarizeQuality(goals) {
  if (goals === null) {
    return "unknown";
  }
  const minimum = Math.min(
    qualityRank(goals.turn.quality),
    qualityRank(goals.line.quality),
    qualityRank(goals.arrival.quality),
  );
  return minimum === 3 ? "green" : minimum === 2 ? "orange" : "red";
}

function seedLearnedProfile(currentParameters) {
  return {
    turnScale: currentParameters.calibrationTurnScale ?? 1,
    lineGainScale: currentParameters.calibrationLineGainScale ?? 1,
    arrivalToleranceMeters: currentParameters.waypointArrivalToleranceMeters,
    pivotAntennaExcursionMeters: currentParameters.pivotAntennaExcursionMeters ?? 0,
  };
}

function buildPersistedParameters(currentParameters, profile) {
  return {
    ...currentParameters,
    calibrationTurnScale: Number(profile.turnScale.toFixed(3)),
    calibrationLineGainScale: Number(profile.lineGainScale.toFixed(3)),
    pivotAntennaExcursionMeters: Number(profile.pivotAntennaExcursionMeters.toFixed(3)),
    waypointArrivalToleranceMeters: Number(profile.arrivalToleranceMeters.toFixed(3)),
  };
}

async function persistLearnedProfile() {
  parameters = buildPersistedParameters(parameters, learnedProfile);
  state.calibration.learnedProfile = clone(learnedProfile);
  await saveSystemParameters(parameterFilePath, parameters);
  await appendJsonl(learningStatePath, {
    timestampMillis: Date.now(),
    learnedProfile,
  });
}

function adaptLearnedProfile(report) {
  const nextProfile = {
    turnScale: clamp((learnedProfile.turnScale * 0.6) + (report.recommendations.recommendedTurnScale * 0.4), 0.3, 1.0),
    lineGainScale: clamp((learnedProfile.lineGainScale * 0.6) + (report.recommendations.recommendedLineGainScale * 0.4), 0.5, 1.25),
    arrivalToleranceMeters: clamp((learnedProfile.arrivalToleranceMeters * 0.6) + (report.recommendations.recommendedArrivalToleranceMeters * 0.4), 0.03, 0.25),
    pivotAntennaExcursionMeters: report.recommendations.pivotAntennaExcursionMeters,
  };
  learnedProfile = nextProfile;
  state.calibration.learnedProfile = clone(nextProfile);
}

function addHistoryEntry(report) {
  const entry = {
    iteration: state.calibration.iteration,
    completedAtMillis: Date.now(),
    goals: report.summary,
    recommendations: report.recommendations,
    quality: summarizeQuality(report.summary),
  };
  state.calibration.history.unshift(entry);
  state.calibration.history = state.calibration.history.slice(0, 20);
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

function deriveGnssState(sample) {
  return {
    sample,
    derived: {
      headingDegrees: sample.headingDegrees ?? null,
      groundSpeedMetersPerSecond: sample.groundSpeedMetersPerSecond ?? 0,
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
    },
  };
}

function updateReadiness() {
  const reasons = [];
  const gnssFixType = state.gnss.ok ? state.gnss.sample.fixType : "none";
  const gnssHasHeading = Boolean(state.gnss.ok && state.gnss.sample.headingDegrees !== undefined);
  const gnssFresh = Boolean(state.gnss.ok && state.gnss.sample.sampleAgeMillis <= 1000);

  if (!state.imu.ok) {
    reasons.push("IMU not ready");
  }
  if (!state.motor.ok) {
    reasons.push("Motor feedback not ready");
  }
  if (!state.estimate.ok) {
    reasons.push("Pose estimate not ready");
  }
  if (!state.gnss.ok) {
    reasons.push("GNSS not ready");
  } else {
    if (!(gnssFixType === "float" || gnssFixType === "fixed")) {
      reasons.push(`GNSS fix is ${gnssFixType}, not float/fixed`);
    }
    if (!gnssHasHeading) {
      reasons.push("GNSS heading unavailable");
    }
    if (!gnssFresh) {
      reasons.push("GNSS sample stale");
    }
  }

  state.readiness = {
    ready: reasons.length === 0,
    reasons,
  };
}

function publishState() {
  state.serverTimestampMillis = Date.now();
  updateReadiness();
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
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
}

async function refreshGnssIfDue(force = false) {
  if (!force && (Date.now() - lastGnssRefreshMillis) < GNSS_REFRESH_INTERVAL_MS) {
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

async function applyWheelTargets(physicalTargets, enableDrive) {
  state.command.enableDrive = enableDrive;
  state.command.requestedLeftMetersPerSecond = physicalTargets.leftMetersPerSecond;
  state.command.requestedRightMetersPerSecond = physicalTargets.rightMetersPerSecond;

  const mapped = mapPhysicalWheelTargetsToRaw(parameters, physicalTargets);
  const limited = commandLimiter.limit(lastWheelTargets, mapped);
  lastWheelTargets = limited;
  state.command.limitedLeftMetersPerSecond = limited.leftMetersPerSecond;
  state.command.limitedRightMetersPerSecond = limited.rightMetersPerSecond;

  await motorNodeClient.sendWheelSpeedCommand({
    timestampMillis: Date.now() >>> 0,
    leftWheelTargetMetersPerSecond: limited.leftMetersPerSecond,
    rightWheelTargetMetersPerSecond: limited.rightMetersPerSecond,
    enableDrive,
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
}

async function pollOnce(physicalTargets = ZERO_WHEELS, enableDrive = false, forceGnss = false) {
  await refreshImu();
  await refreshGnssIfDue(forceGnss);
  await applyWheelTargets(physicalTargets, enableDrive);
  publishState();
  if (!state.estimate.ok) {
    throw new Error("Pose estimate unavailable");
  }
  return {
    timestampMillis: Date.now(),
    estimate: state.estimate.sample,
    imuRollDegrees: state.imu.ok ? state.imu.derived.rollDegrees : undefined,
    imuPitchDegrees: state.imu.ok ? state.imu.derived.pitchDegrees : undefined,
    motorFaultFlags: state.motor.ok ? state.motor.sample.faultFlags : undefined,
    gnssFixType: state.gnss.ok ? state.gnss.sample.fixType : undefined,
  };
}

async function stopDrive() {
  for (let index = 0; index < 3; index += 1) {
    await pollOnce(ZERO_WHEELS, false, true);
    await sleep(ACTIVE_LOOP_MS);
  }
}

async function primePose() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sample = await pollOnce(ZERO_WHEELS, false, true);
    if (state.readiness.ready) {
      return sample;
    }
    await sleep(IDLE_LOOP_MS);
  }
  throw new Error(`Calibration not ready: ${state.readiness.reasons.join("; ")}`);
}

class RuntimeCalibrationExecutor {
  async runTrial(definition) {
    const tunedDefinition = {
      ...definition,
      profile: {
        ...definition.profile,
        turnScale: definition.profile.turnScale * learnedProfile.turnScale,
        lineGainScale: definition.profile.lineGainScale * learnedProfile.lineGainScale,
      },
    };
    const initialSample = await primePose();
    const controller = new AutomaticCalibrationController(tunedDefinition, initialSample.estimate, {
      maxWheelSpeedMetersPerSecond: parameters.maxWheelSpeedMetersPerSecond,
      headingToleranceDegrees: Math.min(parameters.headingArrivalToleranceDegrees, 3),
      positionToleranceMeters: Math.min(learnedProfile.arrivalToleranceMeters, 0.05),
      settleDurationMillis: 500,
    });
    const samples = [initialSample];
    const startedAtMillis = Date.now();

    state.calibration.currentTrialId = tunedDefinition.id;
    state.calibration.currentStage = tunedDefinition.stage;
    state.calibration.currentDescription = tunedDefinition.description;
    state.calibration.targetPose = controller.targetPose() ?? null;

    let estimate = initialSample.estimate;
    let snapshot = controller.step(estimate, Date.now());

    while ((Date.now() - startedAtMillis) <= tunedDefinition.maxDurationMillis) {
      if (calibrationAbortRequested) {
        await stopDrive();
        return {
          definition: tunedDefinition,
          samples,
          completed: false,
          abortReason: "aborted_by_operator",
        };
      }

      state.calibration.phase = snapshot.phase;
      state.calibration.targetHeadingDegrees = snapshot.targetHeadingDegrees ?? null;
      state.calibration.headingErrorDegrees = snapshot.headingErrorDegrees ?? null;
      state.calibration.crossTrackErrorMeters = snapshot.crossTrackErrorMeters ?? null;
      state.calibration.remainingDistanceMeters = snapshot.remainingDistanceMeters ?? null;

      if (snapshot.completed) {
        await stopDrive();
        return {
          definition: tunedDefinition,
          samples,
          completed: true,
        };
      }

      const sample = await pollOnce(snapshot.wheelTargets, true, true);
      samples.push(sample);
      estimate = sample.estimate;
      snapshot = controller.step(estimate, Date.now());
      await sleep(ACTIVE_LOOP_MS);
    }

    await stopDrive();
    return {
      definition: tunedDefinition,
      samples,
      completed: false,
      abortReason: "timeout",
    };
  }
}

async function idleLoop() {
  while (!shuttingDown) {
    if (!controlOwnedByCalibration) {
      try {
        await pollOnce(ZERO_WHEELS, false, true);
      } catch (error) {
        state.notes.unshift(`Idle polling error: ${error instanceof Error ? error.message : String(error)}`);
        state.notes = state.notes.slice(0, 8);
        publishState();
      }
    }
    await sleep(IDLE_LOOP_MS);
  }
}

async function startCalibration() {
  if (calibrationPromise !== null) {
    throw new Error("Calibration already running");
  }
  if (!state.readiness.ready) {
    throw new Error(`Calibration not ready: ${state.readiness.reasons.join("; ")}`);
  }

  calibrationAbortRequested = false;
  state.calibration.running = true;
  state.calibration.iteration = 0;
  state.calibration.abortRequested = false;
  state.calibration.report = null;
  state.calibration.goals = null;
  state.calibration.history = [];
  state.calibration.lastError = null;
  state.calibration.startedAtMillis = Date.now();
  state.calibration.completedAtMillis = null;
  controlOwnedByCalibration = true;
  publishState();

  const calibrationApp = new CalibrationApp({
    executor: new RuntimeCalibrationExecutor(),
    telemetryLogger: new JsonlTelemetryLogger(),
    eventLogger: new JsonlEventLogger(),
    parameterStore: new StaticParameterStore(),
  });

  calibrationPromise = (async () => {
    while (!calibrationAbortRequested) {
      state.calibration.iteration += 1;
      publishState();
      const report = await calibrationApp.start(DEFAULT_AREA);
      state.calibration.report = report;
      state.calibration.goals = report.summary ?? null;
      state.calibration.completedAtMillis = Date.now();
      addHistoryEntry(report);
      adaptLearnedProfile(report);
      await persistLearnedProfile();
      publishState();
      await sleep(750);
    }
  })()
    .catch((error) => {
      state.calibration.lastError = error instanceof Error ? error.message : String(error);
    })
    .finally(async () => {
      calibrationPromise = null;
      controlOwnedByCalibration = false;
      state.calibration.running = false;
      state.calibration.abortRequested = false;
      state.calibration.currentTrialId = null;
      state.calibration.currentStage = null;
      state.calibration.currentDescription = null;
      state.calibration.phase = "idle";
      state.calibration.targetHeadingDegrees = null;
      state.calibration.headingErrorDegrees = null;
      state.calibration.crossTrackErrorMeters = null;
      state.calibration.remainingDistanceMeters = null;
      state.calibration.targetPose = null;
      await stopDrive().catch(() => {});
      publishState();
    });
}

function requestAbort() {
  calibrationAbortRequested = true;
  state.calibration.abortRequested = true;
  publishState();
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

async function handleState(response) {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(state));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && (request.url === "/" || request.url === "/calibration_dashboard.html")) {
      await handlePage(response);
      return;
    }
    if (request.method === "GET" && request.url === "/events") {
      handleEvents(response);
      return;
    }
    if (request.method === "GET" && request.url === "/api/state") {
      await handleState(response);
      return;
    }
    if (request.method === "POST" && request.url === "/api/calibration/start") {
      await readJson(request);
      await startCalibration();
      response.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ accepted: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/calibration/abort") {
      requestAbort();
      response.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ accepted: true }));
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
  calibrationAbortRequested = true;

  try {
    await stopDrive();
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
  const config = await loadSystemParameters();
  parameters = config.parameters;
  parameterFilePath = config.filePath;
  learnedProfile = seedLearnedProfile(parameters);
  state.calibration.learnedProfile = clone(learnedProfile);

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
    maxWheelAccelerationStepMetersPerSecond: parameters.maxWheelAccelerationMetersPerSecondSquared * (ACTIVE_LOOP_MS / 1000),
    maxWheelDecelerationStepMetersPerSecond: parameters.maxWheelDecelerationMetersPerSecondSquared * (ACTIVE_LOOP_MS / 1000),
  });

  console.log("Initialising BMI160 IMU sensor on I2C bus 1 address 0x69...");
  await sensor.initialise();
  console.log("Calibrating gyro bias. Keep the mower still...");
  await sensor.calibrateGyro();

  server.listen(PORT, () => {
    console.log(`Calibration dashboard ready at http://0.0.0.0:${PORT}`);
    console.log(`Telemetry log: ${telemetryLogPath}`);
    console.log(`Event log: ${eventLogPath}`);
  });

  await idleLoop();
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
