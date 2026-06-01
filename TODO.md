# Deployment TODO

Action items required to bring the deployed mower onto the GNSS-validator architecture and the new firmware payload.

## Hardware / firmware

### 1. Flash the GNSS ESP32

Flash `external-hardware/esp32/gnss-node-v2/gnss-node-v2.ino` to the GNSS ESP32.

The payload is now 40 bytes with a new layout. The Pi codec rejects any frame
from the old firmware with `Invalid GNSS payload length`, so the codec and
firmware must change together.

### 2. Reconfigure the UM982 RTK timeouts

Send these commands to the UM982 (over the COM2 serial passthrough) and then
`SAVECONFIG` so they persist across power cycles:

```
CONFIG RTK TIMEOUT 5
CONFIG DGPS TIMEOUT 5
SAVECONFIG
```

Reason: the previous 600 s timeout would let the receiver report `RTK Fixed`
for ten minutes after RTCM corrections stopped, masking a base-station outage
as a good fix. With the base ~30 m away over ESP-NOW, anything more than a
few seconds without RTCM means something is genuinely wrong and the validator
should demote position immediately.

Optionally raise the rates of the auxiliary logs while you're in there — the
validator benefits from fresh heading-quality data on every PVTSLN sample:

```
UNIHEADINGA COM2 0.05
RECTIMEA COM2 10
SAVECONFIG
```

(`UNIHEADINGA` at 20 Hz to match `PVTSLNA`; `RECTIMEA` at 0.1 Hz because UTC
validity changes slowly and 1 Hz is overkill once the clock is stable.)

The firmware has `CONFIGURE_RECEIVER_AT_BOOT = false` by design, so none of
this happens automatically — it's a one-shot manual provisioning step.

## Pi-side checks

### 3. Build

Run `npm run build` in `/home/mower/mower`. The Pi codec, validator,
poseFusion, sensorController, and event types all changed.

### 4. Clean up the deployed pose-calibration.json

The file on the deployed mower still has `wheelbaseMeters: 1.7431` from the
bad calibration run. The new plausibility-clamp will reject it on load and
fall back to 0.55 m, but you can also just overwrite the file with the same
content as the repo version to make the next boot log clean rather than
warn-noisy.

### 5. Run the test suite

Run `npm test` once after build.

`gnssCodec.test.js` was rewritten for the new payload. `poseFusion.test.js`
(739 lines) still targets the removed agreement-gate / blend-factor model and
will fail. Those failures are diagnostic of test staleness, not real
regressions — but you'll want to know which tests need updating before
relying on `npm test` as a green-light.

## Optional follow-up

Once the validator is running cleanly and a straight-line drive works,
re-run the dead-reckoning calibrator to write real per-wheel `metersPerTick`
and the actual measured wheelbase. That replaces the symmetric uncalibrated
defaults with measured values.
