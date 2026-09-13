# GNSS transport verification

## Current implementation

The base and mower sketches target Arduino ESP32 **3.3.5**, with FQBN
`esp32:esp32:esp32` (original ESP32/WROOM). They preserve channel 1, existing
base/relay source filters, the current 15-byte RTCM fragment header, and the Pi's
40-byte sample payload / 51-byte response and 116-byte debug payload / 127-byte response.
Receiver provisioning and GPIO assignments are unchanged.

Broadcast is the only base transport. A base message gets two passes with the
same identity; the existing relay forwards packets unchanged and the mower
suppresses duplicate delivery. This is bounded redundancy, not an acknowledgement
or a guarantee of radio delivery. No return route or relay firmware change is required.

| Stage | Bound / failure policy |
| --- | --- |
| Base UART RX | 4096 bytes; 512 bytes serviced per loop; UART error count |
| Base message queue | Eight messages, maximum 1029 bytes each; drop on overflow |
| Base radio | One outstanding send; four attempts per fragment/pass; two passes |
| Radio spacing | At least 2 ms between starts, 10 ms before second pass |
| Missing callback | Restart base ESP32 after 1000 ms; never overlap unresolved sends |
| Queued correction age | Base skips messages older than 500 ms; rover discards queued radio packets older than 500 ms |
| Rover UART | 8192-byte RX / 4096-byte TX; admit only complete corrections that fit |
| Rover scheduling | Two bounded RX batches surrounding at most four radio packets, including startup waits |
| GNSS line integrity | Unicore CRC32, required field counts, finite/range validation; discard overflow/error-damaged lines through newline |
| I2C publication | Immutable payload plus timestamp/auxiliary ages under a short lock |
| I2C freshness | Age recomputed per request; stalled publication after 250 ms yields unavailable sentinel; receiver sample expires after 2 s |
| I2C transmit | Preload from receive callback with `Wire.slaveWrite`; check initialization and returned write length |
| Link indication | A recognised base/relay probe gives a 100 ms GPIO23 route-LED flash; it is never UART-forwarded and GPIO19 remains correction-only |
| Diagnostics | Bounded nonblocking serial summaries at 10-second intervals |

The original ESP32 Arduino 3.3.5 driver's TX event is posted after a read
transaction. The firmware therefore preloads the response during the preceding
write/STOP receive callback, not from `onRequest`. The master must use a separate
write and read, and validate response sequence, type, length and CRC. The existing
Pi transport does so. Exact callback/first-byte timing still requires physical
measurement with the actual master; the software tests do not model bus timing.

Receiver checksum convention follows the [Unicore N4 manual, section 7.3 and
Appendix 1](https://en.unicore.com/uploads/file/20241219/Unicore_Reference_Commands_Manual_For_N4_High_Precision_Products_V2_EN_R1.4.pdf):
CRC32 excludes `#` and the `*xxxxxxxx` suffix, uses reflected polynomial
`0xEDB88320`, starts at zero and has no final XOR. The native tests include the
manual's published UNIHEADINGA checksum fixture, as well as independent synthetic fixtures.

## Software validation

Run from the repository:

```sh
arduino-cli compile --fqbn esp32:esp32:esp32 --build-path /tmp/mower-base-build external-hardware/esp32/gnss-base-station
arduino-cli compile --fqbn esp32:esp32:esp32 --build-path /tmp/mower-gnss-build external-hardware/esp32/gnss-mower
node --test test/gnssFirmware.test.js
npm run lint
npm test
```

The native test runner needs a C++17 compiler (`CXX` defaults to `c++`). It
compiles both actual sketches into one deterministic hardware-stub harness;
it does not duplicate their parser/transport implementations. Coverage includes
maximum-size fragmentation, mixed direct/relay reconstruction, identical repeats,
CRC rejection/recovery, untrusted probe sources, delayed/missing callbacks,
queue capacity/expiry, send failures, UART admission failure, receiver checksum
fixtures, invalid numbers/dates, oversized lines, alternating sample/debug I2C
requests, stalled publication, independent auxiliary expiry and timer wrap.

Validation on 2026-09-12 used the local installed ESP32 core and Node 20.20.1:

- Both ESP32 sketches compile successfully; generated output stays under `/tmp`.
- Native firmware scenarios pass with `-Wall -Wextra -Werror`.
- `npm run lint` (which runs the TypeScript no-emit typecheck) passes.
- Full Node suite: 436 tests, 428 passed and eight failed in unchanged
  `test/mowingExecutor.test.js` (boundary tracing / continuous connector / resume
  cases expected `complete`, received `error`). GNSS tests passed. The suite uses
  the existing `dist` tree; this firmware change does not rebuild that runtime.

No hardware was flashed, no mower service was restarted, and no physical radio,
UART or I2C stress/latency measurements were performed by these checks.

## Hardware acceptance before field use

1. Flash the reviewed base and mower builds. Keep the base UM980 at 115200,
   mower UM982 COM2 at 460800 and both radios on channel 1. Verify the mower's
   configured base/relay station MACs and periodic RTCM1006 at the base receiver.
2. With motors disabled, capture the Pi's request/STOP/read at 400 kHz using a
   logic analyser. Alternate 51-byte sample and 127-byte debug reads; confirm
   correct first byte, CRC, type and sequence, including the first read after
   reboot. Confirm slave preloading completes before the read begins. If it does
   not, measure and add a bounded master-side preparation interval rather than
   relying on after-read responses or ignoring stale-sequence errors.
3. Repeat with sustained 20 Hz PVTSLNA, 5 Hz UNIHEADINGA, 1 Hz RECTIMEA and normal
   base RTCM traffic. Record I2C latency percentiles and error/retry counts. Wire
   time for an 11-byte request plus 51-byte reply is approximately 1.44 ms at
   400 kHz, before software overhead; a proposed initial p99 acceptance target is
   under 5 ms, to be measured rather than assumed.
4. Test direct-only, relay-only and overlapping coverage, including interference
   and temporary radio loss. Compare RTCM output bytes/CRC at the base and mower
   UARTs, not just the base's local send callback count. Verify duplicates are
   not forwarded and fresh corrections resume after outages.
5. Disconnect/restart the receiver, base and mower in turn. Check age sentinels,
   independent UTC/baseline expiry, unchanged origin policy and recovery. Confirm
   UART/queue error counters remain stable under ordinary sustained traffic.
6. Run an extended stationary soak with normal shared-bus motor/IMU polling.
   Record transport failures, worst-case latency and all UART/queue drops. Check
   physical pull-ups, rise time and grounding if errors remain.
