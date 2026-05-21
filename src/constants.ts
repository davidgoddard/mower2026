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
 * Manual drive control loop interval in milliseconds
 */
export const MANUAL_DRIVE_LOOP_INTERVAL_MS = 100;

/**
 * Default IMU calibration sample count (design decision for accuracy vs time)
 */
export const IMU_DEFAULT_CALIBRATION_SAMPLES = 60;

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
 * Default maximum wheel speed in meters per second (physical system limit)
 * Based on 185 RPM motors with wheel circumference
 */
export const MAX_WHEEL_SPEED_MPS_DEFAULT = 0.75;

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
 * Motor stall detection threshold for measured wheel speed.
 */
export const MOTOR_STALL_SPEED_THRESHOLD_MPS = 0.01;

/**
 * Motor stall detection threshold for encoder deltas.
 */
export const MOTOR_STALL_ENCODER_DELTA_THRESHOLD = 0;

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
 * Number of consecutive stationary samples before declaring a stall.
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
 * Matches sensor polling rate (30Hz) - no benefit to polling faster than sensor updates
 */
export const TURN_POLLING_INTERVAL_MS = 33;

/**
 * Settle time after motor ramp-down before reading final heading
 */
export const TURN_SETTLE_TIME_MS = 200;

/**
 * Motor ramp-down time from hardware spec (milliseconds)
 * Time for motors to decelerate from full speed to zero
 */
export const MOTOR_RAMP_DOWN_TIME_MS = 1000;

/**
 * Motor ramp-up time from hardware spec (milliseconds)
 * Time for motors to accelerate from zero to full speed
 */
export const MOTOR_RAMP_UP_TIME_MS = 1000;

/**
 * Small angle threshold - below this, use special handling (degrees)
 * Small angles require different brake strategy
 */
export const TURN_SMALL_ANGLE_THRESHOLD_DEG = 60;

/**
 * Crawl speed factor used for small-angle turns
 * A lower-than-full-speed turn that still keeps enough momentum to avoid stalls.
 */
export const TURN_SMALL_CRAWL_SPEED_FACTOR = 0.45;

/**
 * Learning rate for brake angle adaptation (0-1)
 * Higher = faster learning but less stable
 */
export const TURN_LEARNING_RATE = 0.3;

/**
 * Turn timeout safety multiplier
 * Timeout = (angle / expected_rotation_rate) * multiplier
 */
export const TURN_TIMEOUT_MULTIPLIER = 3.0;

/**
 * Maximum number of turn results to keep in history
 */
export const TURN_HISTORY_MAX_SIZE = 100;

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
 * Drive timeout safety multiplier
 * Timeout = (distance / expected_speed) * multiplier
 */
export const DRIVE_TIMEOUT_MULTIPLIER = 3.0;

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
export const DRIVE_BRAKE_DISTANCE_DEFAULT_METERS = 2.0;

/**
 * Default CTE correction proportional gain
 * Higher = more aggressive correction
 */
export const DRIVE_CTE_GAIN_DEFAULT = 0.3;

/**
 * Upper bound for the 5cm fine short-drive buckets (meters)
 * The short-drive learner still uses one shared 1.05m bucket for longer runs.
 */
export const DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS = 1.0;

/**
 * Short-drive bucket step in meters
 */
export const DRIVE_SHORT_BUCKET_STEP_METERS = 0.05;

/**
 * Maximum distance covered by short-drive bucket learning (meters)
 */
export const DRIVE_SHORT_BUCKET_MAX_METERS = 4.0;

/**
 * Start of the coarse short-drive bucket range (meters)
 */
export const DRIVE_SHORT_BUCKET_COARSE_START_METERS = 1.05;

/**
 * Step size for the coarse short-drive bucket range (meters)
 */
export const DRIVE_SHORT_BUCKET_COARSE_STEP_METERS = 0.5;

/**
 * Target absolute X error for short-drive learning runs (meters)
 */
export const DRIVE_SHORT_TARGET_X_ERROR_METERS = 0.04;

/**
 * Minimum distance covered by segment-drive learning (meters)
 */
export const DRIVE_SEGMENT_MIN_DISTANCE_METERS = 1.05;

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
 * Default encoder meters per tick for dead-reckoning
 */
export const ENCODER_METERS_PER_TICK_DEFAULT = 0.001;

/**
 * Target CTE for tuning (meters)
 * 5cm - learning algorithm tries to achieve this
 */
export const DRIVE_TARGET_CTE_METERS = 0.05;

/**
 * Distance from the target within which heading preview correction fades out (meters)
 * This keeps the controller from making sharp turn-ins right at the target.
 */
export const DRIVE_HEADING_CORRECTION_FADEOUT_METERS = 0.25;

/**
 * Maximum distance used when projecting heading error into an equivalent lateral offset (meters)
 * Larger remaining distances still cap at this preview range to avoid over-correction.
 */
export const DRIVE_HEADING_CORRECTION_MAX_LOOKAHEAD_METERS = 1.0;

/**
 * Blend factor for heading-preview correction
 * Higher = heading errors influence steering more strongly.
 */
export const DRIVE_HEADING_CORRECTION_BLEND = 0.65;

/**
 * Maximum absolute heading error used by the preview correction (degrees)
 */
export const DRIVE_HEADING_CORRECTION_MAX_DEGREES = 45;
