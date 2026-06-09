# Functional Specification

## Scope

This specification defines the mower control system that runs on a Raspberry Pi and coordinates with:

- a GNSS ESP node which is itself hooked up to a UM982 dual antenna GNSS module
- a motor ESP node
- a IMU 

All 3 of the above are sharing an i2c link running at 400k baud configured on the Pi.

The motors have output pulses for speed and rotational information and there are current sensing modules on the motor power lines.  This information is available over i2c.

Both heading and position information is available from the GNSS module over i2c.

At the current project stage there is no calibrated translational-speed model for mower motion. Runtime logic shall not use meters-per-second vehicle-speed assumptions or speed-based plausibility gates for control, GNSS validation, or learning behaviour unless this specification is explicitly extended to add that capability.

## System goals

The system shall:
- Provide a web page through which a user can:
    - verify the mower state seeing current GNSS pose, IMU reported heading and motor state.  
    - request a run of the turn tuning
        - separate large-angle and small-angle training runs shall be available
        - small-angle training shall keep repeating each bucket until the absolute error is below 2 degrees
        - large-angle training shall likewise keep repeating each requested angle until the absolute error is below 2 degrees
    - request a run of drive tuning
    - define the mowing areas
        - within each area capture zero or more obstacle perimeters
        - define the outer perimeter
        - allocate a name ot the area
    - start mowing of an area
- when turning: continually monitor the turning and adjust its internal control parameters to reduce errors:
    - turns should use IMU heading changes only
    - turns should request one wheel to go forward, the other backward to turn on the spot and run the motors at full speed.
    - turns should learn when to request zero speed (brake) so that the in-built motor ramping down time is built into the stopping distance/angle thus aim to stop with zero degree error
    - small-angle turns should learn their brake fraction using angle buckets from 3° to 60° rather than using a fixed halt point
    - every turn ever should add to the learning
- when driving: continually monitor the driving and adjust its internal control parameters to reduce errors:
    - Every drive should be as straight as possible and arrive at the target with a minimal X and Y error distance
    - Every drive should follow a sequence of events:
        - settle
        - get current pose
        - if current angle to target is more than 5 degrees then call the turn component with the required angle
        - settle 
        - get current pose again
        - compute the travel line to the target
        - apply a regulated pure pursuit controller that:
            - finds a lookahead point on the line
            - converts the line curvature into differential wheel speeds
            - keeps a high cruise speed and only eases off modestly as the mower approaches the target or enters the tightest curves so grass friction does not dominate
            - uses the same geometry for reverse travel with the correct body-heading reference
        - loop reading current pose and measure CTE and remaining distance
        - when remaining distance to target is less than the learned braking distance request zero motor speed if that braking point is still before the target distance.
        - always stop when the arrival tolerance is reached, even if braking was not used
        - wait learned brake time
        - settle
        - get current pose
        - compute new control parameters based on the CTE and X/Y errors
- short drives up to 1 metre shall use positive and negative stop-trigger learning buckets at 5,10,15,20,25,30,35,40,45,50,55,60,70,80,90 and 100cm, and longer plateau drives shall reuse one shared full-speed brake distance while still retrying each training distance as a forward/reverse pair until both legs are below 4cm absolute X error
- short-drive tuning runs shall be able to alternate forward and reverse legs, taking a fresh pose/heading sample for each leg so the mower can train without walking far away from the test area
- short-drive tuning runs shall clear any stale stop latch at the start of a new user-requested run so a fresh Start action actually starts motion
- drive learning shall use a larger learning step for larger distance errors so a 10cm miss adapts faster than a 4cm miss
- drive learning shall maintain separate CTE gains for forward and reverse motion so reverse steering can learn independently from forward steering
- the drive tuning page shall let the operator choose a starting distance, defaulting to 50cm, so already-learned shorter buckets can be skipped during a session
- the drive tuning page shall train the fixed short-bucket distances through 100cm and then longer shared-brake sample distances at 200, 300 and 400cm
- the drive tuning page shall present a compact short-distance training view with a single start action, stop action, and a simple results table containing distance, average CTE, maximum CTE, X error, and Y error
- derive mowing patterns that avoid obstacles and ensure the least number of strips are mowed filling the mowing area with strips that are spaced at 3/4 of the cutting width.

## Operation

A Systemctl registered file must be available that will start the main application server which in turn will make the web page available.

```
sudo systemctl restart mower
```

## Configuration

The system shall store persistent configuration in the `config/` folder, split by concern:

- `config/motor-calibration.json`
  - motor ramp-up time
  - motor ramp-down time
  - motor-specific calibration values
- `config/imu-yaw-calibration.json`
  - persisted IMU yaw scale factor used by the sensor controller
- `config/pose-calibration.json`
  - encoder meters-per-tick calibration
