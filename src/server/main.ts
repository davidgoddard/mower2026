import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { startMowerWebServer } from "./webServer.js";
import { resolveServerPort } from "./appServer.js";
import {
  HTTP_SERVER_HOST_DEFAULT,
  HTTP_SERVER_PORT_DEFAULT,
  MAX_PORT_NUMBER,
} from "../constants.js";

const CONTROL_HOST_DEFAULT = "127.0.0.1";
const CONTROL_PORT_DEFAULT = HTTP_SERVER_PORT_DEFAULT + 1 <= MAX_PORT_NUMBER
  ? HTTP_SERVER_PORT_DEFAULT + 1
  : HTTP_SERVER_PORT_DEFAULT;
const CONTROL_READY_TIMEOUT_MS = 15_000;
const CONTROL_READY_RETRY_DELAY_MS = 200;

const webHost = process.env.MOWER_WEB_HOST ?? process.env.MOWER_CORE_APP_HOST ?? HTTP_SERVER_HOST_DEFAULT;
const webPort = resolveServerPort(
  process.env.MOWER_WEB_PORT ?? process.env.MOWER_CORE_APP_PORT,
  HTTP_SERVER_PORT_DEFAULT,
);
const controlHost = process.env.MOWER_CONTROL_HOST ?? CONTROL_HOST_DEFAULT;
const controlPort = resolveServerPort(process.env.MOWER_CONTROL_PORT, CONTROL_PORT_DEFAULT);

if (webPort === controlPort && webHost === controlHost) {
  throw new Error(`Web and control servers cannot share the same bind address (${webHost}:${webPort})`);
}

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectoryPath = dirname(currentFilePath);
const controlEntryPath = join(currentDirectoryPath, "controlMain.js");

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForControlReady(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({
          hostname: host,
          port,
          path: "/health",
          method: "GET",
          timeout: 1_000,
        }, (response: { resume: () => void; statusCode?: number | null }) => {
          response.resume();
          if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 500) {
            resolve();
            return;
          }
          reject(new Error(`control_health_status_${response.statusCode ?? "unknown"}`));
        });

        req.on("timeout", () => {
          req.destroy(new Error("control_health_timeout"));
        });
        req.on("error", reject);
        req.end();
      });
      return;
    } catch {
      await sleep(CONTROL_READY_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Timed out waiting for control server on ${host}:${port}`);
}

function startControlChild(): ChildProcess {
  const childEnvironment = {
    ...process.env,
    MOWER_CONTROL_HOST: controlHost,
    MOWER_CONTROL_PORT: String(controlPort),
    MOWER_CORE_APP_HOST: controlHost,
    MOWER_CORE_APP_PORT: String(controlPort),
  };

  return spawn(process.execPath, [controlEntryPath], {
    env: childEnvironment,
    stdio: "inherit",
  });
}

let shuttingDown = false;
const controlChild = startControlChild();
let runningWebServer: Awaited<ReturnType<typeof startMowerWebServer>> | null = null;

controlChild.on("exit", (code, signal) => {
  if (shuttingDown) {
    return;
  }

  console.error(`mower-core control process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  process.exit(code ?? 1);
});

try {
  await waitForControlReady(controlHost, controlPort, CONTROL_READY_TIMEOUT_MS);

  runningWebServer = await startMowerWebServer({
    host: webHost,
    port: webPort,
    controlHost,
    controlPort,
  });

  console.log(
    `mower-core web listening on http://${runningWebServer.host}:${runningWebServer.port} (control http://${controlHost}:${controlPort})`,
  );
} catch (error) {
  shuttingDown = true;
  if (!controlChild.killed) {
    controlChild.kill("SIGTERM");
  }
  throw error;
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`mower-core received ${signal}; stopping web and control`);

  try {
    await runningWebServer?.close();
  } catch (error) {
    console.error("mower-core failed to stop web server cleanly", error);
  }

  if (!controlChild.killed) {
    controlChild.kill("SIGTERM");
  }

  await new Promise<void>((resolve) => {
    if (controlChild.exitCode !== null || controlChild.signalCode !== null) {
      resolve();
      return;
    }

    controlChild.once("exit", () => resolve());
  });

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
