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

Recommended usage:

- for real lawn operation, set the fixed base latitude/longitude
- for quick bring-up, leave base at zero and allow dynamic origin

## UM982 configuration

The sketch currently sends a startup configuration including:

- `PVTSLNA COM2 0.1`
- `RECTIMEA COM2 1`
- `UNIHEADINGA COM2 0.2`

and the expected heading configuration for about `0.30 m` antenna spacing.

## Current limitation

This sketch uses ASCII receiver logs for practicality and transparency.

That is acceptable for bring-up and functional testing, but the long-term target may still move to binary logs once the field mapping is proven on real hardware.
