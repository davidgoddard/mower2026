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

Current recommended rates:

- `PVTSLNB`: `20 Hz`
- `RECTIMEB`: `1 Hz`
- `UNIHEADINGB`: `5 Hz`

Rationale:

- position and heading runtime should be driven mainly by `PVTSLN`
- 20 Hz bounds brake-point latency to ~50 ms (3.75 cm of travel at 0.75 m/s
  cruise) — half what 10 Hz gave and a material improvement for cm-class
  stopping accuracy
- time validity changes slowly and does not need high rate
- heading diagnostic detail does not need to ride every cycle unless testing
  shows otherwise

20 Hz `PVTSLN` has been confirmed sufficient for cm-class stop decisions. The
UM982 supports higher rates (up to 50 Hz on some firmware variants) but at
20 Hz the bottleneck becomes the physical stopping behaviour of the mower,
not the sample rate.

### UART budget

At 115200 baud the ESP32-to-UM982 UART has only ~30% headroom at 10 Hz
`PVTSLN` and would saturate at 20 Hz. The ESP32 sketch and UM982 are
configured for **460800 baud** instead, which gives comfortable headroom at
20 Hz and leaves room for 50 Hz if ever wanted.

The baud rate must be persisted on the UM982 (`CONFIG COM2 460800`) during
the one-time manual provisioning session. The ESP32 sketch opens its UART at
460800 unconditionally — a mismatched receiver baud will cause parse
failures at boot. The boot-time config path in the sketch cannot change the
baud mid-session because the ESP is already opened at the new rate; this is
why persistent UM982 configuration is the normal operating model.

## Current sketch startup policy