- `config/path-following-parameters.json`
  - closed-loop detection, verification standoff, turn-only threshold, obstacle outward offset, and pure-pursuit lookahead values used for traced obstacle path following
- `config/turn-learning-parameters.json`
  - turn brake distances and turn learning history
- `config/drive-learning-params.json`
  - drive brake distance, forward/reverse CTE gain, and learning history

The application shall:
- load these files at startup
- create them with defaults when missing
- persist updates back to the same file
- keep hardware calibration separate from operational learning

## Stop Behaviour

The system shall maintain a global stop state that can be raised by:
- user action, such as pressing the stop button or calling the stop API
- execution failure, timeout, or other runtime safety condition

When stop is set:
- all active loops shall check the stop state and return or exit promptly
- every motor command written after that point shall carry the stop-disabled flag so no later command can accidentally re-enable drive while the stop latch remains set
- the sensor controller loop shall continue to send zero wheel speed commands while the current operation remains active
- the motor disable shall be asserted only when the active user-requested operation ends
- active operations shall not continue silently in the background

The stop state shall be cleared only when:
- the user requests a new operation
- the system restarts

Stop requests and clears shall be logged centrally, including the source that raised or cleared the state.

## Primitives

### Logging

A logger must be available that is asynchronous and runs in its own thread and writes out to a session log file using JSONL format entries.

Each time the main app is started a new session file must be created.

For log retention, keep:
- session files from the current startup date
- session files from the most recent prior date with logs

Remove older dated session files.

Entries should include the time, the application context, the class that invoked it and then the data.  

Log entry timestamps should be local time for operator readability.

Most Logs should be added only to aid debugging and removed once no longer required.

Key events in application state progression such as starting something in response to a user request should be added to structure the logs but kept to a minimum.

### I2C bus

There must be one I2C bus in the entire application.

A controller for this will expose asynchronous read and write methods with a simple priority mechanism.

A "Stop" message must be sent next if one has been queued - priority 1

A "Motor Speed" message must be sent priority 2

A "GNSS" read is priority 3

A "IMU read" is priority 4

If a message of one of the priorities has already been queued, then replace the payload if applicable with the latest but keep only one message for that logical key in the queue.  Ie. if a new Motor Speed request arrives, only store the new speed but maintain only one entry in the i2c message queue.

The controller should send all messages in the queue in the priority order as soon as possible and clear the queue as quickly as possible.



### Web server

The user will interact with the controller through a web page.  A server will provide the support for this web page through HTTP API.

A HID games controller interface shall be supported for manual driving.

The web page must remain responsive at all times

#### Dashboard Home Page

The web page home page provides a real-time dashboard view showing the current state of all sensors with graphical and numerical displays:

**IMU Widget:**
- Compass display showing heading (navigation convention: 0° = north, clockwise positive)
- Numeric heading value in degrees
- Pitch indicator: circular level meter showing front-to-back tilt angle
- Roll indicator: circular level meter showing side-to-side tilt angle
- Status indicator (running/error/idle)

**GNSS Widget:**
- Compass display showing GNSS heading (navigation convention)
- Position coordinates (X, Y in meters)
- Fix type (none/single/float/fixed)
- Position accuracy in meters
- Satellite count
- Numeric heading value
- Status indicator

**Motors Widget:**
- Left and right wheel speeds (m/s) derived on the Pi from raw encoder feedback only
- VU meter displays for motor current draw:
  - Real-time current level shown as gradient bar (green → yellow → red)
  - Peak hold indicator (holds maximum for 2 seconds)
  - Numeric display: current / peak in amps
  - Scale: 0-10A maximum
- PWM percentage for each motor
- Watchdog health status
- Fault flags (hexadecimal)
- Status indicator

**Navigation:**
- Header menu buttons for Turn Tuning and Drive Tuning pages
- Back buttons on tuning pages return to dashboard

**Heading Display Convention:**
All compass displays and heading values shown on the web interface use navigation/field heading convention (0° = north, clockwise positive). The internal system uses a different convention (0° = east, counterclockwise positive) which is converted for display purposes.

#### Primitives API

The primitives JSON API (`/api/primitives`) exposes sensor domains as distinct sections:
- `imu` - heading, pitch, roll
- `gnss` - position, heading, fix quality
- `motors` - speeds, currents, PWM, watchdog, faults

For motors, primitives include both:
- last commanded wheel output percentages
- latest feedback sample (derived wheel speed, encoder deltas, PWM, current, watchdog/fault state)

### Sensor Interface

A component is required to interface the controller to the sensor information.

The sensors are interfaced through i2c at 400000Khz set by the Raspberry Pi baud rate for i2c.

The sensor interface shall be implemented as one Sensor Controller boundary in the application layer with a clear separation between:
- application-facing sensor state and polling orchestration
- hardware-facing adapters/drivers for each device.

