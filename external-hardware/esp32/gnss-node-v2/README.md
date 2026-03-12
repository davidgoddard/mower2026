# GNSS Node V2

## Purpose

This folder contains a practical replacement ESP32 rover GNSS sketch for the second-generation mower protocol.

File:

- `gnss-node-v2.ino`
- `UM982-module-pinout.md`

## What it does

- runs as I2C slave at `0x52`
- receives RTCM fragments over ESP-NOW and forwards them to the UM982
- assumes the UM982 has already been configured persistently
- verifies expected logs at startup
- parses:
  - `PVTSLNA`
  - `RECTIMEA`
  - `UNIHEADINGA`
- returns the compact framed GNSS payload expected by the Pi-side protocol

## Important behavior

- absence of a base station does not block operation
- if RTCM is missing, the node still serves GNSS data using whatever fix quality is available
- this supports manual driving and controller-based use even when autonomous accuracy is not available

## Before flashing

Check the development configuration section at the top of the sketch:

- `BASE_LATITUDE_DEGREES`
- `BASE_LONGITUDE_DEGREES`
- `ALLOW_DYNAMIC_ORIGIN_IF_BASE_IS_ZERO`
- `ANTENNA_BASELINE_METERS`
- `ANTENNA_BASELINE_TOLERANCE_METERS`

Recommended usage:

- for real lawn operation, set the fixed base latitude/longitude
- for quick bring-up, leave base at zero and allow dynamic origin

Also confirm the current wiring assumptions in the sketch:

- UM982 serial baud: `115200`
- UM982 UART on ESP32 `Serial2`
- UM982 RX on ESP32 `GPIO16`
- UM982 TX on ESP32 `GPIO17`
- Pi-facing I2C address: `0x52`
- Pi-facing I2C pins on the ESP32: `GPIO21` SDA and `GPIO22` SCL
- heading quality LED: `GPIO5`
- position quality LED: `GPIO18`
- RTCM activity LED: `GPIO19`

The specific UM982 breakout module pin/header mapping used on this mower is documented in [UM982-module-pinout.md](/Volumes/mower/mower/external-hardware/esp32/gnss-node-v2/UM982-module-pinout.md).

Key point:

- the lower labeled header row `EN GND TXD RXD VCC PPS` is the receiver `COM2` UART on this module
- the rover ESP wiring and log configuration should therefore use `COM2`

## LED indicators

The sketch restores the three practical status LEDs from the legacy rover firmware:

- `GPIO5` heading quality
- `GPIO18` position quality
- `GPIO19` RTCM activity

Heading and position LEDs use the same pattern:

- off: no usable solution
- `1` flash every `2 s`: single-point solution
- `2` flashes every `2 s`: differential solution
- `3` flashes every `2 s`: float RTK solution
- solid on: fixed RTK solution

RTCM activity on `GPIO19` pulses briefly whenever a complete RTCM fragment block is received over ESP-NOW and forwarded to the UM982.

If no fresh `PVTSLNA` fix has been parsed for more than about `2 s`, the heading and position LEDs are forced off.

## Serial diagnostics

The sketch now emits a compact debug line about once per second on the USB serial console at `115200`.

Example:

```text
[GNSS] lines=128 pvtslna=42 rectimea=4 uniheadinga=21 unknown=11 logConfig=ok(111) fix=single sats=17 headingValid=yes receiverAgeMs=12 pvtslnaAgeMs=95 uniheadingAgeMs=180 rtcmAgeMs=640 uniloglistAgeMs=220
```

Interpretation:

- `lines`
  - total UM982 text lines seen by the ESP
- `pvtslna`
  - how many `#PVTSLNA` logs have been parsed
- `rectimea`
  - how many `#RECTIMEA` logs have been parsed
- `uniheadinga`
  - how many `#UNIHEADINGA` logs have been parsed
- `fix`
  - current compact fix state derived from `PVTSLNA`
- `logConfig`
  - result of the post-config `UNILOGLIST` verification
  - `ok(111)` means `PVTSLNA COM2`, `RECTIMEA COM2`, and `UNIHEADINGA COM2` were all observed in the receiver log list
  - `partial` means only some of the expected logs were present
  - `none` means the verification ran but none of the expected logs were observed
  - `unknown` means no `UNILOGLIST` result has been parsed yet
- `sats`
  - current satellites-in-use count from `PVTSLNA`
- `headingValid`
  - whether the rover currently has a usable heading solution
- `receiverAgeMs`
  - milliseconds since any UM982 line was last seen
- `pvtslnaAgeMs`
  - milliseconds since the last parsed `PVTSLNA`
- `uniheadingAgeMs`
  - milliseconds since the last parsed `UNIHEADINGA`
- `rtcmAgeMs`
  - milliseconds since the last complete RTCM block was forwarded to the UM982
- `uniloglistAgeMs`
  - milliseconds since the last parsed `UNILOGLIST` response

Useful failure patterns:

- `lines=0`
  - ESP is not receiving any UM982 serial output
- `lines` increasing but `pvtslna=0`
  - UM982 is talking, but not producing the expected `PVTSLNA` log
- `pvtslna` increasing but `fix=none sats=0`
  - parser is running, but the receiver solution itself is not usable
- `rtcmAgeMs=none`
  - rover has not recently received complete RTCM correction blocks

