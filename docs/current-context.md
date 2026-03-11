# Current Context

Last updated: 2026-03-11

This file is the handoff point for future Codex sessions. Read this first, then read `docs/overview.md` for original intent and `docs/architecture.md` for structure.

## Project Boundary

The active codebase is `/Volumes/mower/mower`.

Legacy code in `/Volumes/mower/legacy/mower` is reference material only. It is still useful for:
- games controller HID mapping
- old hardware assumptions
- hardware behavior comparison

The current phase is not autonomy yet. The correct immediate boundary is:

1. manual driving with the games controller on the Pi
2. live telemetry viewing on a phone
3. session logging while manually driving
4. calibration tooling after manual driving is stable
5. perimeter capture and autonomous execution after that

Do not fall back to log-parsing dashboards for the main runtime path. The phone viewer should reflect live runtime state.

## Sensor Status

Current practical status:

- IMU: working on hardware and manually verified
- GNSS: live node polling exists, but still needs full integrated runtime validation under motion
- Motor feedback: live node polling exists, but still needs integrated runtime validation under motion

Conclusion:
- sensor bring-up is good enough to proceed into manual-drive integration
- full multi-sensor runtime validation is still pending

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

## Live Manual Drive Tooling

The current manual-drive stack is under `external-hardware/manual-tests/`.

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

Current default port:
- `8093`

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

## Recommended Next Step

Run live manual-drive bring-up again on the Pi with wheels off the ground first.

Suggested sequence:

1. `cd /Volumes/mower/mower && npm test`
2. `cd /Volumes/mower/mower/external-hardware/manual-tests`
3. `node controller_inspector.js`
4. confirm controller mapping and button labels
5. `node manual_drive_server.js`
6. open `http://<pi-ip>:8093` on the phone
7. arm with `right-top` or `top`
8. confirm wheel targets change with stick demand
9. confirm actual wheel feedback changes
10. only then test on the ground

## After Manual Drive Is Stable

The planned sequence should be:

1. calibration app
2. use manual-drive sessions to tune GNSS/IMU/motor blending
3. get clean pivots, straight drives, and stopping accuracy
4. perimeter capture app using the same controller/runtime stack
5. mowing plan derivation
6. autonomous execution

## Commands And Validation

Project commands:

```sh
cd /Volumes/mower/mower
npm run build
npm test
```

Latest known validation result before this handoff:
- `npm test` passes with `51/51`

## Files Most Worth Reading Next Session

If starting fresh, read in this order:

1. `docs/current-context.md`
2. `docs/overview.md`
3. `docs/architecture.md`
4. `external-hardware/README.md`
5. `external-hardware/manual-tests/manual_drive_server.js`
6. `src/estimation/poseEstimator.ts`
