# GNSS Base Station ESP32

This sketch reads RTCM3 messages from a UM980 base receiver on `Serial2` and forwards them over ESP-NOW to the rover GNSS node.

## File

- `external-hardware/esp32/gnss-base-station/gnss-base-station.ino`

## Defaults

- UM980 UART pins: `RX=16`, `TX=17`
- UM980 UART baud: `115200`
- ESP-NOW channel: `1`
- Transport: fragmented RTCM packets with message ID, fragment index/count, total message length, and RTCM CRC tag

At startup the serial console prints the station-mode MAC address as:

```text
[RTCM-BASE] station MAC=AA:BB:CC:DD:EE:FF
```

Use this address for `BASE_STATION_MAC` in the relay and mower GNSS firmware.

## Peer configuration

For best reliability, set one or more rover MAC addresses in `ROVER_PEERS` and increase `ROVER_PEER_COUNT`.

Default behavior is broadcast fallback only. Broadcast is convenient for bench pairing, but unicast is the intended field mode because it reduces packet loss.

## Rover compatibility

This sketch is paired with:

- `external-hardware/esp32/gnss-mower/gnss-mower.ino`

The rover sketch accepts this fragmented transport and uses its message identity
to suppress duplicate direct and relayed packets.

## Radio-link diagnostics

The base prints its Wi-Fi mode, configured and actual channel, ESP-NOW
initialization, callback-registration, and peer-registration results at startup.
ESP-IDF success is numeric result `0`; `espNowReady=yes` confirms that all
required initialization calls succeeded.

The base also sends a four-byte link probe once per second, independently of
UM980 or antenna availability. This packet is deliberately not RTCM. The
current mower firmware recognizes the configured base as its sender and reports
the probe through `linkProbes` and `linkProbeAgeMs`, but cannot forward it to the
UM982 or use it as a coordinate origin. An increasing mower `linkProbes` count
proves that the base-to-mower ESP-NOW radio route works. Valid RTCM subsequently
increases the first `rtcmFrags` number and pulses the mower's RTCM activity LED.

Base status output is enabled and includes `sendCallbacks=succeeded/failed`,
`probes=sent/dropped`, and `espNowReady=yes|no`. A probe is counted as sent only
when the asynchronous ESP-NOW callback reports `ESP_NOW_SEND_SUCCESS`; the
immediate `esp_now_send()` queueing result alone is not treated as delivery.
Disable `ENABLE_LINK_PROBE` after radio-path diagnosis if the extra diagnostic
packet is no longer wanted.
