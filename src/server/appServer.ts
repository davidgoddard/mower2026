import { createServer } from "node:http";
import { HidGameController } from "../controller/hidGameController.js";
import { ManualDriveCoordinator } from "../control/manualDriveCoordinator.js";
import { TurnController } from "../control/turnController.js";
import { TurnLearningModel } from "../control/turnLearningModel.js";
import { DriveController } from "../control/driveController.js";
import { DriveLearningModel } from "../control/driveLearningModel.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { SessionLogger } from "../logging/index.js";
import { SensorController } from "../sensing/sensorController.js";
import { SensorHardwareGateway, createPiSensorHardwareGateway } from "../sensing/sensorHardwareGateway.js";
import { StubSensorGateway } from "../sensing/stubSensorGateway.js";
import { renderHomePage } from "./homePage.js";
import { getTurnTuningPageHtml } from "./turnTuningPage.js";
import { getDriveTuningPageHtml } from "./driveTuningPage.js";
import { renderPathTracingPage } from "./pathTracingPage.js";
import { getManualDrivePageHtml } from "./manualDrivePage.js";
import { PrimitiveSnapshot, PrimitivesStore } from "./primitivesStore.js";
import { createRelativeAngle } from "../geometry/headingTypes.js";
import { createPosition } from "../geometry/positionTypes.js";
import { MAX_PORT_NUMBER } from "../constants.js";

interface StartMowerServerOptions {
  appName?: string;
  host?: string;
  port?: number;
  logDir?: string;
  sensorPollingIntervalMs?: number;
  i2cBusNumber?: number;
  gnssI2cAddress?: number;
  motorI2cAddress?: number;
  leftMotorForwardSign?: number;
  rightMotorForwardSign?: number;
  controllerEnabled?: boolean;
  controllerSteeringSign?: number;
  controllerSpeedSign?: number;
  manualDriveLoopMs?: number;
  maxWheelSpeedMetersPerSecond?: number;
}

export interface RunningMowerServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

export type AppState = "starting" | "running" | "stopping";

interface RouteResponse {
  statusCode: number;
  contentType: string;
  body: string;
  logNotFound: boolean;
}

function readRequestBody(request: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    request.on("data", (chunk: any) => chunks.push(chunk));
    request.on("end", () => {
      const buffer = Buffer.concat(chunks);
      resolve(buffer.toString("utf-8"));
    });
    request.on("error", reject);
  });
}

function isValidPort(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_PORT_NUMBER;
}

function encodeJson(payload: unknown): string {
  return JSON.stringify(payload);
}

