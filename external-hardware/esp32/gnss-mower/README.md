# Mower GNSS Node

## Purpose

This folder contains a practical replacement ESP32 rover GNSS sketch for the second-generation mower protocol.

File:

- `gnss-mower.ino`
- `UM982-module-pinout.md`

## What it does

- runs as I2C slave at `0x52`
- receives RTCM fragments over ESP-NOW and forwards them to the UM982
- assumes the UM982 has already been configured persistently
- verifies expected logs at startup while servicing UART/radio input
- parses:
  - `PVTSLNA`
  - `RECTIMEA`
  - `UNIHEADINGA`
- returns the compact framed GNSS payload expected by the Pi-side protocol

## Important behavior

- the node answers I2C throughout startup, initially with an explicit unusable sample
- until a verified RTCM 1006 base origin is available, the node reports `fixType=none`, zero local coordinates, and unusable position accuracy
- the production firmware never derives a replacement lawn origin from the first rover fix after a reset
- manual motor control remains independent of GNSS quality, while autonomous consumers fail closed

## Before flashing

Check the development configuration section at the top of the sketch, including `ANTENNA_BASELINE_METERS`, `ANTENNA_BASELINE_TOLERANCE_METERS`, `BASE_STATION_MAC`, and `GNSS_RELAY_MAC`.

Recommended usage:

- configure the base to emit RTCM 1006; the rover decodes a verified message and uses that base position as its stable local origin
- do not enable a dynamic first-fix origin on the mower, because an ESP reset would move the coordinate frame relative to every saved perimeter and obstacle

Also confirm the current wiring assumptions in the sketch:

- UM982 serial baud: `460800` (set via `UM982_UART_BAUD` in the sketch)
- UM982 UART on ESP32 `Serial2`
- UM982 RX on ESP32 `GPIO16`
- UM982 TX on ESP32 `GPIO17`
- Pi-facing I2C address: `0x52`
- Pi-facing I2C pins on the ESP32: `GPIO21` SDA and `GPIO22` SCL
- heading quality LED: `GPIO5`
- position quality LED: `GPIO18`
- RTCM activity LED: `GPIO19`
- RTCM route indicator LED: `GPIO23`

The specific UM982 breakout module pin/header mapping used on this mower is documented in [`UM982-module-pinout.md`](UM982-module-pinout.md).

Key point:

- the lower labeled header row `EN GND TXD RXD VCC PPS` is the receiver `COM2` UART on this module
- the rover ESP wiring and log configuration should therefore use `COM2`

## LED indicators

The sketch restores the three practical status LEDs from the legacy rover firmware:

- `GPIO5` heading quality
- `GPIO18` position quality
- `GPIO19` RTCM activity
- `GPIO23` RTCM route indicator

The route indicator is derived from complete, CRC-valid RTCM messages rather
than individual radio packets:

- off: no verified RTCM message in the last 3 seconds
- solid: the latest correction route was direct from the base
- one 200 ms flash per second: the latest correction route was through the relay
- two short flashes per second: both direct and relay packets contributed, or
  both complete routes were observed

Before flashing, set `BASE_STATION_MAC` and `GNSS_RELAY_MAC` in the sketch to
the station-mode MAC addresses of those ESP32s. When both values are zero the
node rejects correction packets; this prevents an unconfigured node from
mistaking unrelated ESP-NOW traffic for RTCM input.

The fragmented transport accepts packets out of order, combines direct and
relayed fragments by message ID and RTCM CRC, retains incomplete assemblies for
up to 500 ms, and retains completed identities for 10 seconds. A completed RTCM
message is written to the UM982 only once.

Heading and position LEDs use the same pattern:

- off: no usable solution
- `1` flash every `2 s`: single-point solution
- `2` flashes every `2 s`: differential solution
- `3` flashes every `2 s`: float RTK solution
- solid on: fixed RTK solution

The route LED (`GPIO23`) flashes for 100 ms when a configured base or relay
link probe arrives, even if the base receiver has no antenna or emits no RTCM.
The base sends that probe once per second while ESP-NOW is initialized, so this
flash proves the one-way broadcast path to the mower. It is never forwarded to
the UM982. GPIO23 no longer displays direct/relay route patterns; the source
route remains available in diagnostics.

When RTCM is present, `GPIO19` also pulses briefly only when a complete RTCM message has:

- the correct RTCM preamble `0xD3`
- a complete length-matched payload
- a valid RTCM CRC24Q

Only then is it forwarded to the UM982 and allowed to pulse the LED. Random ESP-NOW traffic, probes from unknown senders and malformed RTCM-like fragments do not flash the LED.

If no fresh `PVTSLNA` fix has been parsed for more than about `2 s`, the heading and position LEDs are forced off.

## Transport reliability

The current target is the original ESP32 WROOM using Arduino ESP32 core 3.3.5.
Both base and optional relay use broadcast on channel 1. `BASE_STATION_MAC` and
`GNSS_RELAY_MAC` are receive filters, including for link probes; they are not
unicast peers. The two base broadcast passes and direct/relayed copies share
message identity and are forwarded to the UM982 only once after CRC validation.

