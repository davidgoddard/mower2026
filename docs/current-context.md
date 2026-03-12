# Current Context

Last updated: 2026-03-12

This file is the handoff point for future Codex sessions. Read this first, then read `docs/overview.md` for original intent and `docs/architecture.md` for structure.

## Project Boundary

The active codebase is `/Volumes/mower/mower`.

Legacy code in `/Volumes/mower/legacy/mower` is reference material only. It is still useful for:
- games controller HID mapping
- old hardware assumptions
- hardware behavior comparison

The current phase is not autonomy yet. The correct immediate boundary is:

1. a core Pi app that boots into manual driving with the games controller
2. a landing page on the phone that can switch modes
3. live telemetry viewing and session logging
4. site capture and review after manual driving is stable
5. deterministic coverage planning after that
6. autonomous execution after that

Do not fall back to log-parsing dashboards for the main runtime path. The phone viewer should reflect live runtime state.

## Sensor Status

Current practical status:

- IMU: working on hardware and manually verified
- GNSS: live node polling exists, but still needs full integrated runtime validation under motion
- Motor feedback: live node polling exists, but still needs integrated runtime validation under motion

Conclusion:
- sensor bring-up is good enough to proceed into manual-drive integration
- full multi-sensor runtime validation is still pending

GNSS startup policy decision:

- do not depend on the rover ESP reprogramming the UM982 on every boot
- provision the UM982 once and persist that configuration on the receiver itself
- the ESP should default to passive startup: parse logs, relay RTCM, and verify expected logs

## IMU Status

The BMI160 path is implemented and tested in the main TypeScript codebase.

Relevant files:
- `src/hardware/bmi160ImuSensor.ts`
- `src/sensing/imuAdapter.ts`
- `src/estimation/poseEstimator.ts`
- `src/app/runtimeApp.ts`

Manual verification result:
- IMU reads looked healthy
- gyro near zero when stationary
- accelerometer gravity magnitude near 9.8 m/s^2
- user confirmed the IMU is working correctly

Extra manual tooling exists:
- `external-hardware/manual-tests/imu_manual_test.js`
- `external-hardware/manual-tests/imu_viewer_server.js`
- `external-hardware/manual-tests/imu_viewer.html`

## Core App Boundary

The intended operator entrypoint is now:

- `pi-app/core_server.js`
- `pi-app/web/core_dashboard.html`

Current core app behavior:

- starts in `manual` mode by default
- exposes three operator modes:
  - `manual`
  - `site_capture`
  - `autonomous`
- keeps the live controller, GNSS, IMU, motor, and estimator loop active across those modes
- allows first-pass site capture and saves site JSON files under `pi-app/data/sites/`

Current limitation:

- `autonomous` mode is a shell only
- lane selection, area selection, and mowing execution are not implemented yet

## Live Manual Drive Tooling

The older manual-drive bring-up stack still exists under `external-hardware/manual-tests/`.

Primary files:
- `hidGameController.js`
  - reads the games controller using legacy `node-hid`
  - uses the legacy vendor/product mapping from the old project
- `controller_inspector.js`
  - verifies controller connection and raw control/button mapping
- `manual_drive_server.js`
  - live integration server
  - reads controller input
  - commands motor node
  - polls GNSS, IMU, and motor feedback
  - serves phone dashboard over HTTP/SSE
  - writes JSONL session logs
- `manual_drive_dashboard.html`
  - phone-oriented live dashboard

Current default core-app port:
- `8090`

## Calibration Status

The repo now contains a first-pass calibration subsystem in the main TypeScript codebase.

Relevant files:
- `src/app/calibrationApp.ts`
- `src/calibration/calibrationSupervisor.ts`
- `src/calibration/testSequences.ts`
- `src/calibration/metrics.ts`
- `src/calibration/parameterFitter.ts`
- `src/calibration/calibrationTypes.ts`
- `src/calibration/automaticCalibrationController.ts`
- `external-hardware/manual-tests/calibration_runner_server.js`
- `external-hardware/manual-tests/calibration_dashboard.html`