The Sensor Controller will be responsible for polling each configured sensor device on its own cadence and storing only the latest successful state (plus last error state where relevant). A single scheduler loop wakes every ~8 ms and dispatches reads only to the sensors whose individual deadline has elapsed: IMU at ~125 Hz, motor feedback at 50 Hz, and GNSS at 20 Hz. Polling is asynchronous to the main control code.

The Sensor Controller is the single owner of sensor polling cadence.  Device-specific polling loops are not to be run independently outside this controller in production runtime.

The Sensor Controller should expose a snapshot/read API for the latest sensor state so other components can consume sensor data without direct hardware coupling.

#### Motor interface

The sensor controller shall poll motor feedback at the motor cadence (~50 Hz) and expose the latest motor state in primitives.

The sensor controller shall expose motor command methods for:
- setting left and right wheel target percentages, where 1.0 is full output and 0.0 is stop
- issuing a stop command

Motor speed commands shall be latest-wins: if the application enqueues several speed commands before the bus drains, only the most recent target reaches the ESP32. Every motor speed command is merged with the global system-stop flag so that once stop is latched, any pending or subsequent speed command is rewritten as a disable until the global flag is cleared.

The Pi-to-motor-node command protocol shall use normalized percentages rather than metres-per-second targets.
The ESP32 motor controller shall treat the requested target percentage as the top-of-ramp destination and apply ramp-up/ramp-down over the configured duration.

Motor stop commands must use the highest bus priority (`1`) and motor speed commands use priority (`2`).

Application-level motor command convention shall be:
- positive wheel speed means forward
- negative wheel speed means reverse

Where hardware wiring/motor node direction differs, inversion shall be applied only at the hardware adapter boundary, not in application control logic.

Motor feedback shall include, at minimum:
- encoder pulse delta per wheel since the previous sample
- watchdog health and fault flags
- motor current for both wheels

The sensor controller shall detect likely obstructions/stalls from its latest motor feedback, the current motor command and the latest pose estimate. When the motors are commanded to move but the mower makes no meaningful positional progress over a short grace-adjusted observation window, the controller shall emit an obstruction event, request a global stop and log the condition once.

The ESP32 motor node shall send raw encoder pulse deltas and PWM/current telemetry only.
The Pi-side sensor controller shall convert encoder deltas into wheel speed estimates using the persisted encoder calibration.

Encoder pulse deltas are required so higher level components can integrate distance over time.

Motor commands and feedback shall use framed i2c request/response messages with these message types:
- `0x21` wheel speed command
- `0x22` feedback sample

Motor i2c default address shall be `0x66` and remain configurable for bring-up/testing overrides.

#### Manual drive controller interface

Manual drive arming/disarming shall use:
- right-top button to enable manual drive
- left-top button to disable manual drive and stop motors

Joystick speed/steering demands shall be mapped to left/right wheel speed targets using the previous proven manual-drive shaping model (including deadband and spin/arc behaviour), then sent via the standard motor command primitive. Manual drive shall remain on the normal motor-node path, but may use a faster manual-specific ramp profile than autonomous motion so operator start/stop response stays crisp.

Manual-drive commands must never bypass the motor node control path.

Manual-drive output commands shall be coalesced so tiny analogue stick jitter does not create unnecessary I2C writes, and unchanged held commands shall not be resent to the motor node.

If controller connectivity is lost while manual drive is armed, manual drive shall issue a gentle stop (zero wheel command, drive enabled) but shall keep manual drive armed for a short reconnect grace window so a flaky HID link can recover without the operator re-arming. If the grace window expires without reconnection, manual drive shall disarm via the normal stop path. A controller disconnect shall never trigger a hard motor disable.

#### IMU interface

The sensor controller must maintain IMU-based orientation, integrating yaw values and calculating tilt from the IMU.

**BMI160 IMU Sensor:**
- Gyroscope: 3-axis angular velocity for heading integration
- Accelerometer: 3-axis acceleration (X, Y, Z) for pitch and roll calculation

The runtime shall treat the BMI160 gyro as a `2000 dps` range sensor with the corresponding `16.4 LSB/dps` conversion already baked into the driver.

**Orientation Data Provided:**
- **Heading**: Integrated from the gyro vector projected onto the gravity axis derived from pitch and roll, normalized to signed range `[-180, 180]`
- **Pitch**: Tilt front-to-back (rotation around Y-axis), calculated from accelerometer
  - Positive pitch = nose up, negative = nose down
  - Formula: `pitch = atan2(-ax, sqrt(ay² + az²)) * 180/π`
- **Roll**: Tilt side-to-side (rotation around X-axis), calculated from accelerometer
  - Positive roll = right side down, negative = left side down
  - Formula: `roll = atan2(ay, az) * 180/π`

