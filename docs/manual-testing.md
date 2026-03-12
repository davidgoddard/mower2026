# Manual Testing

This page describes the Pi-side manual tests and viewer pages without bloating the root README.

## Scope

These tools are for hardware bring-up, live operator verification, and calibration preparation.

There are two categories:

- direct manual tests for one subsystem at a time
- live viewer pages for runtime observation

Important distinction:

- [manual_drive_server.js](../external-hardware/manual-tests/manual_drive_server.js) is the current live runtime-facing bring-up path
- [site_capture_server.js](../external-hardware/manual-tests/site_capture_server.js) is the first live perimeter/obstacle capture path built on top of the same manual-drive stack
- [hardware_dashboard_server.js](../external-hardware/manual-tests/hardware_dashboard_server.js) is an older log-driven dashboard and is not the main runtime boundary

## Prerequisites

- run on the mower Pi
- use Node 20 because the Pi-side scripts depend on `i2c-bus`
- build the TypeScript code first

Commands:

```sh
cd /Volumes/mower/mower
npm run build
```

Then run scripts from:

```sh
cd /Volumes/mower/mower/external-hardware/manual-tests
```

Shared configuration is loaded from:

- [config/system-parameters.json](../config/system-parameters.json)

That file controls:

- motor forward signs
- motor trim scales
- controller speed and steering polarity
- acceleration and deceleration limits
- motor ramp timings used by some tests

## Test Inventory

### `motor_mode_test.js`

Purpose:
- verify raw physical wheel direction one side at a time or in simple pairs

Examples:

```sh
node motor_mode_test.js FF
node motor_mode_test.js FR
node motor_mode_test.js F0
node motor_mode_test.js 0F
```

Expected behavior:
- `F` means physical forward wheel rotation
- `R` means physical reverse wheel rotation
- motion should now ramp up rather than slam on immediately
- printed feedback should show physical wheel speeds consistent with the commanded mode

Use this when:
- confirming motor sign mapping
- confirming left and right sides independently
- checking whether firmware direction handling is correct

File:
- [external-hardware/manual-tests/motor_mode_test.js](../external-hardware/manual-tests/motor_mode_test.js)

### `motor_manual_test.js`

Purpose:
- exercise straight drive, reverse, arcs, and spins while collecting motor feedback summaries

Expected behavior:
- wheel feedback should broadly match requested maneuvers
- left and right physical speeds should be similar for symmetric tests
- summary output should help decide trim adjustments

Use this when:
- tuning left/right wheel balance
- checking whether one side is consistently weak

File:
- [external-hardware/manual-tests/motor_manual_test.js](../external-hardware/manual-tests/motor_manual_test.js)

### `motor_idle_noise_test.js`

Purpose:
- verify feedback lines stay quiet with zero command

Expected behavior:
- wheel actual speed near zero
- no suspicious encoder chatter
- no unexpected watchdog/fault behavior while stationary

File:
- [external-hardware/manual-tests/motor_idle_noise_test.js](../external-hardware/manual-tests/motor_idle_noise_test.js)

### `gnss_manual_test.js`

Purpose:
- poll the GNSS node directly and confirm protocol/data health

Expected behavior:
- valid responses over I2C
- `fixType`, satellites, sample age, position, and optional heading fields should update
- indoors, poor fix quality is acceptable; communications stability is the main concern

File:
- [external-hardware/manual-tests/gnss_manual_test.js](../external-hardware/manual-tests/gnss_manual_test.js)

### `imu_manual_test.js`

Purpose:
- read the BMI160 directly and print gyro/accelerometer samples

Expected behavior:
- stationary gyro values near zero
- acceleration magnitude near gravity
- axis split depends on mounting orientation

File:
- [external-hardware/manual-tests/imu_manual_test.js](../external-hardware/manual-tests/imu_manual_test.js)

### `controller_inspector.js`

Purpose:
- verify the games controller is detected and mapped correctly before driving motors

Expected behavior:
- button presses appear with the expected labels
- forward/backward changes `speed`
- left/right changes `angleDegrees`
- current polarity comes from `config/system-parameters.json`

Use this when:
- verifying controller mapping after code or config changes
- checking whether a direction issue is in the controller layer or motor layer

File:
- [external-hardware/manual-tests/controller_inspector.js](../external-hardware/manual-tests/controller_inspector.js)

## Viewer Pages

### `imu_viewer_server.js` + `imu_viewer.html`

Purpose:
- live IMU-only orientation viewer

Expected behavior:
- roll and pitch reflect mower tilt
- yaw is relative only and can drift over time
- useful for verifying IMU orientation and sanity, not absolute heading truth

Run:

```sh
node imu_viewer_server.js
```

Open:

- `http://<pi-ip>:8091`

Files:
- [external-hardware/manual-tests/imu_viewer_server.js](../external-hardware/manual-tests/imu_viewer_server.js)
- [external-hardware/manual-tests/imu_viewer.html](../external-hardware/manual-tests/imu_viewer.html)

### `hardware_dashboard_server.js` + `hardware_dashboard.html`

Purpose:
- older combined phone dashboard driven from log files

Expected behavior:
- only reflects whatever is currently written to `imu.log`, `gps.log`, and `motor_test.log`
- not suitable as the main runtime viewer for manual driving

Use this only if:
- you specifically want to inspect recorded manual-test logs

Files:
- [external-hardware/manual-tests/hardware_dashboard_server.js](../external-hardware/manual-tests/hardware_dashboard_server.js)
- [external-hardware/manual-tests/hardware_dashboard.html](../external-hardware/manual-tests/hardware_dashboard.html)

