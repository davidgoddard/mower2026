#!/usr/bin/env node
// MCP server for the mower repo. Runs on the mower itself so Claude Code
// (on a developer workstation) can build, test, sync, and inspect logs
// against real hardware. Transport: streamable HTTP with a shared bearer
// token. See docs/mcp-server.md for setup.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readdir, stat, open, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

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
const OUTPUT_DIR = resolve(process.env.MOWER_MCP_OUTPUT_DIR ?? join(LOG_DIR, "mcp"));
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_LOG_MATCHES_PER_FILE = 100;

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

export function formatRunResult(label, result) {
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

export async function readTail(path, byteCap) {
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

function resetRegex(regex, text) {
  regex.lastIndex = 0;
  return regex.test(text);
}

function formatLine(lineNumber, text) {
  return `${String(lineNumber).padStart(6, " ")} | ${text}`;
}

export function sanitizeSavedOutputName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("saveOutputAs must not be empty");
  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.includes("..")) throw new Error("saveOutputAs must not contain '..'");
  const safe = normalized
    .replace(/[^A-Za-z0-9._/-]/g, "_")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (!safe) throw new Error("saveOutputAs did not produce a safe file name");
  return safe;
}

export function resolveOutputPath(name) {
  const relative = sanitizeSavedOutputName(name);
  const full = resolve(OUTPUT_DIR, relative);
  if (!full.startsWith(OUTPUT_DIR + "/") && full !== OUTPUT_DIR) {
    throw new Error("resolved output path escapes OUTPUT_DIR");
  }
  return full;
}

export function resolveRepoPath(path) {
  const relative = String(path ?? "").trim();
  if (!relative) throw new Error("path is required");
  if (relative.startsWith("/") || relative.startsWith("~")) {
    throw new Error("path must be relative to the mower repo");
  }
  const full = resolve(REPO_ROOT, relative);
  if (!full.startsWith(REPO_ROOT + "/") && full !== REPO_ROOT) {
    throw new Error("path escapes the mower repo");
  }
  return full;
}

async function maybeSaveOutput(name, text) {
  if (!name) return null;
  const fullPath = resolveOutputPath(name);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, text, "utf8");
  return fullPath;
}

export async function scanTextFile(path, options = {}) {
  const grep = options.grep ? new RegExp(options.grep, options.grepFlags ?? "") : null;
  const contextLines = Math.max(0, Math.min(20, options.contextLines ?? 0));
  const maxMatches = Math.max(1, Math.min(2000, options.maxMatches ?? DEFAULT_MAX_MATCHES));
  const tailLines = Math.max(1, Math.min(5000, options.tailLines ?? DEFAULT_TAIL_LINES));
  const input = createReadStream(path, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let lineNumber = 0;
  let totalMatches = 0;
  let shownMatches = 0;
  let emittedUntil = 0;
  let trailingContextRemaining = 0;
  const previous = [];
  const outputLines = [];
  const tailBuffer = [];

  for await (const line of rl) {
    lineNumber += 1;

    if (!grep) {
      tailBuffer.push(formatLine(lineNumber, line));
      if (tailBuffer.length > tailLines) tailBuffer.shift();
      continue;
    }

    const matched = resetRegex(grep, line);
    if (matched) {
      totalMatches += 1;
      if (shownMatches < maxMatches) {
        for (const prior of previous) {
          if (prior.lineNumber > emittedUntil) {
            outputLines.push(formatLine(prior.lineNumber, prior.text));
            emittedUntil = prior.lineNumber;
          }
        }
        if (lineNumber > emittedUntil) {
          outputLines.push(formatLine(lineNumber, line));
          emittedUntil = lineNumber;
        }
        trailingContextRemaining = contextLines;
        shownMatches += 1;
      }
    } else if (trailingContextRemaining > 0 && lineNumber > emittedUntil) {
      outputLines.push(formatLine(lineNumber, line));
      emittedUntil = lineNumber;
      trailingContextRemaining -= 1;
    }

    if (contextLines > 0) {
      previous.push({ lineNumber, text: line });
      if (previous.length > contextLines) previous.shift();
    }
  }

  if (!grep) {
    return {
      text: tailBuffer.join("\n"),
      lineCount: lineNumber,
      totalMatches: 0,
      shownMatches: 0,
    };
  }

  return {
    text: outputLines.join("\n"),
    lineCount: lineNumber,
    totalMatches,
    shownMatches,
  };
}

export function buildNodeTestArgs(options = {}) {
  const args = ["--test"];
  if (options.testNamePattern) {
    args.push(`--test-name-pattern=${options.testNamePattern}`);
  }
  const files = options.files?.length ? options.files : [];
  args.push(...files);
  return args;
}

async function getLatestLogs(options = {}) {
  const n = options.n ?? 3;
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
    const tail = options.grep
      ? await scanTextFile(file.path, {
        grep: options.grep,
        grepFlags: options.grepFlags,
        contextLines: options.contextLines,
        maxMatches: options.maxMatchesPerFile ?? DEFAULT_LOG_MATCHES_PER_FILE,
      })
      : { text: await readTail(file.path, options.tailBytes ?? PER_FILE_BYTE_CAP), totalMatches: 0, shownMatches: 0 };
    parts.push(`## ${file.name}  (${file.size} bytes, mtime ${new Date(file.mtimeMs).toISOString()})`);
    if (options.grep) {
      parts.push(`Matches shown: ${tail.shownMatches}/${tail.totalMatches}`);
    }
    parts.push("```");
    parts.push(tail.text || "(empty)");
    parts.push("```");
    parts.push("");
  }
  return parts.join("\n");
}

