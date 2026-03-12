# User Guide

## Purpose

This project aims to produce an autonomous mower that can:

- be manually driven for setup and testing
- learn calibration parameters in a controlled test area
- capture mowing perimeters and obstacles by manual driving
- generate multi-area coverage plans
- start mowing from an arbitrary placement by choosing the best area and lane entry

## Planned operator workflow

1. Power on the mower and wait for the core app landing page to appear.
2. Start in manual mode and confirm controller, telemetry, and localization health.
3. Switch to site-capture mode to record the outer perimeter and any obstacles.
4. Review the raw capture and simplified geometry, then fix warnings if needed.
5. Generate and inspect a coverage plan.
6. Place the mower anywhere inside or near the site and switch to autonomous mode.
7. Start mowing.
8. Let the mower determine the best area and first lane before autonomous mowing begins.

## Current limitation

The new codebase is in active development. The landing-page core app and first-pass site capture exist, but planning and autonomous execution are not complete yet.
