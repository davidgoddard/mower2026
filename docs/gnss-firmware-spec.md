# GNSS ESP Firmware Specification

## Purpose

This document defines the recommended UM982 receiver outputs and the GNSS ESP processing pipeline for the second-generation mower architecture.

It is derived from:

- the legacy rover ESP implementation in `/Volumes/mower/legacy/mower/arduino/mower-gps-rtk-rover-esp-now-dual-antenna`
- the UM982 command manual in `/Volumes/mower/legacy/mower/Unicore Reference Commands Manual For N4 High Precision Products_V2_EN_R1.4.pdf`

## Design goals

The GNSS ESP shall:

- continue to relay RTCM corrections to the rover receiver
- consume the minimum useful set of UM982 logs
- derive one compact mower-ready navigation sample per update cycle
- preserve heading and position quality separately
- avoid shipping verbose ASCII NMEA-style traffic to the Pi

## Recommended UM982 logs

### Primary runtime log

`PVTSLNB`

- Manual section: `7.3.24 PVTSLN`
- Manual pages: `211-213`
- Message ID: `1021`

Reason:

- `PVTSLN` already combines best position, best velocity, and heading information.
- It contains the exact class of fields the mower needs for runtime estimation.

Required `PVTSLN` fields for the GNSS ESP parser:

- `bestpos_type`
- `bestpos_lat`
- `bestpos_lon`
- `bestpos_hgt`
- `bestpos_hgtstd`
- `bestpos_latstd`
- `bestpos_lonstd`
- `bestpos_svs`
- `bestpos_solnsvs`
- `psrvel_north`
- `psrvel_east`
- `psrvel_ground`
- `heading_type`
- `heading_length`
- `heading_degree`
- `heading_pitch`
- `heading_trackedsvs`
- `heading_solnsvs`
- `gdop`
- `pdop`
- `hdop`

### Auxiliary time log

`RECTIMEB`

- Manual section: `7.3.47 RECTIME`
- Manual pages: `268-270`
- Message ID: `102`

Reason:

- gives clock validity and UTC validity
- helps discipline sample timestamps and diagnostics

Required `RECTIME` fields:

- `clock status`
- `offset`
- `offset std`
- `utc offset`
- `utc year`
- `utc month`
- `utc day`
- `utc hour`
- `utc min`
- `utc ms`
- `utc status`

### Auxiliary heading diagnostic log

`UNIHEADINGB`

- Manual section: `7.3.48 UNIHEADING`
- Manual pages: `270-272`
- Message ID: `972`

Reason:

- provides heading-specific quality metrics
- useful when `PVTSLN` heading quality needs cross-checking or better diagnostics

Required `UNIHEADING` fields:

- `sol stat`
- `pos type`
- `length`
- `heading`
- `pitch`
- `hdgstddev`
- `ptchstddev`
- `#SVs`
- `#solnSVs`
- `#obs`
- `#multi`
- `ext sol stat`

## UM982 logs not recommended as the primary runtime source

These may still be useful for bench debugging:

- `GPGGA` or `GPGGAH`
- `GPTHS`
- `GPGSTH`
- `GPRMC`
- `GPVTG`
- `GPTRA2`
- `GPROT2`
- `GPHPD`

But they should not be the normal Pi-facing runtime interface because:

- they are verbose ASCII
- they duplicate fields already available in `PVTSLN`
- they increase parsing and transport overhead

## Proposed output rates

Initial recommended rates:

- `PVTSLNB`: `10 Hz`
- `RECTIMEB`: `1 Hz`
- `UNIHEADINGB`: `5 Hz`

Rationale:

- position and heading runtime should be driven mainly by `PVTSLN`
- time validity changes slowly and does not need high rate
- heading diagnostic detail does not need to ride every cycle unless testing shows otherwise

These rates must still be validated against actual UM982 behavior and rover ESP CPU usage.

## Current sketch startup policy