export function routeServerRequest(
  method: string,
  pathname: string,
  state: AppState,
  appName: string,
  primitives: PrimitiveSnapshot,
  turnController: TurnController | null,
  driveController: DriveController | null,
  driveLearningModel: DriveLearningModel | null,
  poseFusion: PoseFusion | null,
): RouteResponse {
  if (method === "GET" && pathname === "/") {
    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: renderHomePage(),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/turn-tuning") {
    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: getTurnTuningPageHtml(),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/drive-tuning") {
    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: getDriveTuningPageHtml(),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/path-tracing") {
    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: renderPathTracingPage(),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/manual-drive") {
    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: getManualDrivePageHtml(),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/health") {
    return {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: encodeJson({
        ok: true,
        app: appName,
        state,
        timestamp: new Date().toISOString(),
      }),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/api/primitives") {
    return {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: encodeJson({
        state,
        primitives,
      }),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/api/turn/status") {
    if (!turnController) {
      return {
        statusCode: 503,
        contentType: "application/json; charset=utf-8",
        body: encodeJson({ error: "turn_controller_not_available" }),
        logNotFound: false,
      };
    }
    return {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: encodeJson({
        state: turnController.getState(),
        history: turnController.getTurnHistory(),
      }),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/api/drive/status") {
    if (!driveController || !driveLearningModel || !poseFusion) {
      return {
        statusCode: 503,
        contentType: "application/json; charset=utf-8",
        body: encodeJson({ error: "drive_controller_not_available" }),
        logNotFound: false,
      };
    }
    return {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: encodeJson({
        state: driveController.getState(),
        history: driveController.getDriveHistory(),
        parameters: {
          ...driveLearningModel.getParameters(),
          encoderMetersPerTick: poseFusion.getEncoderCalibration(),
        },
      }),
      logNotFound: false,
    };
  }

  return {
    statusCode: 404,
    contentType: "application/json; charset=utf-8",
    body: encodeJson({ error: "not_found" }),
    logNotFound: true,
  };
}

export async function startMowerServer(options: StartMowerServerOptions = {}): Promise<RunningMowerServer> {
  const appName = options.appName ?? "mower-core";
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8090;

  let state: AppState = "starting";
  const primitives = new PrimitivesStore();
  const logger = await SessionLogger.create({
    app: appName,
    context: "server",
    source: "CoreServer",
    logDir: options.logDir,
    minLevel: "info",
  });

  const requestLogger = logger.child({ context: "http", source: "HttpRouter" });
  let sensorGateway: SensorHardwareGateway | null = null;
  let sensorController: SensorController | null = null;
  let manualDriveCoordinator: ManualDriveCoordinator | null = null;
  let turnController: TurnController | null = null;
  let turnLearningModel: TurnLearningModel | null = null;
  let poseFusion: PoseFusion | null = null;
  let driveLearningModel: DriveLearningModel | null = null;
  let driveController: DriveController | null = null;
  logger.transition("boot", "starting", { port, host });

  const server = createServer(async (request: any, response: any) => {
    const method = request.method ?? "GET";
    const baseUrl = `http://${request.headers?.host ?? "localhost"}`;
    const requestUrl = new URL(request.url ?? "/", baseUrl);

    // Handle POST endpoints
    if (method === "POST") {
      try {
        const body = await readRequestBody(request);

        // Turn execution
        if (requestUrl.pathname === "/api/turn/execute" && turnController) {
          const data = JSON.parse(body);
          const result = await turnController.executeTurn({
            targetAngle: createRelativeAngle(data.angleDeg),
            direction: data.angleDeg >= 0 ? "ccw" : "cw",
            learningEnabled: data.enableLearning ?? true,
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(result));
          return;
        }

        // Turn tuning sequence
        if (requestUrl.pathname === "/api/turn/tune" && turnController) {
          const data = JSON.parse(body);
          const results = await turnController.runTuningSequence(data.iterations, data.anglesToTest);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Stop turn
        if (requestUrl.pathname === "/api/turn/stop" && turnController) {
          await turnController.stopCurrentTurn();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ stopped: true }));
          return;
        }

        // Clear history
        if (requestUrl.pathname === "/api/turn/clear-history" && turnController) {
          turnController.clearHistory();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ cleared: true }));
          return;
        }

        // Reset learning
        if (requestUrl.pathname === "/api/turn/reset-learning" && turnLearningModel) {
          await turnLearningModel.resetToDefaults();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ reset: true }));
          return;
        }

        // Drive execution
        if (requestUrl.pathname === "/api/drive/execute" && driveController) {
          const data = JSON.parse(body);
          const targetPosition = createPosition(data.targetX, data.targetY);
          const result = await driveController.executeDrive({
            targetPosition,
            learningEnabled: data.learningEnabled ?? true,
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(result));
          return;
        }

        // Drive test pattern
        if (requestUrl.pathname === "/api/drive/test-pattern" && driveController) {
          const results = await driveController.runTestPattern();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Stop drive
        if (requestUrl.pathname === "/api/drive/stop" && driveController) {
          await driveController.stopCurrentDrive();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ stopped: true }));
          return;
        }

        // Clear drive history
        if (requestUrl.pathname === "/api/drive/clear-history" && driveController) {
          driveController.clearHistory();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ cleared: true }));
          return;
        }

        // Reset drive learning
        if (requestUrl.pathname === "/api/drive/reset-learning" && driveLearningModel) {
          await driveLearningModel.resetToDefaults();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ reset: true }));
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(encodeJson({ error: message }));
        return;
      }
    }

    const routed = routeServerRequest(
      method,
      requestUrl.pathname,
      state,
      appName,
      primitives.snapshot(),
      turnController,
      driveController,
      driveLearningModel,
      poseFusion
    );

    if (routed.logNotFound) {
      requestLogger.warn("http.not_found", {
        method,
        path: requestUrl.pathname,
      });
    }

    if (routed.contentType.startsWith("application/json")) {
      response.writeHead(routed.statusCode, { "Content-Type": routed.contentType });
      response.end(routed.body);
      return;
    }

    response.writeHead(routed.statusCode, { "Content-Type": routed.contentType });
    response.end(routed.body);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await logger.close();
    throw error;
  }

  state = "running";
  const boundAddress = server.address();
  const boundPort = typeof boundAddress?.port === "number" ? boundAddress.port : port;

  try {
    sensorGateway = await createPiSensorHardwareGateway(
      options.i2cBusNumber ?? 1,
      {
        gnssAddress: options.gnssI2cAddress ?? 0x52,
        motorAddress: options.motorI2cAddress ?? 0x66,
        leftMotorForwardSign: options.leftMotorForwardSign ?? -1,
        rightMotorForwardSign: options.rightMotorForwardSign ?? -1,
      },
    );
    sensorController = new SensorController({
      logger,
      primitivesStore: primitives,
      gateway: sensorGateway,
      pollIntervalMs: options.sensorPollingIntervalMs ?? 33,
    });
    await sensorController.start();

    if (options.controllerEnabled ?? true) {
      const hidController = new HidGameController({
        steeringSign: options.controllerSteeringSign ?? -1,
        speedSign: options.controllerSpeedSign ?? 1,
      });
      manualDriveCoordinator = new ManualDriveCoordinator({
        logger,
        sensorController,
        hidController,
        controlIntervalMs: options.manualDriveLoopMs ?? 100,
        maxWheelSpeedMetersPerSecond: options.maxWheelSpeedMetersPerSecond ?? 0.75,
      });
      manualDriveCoordinator.start();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("sensors.start_failed", { error: message });
    logger.warn("sensors.using_stub", { reason: "Hardware initialization failed, using stub gateway" });

    // Use stub gateway when hardware fails so controllers can still be created
    sensorGateway = new StubSensorGateway();
    sensorController = new SensorController({
      logger,
      primitivesStore: primitives,
      gateway: sensorGateway,
      pollIntervalMs: options.sensorPollingIntervalMs ?? 33,
    });
    await sensorController.start();

    primitives.update({
      sensorController: {
        status: "error",
        pollIntervalMs: options.sensorPollingIntervalMs ?? 33,
        lastLoopDurationMs: null,
      },
      imu: {
        status: "error",
        error: message,
        headingDeg: null,
        pitchDeg: null,
        rollDeg: null,
      },
      gnss: {
        status: "error",
        error: message,
        xMeters: null,
        yMeters: null,
        headingDeg: null,
        positionAccuracyMeters: null,
        headingAccuracyDeg: null,
        fixType: "unknown",
        satellitesInUse: null,
        sampleAgeMillis: null,
      },
      motors: {
        status: "error",
        error: message,
        commandedLeftWheelSpeedMetersPerSecond: null,
        commandedRightWheelSpeedMetersPerSecond: null,
        leftWheelSpeedMetersPerSecond: null,
        rightWheelSpeedMetersPerSecond: null,
        leftRpm: null,
        rightRpm: null,
        leftEncoderDelta: null,
        rightEncoderDelta: null,
        leftPwmAppliedPercent: null,
        rightPwmAppliedPercent: null,
        leftMotorCurrentAmps: null,
        rightMotorCurrentAmps: null,
        watchdogHealthy: null,
        faultFlags: null,
      },
    });
  }

  // Initialize controllers (they work even with stub sensors)
  if (sensorController) {
    // Initialize turn controller
    turnLearningModel = new TurnLearningModel({ logger });
    await turnLearningModel.loadParameters();
    turnController = new TurnController({
      sensorController,
      logger,
      learningModel: turnLearningModel,
      maxWheelSpeedMetersPerSecond: options.maxWheelSpeedMetersPerSecond ?? 0.75,
    });

    // Initialize pose fusion
    poseFusion = new PoseFusion({
      sensorController,
      logger,
    });
    await poseFusion.start();

    // Initialize drive controller
    driveLearningModel = new DriveLearningModel({ logger });
    await driveLearningModel.loadParameters();
    driveController = new DriveController({
      sensorController,
      poseFusion,
      turnController,
      logger,
      learningModel: driveLearningModel,
    });
  }

  logger.transition("starting", "running", { port: boundPort, host });

  return {
    host,
    port: boundPort,
    async close(): Promise<void> {
      if (state === "stopping") {
        return;
      }

      state = "stopping";
      logger.transition("running", "stopping");

      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      await manualDriveCoordinator?.stop();
      await poseFusion?.stop();
      await sensorController?.stop();
      await sensorGateway?.close();
      await logger.flush();
      await logger.close();
    },
  };
}

export function resolveServerPort(portValue: string | undefined, fallbackPort: number): number {
  if (!isValidPort(portValue)) {
    return fallbackPort;
  }

  return Number(portValue);
}
