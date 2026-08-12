# GNSS ESP-NOW Relay

This ESP32 firmware extends the base-station RTCM link by forwarding every
accepted ESP-NOW packet unchanged. It preserves the base-generated message ID,
fragment number, length, and CRC so the mower can combine direct and relayed
copies and deliver each RTCM message only once.

## Before flashing

1. Obtain the station-mode MAC address of the base ESP32.
2. Replace the zero `BASE_STATION_MAC` value in `gnss-relay-v1.ino`.
3. Flash the relay and read its own station MAC from the serial line beginning
   `[RTCM-RELAY] station MAC=`.
4. Put the base and relay station MAC addresses into the corresponding values
   in `external-hardware/esp32/gnss-node-v2/gnss-node-v2.ino` before flashing
   the mower GNSS ESP32.

The relay deliberately remains disabled while `BASE_STATION_MAC` is all zero.
It receives and broadcasts on ESP-NOW channel 1, matching the base and mower.

## Operation

- Only packets whose immediate sender is the configured base MAC are queued.
- Packets are copied into a 32-entry queue and forwarded unchanged from the
  main loop, keeping ESP-NOW work out of the receive callback.
- Forwarding is broadcast, so a mower MAC is not needed in the relay firmware.
- Filtering by the base MAC prevents relays from repeating each other or their
  own broadcasts.
- The onboard blue LED on GPIO2 pulses for 40 milliseconds after each packet
  is successfully forwarded. Failed ESP-NOW sends do not trigger the LED.
- Serial status reports accepted, forwarded, rejected, dropped, and failed
  packet counts once per second.

The mower uses GPIO23 for a dedicated correction-route indicator. Its patterns
are documented in the mower GNSS node README.
