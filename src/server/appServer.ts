import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { HidGameController } from "../controller/hidGameController.js";
import { ManualDriveCoordinator } from "../control/manualDriveCoordinator.js";
import { TurnController } from "../control/turnController.js";
import { TurnLearningModel } from "../control/turnLearningModel.js";
import { TurnValidationRunner } from "../control/turnValidationRunner.js";
import { DriveController } from "../control/driveController.js";
import { DriveLineController } from "../control/driveLineController.js";
import { RunRecordWriter } from "../control/runRecord.js";
import type { DriveResult } from "../control/driveControllerTypes.js";
import { DriveLearningModel } from "../control/driveLearningModel.js";
import { SegmentTestRunner } from "../control/segmentTestRunner.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { SessionLogger } from "../logging/index.js";
import { SensorController } from "../sensing/sensorController.js";
import { systemStop } from "../control/systemStop.js";
import { SensorHardwareGateway, createPiSensorHardwareGateway } from "../sensing/sensorHardwareGateway.js";
import { StubSensorGateway } from "../sensing/stubSensorGateway.js";
import { MotorCalibration } from "../config/motorCalibration.js";
import { ImuCalibration } from "../config/imuCalibration.js";
import { PoseCalibration } from "../config/poseCalibration.js";
import { GeometryCalibration } from "../config/geometryCalibration.js";
import { PathFollowingConfig, DEFAULT_PATH_FOLLOWING_PARAMETERS } from "../config/pathFollowingConfig.js";
import { renderHomePage } from "./homePage.js";
import { getTurnTuningPageHtml } from "./turnTuningPage.js";
import { getDriveTuningPageHtml } from "./driveTuningPage.js";
import { getSegmentTestingPageHtml } from "./segmentTestingPage.js";
import { renderPathTracingPage } from "./pathTracingPage.js";
import { getManualDrivePageHtml } from "./manualDrivePage.js";
import { getDeadReckoningPageHtml } from "./deadReckoningPage.js";
import { SENSOR_WIDGETS_JS } from "./liveSensorWidgets.js";
import { DeadReckoningCalibrator } from "../control/deadReckoningCalibrator.js";
import { PrimitiveSnapshot, PrimitivesStore } from "./primitivesStore.js";
import { createRelativeAngle, headingDifference, unwrapInternalHeading, unwrapRelativeAngle } from "../geometry/headingTypes.js";
import { createPosition, unwrapMeters } from "../geometry/positionTypes.js";
import {
  MAX_PORT_NUMBER,
  MAX_WHEEL_OUTPUT_PERCENT_DEFAULT,
  SENSOR_CONTROLLER_POLL_INTERVAL_MS,
  ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE,
  ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE,
  WHEEL_BASE_METERS_MIN_PLAUSIBLE,
  WHEEL_BASE_METERS_MAX_PLAUSIBLE,
} from "../constants.js";
import { PathRecorder, PathStore, buildDrivePathPointsForDirection, buildMowingInitialEntryPlan, buildMowingPlan, buildPerimeterJoinPlan, buildPerimeterPathPointsFromPlan, buildVerificationApproachPlan, buildVerificationPathPointsFromPlan, executeSegmentedBoundaryPath, MowingExecutor } from "../pathfollowing/index.js";
import type { MowingStatus, PathPoint } from "../pathfollowing/index.js";
import { CheckpointStore, OperationContextTracker, RetryManager } from "../retry/index.js";
import type { ObstructionEvent } from "../retry/index.js";
import type { ObstructionDetectedEvent } from "../sensing/sensorEvents.js";

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
  maxWheelOutputPercent?: number;
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

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
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

/**
 * Validation-class error: a bad/missing/empty input from the operator. Maps
 * to HTTP 400 by the global POST error handler. Anything else thrown from a
 * route handler is treated as a server-side fault and returned as 500 with a
 * generic message — internal exception text is logged but not echoed.
 */
class BadRequestError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "BadRequestError";
  }
}

function describeDriveFailure(result: DriveResult): string {
  if (result.status === "stopped" && result.errorMessage === "Drive stopped by user request") {
    return "user_stopped";
  }

  return result.errorMessage ?? result.status;
}

/**
 * Write the path-action approach failure outcome with a status code that
 * matches the failure source: "stopped" is an operator-driven outcome (200);
 * any other non-success status is a server-side failure (500).
 */
function writeApproachOutcome(
  response: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void },
  mode: string,
  pathName: string,
  status: string,
  approachResult: Record<string, unknown>,
  failureReason?: string,
): void {
  const reason = failureReason ?? (status === "stopped" ? "user_stopped" : "error");
  const statusCode = status === "stopped" ? 200 : 500;
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(encodeJson({
    mode,
    pathName,
    completed: false,
    reason,
    phase: "approach",
    approachResult,
  }));
}

function getMissingRouteDependencyNames(dependencies: ReadonlyArray<readonly [string, unknown]>): string[] {
  return dependencies
    .filter(([, dependency]) => !dependency)
    .map(([name]) => name);
}

function getTurnAlignmentThresholdDeg(config: PathFollowingConfig | null): number {
  return config?.getParameters().turnAlignmentThresholdDeg
    ?? DEFAULT_PATH_FOLLOWING_PARAMETERS.turnAlignmentThresholdDeg;
}

const STOP_ACTION_PATHS = new Set([
  "/api/stop",
  "/api/turn/stop",
  "/api/drive/stop",
  "/api/path/stop",
  "/api/segment/stop",
  "/api/mowing/stop",
  "/api/dead-reckoning/stop",
]);

export function shouldClearSystemStopForPost(pathname: string): boolean {
  return !STOP_ACTION_PATHS.has(pathname);
}