What exists now:
- a planned calibration sequence for static hold, left/right spins, straight forward/reverse runs, and a combined arrival trial
- metric extraction for spin response, antenna excursion, straight-line bias, oscillation, and arrival error
- a supervisor that runs the sequence through a single executor boundary and emits telemetry/events
- a report with first-pass recommendations for turn scale, line gain scale, pivot antenna excursion, and arrival tolerance
- a real Pi-side automatic calibration runner with a phone dashboard and JSONL logs
- closed-loop trial control for hold, spin, straight-line, and arrival maneuvers using the live estimator state
- iterative calibration loops that keep repeating until the operator stops them
- persistence of learned `calibrationTurnScale`, `calibrationLineGainScale`, `pivotAntennaExcursionMeters`, and `waypointArrivalToleranceMeters` into `config/system-parameters.json`
- a phone scoreboard focused on the three operator goals:
  - turning accuracy
  - straight-line tracking
  - arrival distance

What still does not exist:
- a phone/web UI for reviewing calibration history graphically
- a bounded improvement loop that retries multiple profiles and chooses the best one automatically

## Important Fixes Already Made

### 1. IMU integration in the estimator

The estimator now supports IMU yaw-rate ingestion and the runtime/test coverage was added.

Relevant files:
- `src/estimation/adaptiveTrust.ts`
- `src/estimation/poseEstimator.ts`
- `tests/estimation/poseEstimator.test.ts`

### 2. Mixed timestamp-domain heading bug

A real bug was found during manual-drive logging:

- IMU timestamps use host epoch time
- GNSS and motor feedback timestamps use node-local time
- `PoseEstimator` was using `estimate.timestampMillis` as the IMU integration reference
- after GNSS or motor updates, the estimate timestamp could jump to a different clock domain
- next IMU sample would then integrate over a fake large `dt`
- result: heading jumps wildly even while sensors are stable

Fix applied:
- `PoseEstimator` now tracks `lastImuTimestampMillis` and integrates IMU yaw against the previous IMU sample time instead of whichever measurement last wrote `estimate.timestampMillis`

Relevant file:
- `src/estimation/poseEstimator.ts`

Regression coverage:
- `tests/estimation/poseEstimator.test.ts`

### 3. Manual-drive arm/disarm mapping

The first live session showed wheel targets staying at zero because manual drive was never armed.

The original server only armed on controller `top`.

Current behavior:
- `top` or `right-top` arms manual drive
- `cross` or `left-top` disarms manual drive

Relevant files:
- `external-hardware/manual-tests/manual_drive_server.js`
- `external-hardware/manual-tests/manual_drive_dashboard.html`

## Session Log That Exposed The Bugs

Useful reference log:
- `external-hardware/manual-tests/manual-drive-2026-03-11T11-17-11-619Z.jsonl`

What it showed:
- controller speed changed
- `manualDriveEnabled` stayed false
- command mode stayed `stopped`
- wheel targets remained zero
- estimate heading jumped around despite low IMU gyro values

That log is the reference case for the two fixes above.

## Current Expected Behavior

After restarting `manual_drive_server.js` with the latest code:

- live heading should stop making large random jumps caused by clock-domain mixing
- wheel targets should become nonzero once manual drive is armed and stick demand is nonzero
- the phone dashboard should reflect controller, command, motor feedback, GNSS, IMU, and estimate state live

## Known Remaining Risks

These items are not resolved yet:

- GNSS heading may still wander at very low ground speed; if the phone display still feels noisy while stationary, inspect GNSS heading trust gating rather than blaming the IMU
- actual motor polarity and drive direction still need live confirmation on hardware
- motor node watchdog/fault behavior still needs validation during real driving
- the live manual-drive server is still a practical bring-up layer, not yet the final production runtime entrypoint

## Planning Direction Locked In

The canonical post-calibration workflow is now:

1. use manual drive to confirm GNSS, IMU, and motor telemetry are healthy
2. open a site-capture page and start perimeter capture
3. drive the outer boundary manually while the mower auto-samples points
4. capture zero or more obstacle polygons
5. finish capture and review raw and simplified geometry
6. generate a deterministic coverage plan
7. inspect suggested areas, orientations, and stripe lanes
8. save the mission plan
9. later place the mower anywhere inside or near the site and press start mowing
10. let the mower choose the best local area and lane entry before autonomous mowing begins

Important design constraints:

