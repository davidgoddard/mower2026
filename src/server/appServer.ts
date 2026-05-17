import { createServer } from "node:http";
import { SessionLogger } from "../logging/index.js";
import { SensorController } from "../sensing/sensorController.js";
import { SensorHardwareGateway, createPiSensorHardwareGateway } from "../sensing/sensorHardwareGateway.js";
import { renderHomePage } from "./homePage.js";
import { PrimitiveSnapshot, PrimitivesStore } from "./primitivesStore.js";

interface StartMowerServerOptions {
  appName?: string;
  host?: string;
  port?: number;
  logDir?: string;
  sensorPollingIntervalMs?: number;
  i2cBusNumber?: number;
  gnssI2cAddress?: number;
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

function isValidPort(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535;
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
): RouteResponse {
  if (method === "GET" && pathname === "/") {
    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: renderHomePage(),
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
  logger.transition("boot", "starting", { port, host });

  const server = createServer((request: any, response: any) => {
    const method = request.method ?? "GET";
    const baseUrl = `http://${request.headers?.host ?? "localhost"}`;
    const requestUrl = new URL(request.url ?? "/", baseUrl);
    const routed = routeServerRequest(method, requestUrl.pathname, state, appName, primitives.snapshot());

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
      { gnssAddress: options.gnssI2cAddress ?? 0x52 },
    );
    sensorController = new SensorController({
      logger,
      primitivesStore: primitives,
      gateway: sensorGateway,
      pollIntervalMs: options.sensorPollingIntervalMs ?? 33,
    });
    await sensorController.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("sensors.start_failed", { error: message });
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
