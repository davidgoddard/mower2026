/**
 * System-wide design constants
 *
 * This file contains DESIGN DECISIONS - system-level configuration and tuning
 * parameters that affect behavior across multiple components.
 *
 * Implementation-specific constants (protocol frame sizes, buffer offsets,
 * internal scaling factors) should remain LOCAL to their modules.
 */

// =============================================================================
// TIMING CONSTANTS - System-wide design decisions
// =============================================================================

/**
 * Default sensor polling interval in milliseconds
 * 33ms ≈ 30Hz update rate
 */
export const SENSOR_POLL_INTERVAL_MS = 33;

/**
 * Sensor controller polling interval in milliseconds
 * 10ms = 100Hz update rate for the controller's internal sensor loop / IMU
 * integration path. GNSS and motor feedback keep their own slower cadences.
 */
export const SENSOR_CONTROLLER_POLL_INTERVAL_MS = 10;

/**
 * GNSS polling interval in milliseconds.
 * The GNSS source is configured for 20Hz output, so poll at the same 50ms
 * cadence rather than at the much faster control-loop rate.
 *
 * GNSS samples do not arrive usefully at the 200Hz control-loop cadence, so
 * poll them separately to avoid burning CPU and I2C bandwidth on duplicate
 * reads.
 */
export const SENSOR_CONTROLLER_GNSS_POLL_INTERVAL_MS = 50;

/**
 * Motor feedback polling interval in milliseconds.
 * Wheel encoder/current feedback remains fast enough for stop detection and
 * line driving without forcing every sensor-loop tick to hit the motor
 * node over I2C.
 */
export const SENSOR_CONTROLLER_MOTOR_POLL_INTERVAL_MS = 20;

/**
 * Manual drive control loop interval in milliseconds.
 * Manual driving is operator-facing, so it should react much faster than the
 * conservative autonomous loops.
 */
export const MANUAL_DRIVE_LOOP_INTERVAL_MS = 20;

/**
 * Manual drive keepalive interval in milliseconds.
 * Manual drive uses this when deciding whether the HID snapshot stream has
 * gone stale; unchanged wheel commands are no longer resent as keepalives.
 */
export const MANUAL_DRIVE_COMMAND_REFRESH_INTERVAL_MS = 150;

/**
 * Manual drive motor ramp-up time in milliseconds.
 * Manual drive needs a much snappier feel than autonomous motion while still
 * staying on the normal motor command path.
 */
export const MANUAL_DRIVE_RAMP_UP_TIME_MS = 500;

/**
 * Manual drive motor ramp-down time in milliseconds.
 * Stick release should settle quickly without relying on a hard disable.
 */
export const MANUAL_DRIVE_RAMP_DOWN_TIME_MS = 700;

/**
 * Maximum pose-update emission rate in milliseconds.
 * Pose fusion still ingests IMU, GNSS, and encoder updates at their native
 * cadence, but downstream consumers such as the drive controller only need a
 * bounded control-loop rate rather than a burst on every upstream event.
 */
export const POSE_FUSION_EMIT_INTERVAL_MS = 20;

/**
 * Legacy wheel-command timeout field value, in milliseconds.
 * The current ESP32 motor firmware ignores this field and simply latches the
 * last accepted command until a new command arrives, but the field remains in
 * the on-wire protocol for compatibility with older sketches and tools.
 */
export const MOTOR_COMMAND_WATCHDOG_TIMEOUT_MS = 1000;

/**
 * Manual drive controller-disconnect grace period in milliseconds.
 * If the HID controller drops while manual drive is armed, the coordinator
 * brings the mower to a gentle halt but keeps manual drive armed for this
 * window so a flaky link can reconnect without forcing the operator to
 * re-arm. Past this window the coordinator disarms via the normal stop path.
 */
export const MANUAL_DRIVE_CONTROLLER_DISCONNECT_GRACE_MS = 2000;

/**
 * Default IMU calibration sample count (design decision for accuracy vs time)
 */
export const IMU_DEFAULT_CALIBRATION_SAMPLES = 240;