**Calibration and Zeroing:**
At startup, the IMU performs calibration:
1. Gyroscope bias: Averages all three gyro axes over the default stationary calibration window to determine drift offsets
2. Pitch/roll zeroing: Averages tilt calculations over the same stationary calibration window to establish level reference

This allows the mower to zero its orientation on uneven ground during startup. All subsequent readings subtract these calibrated offsets.

**Heading Reset:**
The sensor controller shall support an external absolute heading update (for example from GNSS) which resets the maintained IMU heading to the supplied value when the GNSS heading is already close to the current IMU heading and the GNSS heading quality is high enough to trust. GNSS position accuracy shall be used separately for trusting x/y updates. After reset, yaw integration continues from the new heading baseline.

Heading resets must be timestamp-aware. When the caller can provide the controller-clock time of the reset, the sensor controller shall use that timestamp as the next integration reference; otherwise it shall use the current controller clock. This ensures rebasing the IMU does not discard or double-count a gyro interval during or immediately after a turn.

GNSS heading resets shall be deferred whenever the latest motor command is non-zero or the latest tilt-compensated IMU yaw rate is above the stationary threshold. The system may still observe the GNSS heading and use good GNSS position data in that state, but it must not write the GNSS heading back into the IMU heading baseline until the mower is stopped and yaw motion has settled.

When a non-zero motor command transitions to a stop command, the sensor controller shall capture a compact IMU diagnostic summary for the just-finished motion. Pose fusion shall prefer that stop-time summary when later logging a GNSS heading rebase, because the sustained stationary wait may otherwise hide the turn evidence from the rolling diagnostic window.

**Internal Heading Convention:**
IMU heading uses internal convention (0° = east, counterclockwise positive). The web interface converts this to navigation convention (0° = north, clockwise positive) for display.

#### GNSS interface

GNSS samples shall be obtained over the shared I2C bus from the GNSS node using request/response framing.

The GNSS node default i2c address is `0x52` and should remain configurable for bring-up/testing overrides.

The GNSS response payload should provide planar position and heading primitives, including:
- timestamp
- `xMeters`, `yMeters`
- fix type / quality
- optional heading and heading accuracy
- optional ground speed
- sample age and related health/debug ages where available.

The application should support the currently observed GNSS payload variants (`36` and `38` bytes) while decoding them into one consistent runtime sample model.

The application should validate that GNSS responses are of the expected node/message type before accepting the sample.

The I2C GNSS request path should be resilient to transient bus errors using short retry attempts before surfacing a read failure.

#### Planar coordinate and heading conventions

All runtime position, heading, and geometry calculations shall be performed on a Cartesian X/Y plane in meters.

Latitude/longitude shall not be used in control, planning, guidance, or estimator math.

If upstream GNSS data originates in latitude/longitude, conversion to planar X/Y meters must happen before the data enters the application estimator/control flow.

Internal heading conventions shall be tied to the X/Y plane:
- 0 degrees points along +X
- positive angles rotate counterclockwise toward +Y.

GNSS heading values that use field/navigation convention (clockwise from north) must be rotated into the internal X/Y heading convention before use in estimator/control logic (for example `internalHeading = normalize(90 - fieldHeading)`).

The GNSS heading exposed to application consumers must be this rotated internal heading and normalized to the signed range `[-180, 180]`.

The GNSS position exposed to application consumers shall be the mower control point rather than the raw antenna phase centre whenever a calibrated body-frame offset is available. That offset is fixed in mower coordinates and must be applied using the current heading so the control point stays consistent as the mower turns.

IMU heading integration direction must match this same internal heading convention so that IMU and GNSS heading increases/decreases are aligned.

# Mid level building blocks

## Turning on the spot

An asynchronous turn component that takes on the responsibility of turning the mower.

Input is a single normalised turn angle

In general the code:

- note the start heading from the IMU only
- starts the motors at full power, 
- monitor the IMU heading only until the brake point is passed and wait
- Once at or beyond the brake point zero the motors
- wait for 2 * the motors configured ramp-down time
- re-read the IMU heading only
- compute the arrival error angle
- use the error angle to adjust the brake angle to improve future turn accuracy

Consideration must be given to the smaller angles where the brake angle is close to the angle to turn to ensure that the motor is asked to power up.  I.e. even if within the braking distance the motors still need to be engaged and the system must be able to turn reasonably small angles this way.

The web server and web app need a dedicated tab that shows requested and achieved angles for all turns between 10, -10, 20, -20 ... and 170, -170, 180, -180 degrees.  A suggestion is to show a table with the requested angles as the column headings and the achieved angle shown in the cell below.

The web page must provide a button to launch into a sequence of test iterations where one iteration goes through all angles to be tested.  

There shall be no separate stationary-pose helper. Whenever the system needs a pose reading, it shall use the normal live pose provider directly so the tuning and validation paths exercise the same building blocks as the rest of the app.

