# UM982 Module Pinout

This note documents the UM982 breakout module used on the mower and the specific header row wired into the rover ESP32.

## Module orientation

With the USB-C connector at the top and the 6-pin header at the bottom, the header row visible along the lower edge is labeled:

```text
EN  GND  TXD  RXD  VCC  PPS
```

This is the row furthest from the board edge in the module photo provided during bring-up.

## Important conclusion

For this module and wiring, the `TXD` / `RXD` header row is the UM982 `COM2` UART.

That conclusion is based on two pieces of evidence:

1. The rover ESP saw the UM982 readiness marker:
   - `$devicename,COM2`
2. GNSS logging worked only when the rover sketch requested:
   - `PVTSLNA COM2 0.1`
   - `RECTIMEA COM2 1`
   - `UNIHEADINGA COM2 0.2`

When the sketch was switched to `COM3`, the ESP stopped receiving the live GNSS logs.

## Rover wiring

The mower rover ESP32 wiring should therefore be:

- UM982 `TXD` -> ESP32 `GPIO16`
- UM982 `RXD` -> ESP32 `GPIO17`
- UM982 `GND` -> ESP32 `GND`
- UM982 `VCC` -> supply as required by the module power design

`PPS` is optional and is not currently used by the mower GNSS sketch.

## Runtime expectation

Because this header is `COM2`, the rover sketch should configure live logs on `COM2`:

```text
PVTSLNA COM2 0.1
RECTIMEA COM2 1
UNIHEADINGA COM2 0.2
```

Any future GNSS bring-up that moves those logs to `COM3` should be treated as suspect unless the physical wiring changes too.