The current ESP32 GNSS sketch in `external-hardware/esp32/gnss-node-v2/gnss-node-v2.ino` now defaults to a passive startup model over `Serial2` at `460800` baud (see `UM982_UART_BAUD`). The UM982 must be persistently configured to match.

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
CONFIG COM2 460800
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
PVTSLNA COM2 0.05
RECTIMEA COM2 1
UNIHEADINGA COM2 0.2
```

Interpretation of the runtime log commands:

- `CONFIG COM2 460800` sets the COM2 UART baud to match the ESP32 sketch
- `PVTSLNA COM2 0.05` requests `PVTSLNA` at `20 Hz`
- `RECTIMEA COM2 1` requests `RECTIMEA` at `1 Hz`
- `UNIHEADINGA COM2 0.2` requests `UNIHEADINGA` at `5 Hz`

During the one-time manual provisioning session, open the terminal at 115200
to send `CONFIG COM2 460800` (the UM982 replies `OK` then switches), then
reconnect at 460800 for the rest of the configuration and the `saveconfig`.

Commands deliberately excluded from normal rover boot:

- `ascii`
  - this UM982 firmware rejects it with `PARSING FAILED NO MATCHING FUNC`
- `CONFIG ANTIJAM AUTO`
  - observed to trigger a later receiver/interface restart, clearing the volatile session
- any `CONFIG COMn <baud>` command
  - the ESP32 sketch opens its UART at a single fixed baud before boot-time
    configuration runs, so a baud-change mid-session would leave ESP and UM982
    mismatched. Baud rate must be persisted on the UM982 during the manual
    provisioning session, not at runtime.

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
- when the sketch constants leave the fixed base at zero, decode verified RTCM 1006 messages from the base and use that transmitted base position as the local origin
- if no configured base and no RTCM 1006 base position is available yet, a dynamic first-fix origin may be used only as a bring-up fallback

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

## Pi-facing payload layout (single version, 40 bytes)

The GNSS ESP emits one fixed payload layout — there is no version negotiation and no v1/v2 fallback.  When the layout needs to change, the firmware and Pi codec are updated together.

| Off | Sz | Field | Encoding |
|---|---|---|---|
| 0 | 8 | `gpsTimeMillis` | uint64 LE — Unix epoch ms from `RECTIMEA` UTC fields; `0` when receiver UTC is not yet valid |
| 8 | 4 | `xMeters × 1000` | int32 LE mm |
| 12 | 4 | `yMeters × 1000` | int32 LE mm |
| 16 | 4 | `headingDegrees × 100` | int32 LE centideg; sentinel `0x7FFFFFFF` |
| 20 | 2 | `pitchDegrees × 100` | int16 LE centideg; sentinel `0x7FFF` |
| 22 | 2 | `groundSpeedMps × 1000` | uint16 LE mm/s; sentinel `0xFFFF` |
| 24 | 2 | `positionAccuracyMeters × 1000` | uint16 LE mm |
| 26 | 2 | `headingAccuracyDeg × 100` | uint16 LE centideg; sentinel `0xFFFF` |
| 28 | 2 | `headingBaselineMeters × 1000` | uint16 LE mm from `UNIHEADINGA.length`; sentinel `0xFFFF` |
| 30 | 2 | `sampleAgeMillis` | uint16 LE — ms since the most recent `PVTSLNA` line |
| 32 | 1 | `fixType` | `0=none, 1=single, 2=float, 3=fixed` |
| 33 | 1 | `satellitesInUse` | uint8 — `bestpos_solnsvs` from `PVTSLNA` |
| 34 | 1 | flags | bit0 utc-valid, bit1 heading-valid, bit2 baseline-valid |
| 35 | 1 | log config mask | bit0 PVTSLNA active, bit1 RECTIMEA active, bit2 UNIHEADINGA active |
| 36 | 4 | reserved | zero-filled |

### Why these fields and no others

Only fields the receiver *actually exposes* in the configured log set are included:

- `gpsTimeMillis` from `RECTIMEA` — only honest source of fix time; the Pi uses it for sanity checks and (optionally) clock sync.
- `headingBaselineMeters` from `UNIHEADINGA.length` — directly observable; lets the validator confirm the dual-antenna geometry matches what the firmware was configured with.
- `headingValid` flag from `UNIHEADINGA` solution status — set when `sol stat` is anything other than `INSUFFICIENT_OBS` and `pos type` is anything other than `NONE`.
- `fixType`, `positionAccuracyMeters`, `satellitesInUse`, `headingAccuracyDegrees` — already supplied by `PVTSLNA` / `UNIHEADINGA` and trusted by the validator.

Fields *not* in the payload because the configured logs do not produce them honestly:

- **HDOP** is not part of `PVTSLNA`, `RECTIMEA` or `UNIHEADINGA` field lists.  Position accuracy from `latstd/lonstd` covers the same concern.
- **RTK reliability** is a *receiver configuration* (`CONFIG RTK RELIABILITY 3 1`), not a per-sample field.  Once that threshold is set the receiver implicitly enforces it; samples below it never reach RTK Fixed.

### Pi clock domain

The Pi-side codec stamps `timestampMillis` from `Date.now()` at decode time so GNSS, IMU and encoder timestamps share the same clock.  The receiver UTC is exposed separately as `gpsTimeMillis`.  When UTC is available and the Pi clock is more than a few seconds off, the Pi can sync `gpsTimeMillis` into the system clock at startup; this is optional and not yet implemented.

### Receiver fields actually consumed

Per [`buildGnssPayload`](../external-hardware/esp32/gnss-node-v2/gnss-node-v2.ino) the GNSS ESP reads these fields from the receiver logs:

- `PVTSLNA`: `bestpos_type`, `bestpos_lat`, `bestpos_lon`, `bestpos_latstd`, `bestpos_lonstd`, `bestpos_solnsvs`, `psrvel_ground`, `heading_type`, `heading`, `pitch`
- `RECTIMEA`: `clock status`, `utc year/month/day/hour/min/ms`, `utc status`
- `UNIHEADINGA`: `sol stat`, `pos type`, `length`, `heading`, `pitch`, `hdgstddev`