async function runNamedCommand(label, command, args, options = {}) {
  const result = await runCommand(command, args, options);
  const text = formatRunResult(label, result);
  const savedPath = await maybeSaveOutput(options.saveOutputAs, text);
  return {
    text: savedPath ? `${text}\n\nSaved output: ${savedPath}` : text,
    isError: result.exitCode !== 0,
  };
}

function buildMcpServer() {
  const server = new McpServer({ name: "mower-mcp", version: "0.1.0" });

  server.tool(
    "getLatestLogs",
    "Return the most recent N log files from the mower's logs/ folder, each tail-capped to keep responses bounded.",
    {
      n: z.number().int().min(1).max(20).default(3),
      grep: z.string().optional(),
      grepFlags: z.string().regex(/^[dgimsuvy]*$/).optional(),
      contextLines: z.number().int().min(0).max(20).default(0),
      maxMatchesPerFile: z.number().int().min(1).max(1000).default(DEFAULT_LOG_MATCHES_PER_FILE),
      tailBytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(PER_FILE_BYTE_CAP),
    },
    async ({ n, grep, grepFlags, contextLines, maxMatchesPerFile, tailBytes }) => {
      const text = await getLatestLogs({ n, grep, grepFlags, contextLines, maxMatchesPerFile, tailBytes });
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "readFile",
    "Read a text file from the mower repo with optional regex filtering and bounded tail output.",
    {
      path: z.string(),
      grep: z.string().optional(),
      grepFlags: z.string().regex(/^[dgimsuvy]*$/).optional(),
      contextLines: z.number().int().min(0).max(20).default(0),
      maxMatches: z.number().int().min(1).max(2000).default(DEFAULT_MAX_MATCHES),
      tailLines: z.number().int().min(1).max(5000).default(DEFAULT_TAIL_LINES),
    },
    async ({ path, grep, grepFlags, contextLines, maxMatches, tailLines }) => {
      const fullPath = resolveRepoPath(path);
      const details = await stat(fullPath);
      if (!details.isFile()) {
        throw new Error(`${path} is not a file`);
      }
      const scanned = grep
        ? await scanTextFile(fullPath, { grep, grepFlags, contextLines, maxMatches })
        : await scanTextFile(fullPath, { tailLines });
      const parts = [
        `# ${path} (${details.size} bytes, mtime ${details.mtime.toISOString()})`,
      ];
      if (grep) {
        parts.push(`Matches shown: ${scanned.shownMatches}/${scanned.totalMatches}`);
      } else {
        parts.push(`Showing last ${tailLines} line(s)`);
      }
      parts.push("```");
      parts.push(scanned.text || "(empty)");
      parts.push("```");
      return { content: [{ type: "text", text: parts.join("\n\n") }] };
    },
  );

  server.tool(
    "build",
    "Run `npm run build` (TypeScript compile) in the mower repo on the mower.",
    {
      saveOutputAs: z.string().optional(),
    },
    async ({ saveOutputAs }) => {
      const result = await runNamedCommand("npm run build", "npm", ["run", "build"], { saveOutputAs });
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      };
    },
  );

  server.tool(
    "test",
    "Run the mower unit tests on the mower, optionally narrowed to specific files or test names.",
    {
      files: z.array(z.string()).max(50).optional(),
      testNamePattern: z.string().optional(),
      saveOutputAs: z.string().optional(),
    },
    async ({ files, testNamePattern, saveOutputAs }) => {
      const resolvedFiles = files?.map((file) => {
        const fullPath = resolveRepoPath(file);
        if (!fullPath.endsWith(".test.js")) {
          throw new Error(`test file must end with .test.js: ${file}`);
        }
        return file;
      });
      const runExplicitFiles = Array.isArray(resolvedFiles) && resolvedFiles.length > 0;
      const command = runExplicitFiles ? "node" : "npm";
      const args = runExplicitFiles
        ? buildNodeTestArgs({ files: resolvedFiles, testNamePattern })
        : [
          "run",
          "test",
          ...(testNamePattern ? ["--", `--test-name-pattern=${testNamePattern}`] : []),
        ];
      const label = runExplicitFiles ? `node ${args.join(" ")}` : `npm ${args.join(" ")}`;
      const result = await runNamedCommand(label, command, args, { saveOutputAs });
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      };
    },
  );

  server.tool(
    "sync",
    "Run `git fetch --all --prune` then `git pull --ff-only` in the mower repo so it picks up changes pushed from the dev workstation.",
    {
      saveOutputAs: z.string().optional(),
    },
    async ({ saveOutputAs }) => {
      const fetchResult = await runCommand("git", ["fetch", "--all", "--prune"]);
      const pullResult = await runCommand("git", ["pull", "--ff-only"]);
      const text = [
        formatRunResult("git fetch --all --prune", fetchResult),
        "",
        formatRunResult("git pull --ff-only", pullResult),
      ].join("\n");
      const savedPath = await maybeSaveOutput(saveOutputAs, text);
      return {
        content: [{ type: "text", text: savedPath ? `${text}\n\nSaved output: ${savedPath}` : text }],
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

export function createHttpHandler() {
  return async (req, res) => {
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
  };
}

export function startHttpServer() {
  const httpServer = createServer(createHttpHandler());

  httpServer.listen(PORT, HOST, () => {
    console.log(`[mower-mcp] listening on ${HOST}:${PORT}, repo=${REPO_ROOT}, logs=${LOG_DIR}, output=${OUTPUT_DIR}`);
  });

  function shutdown(signal) {
    console.log(`[mower-mcp] received ${signal}, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return httpServer;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startHttpServer();
}