The receiver UART uses 8192-byte RX and 4096-byte TX buffers. Corrections are
written only when a complete frame fits in the TX buffer; otherwise they are
counted as drops and remain eligible for recovery by a later broadcast copy.
The normal main loop runs on a 5 ms cadence and reads bounded UART batches before and after processing up to four
radio packets. It also services input during startup LED and command waits.
Packets queued for more than 500 ms are discarded.

PVTSLNA, RECTIMEA and UNIHEADINGA must carry valid Unicore CRC32 checksums.
Non-finite/out-of-range numbers are rejected. Oversized or UART-error-damaged
lines are discarded through newline. UTC, auxiliary heading and baseline flags
expire with their corresponding data; malformed dates clear previous UTC.

## I2C responses

The 40-byte sample payload / 51-byte frame and 116-byte debug payload / 127-byte
frame remain unchanged. Each request is an 11-byte CRC-protected frame followed
by a STOP and a separate read, as used by the Pi transport. Combined repeated-START
requests are not the supported transaction pattern.

On the original ESP32, the Arduino read callback runs after the transaction.
The firmware therefore calls `Wire.slaveWrite()` from the receive callback to
preload the response before the master reads. It never loads a response from
`loop()` or from an after-read callback. Buffer allocation, I2C initialization,
and slave-write results are checked. The master must still reject wrong CRCs,
lengths and sequence numbers and retry, as the production Pi client already does.

The receive callback copies an immutable payload plus age metadata under a short
lock and computes CRC outside it. Sample age advances at request time. If the
main loop has not published for more than 250 ms, a new request receives the
unavailable sample-age sentinel (`65535`), even if I2C itself remains responsive.
The normal receiver-sample expiry remains two seconds. No wire-format or Pi
application change is required.

## Diagnostics

Startup prints radio setup results and station MAC. Every ten seconds, a bounded
nonblocking summary reports `pvt`, `rtcm`, `queueDrop`, `txDrop`, `uartError`,
`crcError`, `lineOverflow`, `i2cError`, `probes`, `packets`, `unknown`, `pvtAgeMs`,
`rtcmAgeMs`, `origin` and `route`. The age sentinel `4294967295` means no sample.
Origin 1 is RTCM1006; route 1/2/3 means direct/relay/mixed for the latest message.
Route age is reflected separately by the route LED's existing freshness rule.

`probes` or `packets` increasing proves radio activity, while increasing `rtcm`
proves complete CRC-valid corrections were accepted into the receiver TX path.
`unknown` indicates source-MAC filtering. Increasing UART, checksum, queue or
I2C error counters requires investigation. Low-satellite raw payload text remains
available through the Pi diagnostic frame. High-volume startup raw-line printing
and per-1006 serial tracing are disabled/removed.

Build and native regression tests:

```sh
arduino-cli compile --fqbn esp32:esp32:esp32 external-hardware/esp32/gnss-mower
node --test test/gnssFirmware.test.js
```

See [GNSS transport verification](../../../docs/gnss-transport-verification.md)
for the required hardware checks and actual validation results.

## UM982 configuration

The preferred operating model is now:

1. configure the UM982 once through a direct serial session
2. save that configuration persistently on the receiver itself
3. leave the ESP sketch in passive startup mode
4. let the ESP verify and parse the existing logs on every reboot

The expected persistent receiver configuration is:

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

Important notes:

- boot-time receiver programming is now disabled by default in the sketch
- the default startup behavior is only to send `UNILOGLIST` and verify the expected `COM2` logs
- `CONFIG COM2 460800` must match `UM982_UART_BAUD` in the sketch; send it
  from a 115200 terminal during the one-time manual provisioning, then
  reconnect at 460800 for the rest
- `PVTSLNA COM2 0.05` requests `20 Hz`
- `RECTIMEA COM2 1` requests `1 Hz`
- `UNIHEADINGA COM2 0.2` requests `5 Hz`
- `CONFIG HEADING LENGTH 30.00 5.00` assumes about `0.30 m` antenna spacing with `0.05 m` tolerance
- `ascii` is not recommended because this receiver firmware rejects it with `PARSING FAILED NO MATCHING FUNC`
- `CONFIG ANTIJAM AUTO` should not be part of normal rover boot because it was observed to trigger another receiver/interface restart
- any `CONFIG COMn <baud>` change must only be done during manual
  provisioning (not at runtime); the ESP32 opens its UART at a fixed baud
  before boot-config runs, so changing the receiver baud mid-session would
  leave the ESP and UM982 mismatched
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

The `sampleAgeMillis=65535` value is an explicit unavailable-data sentinel,
used both before the first solution and once the last solution is too old.
Current Pi software rejects that complete sample and retains the last successful
satellite count with GNSS marked errored; it must never present the paired zero
byte as a current receiver satellite observation.

The deployed pair must be kept together: flash this sketch and rebuild the Pi
`dist` tree from the same source revision. The Pi validates the exact 40-byte
payload/51-byte frame, protocol version, CRC, node/message identifiers, and
request sequence. A mismatched or stale response fails closed and is retried;
there is no legacy payload fallback.

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
