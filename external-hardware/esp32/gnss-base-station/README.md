# GNSS Base Station ESP32

The UM980 sends RTCM3 over Serial2 at 115200 baud (RX GPIO16, TX GPIO17).
The ESP32 validates framing and CRC24Q, then broadcasts fragmented messages on
ESP-NOW channel 1 with Wi-Fi power saving disabled. The receiver must already
be provisioned, including periodic RTCM 1006 so the mower can establish its origin.

## Broadcast and relay operation

Broadcast is the only transmission mode. No mower MAC is needed at the base.
The broadcast address is registered with the ESP-NOW driver; this is not a
unicast connection and does not acknowledge reception by the mower.

Set the station MAC printed at base startup as `BASE_STATION_MAC` in the mower
and optional relay. The mower also accepts `GNSS_RELAY_MAC`. The relay forwards
packets unchanged, so the mower can assemble mixed direct/relay fragments and
suppress duplicate complete messages. The existing relay packet format is unchanged.

Each valid RTCM message receives two broadcast passes with identical message ID,
fragment indexes, length and CRC. Packet starts are spaced at least 2 ms apart;
the second pass starts at least 10 ms after the first pass completes. This bounds
repeat traffic and improves recovery from packet loss without waiting for a return
route. It is not guaranteed delivery, and no application acknowledgement is added.

## Scheduling and failure handling

- A 4096-byte UART RX buffer feeds an eight-message transmit queue. Each loop
  drains at most 512 serial bytes, services the radio, then yields for 1 ms.
- At most one radio send is outstanding. Only its callback advances the state;
  a delayed callback can never be mistaken for the next packet's result.
- Immediate errors or failed callbacks allow at most four attempts per fragment
  per pass. Queue overflow, retry exhaustion and messages older than 500 ms are
  counted as drops. A send already in flight is allowed to finish.
- A callback missing for one second restarts the base ESP32, clearing radio and
  callback state together. It does not restart or reconfigure the UM980.
- UART errors are counted. RTCM parsing slides to the next candidate after a
  bad header/CRC; a partial frame expires after a 250 ms inter-byte gap.
- Idle radio time permits a diagnostic probe about once per second. Probes are
  never forwarded to a GNSS receiver or used as an origin.

## Diagnostics

Startup reports Wi-Fi/channel setup, station MAC, ESP-NOW initialization and
callback registration; `espNowReady=yes` requires successful setup and the
expected channel. Every ten seconds a nonblocking summary reports `read`,
`sentLocal`, `drop`, `reject`, `retry`, `uartError`, `queue` and `callbacks=ok/fail`.
`sentLocal` means both passes completed locally, not that the mower received them.
Summaries are skipped if the serial output buffer has insufficient space.

## Build and verification

Validated with Arduino ESP32 core **3.3.5**, FQBN `esp32:esp32:esp32`:

```sh
arduino-cli compile --fqbn esp32:esp32:esp32 external-hardware/esp32/gnss-base-station
node --test test/gnssFirmware.test.js
```

The native tests compile both actual sketches with deterministic hardware stubs
and need a C++17 compiler (`CXX` may select it). See
[GNSS transport verification](../../../docs/gnss-transport-verification.md)
for hardware acceptance checks. Compilation alone does not flash the ESP32.
