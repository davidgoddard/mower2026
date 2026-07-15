import { createServer, request as createProxyRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import { renderHomePage } from "./homePage.js";
import { getTurnTuningPageHtml } from "./turnTuningPage.js";
import { getDriveTuningPageHtml } from "./driveTuningPage.js";
import { getSegmentTestingPageHtml } from "./segmentTestingPage.js";
import { renderPathTracingPage } from "./pathTracingPage.js";
import { getManualDrivePageCss, getManualDrivePageHtml, getManualDrivePageJs } from "./manualDrivePage.js";
import { getDeadReckoningPageHtml } from "./deadReckoningPage.js";
import { SENSOR_WIDGETS_JS } from "./liveSensorWidgets.js";
import { OPERATOR_PAGE_COMMON_JS } from "./operatorPageCommon.js";

export interface StartMowerWebServerOptions {
  host?: string;
  port?: number;
  controlHost?: string;
  controlPort: number;
}

export interface RunningMowerWebServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

const PAGE_RENDERERS = new Map<string, () => string>([
  ["/", renderHomePage],
  ["/turn-tuning", getTurnTuningPageHtml],
  ["/drive-tuning", getDriveTuningPageHtml],
  ["/segment-testing", getSegmentTestingPageHtml],
  ["/path-tracing", renderPathTracingPage],
  ["/manual-drive", getManualDrivePageHtml],
  ["/dead-reckoning", getDeadReckoningPageHtml],
]);

function cloneHeaders(headers: IncomingHttpHeaders, hostHeader: string): Record<string, string> {
  const forwarded: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || key.toLowerCase() === "host") {
      continue;
    }

    const headerValue: string | null = Array.isArray(value)
      ? value.join(", ")
      : typeof value === "string"
        ? value
        : null;
    if (headerValue !== null) {
      forwarded[key] = headerValue;
    }
  }

  forwarded.host = hostHeader;
  return forwarded;
}

function writeHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

function writeTextAsset(response: ServerResponse, contentType: string, body: string): void {
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function writeStaticWidgetBundle(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  response.end(SENSOR_WIDGETS_JS);
}

function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    controlHost: string;
    controlPort: number;
  },
): void {
  const requestOptions: RequestOptions = {
    hostname: options.controlHost,
    port: options.controlPort,
    method: request.method,
    path: request.url,
    headers: cloneHeaders(request.headers, `${options.controlHost}:${options.controlPort}`),
  };

  const upstreamRequest = createProxyRequest(requestOptions, (upstreamResponse: IncomingMessage) => {
    // `IncomingHttpHeaders` allows `string | string[] | undefined`, but
    // `response.writeHead` wants `OutgoingHttpHeaders`-shaped values. Coerce
    // arrays into a comma-joined string and drop undefined entries.
    const flatHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined) continue;
      flatHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, flatHeaders);
    upstreamResponse.pipe(response);
  });

  upstreamRequest.on("error", (error: Error) => {
    if (response.headersSent) {
      response.end();
      return;
    }

    response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      error: "control_unavailable",
      message: error.message,
    }));
  });

  request.pipe(upstreamRequest);
}

export async function startMowerWebServer(options: StartMowerWebServerOptions): Promise<RunningMowerWebServer> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8090;
  const controlHost = options.controlHost ?? "127.0.0.1";
  const controlPort = options.controlPort;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    const baseUrl = `http://${request.headers.host ?? "localhost"}`;
    const requestUrl = new URL(request.url ?? "/", baseUrl);

    if (method === "GET" && requestUrl.pathname === "/sensor-widgets.js") {
      writeStaticWidgetBundle(response);
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/manual-drive.css") {
      writeTextAsset(response, "text/css; charset=utf-8", getManualDrivePageCss());
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/manual-drive.js") {
      writeTextAsset(response, "application/javascript; charset=utf-8", getManualDrivePageJs());
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/operator-page-common.js") {
      writeTextAsset(response, "application/javascript; charset=utf-8", OPERATOR_PAGE_COMMON_JS);
      return;
    }

    if (method === "GET") {
      const renderPage = PAGE_RENDERERS.get(requestUrl.pathname);
      if (renderPage) {
        writeHtml(response, renderPage());
        return;
      }
    }

    proxyRequest(request, response, { controlHost, controlPort });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const boundAddress = server.address();
  const boundPort = boundAddress !== null && typeof boundAddress === "object"
    ? boundAddress.port
    : port;

  return {
    host,
    port: boundPort,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
