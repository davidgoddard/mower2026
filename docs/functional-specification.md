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

#### Primitives Viewer

The web page must feature a tabbed content area one tab of which is the "Primitives" view.  This will be for showing raw low level data from the sensors.

The primitives JSON should expose sensor domains as distinct sections:
- `imu`
- `gnss`
- `motors`

For motors, primitives should include both:
- last commanded wheel speeds
- latest feedback sample (wheel speeds, encoder deltas, watchdog/fault state)

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

The sensor controller must maintain a IMU based heading angle integrating the yaw values from the IMU.

The IMU primitive exposed to application consumers should be heading-focused.  The application should request heading and receive heading, without requiring raw yaw rate or raw sample timestamps in the external sensor API.

The sensor controller shall support an external absolute heading update (for example from GNSS) which resets the maintained IMU heading to that supplied value.  After reset, yaw integration continues from the new heading baseline.

The externally exposed IMU heading must be normalized to the signed range `[-180, 180]`.

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
