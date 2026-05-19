# Functional Specification

## Scope

This specification defines the mower control system that runs on a Raspberry Pi and coordinates with:

- a GNSS ESP node which is itself hooked up to a UM982 dual antenna GNSS module
- a motor ESP node
- a IMU 

All 3 of the above are sharing an i2c link running at 400k baud configured on the Pi.

The motors have output pulses for speed and rotational information and there are current sensing modules on the motor power lines.  This information is available over i2c.

Both heading and position information is available from the GNSS module over i2c.

## System goals

The system shall:
- Provide a web page through which a user can:
    - verify the mower state seeing current GNSS pose, IMU reported heading and motor state.  
    - request a run of the turn tuning
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
    - every turn ever should add to the learning
- when driving: continually monitor the driving and adjust its internal control parameters to reduce errors:
    - Every drive should be as straight as possible and arrive at the target with a minimal X and Y error distance
    - Every drive should follow a sequence of events:
        - settle
        - get current pose
        - if current angle to target is more than 5 degrees then call the turn component with the required angle
        - settle 
        - get current pose again
        - compute the line to the target
        - apply full motor power
        - loop reading current pose and measure CTE and remaining distance
            - adjust one wheel to slow down to steer back to the line to the target to reduce CTE
            - when remaining distance to target is less than the learned braking distance request zero motor speed.
            - exit the loop when brake applied
        - wait learned brake time
        - settle
        - get current pose
        - compute new control parameters based on the CTE and X/Y errors
- derive mowing patterns that avoid obstacles and ensure the least number of strips are mowed filling the mowing area with strips that are spaced at 3/4 of the cutting width.

## Operation

A Systemctl registered file must be available that will start the main application server which in turn will make the web page available.

```
sudo systemctl restart mower
```


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
- Left and right wheel speeds (m/s)
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
- last commanded wheel speeds
- latest feedback sample (wheel speeds, encoder deltas, PWM, current, watchdog/fault state)

### Sensor Interface

A component is required to interface the controller to the sensor information.

The sensors are interfaced through i2c at 400000Khz set by the Raspberry Pi baud rate for i2c.

The sensor interface shall be implemented as one Sensor Controller boundary in the application layer with a clear separation between:
- application-facing sensor state and polling orchestration
- hardware-facing adapters/drivers for each device.

The Sensor Controller will be responsible for polling each configured sensor device in turn and storing only the latest successful state (plus last error state where relevant).  Polling is asynchronous to the main control code and the sensor loop runs at 30Hz.

The Sensor Controller is the single owner of sensor polling cadence.  Device-specific polling loops are not to be run independently outside this controller in production runtime.

The Sensor Controller should expose a snapshot/read API for the latest sensor state so other components can consume sensor data without direct hardware coupling.

#### Motor interface

The sensor controller shall poll motor feedback each loop and expose the latest motor state in primitives.

The sensor controller shall expose motor command methods for:
- setting left and right wheel target speeds
- issuing a stop command

Motor stop commands must use the highest bus priority (`1`) and motor speed commands use priority (`2`).

Application-level motor command convention shall be:
- positive wheel speed means forward
- negative wheel speed means reverse

Where hardware wiring/motor node direction differs, inversion shall be applied only at the hardware adapter boundary, not in application control logic.

Motor feedback shall include, at minimum:
- left and right wheel speeds in meters per second
- encoder pulse delta per wheel since the previous sample
- watchdog health and fault flags

Encoder pulse deltas are required so higher level components can integrate distance over time.

Motor commands and feedback shall use framed i2c request/response messages with these message types:
- `0x21` wheel speed command
- `0x22` feedback sample

Motor i2c default address shall be `0x66` and remain configurable for bring-up/testing overrides.

#### Manual drive controller interface

Manual drive arming/disarming shall use:
- right-top button to enable manual drive
- left-top button to disable manual drive and stop motors

Joystick speed/steering demands shall be mapped to left/right wheel speed targets using the previous proven manual-drive shaping model (including deadband and spin/arc behaviour), then sent via the standard motor command primitive so normal motor ramping behavior is preserved.

Manual-drive commands must never bypass the motor node control path.

If controller connectivity is lost while manual drive is armed, manual drive shall disarm and issue a motor stop command.

#### IMU interface

The sensor controller must maintain IMU-based orientation, integrating yaw values and calculating tilt from the IMU.

**BMI160 IMU Sensor:**
- Gyroscope: Z-axis angular velocity for heading integration
- Accelerometer: 3-axis acceleration (X, Y, Z) for pitch and roll calculation

**Orientation Data Provided:**
- **Heading**: Integrated from gyro Z-axis, normalized to signed range `[-180, 180]`
- **Pitch**: Tilt front-to-back (rotation around Y-axis), calculated from accelerometer
  - Positive pitch = nose up, negative = nose down
  - Formula: `pitch = atan2(-ax, sqrt(ay² + az²)) * 180/π`
- **Roll**: Tilt side-to-side (rotation around X-axis), calculated from accelerometer
  - Positive roll = right side down, negative = left side down
  - Formula: `roll = atan2(ay, az) * 180/π`

**Calibration and Zeroing:**
At startup, the IMU performs calibration:
1. Gyroscope bias: Averages Z-axis readings while stationary to determine drift offset
2. Pitch/roll zeroing: Averages tilt calculations to establish level reference

This allows the mower to zero its orientation on uneven ground during startup. All subsequent readings subtract these calibrated offsets.

**Heading Reset:**
The sensor controller shall support an external absolute heading update (for example from GNSS) which resets the maintained IMU heading to the supplied value. After reset, yaw integration continues from the new heading baseline.

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

