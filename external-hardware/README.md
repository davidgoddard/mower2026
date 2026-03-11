# External Hardware

This folder contains hardware-facing deliverables intended to be dropped into external tooling such as Arduino IDE or run directly on the mower/Pi for manual verification.

## Current contents

- `esp32/motor-controller-v2/`
  - second-generation motor controller sketch
- `esp32/gnss-node-v2/`
  - second-generation rover GNSS sketch
- `manual-tests/`
  - simple Pi-side manual exercisers

## Current status

These files are produced from the new project architecture and protocol, but they have not been flashed or exercised on the real hardware from this environment.

They are intended as the first practical bring-up artifacts.

## Shared configuration

- Project-wide persisted parameters live in `config/system-parameters.json`.
- Motor inversion for the manual test scripts is read from `leftMotorForwardSign` and `rightMotorForwardSign` in that file.
- Motor trim values can also be stored there for future runtime or firmware use, but the current manual test scripts do not scale their commanded maneuvers with those values.
- Hardware scripts may be pointed at a different JSON file by setting `MOWER_CONFIG_PATH`.

## Manual tests

Current Pi-side scripts:

- `manual-tests/motor_manual_test.js`
  - active drive test for spins, straight runs, reversals, and gentle arcs, using physical wheel-direction mapping and steady-state speed/PWM summaries for tuning left-right balance
- `manual-tests/motor_mode_test.js`
  - direct wheel-direction test for confirming inversion and one-wheel-only modes such as `FF`, `FR`, `F0`, and `0F`
- `manual-tests/motor_idle_noise_test.js`
  - zero-command FG noise test for checking whether the motor feedback lines stay quiet when the mower is stationary
- `manual-tests/gnss_manual_test.js`
  - GNSS node polling and comms-health test; intended to remain useful even indoors with poor fix quality
- `manual-tests/imu_manual_test.js`
  - Pi-side BMI160 IMU test using the new hardware abstraction layer; prints 3-axis gyro and 3-axis acceleration samples
- `manual-tests/imu_viewer_server.js`
  - local IMU visualizer server; serves `manual-tests/imu_viewer.html` with a live 3D mower orientation view based on BMI160 samples
- `manual-tests/hardware_dashboard_server.js`
  - phone-friendly combined dashboard; serves `manual-tests/hardware_dashboard.html` and reads `imu.log`, `gps.log`, and `motor_test.log`
- `manual-tests/controller_inspector.js`
  - legacy-HID-based controller probe; confirms the games controller is detected and shows live button/axis state using the legacy vendor/product mapping
- `manual-tests/manual_drive_server.js`
  - live manual-drive integration server; reads the games controller, drives the motor node, polls GNSS + IMU + motor feedback, serves `manual-tests/manual_drive_dashboard.html`, and writes a JSONL session log