Startup diagnostics were also extended:

- every configuration command sent to the UM982 is printed with:
  - `[GNSS-CONFIG] ...`
- the first few raw lines received back from the UM982 are printed with:
  - `[GNSS-RAW] ...`
- after configuration, the sketch now sends:
  - `UNILOGLIST`
  - and verifies that the three expected `COM2` logs are actually active

This makes it possible to tell whether the receiver is:

- echoing configuration commands
- returning errors
- outputting unexpected log types
- or simply not streaming `PVTSLNA`

## UM982 configuration

The preferred operating model is now:

1. configure the UM982 once through a direct serial session
2. save that configuration persistently on the receiver itself
3. leave the ESP sketch in passive startup mode
4. let the ESP verify and parse the existing logs on every reboot

The expected persistent receiver configuration is:

```text
freset
CONFIG ANTENNA POWERON
CONFIG NMEAVERSION V410
CONFIG RTK TIMEOUT 600
CONFIG RTK RELIABILITY 3 1
CONFIG PPP TIMEOUT 120
CONFIG HEADING OFFSET 0.0 0.0
CONFIG HEADING RELIABILITY 3
CONFIG HEADING FIXLENGTH
CONFIG HEADING LENGTH 30.00 5.00
CONFIG DGPS TIMEOUT 600
CONFIG RTCMB1CB2A ENABLE
CONFIG ANTENNADELTAHEN 0.0000 0.0000 0.0000
CONFIG PPS ENABLE GPS POSITIVE 500000 1000 0 0
CONFIG SIGNALGROUP 3 6
CONFIG AGNSS DISABLE
CONFIG BASEOBSFILTER DISABLE
CONFIG LOGSEQ 1
PVTSLNA COM2 0.1
RECTIMEA COM2 1
UNIHEADINGA COM2 0.2
```

Important notes:

- boot-time receiver programming is now disabled by default in the sketch
- the default startup behavior is only to send `UNILOGLIST` and verify the expected `COM2` logs
- `PVTSLNA COM2 0.1` requests `10 Hz`
- `RECTIMEA COM2 1` requests `1 Hz`
- `UNIHEADINGA COM2 0.2` requests `5 Hz`
- `CONFIG HEADING LENGTH 30.00 5.00` assumes about `0.30 m` antenna spacing with `0.05 m` tolerance
- `ascii` is not recommended because this receiver firmware rejects it with `PARSING FAILED NO MATCHING FUNC`
- `CONFIG ANTIJAM AUTO` should not be part of normal rover boot because it was observed to trigger another receiver/interface restart
- `CONFIG COM1/COM2/COM3 115200` should not be part of normal rover boot because they are unnecessary on the known-good mower wiring and can disrupt the active session
- if bench work ever requires ESP-driven reprovisioning again, that path still exists in the sketch as an opt-in debug setting rather than the default behavior

## Reference base-station configuration

The following base-station UM982 configuration was captured from the user's working base station on `2026-03-11` and is useful as a transport/reference baseline:

```text
CONFIG ANTENNA POWERON
CONFIG NMEAVERSION V410
CONFIG RTK TIMEOUT 120
CONFIG RTK RELIABILITY 3 1
CONFIG PPP TIMEOUT 120
CONFIG DGPS TIMEOUT 300
CONFIG RTCMB1CB2A ENABLE
CONFIG ANTENNADELTAHEN 0.0000 0.0000 0.0000
CONFIG PPS ENABLE GPS POSITIVE 500000 1000 0 0
CONFIG SIGNALGROUP 2
CONFIG ANTIJAM AUTO
CONFIG AGNSS DISABLE
CONFIG BASEOBSFILTER DISABLE
CONFIG COM1 115200
CONFIG COM2 115200
CONFIG COM3 115200
```

Important interpretation:

- this base configuration is relevant to whether RTCM correction data is being generated and forwarded
- it does **not** explain a rover state where `fixType = none`, `satellites = 0`, and `sampleAgeMillis = 65535`
- that rover state means the GNSS node is not seeing usable live receiver solution logs such as `PVTSLNA`, regardless of RTK quality

Differences from the rover-side bring-up configuration are not automatically faults:

- base `CONFIG RTK TIMEOUT 120` vs rover `600`
- base `CONFIG DGPS TIMEOUT 300` vs rover `600`
- base `CONFIG SIGNALGROUP 2` vs rover `CONFIG SIGNALGROUP 3 6`
- base may still use `CONFIG ANTIJAM AUTO` as part of one-time provisioning, but that command is intentionally excluded from the rover's normal boot sequence

Those may affect solution/correction behavior, but they do not by themselves explain the complete absence of rover `PVTSLNA` data.

## Current limitation

This sketch uses ASCII receiver logs for practicality and transparency.

That is acceptable for bring-up and functional testing, but the long-term target may still move to binary logs once the field mapping is proven on real hardware.

## Indoor bring-up expectations

For indoor comms testing, poor GNSS quality is expected.

Healthy indoor bring-up usually means:

- the Pi-side `gnss_manual_test.js` shows repeated coherent framed samples
- `commsHealthy: true`
- `invalidReads` stays at `0` or very low
- `fixTypeLabel` may remain `none` or `single`
- heading and accuracy fields may be present but should not be trusted for navigation indoors