/**
 * GNSS read retry delay in milliseconds (design decision for retry policy)
 */
export const GNSS_RETRY_DELAY_MS = 20;

/**
 * Default GNSS read maximum retry attempts (design decision for reliability)
 */
export const GNSS_DEFAULT_MAX_ATTEMPTS = 3;

// =============================================================================
// I2C HARDWARE ADDRESSES
// =============================================================================

/**
 * Default I2C address for GNSS node (ESP32)
 */
export const I2C_ADDRESS_GNSS_DEFAULT = 0x52;

/**
 * Default I2C address for motor controller node (ESP32)
 */
export const I2C_ADDRESS_MOTOR_DEFAULT = 0x66;

/**
 * Default I2C address for BMI160 IMU sensor
 */
export const I2C_ADDRESS_BMI160_DEFAULT = 0x69;

/**
 * Default I2C bus number on Raspberry Pi
 */
export const I2C_BUS_NUMBER_DEFAULT = 1;

// =============================================================================
// NOTE: Protocol frame formats, payload sizes, and codec scaling factors
// are IMPLEMENTATION DETAILS and should be defined locally in their respective
// codec modules, not here as system-wide constants.
// =============================================================================

// =============================================================================
// MANUAL DRIVE PARAMETERS
// =============================================================================

/**
 * Manual drive joystick turn deadband in degrees
 * Input angles below this are treated as straight
 */
export const MANUAL_TURN_DEADBAND_DEGREES = 6;

/**
 * Manual drive joystick full lock angle in degrees
 * Input angles at or above this produce maximum turn rate
 */
export const MANUAL_TURN_FULL_LOCK_DEGREES = 84;

/**
 * Manual drive speed demand deadband
 * Absolute speed demands below this are treated as zero
 */
export const MANUAL_SPEED_DEADBAND = 0.05;

/**
 * Manual drive turn demand deadband
 * Absolute turn demands below this are treated as zero
 */
export const MANUAL_TURN_DEADBAND = 0.05;

/**
 * Manual drive wheel-output quantization step.
 * This coalesces tiny analogue joystick jitter into one stable command while
 * preserving meaningful operator changes.
 */
export const MANUAL_DRIVE_OUTPUT_QUANTIZATION_PERCENT = 0.02;

/**
 * Motor output deadband
 * Output commands at or below this magnitude are treated as zero.
 */
export const MOTOR_OUTPUT_DEADBAND_PERCENT = 0.1;

/**
 * Minimum non-zero motor output.
 * Any active motor command below this magnitude is raised to this value, and
 * one-wheel commands are converted to a minimum arc command before reaching
 * hardware.
 */
export const MOTOR_MIN_ACTIVE_OUTPUT_PERCENT = 0.3;

/**
 * Manual drive threshold for entering spin mode
 * Turn demand magnitude must exceed this value
 */
export const MANUAL_DRIVE_SPIN_THRESHOLD = 0.995;

/**
 * Manual drive speed demand threshold for spin mode
 * Speed demand must be below this to enable spin
 */
export const MANUAL_DRIVE_SPIN_SPEED_THRESHOLD = 0.15;

/**
 * Manual drive maximum inner wheel speed reduction during arc
 * 0.50 = inner wheel can be reduced to 50% of outer wheel speed
 */
export const MANUAL_DRIVE_MAX_INNER_WHEEL_TRIM = 0.50;

/**
 * Manual drive arc response curve exponent
 * Higher values make steering more aggressive at high turn demands
 */
export const MANUAL_DRIVE_ARC_RESPONSE_EXPONENT = 1.15;

/**
 * Manual drive minimum spin speed scale
 * At spin threshold, wheel speed is this fraction of max
 */
export const MANUAL_DRIVE_MIN_SPIN_SPEED_SCALE = 0.22;

/**
 * Manual drive maximum spin speed scale
 * At full turn demand, wheel speed is this fraction of max
 */
export const MANUAL_DRIVE_MAX_SPIN_SPEED_SCALE = 0.65;

/**
 * Manual drive arc/straight mode boundary
 * Turn magnitudes below this are considered straight
 */