Every turn must feed back the error of the achieved angle to improve the braking angle to attain a zero degree error.

Being able to turn 10 degrees will be tough but consideration should be given to handle this being aware that the braking distance might be greater than the angle to turn and yet the system should engage motors and try to stop on target and so a different implementation might be required for small angles below N.

The operation of the braking is such that once the mower is up to full speed which it does not know so we will use a magnitude based gate, then small angles are managed one way and angles above the gate simply run at full speed until the remaining angle is less than the learned brake angle.  There will be one brake angle for positive and negative turns. 

For small angles run without a brake distance and simply request zero speed when the half way point (a leaned point) has been reached.  I.e. for a 20 degree turn, power on until only 10 degrees left.  The code must learn and update this 'mid point' based on results to get more accurate.  Again, due to mower assymetry there should be one learned value for positive and one for negative.

The transition from small to large angles will be a configuration value set initially to 30 degrees.

The control data such as braking distances learned, perhaps for a given angle, must be persisted and picked up the next time the server starts and must also be used by the next turn immediately.

If the system receives a "Stop" request from a user interaction or a failure condition, the turn must be stopped immediately.

## Driving from point to point

An asynchronous segment-driving component that is responsible for moving the mower from one position(current) to a target position in the X/Y plane.

The input is a single target position

The segment drive goal is to turn to face the target and then drive as straight a line as possible arriving as close to the target as possible.

The straight-line portion is a self-contained line-drive component that assumes the mower is already aligned with the line of travel.  It is responsible for minimising cross-track error (CTE), along-track X error, and arrival Y error, while learning brake distance and CTE gain for both short and long drives.  Forward and reverse motion use separate line-control branches so the reverse case can treat the target as behind the mower while still using the same straight-line learning model.  The target arrival is mandatory; braking is an aid used only when there is still room before the target.  A heading preview term may assist steering while there is still comfortable distance to run, but it should taper off close to the target so that it does not create a sharp turn-in at arrival.  The live CTE correction should become progressively stronger as lateral drift grows so the mower fights a bowing path early rather than waiting for the next run to learn from it.

To control this the drive component will learn how to keep CTE small or zero and keep X/Y arrival errors small or zero.  In priority terms, X is more important than Y but Y should naturally be small if CTE is tuned well.

The logical sequence of steps is:
 
- get current pose
- calculate angle to target
- call the turn component with that angle
- get current pose 
- calculate line to target
- apply power to motors
- monitor and correct CTE and monitor remaining distance.
- when at or beyond the braking distance stop the motors.
- wait for twice the configured motor ramp down time for things to settle
- get current pose
- use current pose to compute final X/Y errors 
- update configuration paraemters to improve the next CTE and X/Y and braking
- produce summary for web page
- return

The drive controller shall not add a separate post-turn heading settle wait before starting the straight-line portion; the current IMU-derived pose is used immediately and GNSS only nudges the heading when it is already close enough.

The drive controller shall not impose a duration-based timeout on a drive. Drives are bounded by measured error: arrival tolerance, the optional cross-track-error limit, and the global stall detector. Ground speed is not guaranteed and a drive that is making honest progress shall be allowed to continue.

Using events for all sensor value inputs.

Ideally the heading is known at all times.  The mower shall run from the IMU heading continuously.  At startup, the first good GNSS heading shall rebase the IMU immediately if the mower is not already commanded to move and yaw motion is settled.  After that, GNSS headings shall only nudge the IMU when the fix is "fixed", the heading accuracy is good, the heading is stable, the mower is stopped, yaw motion has settled, and the new GNSS heading is already very close to the current IMU heading.  If the mower has been commanded to zero speed for a sustained period, a good GNSS heading may be allowed to rebase the IMU again even if it is no longer close, so that the system can recover from drift while stationary.  When the GNSS gives a silly value or loses fix quality a form of dead-reckoning is achieved by keeping the IMU heading and using the last known good position estimate.  Likewise for position, use GNSS when the fix is good but if fix is lost, then use a dead-reckoning using the motor feedback.  This will require a calibrated motor feedback tick to distance value.

It is suggested that the above fusion of values to make sensor readings is encapsulated into one place and can be called everytime a current pose is required.  The turn controller will directly hook the IMU and will not use this component.

Drives should use full speed.
When the start and end positions are obtained using good quality GNSS fixes, the code can optionally update the motor feedback tick to distance configuration value to improve dead-reckoning performance.

### Braking distance learning

Once the mower reaches full speed, the braking distance should stabilize and be roughly constant for all distances driven on level ground.  The system should learn a single brake distance parameter that applies to all drives once at full speed, but the drive controller must still stop on arrival even if braking was not applied early enough or is not needed.
In practice the learned full-speed brake distance should be allowed to move down to around 10cm, because the mower may only need a short ramp-down overrun once it is already at speed.

