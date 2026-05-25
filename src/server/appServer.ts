import { createServer } from "node:http";
import { HidGameController } from "../controller/hidGameController.js";
import { ManualDriveCoordinator } from "../control/manualDriveCoordinator.js";
import { TurnController } from "../control/turnController.js";
import { TurnLearningModel } from "../control/turnLearningModel.js";
import { TurnValidationRunner } from "../control/turnValidationRunner.js";
import { DriveController } from "../control/driveController.js";
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
import { PathFollowingConfig } from "../config/pathFollowingConfig.js";
import { renderHomePage } from "./homePage.js";
import { getTurnTuningPageHtml } from "./turnTuningPage.js";
import { getDriveTuningPageHtml } from "./driveTuningPage.js";
import { getSegmentTestingPageHtml } from "./segmentTestingPage.js";
import { renderPathTracingPage } from "./pathTracingPage.js";
import { getManualDrivePageHtml } from "./manualDrivePage.js";
import { PrimitiveSnapshot, PrimitivesStore } from "./primitivesStore.js";
import { createRelativeAngle, headingDifference, unwrapRelativeAngle } from "../geometry/headingTypes.js";
import { createPosition } from "../geometry/positionTypes.js";
import { MAX_PORT_NUMBER, MAX_WHEEL_OUTPUT_PERCENT_DEFAULT, MAX_WHEEL_SPEED_MPS_DEFAULT, SENSOR_CONTROLLER_POLL_INTERVAL_MS } from "../constants.js";
import { PathRecorder, PathStore, PurePursuitFollower, buildDrivePathPointsForDirection, buildVerificationApproachPlan, buildVerificationPathPointsFromPlan } from "../pathfollowing/index.js";

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const PATH_JOIN_TURN_ALIGNMENT_THRESHOLD_DEG = 2;

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

  if (method === "GET" && pathname === "/api/paths") {
    return {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: encodeJson({ paths: [] }), // Will be populated async
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
  let driveController: DriveController | null = null;
  let segmentTestRunner: SegmentTestRunner | null = null;
  let motorCalibration: MotorCalibration | null = null;
  let imuCalibration: ImuCalibration | null = null;
  let poseCalibration: PoseCalibration | null = null;
  let geometryCalibration: GeometryCalibration | null = null;
  let pathFollowingConfig: PathFollowingConfig | null = null;
  let pathStore: PathStore | null = null;
  let pathRecorder: PathRecorder | null = null;
  let pathFollower: PurePursuitFollower | null = null;
  logger.transition("boot", "starting", { port, host });

  pathStore = new PathStore({
    storageDirectory: "./paths",
    logger: logger.child({ context: "paths", source: "PathStore" }),
  });

  const server = createServer(async (request: any, response: any) => {
    const method = request.method ?? "GET";
    const baseUrl = `http://${request.headers?.host ?? "localhost"}`;
    const requestUrl = new URL(request.url ?? "/", baseUrl);

    // Handle async GET endpoints
    if (method === "GET") {
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
    }

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

        // Large-angle turn training sequence
        if (requestUrl.pathname === "/api/turn/train-large" && turnController) {
          const data = JSON.parse(body);
          const results = await turnController.runLargeAngleTraining(data.iterations);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Small-angle turn training sequence
        if (requestUrl.pathname === "/api/turn/train-small" && turnController) {
          const data = JSON.parse(body);
          const results = await turnController.runSmallAngleTraining(data.targetErrorDeg);
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

        // Stop turn
        if (requestUrl.pathname === "/api/turn/stop" && turnController) {
          systemStop.requestStop("api", "turn_stop");
          await turnController.stopCurrentTurn();
          turnValidationRunner?.stopCurrentValidation();
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
            throw new Error("path_name_required");
          }
          if (pathFollower?.getState().isFollowing) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_following_active" }));
            return;
          }
          if (pathRecorder.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_already_recording" }));
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
            throw new Error("path_name_required");
          }

          await pathStore.deletePath(pathName);
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

        // Drive stored path by staging to the outer edge of the join point and then
        // following the stored path in the chosen direction.
        if (requestUrl.pathname === "/api/path/drive" && driveController && turnController && pathFollower && pathStore && poseFusion) {
          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new Error("path_name_required");
          }
          if (pathRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_recording_active" }));
            return;
          }

          const path = await pathStore.loadPath(pathName);
          if (path.points.length === 0) {
            throw new Error("path_empty");
          }

          const currentPose = poseFusion.getCurrentPose();
          const pathFollowingParameters = pathFollowingConfig?.getParameters();
          const approachPlan = buildVerificationApproachPlan(path.points, currentPose, pathFollowingParameters);
          if (approachPlan === null) {
            throw new Error("path_too_short_for_drive");
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
              response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              response.end(encodeJson({
                mode: "drive",
                pathName,
                completed: false,
                reason: turnResult.status === "stopped" ? "user_stopped" : "error",
                phase: "approach",
                approachResult,
              }));
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
              response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              response.end(encodeJson({
                mode: "drive",
                pathName,
                completed: false,
                reason: driveResult.status === "stopped" ? "user_stopped" : "error",
                phase: "approach",
                approachResult,
              }));
              return;
            }

            const poseAfterDrive = poseFusion.getCurrentPose();
            const turnAngle = headingDifference(poseAfterDrive.heading, approachPlan.tangentHeading);
            if (Math.abs(unwrapRelativeAngle(turnAngle)) > PATH_JOIN_TURN_ALIGNMENT_THRESHOLD_DEG) {
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
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(encodeJson({
                  mode: "drive",
                  pathName,
                  completed: false,
                  reason: turnResult.status === "stopped" ? "user_stopped" : "error",
                  phase: "approach",
                  approachResult,
                }));
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
            throw new Error("path_too_short_for_drive");
          }

          const followResult = await pathFollower.followPathPoints(drivePoints);
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

        // Verify stored path using an outer-edge approach to the nearest join point,
        // then a full loop back to it.
        if (requestUrl.pathname === "/api/path/verify" && driveController && turnController && pathFollower && pathStore && poseFusion) {
          const data = JSON.parse(body);
          const pathName = typeof data.pathName === "string" ? data.pathName.trim() : "";
          if (pathName.length === 0) {
            throw new Error("path_name_required");
          }
          if (pathRecorder?.isRecording()) {
            response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            response.end(encodeJson({ error: "path_recording_active" }));
            return;
          }

          const path = await pathStore.loadPath(pathName);
          if (path.points.length === 0) {
            throw new Error("path_empty");
          }

          const currentPose = poseFusion.getCurrentPose();
          const pathFollowingParameters = pathFollowingConfig?.getParameters();
          const approachPlan = buildVerificationApproachPlan(path.points, currentPose, pathFollowingParameters);
          if (approachPlan === null) {
            throw new Error("path_too_short_for_verification");
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
              response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              response.end(encodeJson({
                mode: "verify",
                pathName,
                completed: false,
                reason: turnResult.status === "stopped" ? "user_stopped" : "error",
                phase: "approach",
                approachResult,
              }));
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
              response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              response.end(encodeJson({
                mode: "verify",
                pathName,
                completed: false,
                reason: driveResult.status === "stopped" ? "user_stopped" : "error",
                phase: "approach",
                approachResult,
              }));
              return;
            }

            const poseAfterDrive = poseFusion.getCurrentPose();
            const turnAngle = headingDifference(poseAfterDrive.heading, approachPlan.tangentHeading);
            if (Math.abs(unwrapRelativeAngle(turnAngle)) > PATH_JOIN_TURN_ALIGNMENT_THRESHOLD_DEG) {
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
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(encodeJson({
                  mode: "verify",
                  pathName,
                  completed: false,
                  reason: turnResult.status === "stopped" ? "user_stopped" : "error",
                  phase: "approach",
                  approachResult,
                }));
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
            throw new Error("path_too_short_for_verification");
          }

          const result = await pathFollower.followPathPoints(verificationPoints);
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

        // Stop active path following
        if (requestUrl.pathname === "/api/path/stop" && pathFollower) {
          await pathFollower.stop();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ stopped: true }));
          return;
        }

        // Segment test run
        if (requestUrl.pathname === "/api/segment/start" && segmentTestRunner) {
          const data = body.trim().length > 0 ? JSON.parse(body) : {};
          systemStop.clearStop("api-segment-start");
          const results = await segmentTestRunner.run({
            waypointCount: data.waypointCount,
            testRunCount: data.testRunCount,
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Stop segment test
        if (requestUrl.pathname === "/api/segment/stop" && segmentTestRunner) {
          systemStop.requestStop("api", "segment_stop");
          segmentTestRunner.stopCurrentTest();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson({ stopped: true }));
          return;
        }

        // Drive test pattern
        if (requestUrl.pathname === "/api/drive/test-pattern" && driveController) {
          const results = await driveController.runTestPattern();
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Short-distance drive training
        if (requestUrl.pathname === "/api/drive/train-short" && driveController) {
          const data = JSON.parse(body);
          systemStop.clearStop("api-drive-train-short");
          const results = await driveController.runShortDistanceTraining({
            targetXErrorMeters: data.targetXErrorMeters,
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
            targetXErrorMeters: data.targetXErrorMeters ?? 0.04,
            includeReverseLegs: data.includeReverseLegs ?? true,
          });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(encodeJson(results));
          return;
        }

        // Stop drive
        if (requestUrl.pathname === "/api/drive/stop" && driveController) {
          systemStop.requestStop("api", "drive_stop");
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
  const boundPort = typeof boundAddress?.port === "number" ? boundAddress.port : port;

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

      const pathFollowingParameters = pathFollowingConfig?.getParameters();
      pathFollower = new PurePursuitFollower({
        targetSpeed: MAX_WHEEL_SPEED_MPS_DEFAULT * 0.8,
        wheelBase: 0.35,
        controlRateHz: 15,
        arrivalThreshold: 0.12,
        minLookaheadMeters: pathFollowingParameters?.purePursuitMinLookaheadMeters,
        baseLookaheadMeters: pathFollowingParameters?.purePursuitBaseLookaheadMeters,
        maxLookaheadMeters: pathFollowingParameters?.purePursuitMaxLookaheadMeters,
        logger: logger.child({ context: "paths", source: "PathFollower" }),
      }, {
        pathStore: pathStore!,
        motorController: {
          async setWheelSpeeds(left: number, right: number): Promise<void> {
            const leftOutput = clamp(
              left / MAX_WHEEL_SPEED_MPS_DEFAULT,
              -MAX_WHEEL_OUTPUT_PERCENT_DEFAULT,
              MAX_WHEEL_OUTPUT_PERCENT_DEFAULT,
            );
            const rightOutput = clamp(
              right / MAX_WHEEL_SPEED_MPS_DEFAULT,
              -MAX_WHEEL_OUTPUT_PERCENT_DEFAULT,
              MAX_WHEEL_OUTPUT_PERCENT_DEFAULT,
            );
            await sensorController.setMotorWheelOutputs(leftOutput, rightOutput);
          },
          async stop(): Promise<void> {
            await sensorController.stopMotors();
          },
          beginOperation(): void {
            sensorController.beginMotorOperation();
          },
          async endOperation(): Promise<void> {
            await sensorController.endMotorOperation();
          },
        },
        getCurrentPose: () => poseFusion!.getCurrentPose(),
        getCurrentSpeed: () => {
          const motors = primitives.snapshot().motors;
          const left = motors.leftWheelSpeedMetersPerSecond;
          const right = motors.rightWheelSpeedMetersPerSecond;
          if (left === null || right === null) {
            return 0;
          }
          return (left + right) / 2;
        },
      });
    }

    // Initialize drive controller
    driveLearningModel = new DriveLearningModel({ logger });
    await driveLearningModel.loadParameters();
    driveController = new DriveController({
      sensorController,
      poseFusion,
      turnController,
      logger,
      learningModel: driveLearningModel,
      motorCalibration: motorCalibration!,
    });

    segmentTestRunner = new SegmentTestRunner({
      driveController,
      sensorController,
      poseProvider: () => poseFusion?.getCurrentPose() ?? null,
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

      await pathFollower?.stop();
      if (pathRecorder?.isRecording()) {
        pathRecorder.cancel();
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