- the planner must emit mission geometry and lane intent, not wheel speeds
- mission start must not assume a fixed starting point
- the first implementation of mission entry can use nearest-lane-endpoint selection with heading-change tie-breaking
- the feature matrix in `docs/requirements-traceability.md` is the source of truth for what exists versus what is still missing

Planned modules for this layer:

- `src/site/siteTypes.ts`
- `src/site/siteCaptureRecorder.ts`
- `src/planning/coverageTypes.ts`
- `src/planning/polygonDecomposer.ts`
- `src/planning/orientationSearch.ts`
- `src/planning/coveragePlanner.ts`
- `src/planning/geojsonExport.ts`
- `src/app/siteCaptureApp.ts`
- `src/app/missionPlannerApp.ts`
- `src/app/missionExecutorApp.ts`

Current implementation status for this layer:

- `src/site/siteTypes.ts` exists
- `src/site/siteCaptureRecorder.ts` exists
- automatic sampling thresholds match the agreed first-pass behavior:
  - distance >= `0.15 m`
  - heading change >= `8 deg`
  - elapsed time >= `2 s`
- recorder supports:
  - perimeter capture
  - obstacle capture
  - undo last point
  - discard current obstacle
  - polygon closure
  - basic simplification
  - basic validation warnings
- `pi-app/core_server.js` now owns the intended operator flow
- `pi-app/web/core_dashboard.html` now provides the landing page and mode switching
- completed site captures are currently persisted as JSON files under `pi-app/data/sites/`
- `src/planning/coverageTypes.ts` now exists
- `src/planning/orientationSearch.ts` now exists
- `src/planning/coveragePlanner.ts` now exists
- `src/planning/missionStartSelector.ts` now exists
- the core app can now:
  - review the latest saved site
  - generate a first deterministic coverage plan
  - persist generated plans under `pi-app/data/plans/`
  - select the nearest lane endpoint from the current live pose
- the core app map now overlays:
  - saved perimeter
  - saved obstacles
  - generated coverage lanes
  - selected mission-start point
- `src/execution/missionTypes.ts`, `src/execution/laneMissionBuilder.ts`, and `src/execution/laneExecutor.ts` now exist
- the first lane executor path now:
  - decomposes a selected lane into turn, drive, turn, drive, and arrive segments
  - hands those segments to the existing line tracker and wheel command planner
  - exposes active execution phase and segment state in the core dashboard
  - executes one selected lane in `autonomous` mode before stopping
- `tests/execution/laneExecutor.test.ts` now provides a deterministic end-to-end emulator test for one lane
- the older `external-hardware/manual-tests/` servers should now be treated as bring-up artifacts, not the main app boundary
- current planning limits:
  - one area only
  - no non-convex decomposition
  - no multi-lane mission execution yet after the first selected lane completes

## Recommended Next Step

Run the core Pi app again on the Pi with wheels off the ground first.

Suggested sequence:

1. `cd /Volumes/mower/mower && npm run build`
2. `node pi-app/core_server.js`
3. open `http://<pi-ip>:8090` on the phone
4. confirm the app starts in `manual` mode
5. arm with `right-top` or `top`
6. confirm wheel targets change with stick demand
7. confirm actual wheel feedback changes
8. switch to `site_capture` mode and confirm capture controls are live
9. only then test on the ground

## After Manual Drive Is Stable

The planned sequence should be:

1. calibration app
2. use manual-drive sessions to tune GNSS/IMU/motor blending
3. get clean pivots, straight drives, and stopping accuracy
4. site capture app using the same controller/runtime stack
5. site review and validation
6. mowing plan derivation
7. autonomous execution with start-area and start-lane selection

## Commands And Validation

Project commands:

```sh
cd /Volumes/mower/mower
npm run build
npm test
```

Latest known validation result before this handoff:
- `npm run build` passes
- `node --test dist/tests/**/*.test.js` fails with `63/64` passing
- current failure: `tests/protocols/gnssCodec.test.ts` still expects a fixed GNSS payload length of `34`, while the current codec emits `36`

## Files Most Worth Reading Next Session

If starting fresh, read in this order:

1. `docs/current-context.md`
2. `docs/overview.md`
3. `docs/architecture.md`
4. `external-hardware/README.md`
5. `external-hardware/manual-tests/manual_drive_server.js`
6. `src/estimation/poseEstimator.ts`