export const MANUAL_DRIVE_ARC_STRAIGHT_THRESHOLD = 0.12;

/**
 * Manual drive joystick turn response exponent
 * Applied to normalized turn input for non-linear feel
 */
export const MANUAL_TURN_RESPONSE_EXPONENT = 2;

// =============================================================================
// MOTOR DIRECTION SIGNS
// =============================================================================

/**
 * Default motor forward direction sign for left motor
 * -1 means hardware is inverted relative to application convention
 */
export const MOTOR_LEFT_FORWARD_SIGN_DEFAULT = -1;

/**
 * Default motor forward direction sign for right motor
 * -1 means hardware is inverted relative to application convention
 */
export const MOTOR_RIGHT_FORWARD_SIGN_DEFAULT = -1;

/**
 * Default controller steering sign
 * -1 inverts left/right steering response
 */
export const CONTROLLER_STEERING_SIGN_DEFAULT = -1;

/**
 * Default controller speed sign
 * 1 means forward on joystick maps to forward motion
 */
export const CONTROLLER_SPEED_SIGN_DEFAULT = 1;

// =============================================================================
// VELOCITY LIMITS
// =============================================================================

/**
 * Default maximum wheel output command (normalized range [-1, 1])
 * 1.0 = full forward output
 */
export const MAX_WHEEL_OUTPUT_PERCENT_DEFAULT = 1.0;

/**
 * Motor stall detection threshold for commanded output magnitude.
 * If both wheel commands are above this level and the mower is not moving,
 * the sensor controller treats it as a likely stall.
 */
export const MOTOR_STALL_COMMAND_THRESHOLD_PERCENT = 0.35;

/**
 * Motor stall detection threshold for encoder deltas.
 * A minimum of 3 ticks prevents a slowly-rotating blade or slight jitter
 * from masking a genuine translational stall.
 */
export const MOTOR_STALL_ENCODER_DELTA_THRESHOLD = 3;

/**
 * Maximum GNSS position accuracy to trust for stall detection.
 */
export const MOTOR_STALL_GNSS_ACCURACY_MAX_METERS = 0.1;

/**
 * Minimum GNSS progress required over the stall observation window while motors are running.
 */
export const MOTOR_STALL_POSITION_DELTA_THRESHOLD_METERS = 0.1;

/**
 * Observation window used to judge whether commanded motion is actually producing progress.
 */
export const MOTOR_STALL_OBSERVATION_WINDOW_MS = 4000;

/**
 * Weighted sample accumulator threshold before declaring a stall.
 * Normal stationary samples add 1; high-current / fault samples add 2,
 * so a high-current stall triggers in ~6 samples (300 ms) while a
 * current-free stall requires ~12 samples (600 ms).
 */
export const MOTOR_STALL_CONSECUTIVE_SAMPLES = 12;

/**
 * Motor current threshold used as additional evidence for an obstruction.
 */
export const MOTOR_STALL_CURRENT_THRESHOLD_AMPS = 2.0;

/**
 * Grace period after a new motor command before stall detection begins.
 */
export const MOTOR_STALL_STARTUP_GRACE_MS = 500;

// =============================================================================
// NETWORK DEFAULTS
// =============================================================================

/**
 * Default HTTP server port
 */
export const HTTP_SERVER_PORT_DEFAULT = 8090;

/**
 * Default HTTP server host (all interfaces)
 */
export const HTTP_SERVER_HOST_DEFAULT = "0.0.0.0";

/**
 * Maximum valid TCP/UDP port number (system constant)
 */
export const MAX_PORT_NUMBER = 65535;

// =============================================================================
// TURN CONTROLLER PARAMETERS - Design decisions
// =============================================================================

/**
 * Turn controller polling interval in milliseconds
 * How often to check heading during turn execution
 * Matches the current turn control cadence; kept separate from the 200Hz sensor loop.
 */
export const TURN_POLLING_INTERVAL_MS = 33;

/**
 * Settle time after motor ramp-down before reading final heading
 */
export const TURN_SETTLE_TIME_MS = 1000;