The current ESP32 GNSS sketch in `external-hardware/esp32/gnss-node-v2/gnss-node-v2.ino` now defaults to a passive startup model over `Serial2` at `115200` baud.

Default startup sequence:

1. start the UART
2. begin parsing whatever the UM982 is already streaming
3. optionally send `UNILOGLIST`
4. verify whether the expected runtime logs are already active

This is now preferred because repeated runtime reconfiguration from the ESP has proven fragile on the mower hardware.

Expected operating model:

1. provision the UM982 once using a direct serial session
2. save that configuration persistently on the UM982 itself using the receiver's own persistence workflow
3. reboot normally
4. let the ESP only parse and verify logs at startup

Boot-time receiver programming still exists in the sketch as an opt-in bench/debug escape hatch, but it is disabled by default via:

```text
CONFIGURE_RECEIVER_AT_BOOT = false
```

Receiver configuration that should exist persistently on the UM982:

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

Interpretation of the runtime log commands:

- `PVTSLNA COM2 0.1` requests `PVTSLNA` at `10 Hz`
- `RECTIMEA COM2 1` requests `RECTIMEA` at `1 Hz`
- `UNIHEADINGA COM2 0.2` requests `UNIHEADINGA` at `5 Hz`

Commands deliberately excluded from normal rover boot:

- `ascii`
  - this UM982 firmware rejects it with `PARSING FAILED NO MATCHING FUNC`
- `CONFIG ANTIJAM AUTO`
  - observed to trigger a later receiver/interface restart, clearing the volatile session
- `CONFIG COM1 115200`
- `CONFIG COM2 115200`
- `CONFIG COM3 115200`
  - unnecessary on the known-good mower hardware and risky during runtime boot

Currently classified delayed command:

- `CONFIG SIGNALGROUP 3 6`
  - returns `OK`
  - then emits a delayed `$devicename,...` event
  - therefore the startup sequencer waits for that second readiness marker before continuing
  - if that delayed readiness event never arrives within the extended timeout window, startup configuration aborts

On normal boot, the sketch only sends `UNILOGLIST` and parses the response to verify that all three expected `COM2` logs are actually active. The serial `[GNSS]` status line reports this as:

- `logConfig=ok(111)` when all three logs are present
- `logConfig=partial(...)` when only some are present
- `logConfig=none(000)` when none are present
- `logConfig=unknown` before any `UNILOGLIST` response has been parsed

The mower's current UM982 breakout module wiring uses the lower header row labeled:

```text
EN  GND  TXD  RXD  VCC  PPS
```

That header is the receiver `COM2` UART for this project wiring. See [UM982-module-pinout.md](/Volumes/mower/mower/external-hardware/esp32/gnss-node-v2/UM982-module-pinout.md).

Reference base-station config captured from the user's working base on `2026-03-11`:

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

This is useful for documenting the correction source, but it does not by itself explain a rover node showing:

- `fixType = none`
- `satellites = 0`
- `sampleAgeMillis = 65535`

That symptom indicates the rover is not parsing usable live receiver logs such as `PVTSLNA`.

The heading-length command currently encodes an antenna baseline assumption of about `0.30 m` with `0.05 m` tolerance.

## GNSS ESP processing pipeline

1. Receive RTCM fragments over ESP-NOW from the base node.
2. Reassemble full RTCM messages.
3. Forward RTCM messages to the UM982 serial port.
4. Read `PVTSLNB` continuously.
5. Read `RECTIMEB` at low rate for time validity.
6. Optionally read `UNIHEADINGB` for heading-quality enrichment.
7. Convert receiver fields into one compact navigation sample.
8. Expose that compact sample to the Pi over I2C.

## Indoor comms test guidance

The current Pi-side GNSS manual test is intended to prove I2C comms and coherent framing even when the mower is indoors.

Indoor success criteria:

- repeated valid framed GNSS samples
- low or zero invalid read count
- fresh `sampleAgeMillis`
- `fixType` may still be `none` or `single`

