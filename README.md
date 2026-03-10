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

- `docs/overview.md`: original project overview and intent.
- `docs/functional-specification.md`: formalized requirements.
- `docs/requirements-traceability.md`: requirement implementation status.
- `docs/architecture.md`: runtime architecture and module boundaries.
- `docs/protocol.md`: binary wire protocol and payload layout.
- `docs/firmware-integration.md`: Pi-to-ESP expectations and shared fault bits.
- `docs/gnss-firmware-spec.md`: recommended UM982 logs and GNSS ESP data mapping.
- `docs/motor-firmware-spec.md`: motor ESP responsibilities and wheel-speed execution contract.
- `docs/motor-firmware-migration.md`: concrete migration path from the legacy motor driver interface.
- `docs/default-parameters.md`: current default geometry, mowing, and execution assumptions.
- `docs/development-guide.md`: engineering workflow for this codebase.
- `docs/user-guide.md`: operator-oriented guide for the planned system.

## Tooling

The project uses plain TypeScript and Node's built-in test runner to keep the baseline simple.

## Commands

If `node`, `npm`, and `tsc` are not on `PATH`, use the explicit binaries already present on this machine:

```sh
/usr/local/bin/npm run build
/usr/local/bin/npm test
```
