# Development Guide

## Source of truth

- New code lives in `/Volumes/mower/mower`
- Legacy code in `/Volumes/mower/legacy/mower` is reference only
- Requirements are tracked in `docs/functional-specification.md`
- Implementation status is tracked in `docs/requirements-traceability.md`

## Engineering rules

- Keep modules small and responsibility-driven.
- Prefer pure functions for geometry, math, validation, and protocol packing.
- Add or update unit tests with each feature.
- Keep protocol payloads compact and versionable.
- Do not bypass runtime interfaces for calibration code.

## Immediate roadmap

1. Define packed wire protocols for GNSS and motor nodes.
2. Implement frame codec and CRC.
3. Implement node clients with transport-independent interfaces.
4. Implement geometry, measurement adaptation, and estimator foundations.
5. Design motor and GNSS firmware message changes.

## Testing approach

- Use unit tests first for pure TypeScript logic.
- Add replay-driven tests once telemetry schemas exist.
- Add hardware integration tests only after protocol boundaries stabilize.

## Runtime and Pi tooling

- Prefer Node 20 on the Raspberry Pi for this project's hardware-facing scripts.
- Current manual I2C exercisers depend on `i2c-bus`, which is not presently a safe choice for Node 22.
- Use `nvm` to select Node 20 before running `npm install` or any manual hardware script.
- Rebuild native dependencies whenever the Node major version changes.
