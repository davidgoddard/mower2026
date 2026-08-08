# Development Guide

## Source of truth

- The mower is a Raspberry Pi based project and requires the Pi to be mounted as a drive - always check and ask if the pi is not available.  The code lives in `/Volumes/mower/mower` when mounted or something similar
- Requirements are tracked in [docs/functional-specification.md](functional-specification.md)
- Sensor API and payload contracts are tracked in [docs/sensors.md](sensors.md)

## Engineering rules

- Keep modules small and responsibility-driven.
- Prefer pure functions for geometry, math, validation, and protocol packing.
- Add or update unit tests with each feature.
- Keep protocol payloads compact and versionable.
- Do not bypass runtime interfaces for turn-tuning, drive-tuning, or control code.
- Keep operator docs current when runtime workflows or persisted parameters change.
- There is currently no calibrated mower translational-speed model in the app. Do not introduce meters-per-second vehicle-speed assumptions or speed-based plausibility gates into runtime control, GNSS validation, or learning logic until the project explicitly adds that capability to the functional specification.

## Current stabilization priorities

1. Keep the Pi runtime and docs aligned around the real operator workflows.
3. Add tests for all changes
4. Remove stale helper files, generated diffs, and workstation metadata from the repo.

## Testing approach

- Use unit tests first for all algorithmic and specification related operations
- Add hardware integration tests

## Runtime and Pi tooling

- Prefer Node 20 on the Raspberry Pi for this project's hardware-facing scripts.
- Current manual I2C exercisers depend on `i2c-bus`, which is not presently a safe choice for Node 22.
- Use `nvm` to select Node 20 before running `npm install` or any manual hardware script.
- Rebuild native dependencies whenever the Node major version changes.
- The production launcher executes `dist/server/main.js`, which now directly starts the single app/control HTTP server used by the operator pages and `/api/*`, so `npm run build` is required before `npm run start` or `systemctl start mower`.
- `/Volumes/Mower/mower` is the mounted live mower software tree, not a detached workstation clone. The on-mower `mower` MCP server is configured and verified for `build`, `test`, `getLatestLogs`, `readFile`, and `sync`; prefer it because local build/test execution through the mount remains unsupported. The live mount normally makes `sync` unnecessary. See [docs/mcp-server.md](mcp-server.md) for setup and usage.
