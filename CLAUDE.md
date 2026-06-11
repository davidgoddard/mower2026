# Mower2026 — Claude Instructions

## Required reading at the start of every session

Before doing any work in this repository, read these files in order:

1. [AGENTS.md](AGENTS.md) — project rules, hardware context, required checks, and coding constraints
2. [docs/system-map.md](docs/system-map.md) — source code map; use this to locate files before searching
3. [docs/functional-specification.md](docs/functional-specification.md) — source of truth for intended behaviour; if code and spec disagree, ask before changing behaviour
4. [docs/mcp-server.md](docs/mcp-server.md) — the on-mower MCP server that exposes `build`, `test`, `sync`, and `getLatestLogs` to Claude Code. The dev workstation only has a static clone, so when the `mower` MCP server is reachable in `/mcp`, use these tools to verify changes against real hardware. Always `sync` before `build`/`test` after pushing.