### `manual_drive_server.js` + `manual_drive_dashboard.html`

Purpose:
- current live manual-drive integration path

What it does:
- reads the games controller live
- commands the motor node live
- polls GNSS, IMU, and motor feedback live
- serves a phone dashboard over SSE
- writes a JSONL session log

Run:

```sh
node manual_drive_server.js
```

Open:

- `http://<pi-ip>:8093`

Files:
- [external-hardware/manual-tests/manual_drive_server.js](../external-hardware/manual-tests/manual_drive_server.js)
- [external-hardware/manual-tests/manual_drive_dashboard.html](../external-hardware/manual-tests/manual_drive_dashboard.html)

Expected behavior:
- controller values update live
- GNSS panel shows live node samples, not log replay
- IMU panel shows live BMI160-derived state
- motor panel shows live feedback
- estimate panel shows the fused state
- `top` or `right-top` arms drive
- `cross` or `left-top` disarms drive

Recommended first test:

1. wheels off the ground
2. verify controller direction signs on the page
3. verify wheel targets move as expected
4. verify actual wheel feedback follows
5. only then test on the ground

### `calibration_runner_server.js` + `calibration_dashboard.html`

Purpose:
- current automatic calibration bring-up path

What it does:
- waits for live GNSS, IMU, motor, and estimator readiness
- runs the planned calibration sequence automatically
- repeats calibration iterations until you stop it
- updates learned control values after each completed iteration
- persists learned values into [config/system-parameters.json](../config/system-parameters.json)
- performs:
  - static hold
  - left and right pivots
  - straight forward and reverse runs
  - a combined arrival trial
- serves a phone dashboard over SSE
- writes JSONL event and telemetry logs

Run:

```sh
node calibration_runner_server.js
```

Open:

- `http://<pi-ip>:8094`

Files:
- [external-hardware/manual-tests/calibration_runner_server.js](../external-hardware/manual-tests/calibration_runner_server.js)
- [external-hardware/manual-tests/calibration_dashboard.html](../external-hardware/manual-tests/calibration_dashboard.html)

### `site_capture_server.js` + `site_capture_dashboard.html`

Purpose:
- first live site-capture path for perimeter and obstacle recording

What it does:
- reuses the same controller, GNSS, IMU, motor, and estimator path as manual drive
- serves a phone page with capture actions
- records perimeter and obstacle polygons using automatic waypoint sampling from live pose
- supports:
  - start perimeter
  - finish perimeter
  - start obstacle
  - finish obstacle
  - undo last point
  - discard current obstacle
  - discard full capture
  - finish capture and save site JSON
- writes a JSONL session log
- persists completed site models into `external-hardware/manual-tests/captures/`

Run:

```sh
node site_capture_server.js
```

Open:

- `http://<pi-ip>:8094`

Files:
- [external-hardware/manual-tests/site_capture_server.js](../external-hardware/manual-tests/site_capture_server.js)
- [external-hardware/manual-tests/site_capture_dashboard.html](../external-hardware/manual-tests/site_capture_dashboard.html)

Expected behavior:
- manual driving still behaves like the live bring-up path
- once perimeter capture is active, points are sampled automatically as the mower moves or turns
- the page shows the current perimeter, obstacles, active capture trace, and current pose
- finishing capture saves a site JSON file for later review/planning

Expected behavior:
- the `Start Calibration` button remains disabled until:
  - GNSS is float or fixed
  - GNSS heading is present and fresh
  - IMU is live
  - motor feedback is live
  - estimator is live
- once started, the mower should:
  - remain still briefly
  - pivot left and right without operator input
  - drive short straight lines
  - attempt a final target arrival
- the page should show three live goal cards:
  - turning accuracy
  - straight-line tracking
  - arrival distance
- those cards should move between red, orange, and green as the runner improves the profile
- each completed iteration should be added to a recent-history list
- learned values should persist across restart because they are written back to [config/system-parameters.json](../config/system-parameters.json)

Recommended first test:

1. place the mower in a clear open area with at least 2 m free in every direction
2. power the base station and wait for rover RTK quality to improve
3. confirm the GNSS LEDs and page both indicate healthy heading/fix
4. keep the e-stop or power cut available
5. start calibration from the phone page

## Expected Behaviors By Symptom

If joystick direction looks wrong:
- check [controller_inspector.js](../external-hardware/manual-tests/controller_inspector.js)
- then inspect `controllerSteeringSign` and `controllerSpeedSign` in [config/system-parameters.json](../config/system-parameters.json)

If wheel direction looks wrong:
- run [motor_mode_test.js](../external-hardware/manual-tests/motor_mode_test.js)
- then inspect `leftMotorForwardSign` and `rightMotorForwardSign`

If left/right balance is poor:
- run [motor_manual_test.js](../external-hardware/manual-tests/motor_manual_test.js)
- adjust motor trim scales from measured data rather than by feel

If stop response is too slow:
- inspect `maxWheelDecelerationMetersPerSecondSquared`
- inspect `motorRampDownMillis`

If GNSS page data looks too stable:
- note that the phone page rounds values for readability
- note that GNSS refresh is slower than the main control loop
- verify against [gnss_manual_test.js](../external-hardware/manual-tests/gnss_manual_test.js) if needed

## Current Recommended Workflow

1. `controller_inspector.js`
2. `motor_mode_test.js`
3. `motor_manual_test.js`
4. `imu_manual_test.js` or IMU viewer if needed
5. `gnss_manual_test.js`
6. `manual_drive_server.js`

That sequence isolates controller, motors, IMU, and GNSS before combined live driving.
