# Wiring

This document collects the current practical wiring for:

- the GNSS ESP32 node
- the motor ESP32 node
- the Raspberry Pi I2C links
- the UM982 GNSS module
- the motor driver, FG feedback, and current sensors

It is based on the current software and hardware notes in:

- `external-hardware/esp32/gnss-node-v2/`
- `external-hardware/esp32/motor-controller-v2/`

## GNSS ESP Wiring

### UM982 module orientation

With the UM982 board viewed from above with:

- antenna sockets at the top
- USB-C connector at the top
- the two rows of header pins at the bottom

The inner lower row used by this project is labeled:

```text
EN  GND  TXD  RXD  VCC  PPS
```

For this module and project wiring, that row is treated as the UM982 `COM2` UART.

### UM982 to ESP32 GNSS node

```text
UM982 module                 ESP32 GNSS node
-----------                 ----------------
TXD ----------------------> GPIO16   (ESP32 Serial2 RX)
RXD <---------------------- GPIO17   (ESP32 Serial2 TX)
GND ----------------------> GND
VCC ----------------------> module supply as required by the board
PPS ----------------------> not connected
EN  ----------------------> leave as module requires
```

### GNSS ESP32 pins used by the sketch

```text
GPIO16  UM982 RX into ESP32 (Serial2 RX)
GPIO17  UM982 TX out of ESP32 (Serial2 TX)
GPIO21  I2C SDA to Raspberry Pi
GPIO22  I2C SCL to Raspberry Pi
GPIO5   Heading quality LED
GPIO18  Position quality LED
GPIO19  RTCM activity LED
```

### GNSS LED meanings

- `GPIO19`: RTCM activity LED
  - pulses when RTCM corrections are received and forwarded to the UM982
- `GPIO5`: heading quality LED
- `GPIO18`: position quality LED

For the heading and position LEDs:

- off: no usable solution
- 1 flash every 2 seconds: single-point solution
- 2 flashes every 2 seconds: differential solution
- 3 flashes every 2 seconds: float RTK solution
- solid on: fixed RTK solution

## Motor ESP Wiring

### ESP32 motor node pins used by the sketch

```text
GPIO16  I2C SDA from Raspberry Pi
GPIO17  I2C SCL from Raspberry Pi

GPIO5   Left motor PWM output
GPIO18  Left motor direction output

GPIO14  Right motor PWM output
GPIO19  Right motor direction output

GPIO21  Left FG/tach input
GPIO22  Right FG/tach input

GPIO34  Left current-sense analog input
GPIO35  Right current-sense analog input
```

### Pi to motor ESP

```text
Raspberry Pi            ESP32 Motor Node
------------           ----------------
GND                ->   GND
SDA                ->   GPIO16
SCL                ->   GPIO17
```

### ESP32 motor node to motor driver

```text
ESP32 Motor Node        Motor Driver
----------------       ------------
GPIO5               ->  Left PWM input
GPIO18              ->  Left DIR input

GPIO14              ->  Right PWM input
GPIO19              ->  Right DIR input

GND                 ->  Driver GND
```

### ESP32 motor node to motor feedback

```text
ESP32 Motor Node        Motors / Sensors
----------------       ----------------
GPIO21              <-  74132-conditioned left FG/tach output
GPIO22              <-  74132-conditioned right FG/tach output

GPIO34              <-  Left current sensor output
GPIO35              <-  Right current sensor output

GND                 ->  Common sensor ground
```

### FG / encoder conditioning with 74132

The left and right motor FG/tach lines now pass through a `74132` quad
Schmitt-trigger NAND stage before entering the ESP32. This conditions slow or
noisy motor-feedback edges before they reach `GPIO21` and `GPIO22`.

Use one NAND gate per wheel as an inverting Schmitt stage:

- tie one NAND input high to `3.3V`
- feed the pulled-up motor `FG` line into the other NAND input
- route the NAND output to the ESP32 tach input

Practical wiring per wheel:

```text
3.3V ---[4.7k to 10k]---+--------------------+
                        |                    |
                        +--- Motor FG        +--- 74132 input B tied to 3.3V
                              output         |
                                             v
                                     +----------------+
                                     | 74132 gate     |
                                     | A <- FG line   |
                                     | B <- 3.3V      |
                                     | Y -> ESP32 GPIO|
                                     +----------------+
                                             |
                                             +-------> GPIO21 (left) or GPIO22 (right)
```

