# User Guide

## Purpose

This project aims to produce an autonomous mower that can:

- be manually driven for setup and testing
- learn calibration parameters in a controlled test area
- record waypoints and routes
- replay routes autonomously with improved path quality

## Planned operator workflow

1. Power on the mower and wait for node health and localization readiness.
2. Use manual control mode to drive and inspect telemetry health.
3. Run calibration in a clear test area when requested by the software workflow.
4. Record route waypoints in manual mode.
5. Review logs and calibration results.
6. Execute autonomous replay once requirements are satisfied.

## Current limitation

The new codebase is in active development. This guide documents intended operator flow, not a completed operator procedure yet.