For very short drives where the mower does not reach full speed (due to motor ramp-up time), a different braking strategy is required.  These short drives should still engage motors and attempt to reach the target, but shall use short-distance stop-trigger buckets at 5,10,15,20,25,30,35,40,45,50,55,60,70,80,90 and 100cm with separate positive / negative learning variants, and paired forward/reverse retries when a bucket misses tolerance.

Short-drive tuning shall use a line-drive training mode that alternates forward and reverse legs around a local anchor so the mower can train in a compact area without needing a long run-up or large amount of free space.

The drive tuning web page shall trickle-feed short-distance training progress while a run is active so the operator can see the current bucket, pair attempt and latest leg result before the full run completes. Short-distance training shall still learn both brake fractions and CTE gain, but the live steering curve should remain nonlinear so the mower fights drift harder as it grows instead of waiting for the next run to discover the bow.

The brake distance may vary depending on terrain slope (uphill vs downhill).  Future enhancements could incorporate IMU pitch angle to adjust brake distance dynamically, but the initial implementation should focus on learning a single brake distance for level ground operation.

The learning algorithm should:
- maintain one primary brake distance parameter (in meters) for full-speed drives
- update this parameter after each drive based on X-axis arrival error
- if overshot target (positive X error): increase brake distance
- if undershot target (negative X error): decrease brake distance
- converge quickly since all full-speed stops should behave similarly

For short drives where full speed is not reached, the system shall:
- use dedicated stop-trigger buckets at 5,10,15,20,25,30,35,40,45,50,55,60,70,80,90 and 100cm
- use one shared full-speed brake distance for longer plateau drives, while still sampling straight-line training at 200, 300 and 400cm
- maintain separate positive and negative variants of the short-drive buckets
- continue short-drive learning runs until the absolute X error is below 4cm, retrying forward/reverse pairs together when either leg misses the target
- sample the current pose and heading immediately before each leg starts so the mower drives from its current local frame
- pause briefly before each leg starts so the operator can see a clear training cadence on the web page
- stop a leg early if the cross-track error grows larger than the requested run distance, to avoid the mower drifting far away from the test area

For segment-drive learning, the system shall:
- use a fixed line defined by the mower's current pose and heading at the start of the run
- train segment distances from 105cm to 6m in 20cm increments
- use the segment controller so each leg turns to face its target and then drives the segment
- repeat each forward/reverse pair until the absolute X error is below 4cm
- present live learning progress and per-run results on the drive tuning page

For segment testing, the system shall:
- collect 7 rough waypoints by taking a live pose, driving forward for about 3 seconds, stopping, settling, and then sampling the next pose along the same line
- drive first back to the earliest waypoint using the existing segment controller
- then run 10 further test segments to random non-nearest waypoints using the same segment controller
- present live IMU and GNSS widgets on the left and a real-time results table on the segment testing page
- show distance to waypoint, required heading change, achieved heading change, drive quality, average CTE, maximum CTE, and X/Y errors for each run

## Path following

There is a need to be able to trace around obstacles using manual driving and then have the mower re-trace that path whilst mowing. 

A path driving component is required which will take an array of path points which may be far apart or very close together and drive that path and return.

### Tracing

The user will be able to use manual driving or simply dragging the mower around an obstacle. The position part only is obtained and logged every time it moves more than 10cm.
Path and area-perimeter recording shall accept fused GNSS and dead-reckoning poses from pose fusion, shall ignore unknown-quality poses, and shall reject implausible jumps between consecutive recorded points, so degraded positioning cannot write large spikes into saved boundaries.

The web page will offer a button to open a combined drive-and-paths page for this purpose, with the live manual-drive canvas at the top and the path recording and management controls alongside it.  

A path will be associated with a name which will default to 'Obstacle N' where N is an increasing number based on already stored obstacles.  The user can add new names. For any name, the user can erase which removes it completely or they can 'record' in which case it starts capturing the path as the user moves/drives the mower. And a 'stop and save' button which will persist the array of positions against the name.

The same page shall also support recording one or more named mowing area perimeters. A mowing area perimeter is captured from position samples every 10cm, is persisted separately from obstacle perimeters, and defaults to a generated mowing-area name when the operator does not provide one. The live canvas shall auto-scale to show the current position history, stored obstacle perimeters, and stored mowing area perimeters together.

For a selected mowing area perimeter, the page shall be able to preview logical mowing strips before motion starts. The operator can choose the strip heading, including by dragging a line on the canvas, and can choose the strip spacing. The initial strip spacing shall be 30cm for the 40cm blade width to provide overlap. The system shall clip the parallel strip lines to the selected mowing area perimeter and draw the resulting strips on the canvas.