74132 supply:

- `VCC` -> `3.3V`
- `GND` -> common ground

The 74132 inverts the FG waveform once, which is acceptable here because the
firmware counts edges rather than decoding quadrature phase.

### FG pull-up wiring

The FG lines are treated as `3.3V` logic and should have external pull-ups.

```text
3.3V ---[4.7k to 10k]---+--- GPIO21
                        |
                        +--- Left FG

3.3V ---[4.7k to 10k]---+--- GPIO22
                        |
                        +--- Right FG
```

Do not pull FG lines directly to `5V` into the ESP32.
Do not power the `74132` from `5V` when its outputs feed the ESP32 GPIOs.

### Current sensors

Current project assumption for the motor ESP:

- left current sensor output -> `GPIO34`
- right current sensor output -> `GPIO35`
- ACS712-style analog current sensors

Practical wiring:

```text
Left current sensor output   -> GPIO34
Right current sensor output  -> GPIO35
Sensor GND                   -> ESP32 GND
Sensor VCC                   -> sensor supply appropriate to the module used
```

## One-Page System Block Diagram

```text
                           +----------------------+
                           |     Raspberry Pi     |
                           |                      |
                           | I2C SDA ------------ +-------------------+
                           | I2C SCL ------------ +---------------+   |
                           | GND -----------------+-----------+   |   |
                           +----------------------+           |   |   |
                                                              |   |   |
                                                              |   |   |
                     +----------------------------------------+   |   +----------------------------------+
                     |                                            |                                      |
                     v                                            v                                      v
            +--------------------------------------+     +--------------------------------------------------+                    Common Ground
            |           ESP32 GNSS Node           |     |                 ESP32 Motor Node                 |
            |                                      |     |                                                  |
            | GPIO16 RX <-------+----- UM982 TXD   |     | GPIO16 SDA <------+----- Pi SDA                  |
            | GPIO17 TX ------- +----> UM982 RXD   |     | GPIO17 SCL <------+----- Pi SCL                  |
            | GND ------------- +----- UM982 GND   |     | GND ------------- +----- Pi/driver/sensor GND   |
            | VCC supply ------ +----> UM982 VCC   |     |                                                  |
            | GPIO5  ---------- +----> Heading LED |     | GPIO5  ---------- +----> Left PWM                |
            | GPIO18 ---------- +----> Position LED|     | GPIO18 ---------- +----> Left DIR                |
            | GPIO19 ---------- +----> RTCM LED    |     | GPIO14 ---------- +----> Right PWM               |
            | GPIO21 SDA <------+----- Pi SDA      |     | GPIO19 ---------- +----> Right DIR               |
            | GPIO22 SCL <------+----- Pi SCL      |     | GPIO21 <--------- +----- 74132 <- Left FG        |
            +--------------------------------------+     | GPIO22 <--------- +----- 74132 <- Right FG       |
                                                         | GPIO34 <--------- +----- Left current sensor     |
                                                         | GPIO35 <--------- +----- Right current sensor    |
                                                         +--------------------------------------------------+
                                                                                   |
                                                                                   v
                                                         +--------------------------------+
                                                         |          Motor Driver          |
                                                         |                                |
                                                         | Left PWM <--------------------+
                                                         | Left DIR <--------------------+
                                                         | Right PWM <-------------------+
                                                         | Right DIR <-------------------+
                                                         | GND -------------------------+
                                                         +--------------------------------+
                                                                  |      |
                                                                  v      v
                                                             Left motor  Right motor
                                                                |             |
                                                                +-- FG        +-- FG
```

## Important Constraints

- Common ground is required between Pi, ESP32 boards, motor driver, and sensors.
- The UM982 UART wiring is crossed: UM982 `TXD -> ESP32 GPIO16`, UM982 `RXD <- ESP32 GPIO17`.
- The project treats the inner UM982 header row as `COM2`.
- FG/tach lines must be pulled up to `3.3V`, not `5V`.
- The left and right FG/tach lines pass through a `74132` Schmitt-trigger stage before reaching `GPIO21` and `GPIO22`.
- Do not feed `5V` directly into ESP32 GPIO pins.
- UM982 board power should follow the module board's power design rather than assuming bare-chip supply rules.
