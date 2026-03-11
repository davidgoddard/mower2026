# Mower

Second-generation autonomous mower software for a Raspberry Pi with GNSS and motor ESP nodes.

## Current state

This directory is the new clean codebase. Legacy code in `/Volumes/mower/legacy/mower` is reference material only.

## Principles

- Pi owns system truth, planning, estimation, safety, and calibration.
- ESP nodes own real-time hardware execution.
- Protocols must stay compact enough for I2C now and portable to CAN later.
- Requirements and implementation status are tracked in project docs from the start.

## Documentation

- [docs/current-context.md](docs/current-context.md): latest implementation handoff and next-step summary for future sessions.
- [docs/manual-testing.md](docs/manual-testing.md): manual test scripts, live viewer pages, and expected bring-up behavior.
- [docs/overview.md](docs/overview.md): original project overview and intent.
- [docs/functional-specification.md](docs/functional-specification.md): formalized requirements.
- [docs/requirements-traceability.md](docs/requirements-traceability.md): requirement implementation status.
- [docs/architecture.md](docs/architecture.md): runtime architecture and module boundaries.
- [docs/protocol.md](docs/protocol.md): binary wire protocol and payload layout.
- [docs/firmware-integration.md](docs/firmware-integration.md): Pi-to-ESP expectations and shared fault bits.
- [docs/gnss-firmware-spec.md](docs/gnss-firmware-spec.md): recommended UM982 logs and GNSS ESP data mapping.
- [docs/motor-firmware-spec.md](docs/motor-firmware-spec.md): motor ESP responsibilities and wheel-speed execution contract.
- [docs/default-parameters.md](docs/default-parameters.md): current default geometry, mowing, and execution assumptions.
- [docs/development-guide.md](docs/development-guide.md): engineering workflow for this codebase.
- [docs/user-guide.md](docs/user-guide.md): operator-oriented guide for the planned system.

## Tooling

The project uses plain TypeScript and Node's built-in test runner to keep the baseline simple.

## Commands

If `node`, `npm`, and `tsc` are not on `PATH`, use the explicit binaries already present on this machine:

```sh
/usr/local/bin/npm run build
/usr/local/bin/npm test
```

## Developer setup

The core TypeScript code is intentionally simple, but the Pi-side manual hardware scripts currently depend on `i2c-bus`, which supports Node 20 rather than Node 22.

Use `nvm` on the Pi:

```sh
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 20
nvm use 20
nvm alias default 20
```

Then reinstall project dependencies under Node 20:

```sh
cd /Volumes/mower/mower
rm -rf node_modules package-lock.json
npm install
```

After that, manual hardware scripts can be run from:

```sh
cd /Volumes/mower/mower/external-hardware/manual-tests
node motor_manual_test.js
node gnss_manual_test.js
```

If `node` is not on `PATH`, use `/usr/local/bin/node` or reopen the shell after loading `nvm`.

## Manual Tests

Manual hardware tests and phone/web viewers are available for:

- motor direction and balance
- GNSS node polling
- IMU sanity checks
- games controller inspection
- live manual drive with phone telemetry

The full guide is here:

- [docs/manual-testing.md](docs/manual-testing.md)
