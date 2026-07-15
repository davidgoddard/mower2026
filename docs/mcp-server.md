# Mower MCP Server

A small MCP server that runs **on the mower itself** so Claude Code (running on
a developer workstation) can build, test, sync, and inspect logs against the
real hardware. The dev workstation usually only has a static clone of the repo;
this server is what makes it possible to verify changes against real sensors,
real motors, and the real filesystem layout.

Source lives in [tools/mcp-server/](../tools/mcp-server/).

---

## What it exposes

The server provides four tools over MCP. Names below are the exact MCP tool
names Claude will see.

| Tool | Effect on the mower |
|---|---|
| `getLatestLogs` | Returns the most recent N log files from `$MOWER_LOG_DIR` (default `<repo>/logs/`). Each file is tail-capped (default last 512 KB) so a single huge JSONL session log doesn't blow the response. Can optionally regex-filter server-side with match context. |
| `build`         | Runs `npm run build` in the repo root (= `tsc -p tsconfig.json`). Returns stdout, stderr, exit code. |
| `test`          | Runs the unit test suite in the repo root. Can optionally target specific `*.test.js` files, apply a `--test-name-pattern`, and save the result to a named file under the mower logs folder. |
| `sync`          | Runs `git fetch --all --prune` then `git pull --ff-only` so the mower picks up commits the dev workstation just pushed. Both commands' output is returned. |
| `readFile`      | Reads a text file from the mower repo with bounded output. Can tail the file or regex-filter it server-side with surrounding context, which is useful for saved test output and noisy JSONL logs. |

All four tools are remote-procedure calls — they execute on the mower, not on
the workstation Claude is running on.

---

## How Claude should use it

**Always check first whether the MCP server is reachable.** If it is, prefer
its tools over local guesswork:

- After the user pushes a change, call `sync` before `build`/`test` — otherwise
  the mower is running old code.
- Run `build` after any TypeScript change so type errors surface against the
  real `tsconfig.json` and the real `node_modules`.
- Run `test` instead of trying to reason about test results from the static
  clone — the dev workstation can't run them anyway (`AGENTS.md` forbids it).
- Use `getLatestLogs` when diagnosing runtime behaviour (failed runs, sensor
  glitches, stop conditions). Start with `n=3`; add `grep` and
  `contextLines` when the logs are noisy. Logs are JSONL — each line is a
  structured record from [src/logging/sessionLogger.ts](../src/logging/sessionLogger.ts).
- Use targeted `test` runs when the full suite output would be too large. Pass
  a specific test file and, if needed, `testNamePattern` to isolate one case.
- Use `saveOutputAs` on `test`, `build`, or `sync` when you want the full
  result saved under the mower log tree, then fetch it later with `readFile`.
- Use `readFile` for saved test output, generated artifacts, or focused log
  inspection when `getLatestLogs` alone would still return too much noise.

If the MCP server is **not** reachable (e.g. mower is offline, or the user is
working purely on the static clone), fall back to source inspection per
[AGENTS.md](../AGENTS.md) and tell the user explicitly that build/test/log
verification was skipped.

### Order-of-operations after a code change
1. User pushes → `sync` on the mower
2. `build` → fix any TS errors
3. `test` → fix any failures
4. If the user is running the live app, `getLatestLogs(3)` to confirm no new
   warnings/errors
5. If the suite output is too noisy, rerun a narrowed `test` and/or read the
   saved output file with `readFile`

Don't call `build` and `test` in parallel — `tsc` writes `dist/` and the test
suite imports from it via the build output.

---

## Operator setup (once per mower)

These steps are run **on the mower**, not on the dev workstation.

### 1. Install dependencies

```bash
cd /home/mower/mower/tools/mcp-server
npm install
```

This installs `@modelcontextprotocol/sdk` and `zod` only into
`tools/mcp-server/node_modules`, separate from the runtime's `node_modules`.

### 2. Generate a shared token

```bash
openssl rand -hex 32
```

Copy the output. The dev workstation will need the same value.

### 3. Create the env file

```bash
sudo tee /etc/mower-mcp.env >/dev/null <<EOF
MOWER_MCP_TOKEN=<paste-token-here>
EOF
sudo chmod 600 /etc/mower-mcp.env
```

### 4. Install the systemd unit

```bash
cd /home/mower/mower
sudo cp systemd/mower-mcp.service.template /etc/systemd/system/mower-mcp.service
sudo sed -i \
  -e "s|__MOWER_USER__|mower|g" \
  -e "s|__MOWER_GROUP__|mower|g" \
  -e "s|__MOWER_REPO_DIR__|/home/mower/mower|g" \
  /etc/systemd/system/mower-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now mower-mcp.service
sudo systemctl status mower-mcp.service
```