Every turn must feed back the error of the achieved angle to improve the braking angle to attain a zero degree error.

Being able to turn 10 degrees will be tough but consideration should be given to handle this being aware that the braking distance might be greater than the angle to turn and yet the system should engage motors and try to stop on target and so a different implementation might be required for small angles below N.

The operation of the braking is such that once the mower is up to full speed which it does not know so we will use a magnitude based gate, then small angles are managed one way and angles above the gate simply run at full speed until the remaining angle is less than the learned brake angle.  There will be one brake angle for positive and negative turns. 

For small angles run without a brake distance and simply request zero speed when the half way point (a leaned point) has been reached.  I.e. for a 20 degree turn, power on until only 10 degrees left.  The code must learn and update this 'mid point' based on results to get more accurate.  Again, due to mower assymetry there should be one learned value for positive and one for negative.

The transition from small to large angles will be a configuration value set initially to 30 degrees.

The control data such as braking distances learned, perhaps for a given angle, must be persisted and picked up the next time the server starts and must also be used by the next turn immediately.

If the system receives a "Stop" request from a user interaction or a failure condition, the turn must be stopped immediately.

## Driving from point to point

An asynchronous component that is responsble for moving the mower from one position(current) to a target position in the X/Y plane.

The input is a single target position

The goal is to turn to face the target and then drive as straight a line as possible arriving as close to the target as possible.

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

Using events for all sensor value inputs.

Ideally the heading is known at all times.  When GNSS is "fixed" and the current GNSS heading is within tolerance for the time since the last one (i.e. no sudden turns in fractions of a second) then use this GNSS heading as the system wide current heading updating the IMU base heading.  When the GNSS gives a silly value or loses fix quality a form of dead-reckoning is achieved by using the IMU heading (which was updated from the last good GNSS value).  Likewise for position, use GNSS when good fix but if fix is lost, then use a dead-reckoning using the motor feedback.  This will require a calibrated motor feedback tick to distance value.

It is suggested that the above fusion of values to make sensor readings is encapsulated into one place and can be called everytime a current pose is required.  The turn controller will directly hook the IMU and will not use this component.

Drives should use full speed.
When the start and end positions are obtained using good quality GNSS fixes, the code can optionally update the motor feedback tick to distance configuration value to improve dead-reckoning performance.

### Braking distance learning

Once the mower reaches full speed, the braking distance should stabilize and be roughly constant for all distances driven on level ground.  The system should learn a single brake distance parameter that applies to all drives once at full speed.

For very short drives where the mower does not reach full speed (due to motor ramp-up time), a different braking strategy may be required.  These short drives should still engage motors and attempt to reach the target, but may need separate learning parameters or a different control approach.

The brake distance may vary depending on terrain slope (uphill vs downhill).  Future enhancements could incorporate IMU pitch angle to adjust brake distance dynamically, but the initial implementation should focus on learning a single brake distance for level ground operation.

The learning algorithm should:
- maintain one primary brake distance parameter (in meters) for full-speed drives
- update this parameter after each drive based on X-axis arrival error
- if overshot target (positive X error): increase brake distance
- if undershot target (negative X error): decrease brake distance
- converge quickly since all full-speed stops should behave similarly

For short drives where full speed is not reached, consider:
- a minimum drive distance threshold (e.g. 3 meters) below which different control may be needed
- potentially disabling brake distance learning for these short drives
- or learning a separate parameter set for short-distance drives

## Path following

There is a need to be able to trace around obstacles using manual driving and then have the mower re-trace that path whilst mowing. 

A path driving component is required which will take an array of path points which may be far apart or very close together and drive that path and return.

### Tracing

The user will be able to use manual driving or simply dragging the mower around an obstacle. The position part only is obtained and logged every time it moves more than 10cm.

The web page will offer a button to open a path tracing page for this purpose.  

A path will be associated with a name which will default to 'Obstacle N' where N is an increasing number based on already stored obstacles.  The user can add new names. For any name, the user can erase which removes it completely or they can 'record' in which case it starts capturing the path as the user moves/drives the mower. And a 'stop and save' button which will persist the array of positions against the name.

### Re-tracing

From the same page as for tracing the obstacle's perimeter, there will be a button to 'Drive'.

The drive button will pre-pend the current position to the path and then start the drive mode.

The drive will perform a smooth line-follower algorithm but only resort to 'turn-on-the-spot' when the direction to the next point requires a turn greater than can be achieved using an arc - arc is preferred.   With one heel stationary the mower will pivot around that wheel so it can produce very tight circles.

A "Stop" button will be prominant on the screen and immediately terminate a drive.

Driving should initially be performed at full speed as this ensures the blades are moving quickly and it overcomes the friction - a slow drive could get stuck.

## Obstructions - retry

The mower has two current meters; one for each motor.  When either the current goes over a threshold (to be defined but start with 2 amps) or the position is effectively stationary whilst the motor feedback indicates movement (wheel slip) or the position is stationary for 1 second and the motors have been engaged, then enter a retry loop.

The retry loop involves driving in reverse to the last known point if it was driving a line and reversing for 2 seconds and then driving forward to continue and hence re-try. This is presumed to get over long or thick grass that causes a jam.  If the retry is failed 3 times then abort the entire session and power off the motors.

The retry loop involves retracing the path backwards for the last 5 waypoints if it was path following to ensure it does not collide with the obstacle.

If turning on the spot, then simply turn the other way for 2 seconds and then retry going forward.  Note that this will require the angles to be managed so that the original target heading is reached even if a back-up and retry occurs.

Logging should indicate that the retry has occured and which condition was detected and the context in which it occured such as line following or turning.

