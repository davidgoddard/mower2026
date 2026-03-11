# GNSS Node V2

## Purpose

This folder contains a practical replacement ESP32 rover GNSS sketch for the second-generation mower protocol.

File:

- `gnss-node-v2.ino`

## What it does

- runs as I2C slave at `0x52`
- receives RTCM fragments over ESP-NOW and forwards them to the UM982
- configures the UM982 at startup
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

## UM982 configuration

At startup the sketch sends `ascii`, then this command set to the UM982:

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
CONFIG ANTIJAM AUTO
CONFIG AGNSS DISABLE
CONFIG BASEOBSFILTER DISABLE
CONFIG LOGSEQ 1
CONFIG COM1 115200
CONFIG COM2 115200
CONFIG COM3 115200
PVTSLNA COM2 0.1
RECTIMEA COM2 1
UNIHEADINGA COM2 0.2
```

Important notes:

- `PVTSLNA COM2 0.1` requests `10 Hz`
- `RECTIMEA COM2 1` requests `1 Hz`
- `UNIHEADINGA COM2 0.2` requests `5 Hz`
- `CONFIG HEADING LENGTH 30.00 5.00` assumes about `0.30 m` antenna spacing with `0.05 m` tolerance
- the sketch currently uses ASCII receiver logs for transparency during bring-up

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