Indoor non-goals:

- precise local position
- trustworthy heading
- RTK float/fixed confirmation

## Pi-facing compact sample mapping

The GNSS ESP should produce the compact sample described in `src/protocols/gnssProtocol.ts`.

### Compact field mapping

| Pi-facing field | Source | Mapping |
| --- | --- | --- |
| `timestampMillis` | GNSS ESP local monotonic clock | capture at sample publication |
| `xMeters` | derived in GNSS ESP | convert from lat/lon to local mower frame |
| `yMeters` | derived in GNSS ESP | convert from lat/lon to local mower frame |
| `headingDegrees` | `PVTSLN.heading_degree` | include only when heading is valid |
| `pitchDegrees` | `PVTSLN.heading_pitch` or `UNIHEADING.pitch` | include when available |
| `groundSpeedMetersPerSecond` | `PVTSLN.psrvel_ground` | direct mapping |
| `positionAccuracyMeters` | derived from `latstd/lonstd/hgtstd` | use a conservative horizontal accuracy metric |
| `headingAccuracyDegrees` | prefer `UNIHEADING.hdgstddev`, else derive from heading type | include when available |
| `fixType` | `bestpos_type` | map to `none/single/float/fixed` |
| `satellitesInUse` | `bestpos_solnsvs` | use solution satellites rather than tracked count |
| `sampleAgeMillis` | GNSS ESP freshness tracker | time since last complete receiver update |

## Position frame decision

The GNSS ESP should convert receiver latitude/longitude to local `x/y` before sending to the Pi.

Reason:

- it shrinks the Pi-facing payload
- it keeps the estimator and guidance layers free from repeated geodetic conversion
- it matches the mower’s local-navigation problem better than global coordinates

### Reference frame rule

The GNSS ESP shall define a stable local tangent-plane reference.

Chosen decision:

- use the fixed base-station position as the local origin

Operational rule:

- base station = `(0, 0)` in the mower local frame
- if the base station is moved, previously recorded geometry is considered invalid and must be re-recorded

This is the current project assumption and should be treated as fixed unless the architecture is intentionally revised later.

## Antenna geometry notes

Current approximate mower geometry from the user:

- dual-antenna spacing is about `0.30 m`
- the antenna platform is angled by about `20-30 degrees`
- the center of the front antenna dome is about `0.07 m` in front of the main axle
- the rear antenna is behind the front antenna on the same platform
- both antennas are roughly centered laterally, but not precisely surveyed

Implication:

- the GNSS ESP and Pi-side estimator should treat these as provisional geometry values
- firmware should keep baseline length configurable rather than hard-coding one exact surveyed distance

## Receiver quality mapping

### Position quality

Map `bestpos_type` into Pi-facing fix quality:

- no valid solution -> `none`
- `SINGLE` or equivalent -> `single`
- float RTK types -> `float`
- fixed RTK integer types -> `fixed`

### Heading quality

Heading shall be considered valid only when the heading solution status and type indicate a computed heading.

At minimum:

- invalid or no solution -> heading omitted
- float heading solution -> heading included with reduced confidence
- fixed heading solution -> heading included with high confidence

## Data the new GNSS ESP should preserve from receiver output

These were effectively lost in the legacy rover ESP and should be retained now:

- horizontal accuracy proxy
- heading accuracy
- solution satellite count
- ground speed
- baseline length
- explicit freshness

## Remaining implementation decisions

The remaining GNSS firmware decisions and data gaps are tracked centrally in [requirements-traceability.md](requirements-traceability.md).

## Recommended next implementation step

When the GNSS ESP rewrite starts:

1. configure `PVTSLNB`, `RECTIMEB`, and `UNIHEADINGB`
2. verify actual observed rates and payload parsing
3. capture example decoded samples
4. validate local `x/y` conversion against a fixed base origin
5. lock the final Pi-facing compact message
