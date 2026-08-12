# GNSS Base Station ESP32

This sketch reads RTCM3 messages from a UM980 base receiver on `Serial2` and forwards them over ESP-NOW to the rover GNSS node.

## File

- `external-hardware/esp32/gnss-base-station-v1/gnss-base-station-v1.ino`

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

- `external-hardware/esp32/gnss-node-v2/gnss-node-v2.ino`

The rover sketch accepts this fragmented transport and uses its message identity
to suppress duplicate direct and relayed packets.