You should see `[mower-mcp] listening on 0.0.0.0:8765, repo=...`

### 5. Open the firewall (if applicable)

```bash
# UFW example — adapt to your firewall:
sudo ufw allow from 192.168.0.0/16 to any port 8765 proto tcp
```

Restrict the source range to your LAN. The token is the only thing standing
between any LAN client and `npm run test` / log access.

---

## Dev workstation setup

### Codex

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.mower]
url = "http://<mower-lan-ip>:8765"
bearer_token_env_var = "MOWER_MCP_TOKEN"
startup_timeout_sec = 30
tool_timeout_sec = 600
```

Set the token in the environment before launching Codex. For the macOS desktop
app, register it in the launch environment:

```bash
launchctl setenv MOWER_MCP_TOKEN '<same-token-as-on-the-mower>'
```

Then fully restart Codex. In the MCP panel, `mower` should appear as enabled.
In a fresh thread, the remote tools should be callable under the `mower` MCP
server.

### Claude Code

Add the server to `~/.claude.json` (or your project-local Claude Code config)
under `mcpServers`:

```json
{
  "mcpServers": {
    "mower": {
      "type": "http",
      "url": "http://<mower-lan-ip>:8765",
      "headers": {
        "Authorization": "Bearer <same-token-as-on-the-mower>"
      }
    }
  }
}
```

Replace `<mower-lan-ip>` with the mower's IP (or hostname if mDNS/`/etc/hosts`
resolves it). After editing, restart Claude Code.

Verify with `/mcp` inside Claude Code — `mower` should be listed and the four
tools (`getLatestLogs`, `build`, `test`, `sync`) should appear.

---

## Configuration knobs

All optional, set on the mower (typically in `/etc/mower-mcp.env` or the unit
file):

| Variable | Default | Purpose |
|---|---|---|
| `MOWER_MCP_TOKEN`            | *(unset → server refuses everything)* | Shared bearer token. |
| `MOWER_MCP_HOST`             | `0.0.0.0`                              | Listen address. |
| `MOWER_MCP_PORT`             | `8765`                                 | Listen port. |
| `MOWER_REPO_ROOT`            | `<server.js>/../..`                    | Repo root used as cwd for build/test/sync. |
| `MOWER_LOG_DIR`              | `$MOWER_REPO_ROOT/logs`                | Where `getLatestLogs` looks. |
| `MOWER_MCP_LOG_TAIL_BYTES`   | `524288` (512 KB)                      | Per-file tail cap for `getLatestLogs`. |
| `MOWER_MCP_OUTPUT_DIR`       | `$MOWER_LOG_DIR/mcp`                   | Where saved `build` / `test` / `sync` output files are written. |
| `MOWER_MCP_COMMAND_TIMEOUT_MS` | `600000` (10 min)                    | Hard timeout for `build`/`test`/`sync`. |

---

## Security notes

- Bearer-token auth only. Rotate the token by editing `/etc/mower-mcp.env` and
  `systemctl restart mower-mcp.service` (and updating the workstation config).
- The server runs as the `mower` user, so anyone with the token can run
  arbitrary `npm run` scripts and read anything that user can read. Keep the
  token off shared chat tools and off git.
- The server does not expose a generic shell. Only the four tools above are
  callable. If you add more tools, do it via `server.tool(...)` calls in
  [tools/mcp-server/server.js](../tools/mcp-server/server.js) — never via a
  generic command-runner tool.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 unauthorized` from Claude Code | Token mismatch or `MOWER_MCP_TOKEN` unset on the mower. |
| Connection refused | Service not running (`systemctl status mower-mcp.service`) or firewall blocking the port. |
| `build` returns exit 1 with `tsc: not found` | The mower is missing devDependencies — run `npm install` in the repo root. |
| `getLatestLogs` returns nothing | `$MOWER_LOG_DIR` is wrong, or no `*.jsonl` / `*.log` files yet (the mower app hasn't run). |
| `readFile` or filtered `getLatestLogs` returns no matches | The regex did not match, or the wrong file/path was selected. Retry with broader input or lower-context filtering. |
| A full `test` run is truncated in the client | The suite completed, but the returned text payload hit response limits. Re-run a narrower `test`, or save output and fetch it with `readFile`. |
| `sync` fails with `would clobber` | The mower has uncommitted changes — SSH in and resolve manually. The server intentionally uses `--ff-only` so it never overwrites local work. |