/**
 * Pause between successive turn-training runs.
 * This gives the mower a visibly settled pause so the operator can see that
 * measuring and learning has happened before the next turn starts.
 */
export const TURN_TRAINING_INTER_TURN_PAUSE_MS = 1000;

/**
 * ESP32 motor control loop period (milliseconds).
 * The firmware runs at 100 Hz; each tick is 10 ms.
 */
export const MOTOR_CONTROL_TICK_MS = 10;

/**
 * Default motor deceleration rate (%/s).
 *
 * The ESP32 subtracts `decelPercentPerSecond × (elapsedMs / 1000)` from the
 * applied PWM each 10 ms tick.  250 %/s = 2.5 % per tick, so a 100 % →0 %
 * ramp takes 100/2.5 = 40 ticks = 400 ms.
 *
 * Calibrated value lives in `motorDecelPercentPerSecond` in
 * `config/motor-calibration.json`; this constant is the fall-back default and
 * must match `DEFAULT_DECEL_PERCENT_PER_SECOND` in the ESP32 firmware.
 */
export const MOTOR_DECEL_PERCENT_PER_SECOND = 150;

/**
 * Default motor acceleration rate (%/s).
 *
 * Equivalent to the old 460 ms full-range ramp: 100/0.46 ≈ 217 %/s.
 */
export const MOTOR_ACCEL_PERCENT_PER_SECOND = 150;

/**
 * Backward-compatible alias: milliseconds for a full 0→100 % ramp at the
 * default deceleration rate.  Used only by callers that still think in ms.
 */
export const MOTOR_RAMP_DOWN_TIME_MS = Math.round(100_000 / MOTOR_DECEL_PERCENT_PER_SECOND);

/**
 * Backward-compatible alias: milliseconds for a full 0→100 % ramp at the
 * default acceleration rate.
 */
export const MOTOR_RAMP_UP_TIME_MS = Math.round(100_000 / MOTOR_ACCEL_PERCENT_PER_SECOND);

/**
 * Small angle threshold - below this, use special handling (degrees)
 * Small angles require different brake strategy
 */
export const TURN_SMALL_ANGLE_THRESHOLD_DEG = 60;

/**
 * Crawl speed factor used for small-angle turns
 * A lower-than-full-speed turn that still keeps enough momentum to avoid stalls.
 */
export const TURN_SMALL_CRAWL_SPEED_FACTOR = 0.5;

/**
 * Learning rate for brake angle adaptation (0-1)
 * Higher = faster learning but less stable
 */
export const TURN_LEARNING_RATE = 0.18;

/**
 * Per-update clamp on the absolute change to a short-drive brake distance (meters).
 * Prevents a single very poor run from re-tuning the bucket too aggressively.
 */
export const DRIVE_SHORT_MAX_DISTANCE_STEP_METERS = 0.05;

/**
 * Maximum number of turn results to keep in history
 */
export const TURN_HISTORY_MAX_SIZE = 100;

/**
 * Turn watchdog timeout (milliseconds). If no IMU heading update is received
 * while a turn is in the active "turning" phase for longer than this window,
 * the controller treats the sensor stream as dead, raises systemStop and
 * resolves the turn promise with an error. Generously sized so a healthy turn
 * (worst-case 180° at low GNSS-rebase wheel speed) cannot trip it.
 */
export const TURN_HEADING_UPDATE_WATCHDOG_TIMEOUT_MS = 30_000;

/**
 * Rolling window duration (milliseconds) for the live angular-rate estimator
 * used during large-angle turns.
 *
 * IMU events that arrive within this window are kept to compute a rolling
 * average yaw rate. The rate is then multiplied by half the motor ramp-down
 * time to predict how far the mower will coast after the brake command, so
 * the brake trigger fires at the right moment regardless of the current
 * session's battery voltage or motor temperature.
 *
 * 200 ms at the 50 Hz sensor loop gives ~10 samples — enough to smooth
 * single-sample jitter without being too slow to react if the mower
 * accelerates during the first part of the turn.
 */
export const TURN_RATE_WINDOW_MS = 200;