export function routeServerRequest(
  method: string,
  pathname: string,
  state: AppState,
  appName: string,
  primitives: PrimitiveSnapshot,
  turnController: TurnController | null,
  turnValidationRunner: TurnValidationRunner | null,
  driveController: DriveController | null,
  driveLearningModel: DriveLearningModel | null,
  poseFusion: PoseFusion | null,
  motorCalibration: MotorCalibration | null,
  pathStore: PathStore | null,
  segmentTestRunner: SegmentTestRunner | null = null,
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

  if (method === "GET" && pathname === "/segment-testing") {
    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: getSegmentTestingPageHtml(),
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

  if (method === "GET" && pathname === "/dead-reckoning") {
    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: getDeadReckoningPageHtml(),
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
    const history = turnController.getTurnHistory().map(({ brakeDistanceUsed: _brakeDistanceUsed, ...result }) => result);
    return {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: encodeJson({
        state: turnController.getState(),
        history,
        parameters: turnController.getLearningParameters(),
        learningDiagnostics: turnController.getLearningDiagnostics(),
        realPoseHistory: turnValidationRunner?.getHistory() ?? [],
        realPoseValidation: turnValidationRunner?.getState() ?? null,
      }),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/api/drive/status") {
    if (!driveController || !driveLearningModel || !poseFusion || !motorCalibration) {
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
          motorRampDownTimeMs: motorCalibration.getRampDownTime(),
          motorRampUpTimeMs: motorCalibration.getRampUpTime(),
        },
      }),
      logNotFound: false,
    };
  }

  if (method === "GET" && pathname === "/api/segment/status") {
    if (!segmentTestRunner) {
      return {
        statusCode: 503,
        contentType: "application/json; charset=utf-8",
        body: encodeJson({ error: "segment_test_runner_not_available" }),
        logNotFound: false,
      };
    }
    return {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: encodeJson({
        state: segmentTestRunner.getState(),
        history: segmentTestRunner.getHistory(),
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
  systemStop.configureLogger(logger.child({ context: "control", source: "SystemStop" }));

  const requestLogger = logger.child({ context: "http", source: "HttpRouter" });
  let sensorGateway: SensorHardwareGateway | null = null;
  let sensorController: SensorController | null = null;
  let manualDriveCoordinator: ManualDriveCoordinator | null = null;
  let turnController: TurnController | null = null;
  let turnLearningModel: TurnLearningModel | null = null;
  let turnValidationRunner: TurnValidationRunner | null = null;
  let poseFusion: PoseFusion | null = null;
  let driveLearningModel: DriveLearningModel | null = null;
  let driveLineController: DriveLineController | null = null;
  let driveController: DriveController | null = null;
  let segmentTestRunner: SegmentTestRunner | null = null;
  let deadReckoningCalibrator: DeadReckoningCalibrator | null = null;
  let motorCalibration: MotorCalibration | null = null;
  let imuCalibration: ImuCalibration | null = null;
  let poseCalibration: PoseCalibration | null = null;
  let geometryCalibration: GeometryCalibration | null = null;
  let pathFollowingConfig: PathFollowingConfig | null = null;
  let pathStore: PathStore | null = null;
  let areaPerimeterStore: PathStore | null = null;
  let pathRecorder: PathRecorder | null = null;
  let areaPerimeterRecorder: PathRecorder | null = null;
  let mowingExecutor: MowingExecutor | null = null;
  let mowingStatus: MowingStatus = { phase: "idle", currentStripIndex: 0, totalStrips: 0, tracedBoundaryCount: 0 };
  let operationContextTracker: OperationContextTracker | null = null;
  let checkpointStore: CheckpointStore | null = null;
  let retryManager: RetryManager | null = null;
  logger.transition("boot", "starting", { port, host });

  pathStore = new PathStore({
    storageDirectory: "./paths",
    logger: logger.child({ context: "paths", source: "PathStore" }),
  });
  areaPerimeterStore = new PathStore({
    storageDirectory: "./area-perimeters",
    filenameSuffix: ".area.path.json",
    logger: logger.child({ context: "paths", source: "AreaPerimeterStore" }),
  });

  /**
   * Execute the segmented executor over a perimeter follow with full retry
   * wiring: registers the operation context, starts a retry session, clears
   * the recent-target trail, pushes a path checkpoint that retry can read on
   * a high-current obstruction, and lets the retry manager pull `pathRestart`
   * from its constructor-injected dependencies. The route handlers all funnel
   * through this so retry is uniform.
   */
  async function runSegmentedPerimeterFollow(
    boundaryPoints: PathPoint[],
    options: { reanchorToStartPose?: boolean } = {},
  ) {
    if (!driveController) {
      throw new Error("driveController_unavailable");
    }
    const sessionId = `path-${Date.now()}`;
    const recentTargetSink = retryManager ?? undefined;
    const pathFollowingParameters = pathFollowingConfig?.getParameters();

    operationContextTracker?.setContext("path");
    retryManager?.startSession(sessionId, "path");
    retryManager?.clearRecentTargets();

    if (poseFusion && checkpointStore) {
      checkpointStore.addCheckpoint({
        id: sessionId,
        timestamp: Date.now(),
        pose: poseFusion.getCurrentPose(),
        context: "path",
        metadata: {
          type: "path",
          waypoints: boundaryPoints,
        },
      });
    }

    try {
      return await executeSegmentedBoundaryPath(boundaryPoints, driveController, {
        parameters: pathFollowingParameters,
        learningEnabled: true,
        startPose: poseFusion?.getCurrentPose(),
        reanchorToStartPose: options.reanchorToStartPose ?? true,
        recentTargetSink,
      });
    } finally {
      retryManager?.endSession();
      operationContextTracker?.clearContext();
    }
  }

  async function requestEmergencyStop(reason: string): Promise<void> {
    systemStop.requestStop("api", reason);
    await sensorController?.emergencyStopMotors();

    const stopOperations: Promise<unknown>[] = [];

    turnValidationRunner?.stopCurrentValidation();
    mowingExecutor?.stop();
    segmentTestRunner?.stopCurrentTest();
    deadReckoningCalibrator?.requestStop();
    void retryManager?.endSession();
    operationContextTracker?.clearContext();

    if (turnController) {
      stopOperations.push(turnController.stopCurrentTurn());
    }
    if (driveController) {
      stopOperations.push(driveController.stopCurrentDrive());
    }

    await Promise.allSettled(stopOperations);
  }

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    const baseUrl = `http://${request.headers?.host ?? "localhost"}`;
    const requestUrl = new URL(request.url ?? "/", baseUrl);

    // Handle async GET endpoints
    if (method === "GET") {
      // Static web-component bundle — cached for 1 hour in the browser
      if (requestUrl.pathname === "/sensor-widgets.js") {
        response.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        });
        response.end(SENSOR_WIDGETS_JS);
        return;
      }

      // List all paths
      if (requestUrl.pathname === "/api/paths" && pathStore) {
        try {
          const pathNames = await pathStore.listPaths();
          const pathEntries = await Promise.all(
            pathNames.map(async (name) => {
              try {
                const path = await pathStore!.loadPath(name);
                return {
                  name: path.name,
                  pointCount: path.points.length,
                  totalDistance: path.metadata.totalDistance,
                  createdAt: path.createdAt,
                };
              } catch (error) {
                logger.warn("path_store.entry_skipped", {
                  name,
                  error: error instanceof Error ? error.message : String(error),
                });
                return null;
              }
            })
          );
          const paths = pathEntries.filter((path): path is NonNullable<typeof path> => path !== null);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ paths }));
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ error: message }));
          return;
        }
      }

      if (requestUrl.pathname === "/api/path/list" && pathStore) {
        try {
          const pathNames = await pathStore.listPaths();
          const pathEntries = await Promise.all(
            pathNames.map(async (name) => {
              try {
                const path = await pathStore!.loadPath(name);
                return {
                  name: path.name,
                  pointCount: path.points.length,
                  totalDistance: path.metadata.totalDistance,
                  createdAt: path.createdAt,
                };
              } catch (error) {
                logger.warn("path_store.entry_skipped", {
                  name,
                  error: error instanceof Error ? error.message : String(error),
                });
                return null;
              }
            })
          );
          const paths = pathEntries.filter((path): path is NonNullable<typeof path> => path !== null);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(paths));
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ error: message }));
          return;
        }
      }

      if ((requestUrl.pathname === "/api/area-perimeters" || requestUrl.pathname === "/api/area-perimeter/list") && areaPerimeterStore) {
        try {
          const pathNames = await areaPerimeterStore.listPaths();
          const pathEntries = await Promise.all(
            pathNames.map(async (name) => {
              try {
                const path = await areaPerimeterStore!.loadPath(name);
                return {
                  name: path.name,
                  pointCount: path.points.length,
                  totalDistance: path.metadata.totalDistance,
                  createdAt: path.createdAt,
                };
              } catch (error) {
                logger.warn("area_perimeter_store.entry_skipped", {
                  name,
                  error: error instanceof Error ? error.message : String(error),
                });
                return null;
              }
            })
          );
          const paths = pathEntries.filter((path): path is NonNullable<typeof path> => path !== null);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(requestUrl.pathname === "/api/area-perimeters" ? { paths } : paths));
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ error: message }));
          return;
        }
      }

      // Load specific path with all points
      const pathLoadMatch = requestUrl.pathname.match(/^\/api\/paths\/([^\/]+)$/);
      if (pathLoadMatch && pathStore) {
        try {
          const pathName = decodeURIComponent(pathLoadMatch[1]);
          const path = await pathStore.loadPath(pathName);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(path));
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ error: message }));
          return;
        }
      }

      if (requestUrl.pathname === "/api/path/record/status" && pathRecorder) {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(encodeJson({
          recording: pathRecorder.isRecording(),
          pointCount: pathRecorder.getPointCount(),
        }));
        return;
      }

      if (requestUrl.pathname === "/api/area-perimeter/record/status" && areaPerimeterRecorder) {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(encodeJson({
          recording: areaPerimeterRecorder.isRecording(),
          pointCount: areaPerimeterRecorder.getPointCount(),
        }));
        return;
      }

      if (requestUrl.pathname === "/api/mowing/status") {
        const status = mowingExecutor ? mowingExecutor.getStatus() : mowingStatus;
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(encodeJson(status));
        return;
      }

      if (requestUrl.pathname === "/api/dead-reckoning/status") {
        const drState = deadReckoningCalibrator
          ? deadReckoningCalibrator.getState()
          : { running: false, phase: "idle", phaseMessage: "Calibrator not available.", gnssWarning: null, result: null, lastUpdated: null };
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(encodeJson(drState));
        return;
      }

      const areaPerimeterLoadMatch = requestUrl.pathname.match(/^\/api\/area-perimeters\/([^\/]+)$/);
      if (areaPerimeterLoadMatch && areaPerimeterStore) {
        try {
          const pathName = decodeURIComponent(areaPerimeterLoadMatch[1]);
          const path = await areaPerimeterStore.loadPath(pathName);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(path));
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ error: message }));
          return;
        }
      }
    }

    // Handle POST endpoints
    if (method === "POST") {
      try {
        if (shouldClearSystemStopForPost(requestUrl.pathname)) {
          systemStop.clearStop(`post:${requestUrl.pathname}`);
        }

        const body = await readRequestBody(request);

        if (requestUrl.pathname === "/api/stop") {
          await requestEmergencyStop("emergency_stop");
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ stopped: true }));
          return;
        }

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

        // Large-angle turn training sequence
        if (requestUrl.pathname === "/api/turn/train-large" && turnController) {
          const data = JSON.parse(body);
          const results = await turnController.runLargeAngleTraining(data.iterations, undefined, data.startAngleDeg);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Small-angle turn training sequence
        if (requestUrl.pathname === "/api/turn/train-small" && turnController) {
          const data = JSON.parse(body);
          const results = await turnController.runSmallAngleTraining(data.targetErrorDeg, undefined, data.startAngleDeg);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Real-pose turn validation sweep
        if (requestUrl.pathname === "/api/turn/train-real-pose" && turnValidationRunner) {
          const data = JSON.parse(body);
          const results = await turnValidationRunner.run(data.iterations ?? 20);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Stop turn (operator-initiated stop button → emergency disable)
        if (requestUrl.pathname === "/api/turn/stop" && turnController) {
          await requestEmergencyStop("turn_stop");
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

        // Path recording start
        if (requestUrl.pathname === "/api/path/record/start" && pathRecorder) {
          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new BadRequestError("path_name_required");
          }
          if (pathRecorder.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_already_recording" }));
            return;
          }
          if (areaPerimeterRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "area_perimeter_recording_active" }));
            return;
          }

          pathRecorder.startRecording(pathName);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            recording: true,
            pathName,
            pointCount: pathRecorder.getPointCount(),
          }));
          return;
        }

        // Delete stored path
        if (requestUrl.pathname === "/api/path/delete" && pathStore) {
          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new BadRequestError("path_name_required");
          }

          await pathStore.deletePath(pathName);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ deleted: true, pathName }));
          return;
        }

        if (requestUrl.pathname === "/api/area-perimeter/record/start" && areaPerimeterRecorder) {
          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new BadRequestError("path_name_required");
          }
          if (pathRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_recording_active" }));
            return;
          }
          if (areaPerimeterRecorder.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "area_perimeter_already_recording" }));
            return;
          }

          areaPerimeterRecorder.startRecording(pathName);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            recording: true,
            pathName,
            pointCount: areaPerimeterRecorder.getPointCount(),
          }));
          return;
        }

        if (requestUrl.pathname === "/api/area-perimeter/delete" && areaPerimeterStore) {
          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new BadRequestError("path_name_required");
          }

          await areaPerimeterStore.deletePath(pathName);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ deleted: true, pathName }));
          return;
        }

        // Path recording stop/save
        if (requestUrl.pathname === "/api/path/record/stop" && pathRecorder) {
          if (!pathRecorder.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "not_recording" }));
            return;
          }

          const savedPath = await pathRecorder.stopAndSave();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            ...savedPath,
            pointCount: savedPath.metadata.pointCount,
          }));
          return;
        }

        // Path recording cancel
        if (requestUrl.pathname === "/api/path/record/cancel" && pathRecorder) {
          if (!pathRecorder.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "not_recording" }));
            return;
          }

          pathRecorder.cancel();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ cancelled: true }));
          return;
        }

        // Path recording status
        if (requestUrl.pathname === "/api/path/record/status" && pathRecorder) {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            recording: pathRecorder.isRecording(),
            pointCount: pathRecorder.getPointCount(),
          }));
          return;
        }

        if (requestUrl.pathname === "/api/area-perimeter/record/stop" && areaPerimeterRecorder) {
          if (!areaPerimeterRecorder.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "not_recording" }));
            return;
          }

          const savedPath = await areaPerimeterRecorder.stopAndSave();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            ...savedPath,
            pointCount: savedPath.metadata.pointCount,
          }));
          return;
        }

        if (requestUrl.pathname === "/api/area-perimeter/record/cancel" && areaPerimeterRecorder) {
          if (!areaPerimeterRecorder.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "not_recording" }));
            return;
          }

          areaPerimeterRecorder.cancel();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ cancelled: true }));
          return;
        }

        if (requestUrl.pathname === "/api/area-perimeter/record/status" && areaPerimeterRecorder) {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            recording: areaPerimeterRecorder.isRecording(),
            pointCount: areaPerimeterRecorder.getPointCount(),
          }));
          return;
        }

        // Drive stored path by staging to the outer edge of the join point and then
        // following the stored path in the chosen direction.
        if (requestUrl.pathname === "/api/path/drive") {
          if (!driveController || !turnController || !pathStore || !poseFusion) {
            response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({
              error: "path_drive_not_available",
              missing: getMissingRouteDependencyNames([
                ["driveController", driveController],
                ["turnController", turnController],
                ["pathStore", pathStore],
                ["poseFusion", poseFusion],
              ]),
            }));
            return;
          }

          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new BadRequestError("path_name_required");
          }
          if (pathRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_recording_active" }));
            return;
          }
          if (areaPerimeterRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "area_perimeter_recording_active" }));
            return;
          }

          const path = await pathStore.loadPath(pathName);
          if (path.points.length === 0) {
            throw new BadRequestError("path_empty");
          }

          systemStop.clearStop("api-path-drive");
          const currentPose = poseFusion.getCurrentPose();
          const pathFollowingParameters = pathFollowingConfig?.getParameters();
          const approachPlan = buildVerificationApproachPlan(path.points, currentPose, pathFollowingParameters);
          if (approachPlan === null) {
            throw new BadRequestError("path_too_short_for_drive");
          }

          let approachResult: Record<string, unknown>;
          if (approachPlan.turnOnly) {
            const turnAngle = headingDifference(currentPose.heading, approachPlan.tangentHeading);
            const turnResult = await turnController.executeTurn({
              targetAngle: turnAngle,
              direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
              learningEnabled: true,
            });
            approachResult = {
              phase: "turn_only",
              tangentHeadingDeg: approachPlan.tangentHeading,
              turnResult,
            };

            if (turnResult.status !== "success") {
              writeApproachOutcome(response, "drive", pathName, turnResult.status, approachResult);
              return;
            }
          } else {
            const driveResult = await driveController.executeDrive({
              targetPosition: createPosition(approachPlan.approachTarget.xMeters, approachPlan.approachTarget.yMeters),
              learningEnabled: true,
            });
            approachResult = {
              phase: "outer_edge_drive",
              joinPoint: approachPlan.joinPoint,
              tangentHeadingDeg: approachPlan.tangentHeading,
              approachTarget: approachPlan.approachTarget,
              driveResult,
            };

            if (driveResult.status !== "success") {
              writeApproachOutcome(response, "drive", pathName, driveResult.status, approachResult, describeDriveFailure(driveResult));
              return;
            }

            const poseAfterDrive = poseFusion.getCurrentPose();
            const turnAngle = headingDifference(poseAfterDrive.heading, approachPlan.tangentHeading);
            if (Math.abs(unwrapRelativeAngle(turnAngle)) > getTurnAlignmentThresholdDeg(pathFollowingConfig)) {
              const turnResult = await turnController.executeTurn({
                targetAngle: turnAngle,
                direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
                learningEnabled: true,
              });
              approachResult = {
                ...approachResult,
                phase: "turn_to_join",
                turnResult,
              };

              if (turnResult.status !== "success") {
                writeApproachOutcome(response, "drive", pathName, turnResult.status, approachResult);
                return;
              }
            }
          }

          const drivePoints = buildDrivePathPointsForDirection(
            path.points,
            poseFusion.getCurrentPose(),
            approachPlan.pathDirection,
            pathFollowingParameters,
          );
          if (drivePoints.length < 2) {
            throw new BadRequestError("path_too_short_for_drive");
          }

          const followResult = await runSegmentedPerimeterFollow(drivePoints);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            mode: "drive",
            pathName,
            phase: "follow",
            approachResult,
            ...followResult,
          }));
          return;
        }

        if (requestUrl.pathname === "/api/area-perimeter/drive") {
          if (!driveController || !areaPerimeterStore || !poseFusion) {
            response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({
              error: "area_perimeter_drive_not_available",
              missing: getMissingRouteDependencyNames([
                ["driveController", driveController],
                ["areaPerimeterStore", areaPerimeterStore],
                ["poseFusion", poseFusion],
              ]),
            }));
            return;
          }

          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new BadRequestError("path_name_required");
          }
          if (pathRecorder?.isRecording() || areaPerimeterRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_recording_active" }));
            return;
          }

          const path = await areaPerimeterStore.loadPath(pathName);
          if (path.points.length === 0) {
            throw new BadRequestError("path_empty");
          }

          const pathFollowingParameters = pathFollowingConfig?.getParameters();
          const currentPose = poseFusion.getCurrentPose();
          const joinPlan = buildPerimeterJoinPlan(path.points, currentPose, pathFollowingParameters);
          if (joinPlan === null) {
            throw new BadRequestError("path_too_short_for_drive");
          }

          const drivePoints = buildPerimeterPathPointsFromPlan(path.points, joinPlan, pathFollowingParameters);
          if (drivePoints.length < 2) {
            throw new BadRequestError("path_too_short_for_drive");
          }

          systemStop.clearStop("api-area-perimeter-drive");
          const result = await runSegmentedPerimeterFollow(drivePoints);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            mode: "area_perimeter_drive",
            pathName,
            phase: "follow",
            joinPlan,
            ...result,
          }));
          return;
        }

        // Verify stored path using an outer-edge approach to the nearest join point,
        // then a full loop back to it.
        if (requestUrl.pathname === "/api/path/verify") {
          if (!driveController || !turnController || !pathStore || !poseFusion) {
            response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({
              error: "path_verification_not_available",
              missing: getMissingRouteDependencyNames([
                ["driveController", driveController],
                ["turnController", turnController],
                ["pathStore", pathStore],
                ["poseFusion", poseFusion],
              ]),
            }));
            return;
          }

          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new BadRequestError("path_name_required");
          }
          if (pathRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_recording_active" }));
            return;
          }
          if (areaPerimeterRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "area_perimeter_recording_active" }));
            return;
          }

          const path = await pathStore.loadPath(pathName);
          if (path.points.length === 0) {
            throw new BadRequestError("path_empty");
          }

          systemStop.clearStop("api-path-verify");
          const currentPose = poseFusion.getCurrentPose();
          const pathFollowingParameters = pathFollowingConfig?.getParameters();
          const approachPlan = buildVerificationApproachPlan(path.points, currentPose, pathFollowingParameters);
          if (approachPlan === null) {
            throw new BadRequestError("path_too_short_for_verification");
          }

          let approachResult: Record<string, unknown>;
          if (approachPlan.turnOnly) {
            const turnAngle = headingDifference(currentPose.heading, approachPlan.tangentHeading);
            const turnResult = await turnController.executeTurn({
              targetAngle: turnAngle,
              direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
              learningEnabled: true,
            });
            approachResult = {
              phase: "turn_only",
              tangentHeadingDeg: approachPlan.tangentHeading,
              turnResult,
            };

            if (turnResult.status !== "success") {
              writeApproachOutcome(response, "verify", pathName, turnResult.status, approachResult);
              return;
            }
          } else {
            const driveResult = await driveController.executeDrive({
              targetPosition: createPosition(approachPlan.approachTarget.xMeters, approachPlan.approachTarget.yMeters),
              learningEnabled: true,
            });
            approachResult = {
              phase: "tangent_drive",
              joinPoint: approachPlan.joinPoint,
              tangentHeadingDeg: approachPlan.tangentHeading,
              approachTarget: approachPlan.approachTarget,
              driveResult,
            };

            if (driveResult.status !== "success") {
              writeApproachOutcome(response, "verify", pathName, driveResult.status, approachResult, describeDriveFailure(driveResult));
              return;
            }

            const poseAfterDrive = poseFusion.getCurrentPose();
            const turnAngle = headingDifference(poseAfterDrive.heading, approachPlan.tangentHeading);
            if (Math.abs(unwrapRelativeAngle(turnAngle)) > getTurnAlignmentThresholdDeg(pathFollowingConfig)) {
              const turnResult = await turnController.executeTurn({
                targetAngle: turnAngle,
                direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
                learningEnabled: true,
              });
              approachResult = {
                ...approachResult,
                phase: "turn_to_join",
                turnResult,
              };

              if (turnResult.status !== "success") {
                writeApproachOutcome(response, "verify", pathName, turnResult.status, approachResult);
                return;
              }
            }
          }

          const verificationPoints = buildVerificationPathPointsFromPlan(
            path.points,
            poseFusion.getCurrentPose(),
            approachPlan,
            pathFollowingParameters,
          );
          if (verificationPoints.length < 2) {
            throw new BadRequestError("path_too_short_for_verification");
          }

          const result = await runSegmentedPerimeterFollow(verificationPoints, { reanchorToStartPose: false });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            mode: "verify",
            pathName,
            phase: "follow",
            approachResult,
            ...result,
          }));
          return;
        }

        if (requestUrl.pathname === "/api/area-perimeter/verify") {
          if (!driveController || !turnController || !areaPerimeterStore || !poseFusion) {
            response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({
              error: "area_perimeter_verification_not_available",
              missing: getMissingRouteDependencyNames([
                ["driveController", driveController],
                ["turnController", turnController],
                ["areaPerimeterStore", areaPerimeterStore],
                ["poseFusion", poseFusion],
              ]),
            }));
            return;
          }

          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new BadRequestError("path_name_required");
          }
          if (pathRecorder?.isRecording() || areaPerimeterRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_recording_active" }));
            return;
          }

          const path = await areaPerimeterStore.loadPath(pathName);
          if (path.points.length === 0) {
            throw new BadRequestError("path_empty");
          }

          systemStop.clearStop("api-area-perimeter-verify");
          const currentPose = poseFusion.getCurrentPose();
          const pathFollowingParameters = pathFollowingConfig?.getParameters();
          const joinPlan = buildPerimeterJoinPlan(path.points, currentPose, pathFollowingParameters);
          if (joinPlan === null) {
            throw new BadRequestError("path_too_short_for_verification");
          }

          let approachResult: Record<string, unknown> = {
            phase: "already_at_join",
            joinPoint: joinPlan.joinPoint,
            tangentHeadingDeg: joinPlan.tangentHeading,
          };
          if (!joinPlan.turnOnly) {
            const driveResult = await driveController.executeDrive({
              targetPosition: createPosition(joinPlan.approachTarget.xMeters, joinPlan.approachTarget.yMeters),
              learningEnabled: true,
            });
            approachResult = {
              phase: "nearest_perimeter_drive",
              joinPoint: joinPlan.joinPoint,
              tangentHeadingDeg: joinPlan.tangentHeading,
              approachTarget: joinPlan.approachTarget,
              driveResult,
            };

            if (driveResult.status !== "success") {
              writeApproachOutcome(response, "area_perimeter_verify", pathName, driveResult.status, approachResult, describeDriveFailure(driveResult));
              return;
            }
          }

          const poseBeforeFollow = poseFusion.getCurrentPose();
          const turnAngle = headingDifference(poseBeforeFollow.heading, joinPlan.tangentHeading);
          if (Math.abs(unwrapRelativeAngle(turnAngle)) > getTurnAlignmentThresholdDeg(pathFollowingConfig)) {
            const turnResult = await turnController.executeTurn({
              targetAngle: turnAngle,
              direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
              learningEnabled: true,
            });
            approachResult = {
              ...approachResult,
              phase: "turn_to_join",
              turnResult,
            };

            if (turnResult.status !== "success") {
              writeApproachOutcome(response, "area_perimeter_verify", pathName, turnResult.status, approachResult);
              return;
            }
          }

          const perimeterPoints = buildPerimeterPathPointsFromPlan(path.points, joinPlan, pathFollowingParameters);
          if (perimeterPoints.length < 2) {
            throw new BadRequestError("path_too_short_for_verification");
          }

          const result = await runSegmentedPerimeterFollow(perimeterPoints);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            mode: "area_perimeter_verify",
            pathName,
            phase: "follow",
            approachResult,
            ...result,
          }));
          return;
        }

        // Start mowing an area
        if (requestUrl.pathname === "/api/mowing/start" && areaPerimeterStore && pathStore && driveController && turnController && poseFusion) {
          const data = JSON.parse(body);
          const areaName = typeof data.areaName === "string" ? data.areaName.trim() : "";
          const headingDeg = Number(data.headingDeg);
          const stripSpacingMeters = data.stripSpacingMeters === undefined ? undefined : Number(data.stripSpacingMeters);
          if (areaName.length === 0) {
            throw new BadRequestError("area_name_required");
          }
          if (!Number.isFinite(headingDeg)) {
            throw new BadRequestError("heading_required");
          }
          if (mowingExecutor && mowingStatus.phase !== "idle" && mowingStatus.phase !== "complete" && mowingStatus.phase !== "stopped" && mowingStatus.phase !== "error") {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "mowing_already_active" }));
            return;
          }
          if (pathRecorder?.isRecording() || areaPerimeterRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_recording_active" }));
            return;
          }

          const area = await areaPerimeterStore.loadPath(areaName);
          const obstacleNames = await pathStore.listPaths();
          const obstaclePointsArray = await Promise.all(obstacleNames.map(async (name) => {
            const obs = await pathStore!.loadPath(name);
            return obs.points;
          }));
          const pathFollowingParameters = pathFollowingConfig?.getParameters();
          const currentPose = poseFusion.getCurrentPose();
          const initialEntryPlan = buildMowingInitialEntryPlan(area.points, {
            xMeters: unwrapMeters(currentPose.position.xMeters),
            yMeters: unwrapMeters(currentPose.position.yMeters),
          }, {
            mowingStandoffMeters: pathFollowingParameters?.mowingStandoffMeters,
            obstacles: obstaclePointsArray,
          });
          if (!initialEntryPlan) {
            throw new BadRequestError("no_line_of_sight_area_entry");
          }
          const plan = buildMowingPlan(area.points, {
            headingDeg,
            stripSpacingMeters,
            bladeWidthMeters: 0.4,
            mowingStandoffMeters: pathFollowingParameters?.mowingStandoffMeters,
            preferredStartPoint: initialEntryPlan.entryPoint,
            obstacles: obstaclePointsArray,
          });

          if (plan.strips.length === 0) {
            throw new BadRequestError("no_strips_generated");
          }

          systemStop.clearStop("api-mowing-start");
          mowingExecutor = new MowingExecutor({
            plan,
            initialEntryPlan,
            areaPoints: area.points,
            obstaclePointsArray,
            driveController,
            turnController,
            poseFusion,
            logger: logger.child({ context: "mowing", source: "MowingExecutor" }),
            parameters: pathFollowingParameters,
            recentTargetSink: retryManager ?? undefined,
          });
          mowingStatus = mowingExecutor.getStatus();

          // Wrap the mowing run with retry-session lifecycle so any path-context
          // obstruction during a perimeter trace or connector follow can be
          // recovered. The session covers the whole mow; recent-target trail is
          // cleared at start.
          const mowingSessionId = `mowing-${Date.now()}`;
          operationContextTracker?.setContext("path");
          retryManager?.startSession(mowingSessionId, "path");
          retryManager?.clearRecentTargets();

          // Run in background; update shared status when done
          mowingExecutor.execute().then((finalStatus) => {
            mowingStatus = finalStatus;
          }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            mowingStatus = { phase: "error", currentStripIndex: 0, totalStrips: plan.strips.length, tracedBoundaryCount: 0, error: message };
          }).finally(() => {
            retryManager?.endSession();
            operationContextTracker?.clearContext();
          });

          mowingStatus = mowingExecutor.getStatus();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            started: true,
            areaName,
            stripCount: plan.strips.length,
            initialEntry: {
              xMeters: initialEntryPlan.entryPoint.xMeters,
              yMeters: initialEntryPlan.entryPoint.yMeters,
              approachX: initialEntryPlan.approachTarget.xMeters,
              approachY: initialEntryPlan.approachTarget.yMeters,
            },
          }));
          return;
        }

        // Stop active mowing (operator-initiated stop button → emergency disable)
        if (requestUrl.pathname === "/api/mowing/stop") {
          await requestEmergencyStop("mowing_stop");
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ stopped: true }));
          return;
        }

        if (requestUrl.pathname === "/api/mowing-plan/preview" && areaPerimeterStore && pathStore) {
          const data = JSON.parse(body);
          const areaName = typeof data.areaName === "string" ? data.areaName.trim() : "";
          const headingDeg = Number(data.headingDeg);
          const stripSpacingMeters = data.stripSpacingMeters === undefined ? undefined : Number(data.stripSpacingMeters);
          if (areaName.length === 0) {
            throw new BadRequestError("area_name_required");
          }
          if (!Number.isFinite(headingDeg)) {
            throw new BadRequestError("heading_required");
          }

          const area = await areaPerimeterStore.loadPath(areaName);
          const obstacleNames = await pathStore.listPaths();
          const obstacles = await Promise.all(obstacleNames.map(async (obstacleName) => {
            const obstacle = await pathStore!.loadPath(obstacleName);
            return obstacle.points;
          }));
          const pathFollowingParameters = pathFollowingConfig?.getParameters();
          const plan = buildMowingPlan(area.points, {
            headingDeg,
            stripSpacingMeters,
            bladeWidthMeters: 0.4,
            mowingStandoffMeters: pathFollowingParameters?.mowingStandoffMeters,
            obstacles,
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({
            areaName,
            ...plan,
          }));
          return;
        }

        // Stop active path following (operator-initiated stop button → emergency disable)
        if (requestUrl.pathname === "/api/path/stop") {
          await requestEmergencyStop("path_stop_requested");
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ stopped: true }));
          return;
        }

        // Segment test run — fire-and-forget; the page polls /api/segment/status
        if (requestUrl.pathname === "/api/segment/start" && segmentTestRunner) {
          if (segmentTestRunner.getState().running) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "segment_test_already_running" }));
            return;
          }
          const data = body.trim().length > 0 ? JSON.parse(body) : {};
          systemStop.clearStop("api-segment-start");
          segmentTestRunner.run({
            waypointCount: data.waypointCount,
            testRunCount: data.testRunCount,
          }).catch((err) => {
            logger.warn("segment_test.run_error", { error: err instanceof Error ? err.message : String(err) });
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ started: true }));
          return;
        }

        // Stop segment test (operator-initiated stop button → emergency disable)
        if (requestUrl.pathname === "/api/segment/stop" && segmentTestRunner) {
          await requestEmergencyStop("segment_stop");
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ stopped: true }));
          return;
        }

        // Start dead-reckoning calibration
        if (requestUrl.pathname === "/api/dead-reckoning/start" && deadReckoningCalibrator) {
          if (deadReckoningCalibrator.getState().running) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "dead_reckoning_already_running" }));
            return;
          }
          const data = body.trim().length > 0 ? JSON.parse(body) : {};
          const lineDistanceMeters = typeof data.lineDistanceMeters === "number" ? data.lineDistanceMeters : undefined;
          const arcSweepDegrees = typeof data.arcSweepDegrees === "number" ? data.arcSweepDegrees : undefined;
          systemStop.clearStop("dead-reckoning-run");
          // Fire-and-forget — the status endpoint is polled separately
          deadReckoningCalibrator.run({ lineDistanceMeters, arcSweepDegrees }).catch((err) => {
            logger.warn("dead_reckoning.run_error", { error: err instanceof Error ? err.message : String(err) });
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ started: true }));
          return;
        }

        if (requestUrl.pathname === "/api/dead-reckoning/start" && !deadReckoningCalibrator) {
          response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ error: "dead_reckoning_calibrator_not_available" }));
          return;
        }

        // Stop dead-reckoning calibration (operator-initiated stop button → emergency disable)
        if (requestUrl.pathname === "/api/dead-reckoning/stop" && deadReckoningCalibrator) {
          await requestEmergencyStop("dead_reckoning_stop");
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ stopped: true }));
          return;
        }

        // Apply suggested dead-reckoning calibration (per-wheel or shared scalar)
        if (requestUrl.pathname === "/api/dead-reckoning/apply" && poseFusion && poseCalibration) {
          const data = JSON.parse(body);
          const leftMPT   = typeof data.leftMetersPerTick   === "number" ? data.leftMetersPerTick   : null;
          const rightMPT  = typeof data.rightMetersPerTick  === "number" ? data.rightMetersPerTick  : null;
          const wheelbase = typeof data.wheelbaseMeters     === "number" ? data.wheelbaseMeters     : null;
          const sharedMPT = typeof data.encoderMetersPerTick === "number" ? data.encoderMetersPerTick : null;

          const leftMptPlausible = leftMPT !== null &&
            leftMPT >= ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE &&
            leftMPT <= ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE;
          const rightMptPlausible = rightMPT !== null &&
            rightMPT >= ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE &&
            rightMPT <= ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE;
          const wheelbasePlausible = wheelbase !== null &&
            wheelbase >= WHEEL_BASE_METERS_MIN_PLAUSIBLE &&
            wheelbase <= WHEEL_BASE_METERS_MAX_PLAUSIBLE;
          const sharedMptPlausible = sharedMPT !== null &&
            sharedMPT >= ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE &&
            sharedMPT <= ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE;

          if (leftMptPlausible && rightMptPlausible && wheelbasePlausible) {
            await poseFusion.setPerWheelCalibration(leftMPT, rightMPT, wheelbase);
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({
              applied: true,
              leftMetersPerTick: leftMPT,
              rightMetersPerTick: rightMPT,
              wheelbaseMeters: wheelbase,
              encoderMetersPerTick: (leftMPT + rightMPT) / 2,
            }));
          } else if (sharedMptPlausible) {
            await poseFusion.setEncoderCalibration(sharedMPT);
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ applied: true, encoderMetersPerTick: sharedMPT }));
          } else {
            response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "invalid_calibration_values" }));
          }
          return;
        }

        // Drive test pattern — fire-and-forget; the page polls /api/drive/status
        if (requestUrl.pathname === "/api/drive/test-pattern" && driveController) {
          systemStop.clearStop("api-drive-test-pattern");
          driveController.runTestPattern().catch((err) => {
            logger.warn("drive.test_pattern.run_error", { error: err instanceof Error ? err.message : String(err) });
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ started: true }));
          return;
        }

        // Short-distance drive training
        if (requestUrl.pathname === "/api/drive/train-short" && driveController) {
          const data = JSON.parse(body);
          systemStop.clearStop("api-drive-train-short");
          const results = await driveController.runShortDistanceTraining({
            targetXErrorMeters: data.targetXErrorMeters,
            targetYErrorMeters: data.targetYErrorMeters,
            includeReverseLegs: data.includeReverseLegs ?? true,
            startDistanceMeters: data.startDistanceMeters,
            maxDistanceMeters: data.maxDistanceMeters,
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        if (requestUrl.pathname === "/api/drive/train-long-bias" && driveController) {
          const data = JSON.parse(body);
          systemStop.clearStop("api-drive-train-long-bias");
          const results = await driveController.runLongHeadingTraining({
            stage: "bias",
            targetXErrorMeters: data.targetXErrorMeters,
            targetYErrorMeters: data.targetYErrorMeters,
            includeReverseLegs: data.includeReverseLegs ?? true,
            startDistanceMeters: data.startDistanceMeters,
            maxDistanceMeters: data.maxDistanceMeters,
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        if (requestUrl.pathname === "/api/drive/train-long-gain" && driveController) {
          const data = JSON.parse(body);
          systemStop.clearStop("api-drive-train-long-gain");
          const results = await driveController.runLongHeadingTraining({
            stage: "gain",
            targetXErrorMeters: data.targetXErrorMeters,
            targetYErrorMeters: data.targetYErrorMeters,
            includeReverseLegs: data.includeReverseLegs ?? true,
            startDistanceMeters: data.startDistanceMeters,
            maxDistanceMeters: data.maxDistanceMeters,
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Segment-drive training
        if (requestUrl.pathname === "/api/drive/train-segment" && driveController) {
          const data = JSON.parse(body);
          systemStop.clearStop("api-drive-train-segment");
          const results = await driveController.runSegmentTraining({
            targetXErrorMeters: data.targetXErrorMeters,
            targetYErrorMeters: data.targetYErrorMeters,
            includeReverseLegs: data.includeReverseLegs ?? true,
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Stop drive (operator-initiated stop button → emergency disable)
        if (requestUrl.pathname === "/api/drive/stop" && driveController) {
          await requestEmergencyStop("drive_stop");
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
        if (error instanceof BadRequestError) {
          response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ error: error.code }));
          return;
        }
        if (error instanceof SyntaxError) {
          requestLogger.warn("http.invalid_json_body", {
            method,
            path: requestUrl.pathname,
            error: error.message,
          });
          response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ error: "invalid_json_body" }));
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        requestLogger.error("http.internal_error", {
          method,
          path: requestUrl.pathname,
          error: message,
        });
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(encodeJson({ error: "internal_error" }));
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
      turnValidationRunner,
      driveController,
      driveLearningModel,
      poseFusion,
      motorCalibration,
      pathStore,
      segmentTestRunner
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
  const boundPort = boundAddress !== null && typeof boundAddress === "object"
    ? boundAddress.port
    : port;

  try {
    motorCalibration = new MotorCalibration({ logger });
    await motorCalibration.loadParameters();

    imuCalibration = new ImuCalibration({
      logger,
      parametersPath: process.env.MOWER_IMU_YAW_CALIBRATION_PATH,
    });
    await imuCalibration.loadParameters();

    poseCalibration = new PoseCalibration({ logger });
    await poseCalibration.loadParameters();

    geometryCalibration = new GeometryCalibration({ logger });
    await geometryCalibration.loadParameters();

    pathFollowingConfig = new PathFollowingConfig({
      logger,
      parametersPath: process.env.MOWER_PATH_FOLLOWING_PARAMETERS_PATH,
    });
    await pathFollowingConfig.loadParameters();

    sensorGateway = await createPiSensorHardwareGateway(
      options.i2cBusNumber ?? 1,
      {
        gnssAddress: options.gnssI2cAddress ?? 0x52,
        motorAddress: options.motorI2cAddress ?? 0x66,
        leftMotorForwardSign: options.leftMotorForwardSign ?? -1,
        rightMotorForwardSign: options.rightMotorForwardSign ?? -1,
        motorCalibration: motorCalibration!,
      },
    );
    sensorController = new SensorController({
      logger,
      primitivesStore: primitives,
      gateway: sensorGateway,
      imuCalibration: imuCalibration!,
      poseCalibration: poseCalibration!,
      geometryCalibration: geometryCalibration!,
      pollIntervalMs: options.sensorPollingIntervalMs ?? SENSOR_CONTROLLER_POLL_INTERVAL_MS,
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
        maxWheelOutputPercent: options.maxWheelOutputPercent ?? MAX_WHEEL_OUTPUT_PERCENT_DEFAULT,
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
      imuCalibration: imuCalibration!,
      poseCalibration: poseCalibration!,
      geometryCalibration: geometryCalibration!,
      pollIntervalMs: options.sensorPollingIntervalMs ?? SENSOR_CONTROLLER_POLL_INTERVAL_MS,
    });
    await sensorController.start();

    primitives.update({
      sensorController: {
        status: "error",
        pollIntervalMs: options.sensorPollingIntervalMs ?? SENSOR_CONTROLLER_POLL_INTERVAL_MS,
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
        commandedLeftWheelOutputPercent: null,
        commandedRightWheelOutputPercent: null,
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
      motorCalibration: motorCalibration!,
      maxWheelOutputPercent: options.maxWheelOutputPercent ?? MAX_WHEEL_OUTPUT_PERCENT_DEFAULT,
    });

    // Initialize pose fusion
    poseFusion = new PoseFusion({
      sensorController,
      logger,
      poseCalibration: poseCalibration!,
    });
    await poseFusion.start();
    const refreshPoseFusionPrimitive = () => {
      primitives.update({
        poseFusion: poseFusion?.getPrimitiveState() ?? primitives.snapshot().poseFusion,
      });
    };
    poseFusion.on("poseUpdate", refreshPoseFusionPrimitive);
    refreshPoseFusionPrimitive();

    turnValidationRunner = new TurnValidationRunner({
      turnController,
      poseProvider: () => poseFusion?.getCurrentPose() ?? null,
      logger,
    });

    if (pathStore) {
      pathRecorder = new PathRecorder({
        logger: logger.child({ context: "paths", source: "PathRecorder" }),
        distanceThreshold: 0.1,
      }, {
        pathStore: pathStore!,
        poseFusion: poseFusion!,
      });

      if (areaPerimeterStore) {
        areaPerimeterRecorder = new PathRecorder({
          logger: logger.child({ context: "paths", source: "AreaPerimeterRecorder" }),
          distanceThreshold: 0.1,
        }, {
          pathStore: areaPerimeterStore,
          poseFusion: poseFusion!,
        });
      }

    }

    // Initialize drive controller
    driveLearningModel = new DriveLearningModel({ logger });
    await driveLearningModel.loadParameters();
    driveLineController = new DriveLineController({
      sensorController,
      poseFusion,
      logger,
      learningModel: driveLearningModel,
      motorCalibration: motorCalibration!,
      runRecordWriter: new RunRecordWriter({ logger }),
    });

    driveController = new DriveController({
      sensorController,
      poseFusion,
      turnController,
      logger,
      learningModel: driveLearningModel,
      lineDriveController: driveLineController,
      motorCalibration: motorCalibration!,
    });

    operationContextTracker = new OperationContextTracker();
    checkpointStore = new CheckpointStore({
      logger: logger.child({ context: "retry", source: "CheckpointStore" }),
    });
    retryManager = new RetryManager(
      {
        logger: logger.child({ context: "retry", source: "RetryManager" }),
        checkpointStore,
        pathRetryReverseDistanceMeters: pathFollowingConfig?.getParameters().pathRetryReverseDistanceMeters,
      },
      {
        motorController: {
          stop: () => sensorController.stopMotors(),
        },
        driveController: {
          driveSegment: (target, sign) => driveController!.driveSegment(target, sign),
          reverseForDuration: (durationMs) => driveController!.reverseForDuration(durationMs),
        },
        // Re-run the same boundary follow after the retry's reverse retreat.
        // The segmented executor re-anchors to the nearest target on entry.
        pathRestart: async (waypoints) => {
          retryManager?.clearRecentTargets();
          await executeSegmentedBoundaryPath(waypoints, driveController!, {
            parameters: pathFollowingConfig?.getParameters(),
            learningEnabled: true,
            startPose: poseFusion?.getCurrentPose(),
            recentTargetSink: retryManager ?? undefined,
          });
        },
        getCurrentPose: () => poseFusion!.getCurrentPose(),
      },
    );

    sensorController.on("obstructionDetected", (event: ObstructionDetectedEvent) => {
      const context = operationContextTracker!.getContext();
      if (!context) {
        return;
      }
      const pose = poseFusion!.getCurrentPose();
      const obstruction: ObstructionEvent = {
        type: event.type,
        timestamp: event.timestampMillis,
        context,
        motorCurrents: {
          left: event.leftMotorCurrentAmps,
          right: event.rightMotorCurrentAmps,
        },
        position: pose,
      };
      void retryManager!.handleObstruction(obstruction);
    });

    segmentTestRunner = new SegmentTestRunner({
      driveController,
      sensorController,
      poseProvider: () => poseFusion?.getCurrentPose() ?? null,
      logger,
    });

    deadReckoningCalibrator = new DeadReckoningCalibrator({
      sensorController,
      poseFusion,
      poseCalibration: poseCalibration!,
      motorCalibration: motorCalibration ?? undefined,
      driveLineController,
      turnController,
      logger,
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

      await driveController?.stopCurrentDrive();
      if (pathRecorder?.isRecording()) {
        pathRecorder.cancel();
      }
      if (areaPerimeterRecorder?.isRecording()) {
        areaPerimeterRecorder.cancel();
      }
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