Mowing strip previews shall treat recorded obstacle perimeters as exclusion zones. Strips shall be split rather than crossing obstacle boundaries, and connector previews between strips shall route around an obstacle perimeter when the direct connector would cross the obstacle.

### Re-tracing

From the same page as for tracing the obstacle's perimeter, there will be a button to 'Drive'.

There will also be a button to 'Verify'.

The drive button shall immediately follow the stored path from the mower's current position.
The verify button shall first execute a segment-style approach to about 10cm short of the nearest recorded point, then continue around the stored path until it returns to that join point. The 10cm standoff exists so the mower has body clearance to turn on the spot at arrival without fouling the recorded edge; it is not an inflation of the path itself.

All perimeter follows — obstacle perimeters, mowing area perimeters, mowing first-encounter boundary traces, and inter-strip connectors — shall use the segmented drive executor. There shall be no separate pure-pursuit follower and no per-path drive-algorithm choice.

The segmented drive executor shall simplify the manually driven recording before execution using both a chord tolerance and a per-vertex turn-angle gate:
- A run of consecutive recorded points may be replaced by a single straight segment if every original point in the run lies within the configured simplification tolerance of that chord, and no original interior vertex of the run requires a heading change above the configured maximum vertex turn angle.
- The first vertex that fails either test ends the chord at the last good vertex; that failing vertex becomes a turn-on-the-spot pivot before the next chord begins.
- Long simplified chords shall still be subdivided into bounded segment targets so the segment drive controller has frequent re-anchor opportunities.

The recorded perimeter points are the boundary to follow as faithfully as the simplifier allows. No outward inflation is applied to either obstacle or area perimeters; the original manually driven trace is presumed to already respect the safe edge of the obstacle or area.

Driving a mowing area perimeter assumes the mower is already on or close to the perimeter: the runtime shall choose the nearest recorded perimeter point and continue in the direction that best matches the mower's current heading. Verifying a mowing area perimeter shall segment-drive to the nearest perimeter point, stop there, turn to align with the chosen path direction, and then continue around the perimeter using the same segmented executor.

At execution time the segmented executor shall re-anchor the target list to the nearest target to the mower's current pose and skip targets already reached, so it resumes from where the mower meets the boundary rather than returning to the saved path's first point. The executor shall abort the run if the measured segment cross-track error exceeds the configured path-following limit.

Generated strip previews define geometry only. They do not start mowing motion until an execution workflow is added.

The closed-loop tolerance, closed-loop detection tolerance, verification approach standoff, verification turn-only distance, segmented-drive simplification tolerance, segmented-drive maximum vertex turn angle, segmented-drive maximum segment length, segmented-drive minimum segment length, segmented-drive maximum CTE, and path-retry reverse distance shall be loaded from persisted path-following configuration rather than being hard-coded in the path helpers.

A "Stop" button shall be prominent on the screen and immediately terminate a drive.

Driving should initially be performed at full speed as this ensures the blades are moving quickly and it overcomes the friction — a slow drive could get stuck.

## Obstructions - retry

The mower has two current meters; one for each motor. The system shall classify obstruction events into three types:

- **high_current** — either motor draws above the configured current threshold (initial value 2 A). This is treated as the mower hitting thick grass or a clump that the blades may yet cut through with another run-up.
- **wheel_slip** — wheels are turning per encoder feedback but the fused position is effectively stationary.
- **stall** — the position is stationary for the stall window while motors are engaged, and the encoders also show no meaningful progress.

Only `high_current` events trigger a retry. `wheel_slip` and `stall` events shall stop the active operation and abort the session — the mower is assumed to be physically stuck.

The high-current retry strategy depends on the active operation:

- **Line driving**: reverse for the configured duration (initial 2 s, roughly half a metre at full speed), settle, then drive forward to the original target again.
- **Path following / boundary tracing**: stop the segmented executor cleanly, then retrace the most recently completed targets backward — re-issuing each as a reverse-direction segment drive — until the cumulative reverse distance reaches the configured retreat distance (initial value 0.5 m). The mower travels rear-first along the line it just came in on rather than pivoting through the obstruction. Once clear, restart the same boundary follow; the segmented executor's nearest-target re-anchor logic resumes forward travel from wherever the mower is.
- **Turn on the spot**: turn the opposite direction for the configured escape duration, then resume the original turn from the new heading. Angles must be managed so that the original target heading is still reached even after the back-up.

If the same operation accumulates more than the configured maximum number of high-current retries (initial value 3) without making progress, the session shall be aborted and the motors powered off.

Logging shall indicate that the retry has occurred, which obstruction type was detected, and the context (line driving, path following, or turning).

## Mowing Strip Planning

### Strip geometry