/**
 * Turn learning parameters file path (relative to project root)
 */
export const TURN_LEARNING_PARAMETERS_PATH = "config/turn-learning-parameters.json";

/**
 * Drive learning parameters file path (relative to project root)
 */
export const DRIVE_LEARNING_PARAMETERS_PATH = "config/drive-learning-params.json";

/**
 * Motor calibration file path (relative to project root)
 */
export const MOTOR_CALIBRATION_PATH = "config/motor-calibration.json";

/**
 * Pose calibration file path (relative to project root)
 */
export const POSE_CALIBRATION_PATH = "config/pose-calibration.json";

/**
 * Geometry calibration file path (relative to project root)
 */
export const GEOMETRY_CALIBRATION_PATH = "config/geometry-calibration.json";

/**
 * IMU yaw calibration file path (relative to project root)
 */
export const IMU_YAW_CALIBRATION_PATH = "config/imu-yaw-calibration.json";

/**
 * Path following parameters file path (relative to project root)
 */
export const PATH_FOLLOWING_PARAMETERS_PATH = "config/path-following-parameters.json";

// =============================================================================
// DRIVE CONTROLLER PARAMETERS - Design decisions
// =============================================================================

/**
 * Settle time after turn before starting drive
 */
export const DRIVE_SETTLE_TIME_MS = 200;

/**
 * Initial turn threshold - if heading error exceeds this, turn before driving (degrees)
 */
export const DRIVE_INITIAL_TURN_THRESHOLD_DEG = 5;

/**
 * Maximum number of drive results to keep in history
 */
export const DRIVE_HISTORY_MAX_SIZE = 50;

/**
 * Default full speed motor command (dimensionless, range [-1, 1])
 * 1.0 = full forward speed
 */
export const DRIVE_FULL_SPEED_COMMAND_DEFAULT = 1.0;

/**
 * Default brake distance for full-speed drives (meters)
 */
export const DRIVE_BRAKE_DISTANCE_DEFAULT_METERS = 0.2;

/**
 * Default CTE correction proportional gain
 * Higher = more aggressive correction
 */
export const DRIVE_CTE_GAIN_DEFAULT = 0.3;

/**
 * Default wheel track / wheelbase for dead-reckoning differential odometry (meters).
 * Centre-to-centre distance between the left and right wheels.  This is the
 * starting value used when no calibration file exists; the dead-reckoning
 * calibration writes the measured value back into pose-calibration.json.
 */
export const WHEEL_BASE_METERS_DEFAULT = 0.55;

/**
 * Plausible wheelbase range for a sub-1m garden robot.
 * Persisted values outside this range are rejected on load and the defaults
 * are used instead — this prevents a corrupted calibration run from poisoning
 * the next session.
 */
export const WHEEL_BASE_METERS_MIN_PLAUSIBLE = 0.20;
export const WHEEL_BASE_METERS_MAX_PLAUSIBLE = 1.50;

/**
 * Heading-error angle at which the straight-line driver gives up trying to
 * steer through the misalignment under power and pivots in place to
 * re-acquire the line first.
 */
export const DRIVE_STEERING_ROTATE_TO_HEADING_MIN_ANGLE_DEG = 45;

/**
 * Wheel output magnitude used for the in-place pivot recovery.  Kept above
 * the motor minimum-active output so it never deadbands out.
 */
export const DRIVE_STEERING_PIVOT_OUTPUT_PERCENT = 0.35;

/**
 * Within this remaining-along-track distance from the target the driver no
 * longer reaches for an in-place pivot.  The brake trigger is imminent and
 * pivoting next to the target would just waste arrival accuracy.
 */
export const DRIVE_STEERING_TARGET_INFLUENCE_DISTANCE_METERS = 0.5;

/**
 * Maximum left/right wheel-trim magnitude applied by the proportional CTE
 * correction.  Trims above this would make one wheel reverse while the other
 * is still forward, which the minimum-active-arc handler turns into an
 * in-place pivot — capping here keeps that pivot escalation deliberate.
 */
export const DRIVE_STEERING_MAX_TRIM_PERCENT = 0.35;

