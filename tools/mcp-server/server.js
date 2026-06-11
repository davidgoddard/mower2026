#!/usr/bin/env node
// MCP server for the mower repo. Runs on the mower itself so Claude Code
// (on a developer workstation) can build, test, sync, and inspect logs
// against real hardware. Transport: streamable HTTP with a shared bearer
// token. See docs/mcp-server.md for setup.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdir, stat, open } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(process.env.MOWER_REPO_ROOT ?? resolve(__dirname, "..", ".."));
const LOG_DIR = resolve(process.env.MOWER_LOG_DIR ?? join(REPO_ROOT, "logs"));
const PORT = Number(process.env.MOWER_MCP_PORT ?? 8765);
const HOST = process.env.MOWER_MCP_HOST ?? "0.0.0.0";
const TOKEN = process.env.MOWER_MCP_TOKEN ?? "";

const PER_FILE_BYTE_CAP = Number(process.env.MOWER_MCP_LOG_TAIL_BYTES ?? 512 * 1024);
const COMMAND_TIMEOUT_MS = Number(process.env.MOWER_MCP_COMMAND_TIMEOUT_MS ?? 10 * 60 * 1000);

if (!TOKEN) {
  console.warn("[mower-mcp] MOWER_MCP_TOKEN is not set — server will refuse all requests.");
}

function runCommand(command, args, opts = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolveResult({ exitCode: null, stdout, stderr: stderr + `\n[spawn error] ${err.message}`, timedOut });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

function formatRunResult(label, result) {
  const status = result.timedOut
    ? `TIMED OUT after ${COMMAND_TIMEOUT_MS} ms`
    : `exit ${result.exitCode}`;
  return [
    `# ${label} — ${status}`,
    "",
    "## stdout",
    result.stdout.trim() || "(empty)",
    "",
    "## stderr",
    result.stderr.trim() || "(empty)",
  ].join("\n");
}

async function readTail(path, byteCap) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - byteCap);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
      text = `[truncated: showing last ${length} of ${size} bytes]\n` + text;
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function getLatestLogs(n) {
  const entries = await readdir(LOG_DIR, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".log")) continue;
    const full = join(LOG_DIR, entry.name);
    const s = await stat(full);
    candidates.push({ name: entry.name, path: full, mtimeMs: s.mtimeMs, size: s.size });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = candidates.slice(0, n);

  const parts = [`# Latest ${picked.length} log file(s) from ${LOG_DIR}`, ""];
  for (const file of picked) {
    const tail = await readTail(file.path, PER_FILE_BYTE_CAP);
    parts.push(`## ${file.name}  (${file.size} bytes, mtime ${new Date(file.mtimeMs).toISOString()})`);
    parts.push("```");
    parts.push(tail);
    parts.push("```");
    parts.push("");
  }
  return parts.join("\n");
}

function buildMcpServer() {
  const server = new McpServer({ name: "mower-mcp", version: "0.1.0" });

  server.tool(
    "getLatestLogs",
    "Return the most recent N log files from the mower's logs/ folder, each tail-capped to keep responses bounded.",
    { n: z.number().int().min(1).max(20).default(3) },
    async ({ n }) => {
      const text = await getLatestLogs(n);
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "build",
    "Run `npm run build` (TypeScript compile) in the mower repo on the mower.",
    {},
    async () => {
      const result = await runCommand("npm", ["run", "build"]);
      return {
        content: [{ type: "text", text: formatRunResult("npm run build", result) }],
        isError: result.exitCode !== 0,
      };
    },
  );

  server.tool(
    "test",
    "Run `npm run test` (unit test suite) in the mower repo on the mower.",
    {},
    async () => {
      const result = await runCommand("npm", ["run", "test"]);
      return {
        content: [{ type: "text", text: formatRunResult("npm run test", result) }],
        isError: result.exitCode !== 0,
      };
    },
  );

  server.tool(
    "sync",
    "Run `git fetch --all --prune` then `git pull --ff-only` in the mower repo so it picks up changes pushed from the dev workstation.",
    {},
    async () => {
      const fetchResult = await runCommand("git", ["fetch", "--all", "--prune"]);
      const pullResult = await runCommand("git", ["pull", "--ff-only"]);
      const text = [
        formatRunResult("git fetch --all --prune", fetchResult),
        "",
        formatRunResult("git pull --ff-only", pullResult),
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        isError: fetchResult.exitCode !== 0 || pullResult.exitCode !== 0,
      };
    },
  );

  return server;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

const httpServer = createServer(async (req, res) => {
  const auth = req.headers["authorization"] ?? "";
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end();
    return;
  }

  // Stateless: one server + transport per request. The streamable-HTTP MCP
  // transport supports this mode and it sidesteps session-id bookkeeping.
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid_json", detail: String(err?.message ?? err) }));
    return;
  }

  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[mower-mcp] request error", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "internal_error", detail: String(err?.message ?? err) }));
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[mower-mcp] listening on ${HOST}:${PORT}, repo=${REPO_ROOT}, logs=${LOG_DIR}`);
});

function shutdown(signal) {
  console.log(`[mower-mcp] received ${signal}, shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