The mowing planner divides a recorded area perimeter into a set of parallel mowing strips whose axis is set by the operator-chosen heading angle.  The planner projects the perimeter polygon onto the normal to that axis and generates one strip line per spacing interval across the full width of the area.  Each strip line is then clipped to the area polygon boundary so strip endpoints land exactly on the perimeter.  Where a recorded obstacle polygon intersects a strip, the overlapping section is removed and the strip is split into two or more shorter sub-strips, each of which is treated as an independent mowing segment.  The strip spacing defaults to 30 cm for a 40 cm blade to provide a 10 cm overlap on each pass.

### Traversal sequencing and directional consistency

Once all strips are computed the planner sequences them for the shortest total travel path.  The first strip is chosen at the lowest normal-axis offset and entered from the end with the highest projection along the mowing direction.  After the first transition the planner records which side of the area (which normal-axis direction) it advanced toward and locks that crossing direction in for the remainder of the plan.  Subsequent strip choices prefer candidates that continue in the same crossing direction; only if no same-direction strip is reachable (for example an island of unmown ground on the far side of an obstacle) will the planner cross back.

Within each strip the mower always enters at one end and exits at the other, giving a boustrophedon (back-and-forth) pattern across the area.  Where two candidate strips have equal connector cost, the planner prefers the strip with the smallest offset difference from the current strip (i.e. the immediately adjacent strip) to avoid skipping over uncut ground.

### Boundary standoff distance

No mowing strip or connector segment shall bring the mower closer than 15 cm to any recorded boundary (area perimeter or obstacle perimeter) unless that boundary is being explicitly driven as part of a boundary-tracing pass (see below).  This standoff gives the mower sufficient room to execute a turn-on-the-spot at a strip end without fouling the boundary.  The standoff distance of 15 cm is a configurable parameter stored in the path-following configuration.

### First-arrival boundary tracing

The first time the mower reaches any boundary — whether the outer area perimeter or an obstacle perimeter — during a mowing session it must perform a complete boundary trace of that boundary before continuing with strip mowing.  This ensures a clean mowed edge is cut all the way around the area and around each obstacle, which the strip pattern alone would not achieve since strips stop short of the boundary by the standoff distance.

The sequence on first arrival at a boundary is:

1. **Stop short.** The mowing strip or connector brings the mower to within the standoff distance (15 cm) of the boundary, then stops.  The boundary is flagged as not yet traced.
2. **Align to the boundary tangent.** The mower turns on the spot to face tangentially along the boundary at the nearest recorded boundary point, choosing the direction that will travel around the boundary in the correct orientation (clockwise around obstacles, following the recorded direction for the area perimeter).
3. **Line-follow the boundary.** The mower switches to path-follower mode and follows the recorded boundary path.  It continues until it returns to the point at which it joined the boundary — the join point is detected when the mower is within the closed-loop tolerance of that starting point and has travelled enough distance to have genuinely completed a loop.
4. **Mark boundary as traced.** The boundary is flagged as fully traced for this mowing session.
5. **Resume strip sequencing.** The mower returns to the strip end at which it first stopped and continues the normal strip-mowing sequence from that point.

### Connector routing at strip ends

At the end of a mowing strip the mower cannot simply drive a straight line toward the start of the next strip.  The perimeter boundary, an obstacle edge, or uneven terrain may lie immediately in that direction, and driving blindly across unknown ground risks the mower falling into a hole, hitting a kerb, or colliding with an obstacle.

The safe transition sequence at a strip end is therefore:

1. **Stop at the standoff point.** The strip drive ends when the mower reaches the point on the strip that is the standoff distance back from the boundary.  If this is the first arrival at this boundary the mower performs the boundary trace described above before continuing.
2. **Turn to face along the boundary.** The mower performs a turn-on-the-spot to align its heading tangentially with the recorded boundary at the nearest boundary point.
3. **Line-follow the boundary to the next strip entry.** The mower switches to path-follower mode and travels along the recorded boundary — known safe ground — until it reaches the standoff point of the next strip's entry end.  Because the boundary has already been traced at this stage, this leg travels inward of the boundary by the standoff distance rather than on the boundary line itself.
4. **Segment drive down the next strip.** At the next strip's entry standoff point the mower executes a segment drive: it turns on the spot to face along the strip axis and then drives the strip in a straight line using the pure-pursuit controller until it reaches the standoff point at the far end.

This means inter-strip travel is always composed of two phases: a boundary-following phase (safe known ground, inside the standoff margin) and a segment-drive phase (straight mowing pass).  The planner pre-computes the full sequence of strip standoff endpoints and connector waypoints before motion starts so the operator can preview the entire planned route on the canvas.

### Cost model summary

The total connector cost between two strips is the geometric path length of the connector: the Euclidean distance, or the obstacle-perimeter walk distance when a direct line would cross an obstacle.

The planner selects the traversal sequence that minimises total connector cost across all strip transitions, minimising total non-mowing travel distance.