/**
 * Additional proportional steering trim applied per degree of heading error
 * on longer straight drives. Short drives keep the existing CTE-only trim so
 * the already-working <=1m behavior is preserved.
 */
export const DRIVE_LONG_STEERING_HEADING_GAIN_PER_DEG = 0.01;

/**
 * Upper bound for the dedicated short-distance stop-trigger buckets (meters).
 */
export const DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS = 1.0;

/**
 * Short-drive bucket step in meters
 */
export const DRIVE_SHORT_BUCKET_STEP_METERS = 0.05;

/**
 * Exact short-distance training / learning buckets (meters).
 * These runs are too short to assume the mower has definitely reached the
 * shared full-speed plateau before braking.
 */
export const DRIVE_SHORT_BUCKET_DISTANCES_METERS = [
  0.10, 0.15, 0.20, 0.25, 0.30,
  0.35, 0.40, 0.45, 0.50, 0.55, 0.60,
  0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00,
] as const;

/**
 * Longer straight-drive sample distances (meters) used to keep exercising the
 * forward/reverse full-speed brake distances under real conditions without introducing
 * extra long-distance buckets.
 */
export const DRIVE_LONG_SAMPLE_DISTANCES_METERS = [2.0, 3.0, 4.0] as const;

/**
 * Maximum distance covered by straight-line training runs (meters).
 */
export const DRIVE_SHORT_BUCKET_MAX_METERS = 4.0;

/**
 * Acceptance bound for line-drive arrival error (meters), applied to BOTH the
 * along-track (X) and cross-track (Y) error.  The tuner repeats the
 * forward+reverse pair at every distance until both legs are within this
 * bound on both axes.  Same bound for short and long drives — see the
 * project-wide drive-acceptance feedback memory.
 */
export const DRIVE_ACCEPTANCE_ERROR_METERS = 0.03;

/**
 * Backwards-compatible alias used by the existing API surface for the
 * short-distance training endpoint (`targetXErrorMeters`).  Removing the
 * old constant would force a wider rename; aliasing keeps the diff small.
 */
export const DRIVE_SHORT_TARGET_X_ERROR_METERS = DRIVE_ACCEPTANCE_ERROR_METERS;

/**
 * Acceptance bound for cross-track Y error at arrival (meters).  Mirror of
 * `DRIVE_ACCEPTANCE_ERROR_METERS` exposed under a Y-specific name so the API
 * surface for the short-training endpoint can carry it as `targetYErrorMeters`.
 */
export const DRIVE_SHORT_TARGET_Y_ERROR_METERS = DRIVE_ACCEPTANCE_ERROR_METERS;

/**
 * Minimum distance covered by segment-drive learning (meters)
 */
export const DRIVE_SEGMENT_MIN_DISTANCE_METERS = 0.3;

/**
 * Maximum distance covered by segment-drive learning (meters)
 */
export const DRIVE_SEGMENT_MAX_DISTANCE_METERS = 6.0;

/**
 * Step size for segment-drive learning distances (meters)
 */
export const DRIVE_SEGMENT_STEP_METERS = 0.2;

/**
 * Arrival tolerance for drive completion (meters)
 * Once the mower is within this along-track distance of the target, it should stop.
 */
export const DRIVE_ARRIVAL_TOLERANCE_METERS = 0.01;

/**
 * Default encoder meters per tick for dead-reckoning.
 * Treated as an uncalibrated starting point — assume left and right wheels are
 * the same diameter until a calibration run measures otherwise.  The
 * dead-reckoning calibration writes per-wheel values back into
 * pose-calibration.json.
 */
export const ENCODER_METERS_PER_TICK_DEFAULT = 0.001;

/**
 * Plausible per-wheel meters-per-tick range.
 * Persisted values outside this range are rejected on load and the default
 * is used instead.
 */
export const ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE = 1e-5;
export const ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE = 1e-2;

/**
 * Target CTE for tuning (meters)
 * 4cm - learning algorithm tries to achieve this
 */
export const DRIVE_TARGET_CTE_METERS = 0.04;
