#include <Arduino.h>
#include <Wire.h>
#include "driver/ledc.h"

// Second-generation motor controller for ESP32.
// It accepts explicit left/right wheel percentage targets over I2C, applies
// local ramping and safe direction reversals, and returns a coherent feedback
// snapshot with FG pulse deltas, applied PWM, current, and watchdog/fault
// state.
//
// This sketch intentionally does NOT run any local wheel-speed regulation from
// encoder feedback. The Pi is the controller. This ESP32 is only a ramped PWM
// bridge plus telemetry source.
//
// Encoder signing: each tachometer line is single-channel (no quadrature), so
// pulse direction is inferred from a cached "last commanded direction" sign
// per wheel (g_leftDirSign / g_rightDirSign). applyMotorHardware updates the
// cache in lockstep with the DIR-pin write, so the cache is the canonical
// record of the last commanded direction and the encoder ISR signs each
// pulse from it directly. The cache is only flipped after the firmware has
// ramped PWM magnitude through zero, so coast pulses during brake-to-stop
// and during direction reversals are signed by the direction the wheel was
// actually rolling at the moment of the pulse — not by whether the motor
// is currently powered.

// ===== I2C / protocol =====
static const uint8_t I2C_SLAVE_ADDRESS = 0x66;
static const uint8_t PROTOCOL_START_OF_FRAME = 0x4D;
static const uint8_t PROTOCOL_VERSION = 0x01;
static const uint8_t NODE_ID_MOTOR = 0x20;
static const uint8_t MESSAGE_TYPE_WHEEL_SPEED_COMMAND = 0x21;
static const uint8_t MESSAGE_TYPE_MOTOR_FEEDBACK = 0x22;

static const size_t FRAME_HEADER_SIZE = 9;
static const size_t FRAME_CRC_SIZE = 2;
static const size_t WHEEL_COMMAND_PAYLOAD_SIZE = 15;
static const size_t MOTOR_FEEDBACK_PAYLOAD_SIZE = 22;
static const size_t MAX_FRAME_SIZE = FRAME_HEADER_SIZE + MOTOR_FEEDBACK_PAYLOAD_SIZE + FRAME_CRC_SIZE;

// ===== Pins =====
static const uint8_t SDA_PIN = 16;
static const uint8_t SCL_PIN = 17;

static const uint8_t LEFT_PWM_PIN = 5;
static const uint8_t LEFT_DIR_PIN = 18;
static const uint8_t RIGHT_PWM_PIN = 14;
static const uint8_t RIGHT_DIR_PIN = 19;

static const uint8_t LEFT_TACH_PIN = 21;
static const uint8_t RIGHT_TACH_PIN = 22;
static const uint8_t LEFT_CURRENT_SENSE_PIN = 34;
static const uint8_t RIGHT_CURRENT_SENSE_PIN = 35;

// ===== PWM =====
static const uint32_t PWM_FREQ_HZ = 30000;
static const ledc_mode_t PWM_MODE = LEDC_HIGH_SPEED_MODE;
static const ledc_timer_bit_t PWM_RESOLUTION = LEDC_TIMER_8_BIT;
static const ledc_timer_t PWM_TIMER = LEDC_TIMER_0;
static const ledc_channel_t LEFT_CHANNEL = LEDC_CHANNEL_0;
static const ledc_channel_t RIGHT_CHANNEL = LEDC_CHANNEL_1;
static const int PWM_MAX_DUTY = 255;

// ===== Control / reporting =====
static const uint32_t CONTROL_PERIOD_MS = 10;      // 100 Hz
static const uint32_t FEEDBACK_PERIOD_MS = 50;     // 20 Hz
static const uint32_t DEFAULT_RAMP_UP_MS = 460;
static const uint32_t DEFAULT_RAMP_DOWN_MS = 700;
static const float DEFAULT_MIN_EFFECTIVE_WHEEL_OUTPUT_PERCENT = 0.025f;
static const float CURRENT_SENSOR_SUPPLY_VOLTS = 3.3f;
static const float CURRENT_SENSOR_VOLTS_PER_AMP = 0.185f;  // ACS712ELC-05B typical sensitivity
static const float CURRENT_SENSOR_FILTER_ALPHA = 0.2f;
static const uint16_t CURRENT_SENSOR_CALIBRATION_SAMPLES = 128;
static const uint16_t ADC_MAX_COUNT = 4095;

// ===== Fault bits =====
static const uint16_t MOTOR_FAULT_LEFT_DRIVER = (1u << 3);
static const uint16_t MOTOR_FAULT_RIGHT_DRIVER = (1u << 4);
static const uint16_t MOTOR_FAULT_OVERCURRENT = (1u << 5);

struct WheelSpeedCommand {
  uint32_t timestampMillis;
  float leftWheelTargetPercent;
  float rightWheelTargetPercent;
  bool enableDrive;
  uint16_t commandTimeoutMillis;
  bool hasAccelLimit;
  float maxAccelerationPercentPerSecond;
  bool hasDecelLimit;
  float maxDecelerationPercentPerSecond;
};

struct FeedbackSnapshot {
  uint32_t timestampMillis;
  int32_t leftEncoderDelta;
  int32_t rightEncoderDelta;
  int8_t leftPwmAppliedPercent;
  int8_t rightPwmAppliedPercent;
  float leftMotorCurrentAmps;
  float rightMotorCurrentAmps;
  bool watchdogHealthy;
  uint16_t faultFlags;
};

struct MotorState {
  const char *label;
  ledc_channel_t pwmChannel;
  uint8_t pwmPin;
  uint8_t dirPin;
  bool inverted;
  int8_t appliedPwmPercent;
  int8_t requestedPwmPercent;
  int8_t currentDirectionSign;
  bool directionChangePending;
  float targetPercent;
  float rampedTargetPercent;
};

struct CurrentSensorState {
  uint8_t pin;
  float zeroVoltageVolts;
  float filteredCurrentAmps;
};

volatile int32_t g_leftPulseAccumulator = 0;
volatile int32_t g_rightPulseAccumulator = 0;
volatile uint32_t g_lastLeftPulseMicros = 0;
volatile uint32_t g_lastRightPulseMicros = 0;
// Last sign written to the DIR pin for each wheel. The encoder ISRs sign
// each pulse by this value so coast pulses during brake-to-stop are
// attributed to the direction the wheel was last driven, not zeroed.
// applyMotorHardware updates these together with the digitalWrite that
// drives the DIR pin, so there is exactly one source of truth.
volatile int8_t g_leftDirSign = 1;
volatile int8_t g_rightDirSign = 1;
static const uint32_t ENCODER_DEBOUNCE_MICROS = 800;

MotorState g_leftMotor = { "left", LEFT_CHANNEL, LEFT_PWM_PIN, LEFT_DIR_PIN, false, 0, 0, 1, false, 0.0f, 0.0f };
MotorState g_rightMotor = { "right", RIGHT_CHANNEL, RIGHT_PWM_PIN, RIGHT_DIR_PIN, true, 0, 0, 1, false, 0.0f, 0.0f };

WheelSpeedCommand g_latestCommand = { 0, 0.0f, 0.0f, false, 0, false, 0.0f, false, 0.0f };
FeedbackSnapshot g_latestFeedback = { 0, 0, 0, 0, 0, 0.0f, 0.0f, false, 0 };
CurrentSensorState g_leftCurrentSensor = { LEFT_CURRENT_SENSE_PIN, CURRENT_SENSOR_SUPPLY_VOLTS / 2.0f, 0.0f };
CurrentSensorState g_rightCurrentSensor = { RIGHT_CURRENT_SENSE_PIN, CURRENT_SENSOR_SUPPLY_VOLTS / 2.0f, 0.0f };

uint16_t g_lastFeedbackRequestSequence = 0;
bool g_haveFeedbackRequest = false;

uint8_t g_txFrame[MAX_FRAME_SIZE];
size_t g_txFrameLength = 0;

uint32_t g_lastControlMillis = 0;
uint32_t g_lastFeedbackMillis = 0;

// ===== Helpers =====
uint16_t crc16Ccitt(const uint8_t *data, size_t length) {
  uint16_t crc = 0xFFFF;
  for (size_t index = 0; index < length; index += 1) {
    crc ^= static_cast<uint16_t>(data[index]) << 8;
    for (uint8_t bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) != 0) {
        crc = static_cast<uint16_t>((crc << 1) ^ 0x1021);
      } else {
        crc = static_cast<uint16_t>(crc << 1);
      }
    }
  }
  return crc;
}

uint16_t readU16LE(const uint8_t *bytes) {
  return static_cast<uint16_t>(bytes[0]) | (static_cast<uint16_t>(bytes[1]) << 8);
}

uint32_t readU32LE(const uint8_t *bytes) {
  return static_cast<uint32_t>(bytes[0])
       | (static_cast<uint32_t>(bytes[1]) << 8)
       | (static_cast<uint32_t>(bytes[2]) << 16)
       | (static_cast<uint32_t>(bytes[3]) << 24);
}

int16_t readI16LE(const uint8_t *bytes) {
  return static_cast<int16_t>(readU16LE(bytes));
}

int32_t readI32LE(const uint8_t *bytes) {
  return static_cast<int32_t>(readU32LE(bytes));
}

void writeU16LE(uint8_t *bytes, uint16_t value) {
  bytes[0] = static_cast<uint8_t>(value & 0xFF);
  bytes[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

void writeU32LE(uint8_t *bytes, uint32_t value) {
  bytes[0] = static_cast<uint8_t>(value & 0xFF);
  bytes[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
  bytes[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
  bytes[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
}

void writeI16LE(uint8_t *bytes, int16_t value) {
  writeU16LE(bytes, static_cast<uint16_t>(value));
}

void writeI32LE(uint8_t *bytes, int32_t value) {
  writeU32LE(bytes, static_cast<uint32_t>(value));
}

int8_t clampPercent(int value) {
  if (value < -100) return -100;
  if (value > 100) return 100;
  return static_cast<int8_t>(value);
}

float clampFloat(float value, float minValue, float maxValue) {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

uint16_t encodeCurrentTenths(float amps) {
  float clamped = clampFloat(amps, 0.0f, 6553.4f);
  return static_cast<uint16_t>((clamped * 10.0f) + 0.5f);
}

// ===== Encoder ISR =====
//
// Single-line tachometer: each pulse reports physical wheel rotation, but the
// pulse alone has no direction. We sign each pulse by g_leftDirSign /
// g_rightDirSign, which applyMotorHardware updates atomically with the
// DIR-pin write — so the cache is the canonical record of the last
// commanded direction. Crucially this is correct during the brake/coast
// window (DIR is unchanged, so coast pulses inherit the last commanded
// direction) and during a direction reversal (the firmware ramps PWM
// magnitude to zero before flipping DIR, so deceleration pulses keep the
// OLD sign and post-flip pulses pick up the NEW sign).
void IRAM_ATTR onLeftPulse() {
  uint32_t now = micros();
  if (now - g_lastLeftPulseMicros > ENCODER_DEBOUNCE_MICROS) {
    g_leftPulseAccumulator += g_leftDirSign;
    g_lastLeftPulseMicros = now;
  }
}

void IRAM_ATTR onRightPulse() {
  uint32_t now = micros();
  if (now - g_lastRightPulseMicros > ENCODER_DEBOUNCE_MICROS) {
    g_rightPulseAccumulator += g_rightDirSign;
    g_lastRightPulseMicros = now;
  }
}

// ===== Protocol handling =====
bool decodeFrame(const uint8_t *frame, size_t length, uint8_t &messageType, uint16_t &sequence, const uint8_t *&payload, uint16_t &payloadLength) {
  if (length < FRAME_HEADER_SIZE + FRAME_CRC_SIZE) {
    return false;
  }
  if (frame[0] != PROTOCOL_START_OF_FRAME || frame[1] != PROTOCOL_VERSION || frame[2] != NODE_ID_MOTOR) {
    return false;
  }

  messageType = frame[3];
  sequence = readU16LE(&frame[5]);
  payloadLength = readU16LE(&frame[7]);
  size_t expectedLength = FRAME_HEADER_SIZE + payloadLength + FRAME_CRC_SIZE;
  if (length != expectedLength) {
    return false;
  }

  uint16_t actualCrc = readU16LE(&frame[FRAME_HEADER_SIZE + payloadLength]);
  uint16_t expectedCrc = crc16Ccitt(&frame[1], FRAME_HEADER_SIZE - 1 + payloadLength);
  if (actualCrc != expectedCrc) {
    return false;
  }

  payload = &frame[FRAME_HEADER_SIZE];
  return true;
}

size_t encodeFrame(uint8_t messageType, uint16_t sequence, uint8_t flags, const uint8_t *payload, uint16_t payloadLength, uint8_t *outFrame) {
  outFrame[0] = PROTOCOL_START_OF_FRAME;
  outFrame[1] = PROTOCOL_VERSION;
  outFrame[2] = NODE_ID_MOTOR;
  outFrame[3] = messageType;
  outFrame[4] = flags;
  writeU16LE(&outFrame[5], sequence);
  writeU16LE(&outFrame[7], payloadLength);
  memcpy(&outFrame[FRAME_HEADER_SIZE], payload, payloadLength);
  uint16_t crc = crc16Ccitt(&outFrame[1], FRAME_HEADER_SIZE - 1 + payloadLength);
  writeU16LE(&outFrame[FRAME_HEADER_SIZE + payloadLength], crc);
  return FRAME_HEADER_SIZE + payloadLength + FRAME_CRC_SIZE;
}

bool decodeWheelSpeedCommandPayload(const uint8_t *payload, uint16_t payloadLength, WheelSpeedCommand &command) {
  if (payloadLength != WHEEL_COMMAND_PAYLOAD_SIZE) {
    return false;
  }

  command.timestampMillis = readU32LE(&payload[0]);
  command.leftWheelTargetPercent = static_cast<float>(readI16LE(&payload[4])) / 1000.0f;
  command.rightWheelTargetPercent = static_cast<float>(readI16LE(&payload[6])) / 1000.0f;
  command.enableDrive = payload[8] == 1;
  command.commandTimeoutMillis = readU16LE(&payload[9]);

  uint16_t accelRaw = readU16LE(&payload[11]);
  command.hasAccelLimit = accelRaw != 0xFFFF;
  command.maxAccelerationPercentPerSecond = command.hasAccelLimit ? static_cast<float>(accelRaw) / 1000.0f : 0.0f;

  uint16_t decelRaw = readU16LE(&payload[13]);
  command.hasDecelLimit = decelRaw != 0xFFFF;
  command.maxDecelerationPercentPerSecond = command.hasDecelLimit ? static_cast<float>(decelRaw) / 1000.0f : 0.0f;
  return true;
}

void encodeMotorFeedbackPayload(const FeedbackSnapshot &feedback, uint8_t *payloadOut) {
  writeU32LE(&payloadOut[0], feedback.timestampMillis);
  writeI32LE(&payloadOut[4], feedback.leftEncoderDelta);
  writeI32LE(&payloadOut[8], feedback.rightEncoderDelta);
  payloadOut[12] = static_cast<uint8_t>(feedback.leftPwmAppliedPercent);
  payloadOut[13] = static_cast<uint8_t>(feedback.rightPwmAppliedPercent);
  writeU16LE(&payloadOut[14], encodeCurrentTenths(feedback.leftMotorCurrentAmps));
  writeU16LE(&payloadOut[16], encodeCurrentTenths(feedback.rightMotorCurrentAmps));
  payloadOut[18] = feedback.watchdogHealthy ? 1 : 0;
  writeU16LE(&payloadOut[19], feedback.faultFlags);
  payloadOut[21] = 0;
}

// ===== Low-level motor output =====
void applyMotorHardware(MotorState &motor) {
  int8_t dirSign = motor.currentDirectionSign >= 0 ? 1 : -1;
  int directionBit = dirSign >= 0 ? 0 : 1;
  digitalWrite(motor.dirPin, directionBit ^ (motor.inverted ? 1 : 0));

  // Mirror the sign that just drove the DIR pin into the volatile cache the
  // encoder ISR reads. Doing it here (the only place that writes the DIR
  // pin) keeps the cache and the pin in lockstep — the ISR can rely on the
  // cache being a faithful record of the last commanded direction.
  if (motor.dirPin == LEFT_DIR_PIN) {
    g_leftDirSign = dirSign;
  } else if (motor.dirPin == RIGHT_DIR_PIN) {
    g_rightDirSign = dirSign;
  }

  int duty = (abs(motor.appliedPwmPercent) * PWM_MAX_DUTY) / 100;
  ledc_set_duty(PWM_MODE, motor.pwmChannel, duty);
  ledc_update_duty(PWM_MODE, motor.pwmChannel);
}

void forceMotorStop(MotorState &motor) {
  motor.requestedPwmPercent = 0;
  motor.appliedPwmPercent = 0;
  // Leave currentDirectionSign at its last non-zero value. The DIR pin is
  // driven from this field, and the encoder ISR signs coast pulses by the
  // pin level. Zeroing the sign here would flip the DIR pin to a default
  // ("forward") while the wheel is still coasting in the prior direction,
  // mis-signing every coast pulse during the brake-to-stop window.
  motor.targetPercent = 0.0f;
  motor.rampedTargetPercent = 0.0f;
  applyMotorHardware(motor);
}

void stepMotorTowardRequested(MotorState &motor, uint32_t elapsedMs, uint32_t rampUpMs, uint32_t rampDownMs) {
  // The Pi owns control. This ESP32 only ramps the requested duty toward the
  // latest accepted target and handles safe direction reversals through zero.
  motor.rampedTargetPercent = motor.targetPercent;

  if (fabs(motor.rampedTargetPercent) < DEFAULT_MIN_EFFECTIVE_WHEEL_OUTPUT_PERCENT) {
    motor.requestedPwmPercent = 0;
  } else {
    motor.requestedPwmPercent = clampPercent(
      static_cast<int>(motor.rampedTargetPercent * 100.0f)
    );
  }

  int targetSign = motor.requestedPwmPercent >= 0 ? 1 : -1;
  int targetMagnitude = abs(motor.requestedPwmPercent);
  int currentMagnitude = abs(motor.appliedPwmPercent);
  uint32_t activeRampMs = (targetMagnitude > currentMagnitude) ? rampUpMs : rampDownMs;
  int maxStep = max(1, static_cast<int>((100.0f * static_cast<float>(elapsedMs)) / static_cast<float>(max<uint32_t>(1, activeRampMs))));

  if (motor.appliedPwmPercent != 0 && motor.currentDirectionSign != targetSign && targetMagnitude > 0) {
    int reduced = currentMagnitude - maxStep;
    if (reduced < 0) reduced = 0;
    motor.appliedPwmPercent = clampPercent(motor.currentDirectionSign * reduced);
    if (reduced == 0) {
      motor.currentDirectionSign = targetSign;
    }
    applyMotorHardware(motor);
    return;
  }

  int desiredSignedPercent = targetMagnitude == 0 ? 0 : targetSign * targetMagnitude;
  if (motor.appliedPwmPercent < desiredSignedPercent) {
    motor.appliedPwmPercent = clampPercent(motor.appliedPwmPercent + maxStep);
  } else if (motor.appliedPwmPercent > desiredSignedPercent) {
    motor.appliedPwmPercent = clampPercent(motor.appliedPwmPercent - maxStep);
  }

  int minimumMovingPwmPercent = max(
    1,
    static_cast<int>(DEFAULT_MIN_EFFECTIVE_WHEEL_OUTPUT_PERCENT * 100.0f)
  );
  int appliedMagnitude = abs(motor.appliedPwmPercent);
  bool effectiveMoveRequested = targetMagnitude > 0
    && fabs(motor.rampedTargetPercent) >= DEFAULT_MIN_EFFECTIVE_WHEEL_OUTPUT_PERCENT;
  if (effectiveMoveRequested && appliedMagnitude > 0 && appliedMagnitude < minimumMovingPwmPercent) {
    motor.appliedPwmPercent = clampPercent(targetSign * minimumMovingPwmPercent);
  } else if (targetMagnitude == 0 && appliedMagnitude < minimumMovingPwmPercent) {
    motor.appliedPwmPercent = 0;
  }

  if (motor.appliedPwmPercent > 0) {
    motor.currentDirectionSign = 1;
  } else if (motor.appliedPwmPercent < 0) {
    motor.currentDirectionSign = -1;
  }
  // When the applied PWM falls to zero we deliberately keep the last
  // non-zero direction sign. The DIR pin stays reflecting the direction
  // the wheel was last driven, so the encoder ISR signs coast pulses
  // correctly while the wheel rolls to a stop.
  applyMotorHardware(motor);
}

uint32_t rampMillisFromRate(float percentPerSecond, uint32_t fallbackRampMs) {
  if (percentPerSecond <= 0.0f) {
    return fallbackRampMs;
  }
  float rampMillis = (1.0f / percentPerSecond) * 1000.0f;
  return max<uint32_t>(1, static_cast<uint32_t>(rampMillis));
}

// ===== Control / feedback =====
float adcCountToVolts(int rawCount) {
  return (static_cast<float>(rawCount) / static_cast<float>(ADC_MAX_COUNT)) * CURRENT_SENSOR_SUPPLY_VOLTS;
}

void calibrateCurrentSensor(CurrentSensorState &sensor) {
  uint32_t accumulator = 0;
  for (uint16_t index = 0; index < CURRENT_SENSOR_CALIBRATION_SAMPLES; index += 1) {
    accumulator += static_cast<uint32_t>(analogRead(sensor.pin));
    delay(2);
  }

  sensor.zeroVoltageVolts = adcCountToVolts(static_cast<int>(accumulator / CURRENT_SENSOR_CALIBRATION_SAMPLES));
  sensor.filteredCurrentAmps = 0.0f;
}

float readCurrentSensor(CurrentSensorState &sensor) {
  const int rawCount = analogRead(sensor.pin);
  const float measuredVolts = adcCountToVolts(rawCount);
  const float signedCurrentAmps = (measuredVolts - sensor.zeroVoltageVolts) / CURRENT_SENSOR_VOLTS_PER_AMP;
  const float currentMagnitudeAmps = fabs(signedCurrentAmps);

  sensor.filteredCurrentAmps = (sensor.filteredCurrentAmps * (1.0f - CURRENT_SENSOR_FILTER_ALPHA))
    + (currentMagnitudeAmps * CURRENT_SENSOR_FILTER_ALPHA);
  return sensor.filteredCurrentAmps;
}

void refreshFeedbackSnapshot(uint32_t nowMillis) {
  static uint32_t lastSnapshotMillis = 0;
  uint32_t elapsedMs = nowMillis - lastSnapshotMillis;
  if (elapsedMs == 0) {
    elapsedMs = FEEDBACK_PERIOD_MS;
  }
  lastSnapshotMillis = nowMillis;

  // The encoder ISRs already sign each pulse by the live DIR-pin level, so
  // the accumulator is the signed pulse delta over this feedback window —
  // including coast pulses during brake-to-stop and ramp-down, which used
  // to be discarded by an unwanted "is the motor driven right now?" gate.
  int32_t signedLeftPulses = 0;
  int32_t signedRightPulses = 0;
  noInterrupts();
  signedLeftPulses = g_leftPulseAccumulator;
  signedRightPulses = g_rightPulseAccumulator;
  g_leftPulseAccumulator = 0;
  g_rightPulseAccumulator = 0;
  interrupts();

  g_latestFeedback.timestampMillis = nowMillis;
  g_latestFeedback.leftEncoderDelta = signedLeftPulses;
  g_latestFeedback.rightEncoderDelta = signedRightPulses;
  g_latestFeedback.leftPwmAppliedPercent = g_leftMotor.appliedPwmPercent;
  g_latestFeedback.rightPwmAppliedPercent = g_rightMotor.appliedPwmPercent;
  g_latestFeedback.leftMotorCurrentAmps = readCurrentSensor(g_leftCurrentSensor);
  g_latestFeedback.rightMotorCurrentAmps = readCurrentSensor(g_rightCurrentSensor);
  g_latestFeedback.faultFlags = 0;
  g_latestFeedback.watchdogHealthy = g_latestCommand.enableDrive;

  uint8_t payload[MOTOR_FEEDBACK_PAYLOAD_SIZE];
  encodeMotorFeedbackPayload(g_latestFeedback, payload);
  g_txFrameLength = encodeFrame(MESSAGE_TYPE_MOTOR_FEEDBACK, g_lastFeedbackRequestSequence, g_latestFeedback.faultFlags == 0 ? 0 : 0x01, payload, MOTOR_FEEDBACK_PAYLOAD_SIZE, g_txFrame);
}

void runControlStep(uint32_t nowMillis) {
  static uint32_t lastStepMillis = 0;

  bool allowDrive = g_latestCommand.enableDrive;

  float leftTarget = allowDrive ? g_latestCommand.leftWheelTargetPercent : 0.0f;
  float rightTarget = allowDrive ? g_latestCommand.rightWheelTargetPercent : 0.0f;
  g_leftMotor.targetPercent = leftTarget;
  g_rightMotor.targetPercent = rightTarget;

  if (!allowDrive) {
    forceMotorStop(g_leftMotor);
    forceMotorStop(g_rightMotor);
    lastStepMillis = nowMillis;
    return;
  }

  uint32_t elapsedMs = nowMillis - lastStepMillis;
  if (elapsedMs == 0 || elapsedMs > (CONTROL_PERIOD_MS * 2)) {
    elapsedMs = CONTROL_PERIOD_MS;
  }
  lastStepMillis = nowMillis;

  uint32_t rampUpMs = g_latestCommand.hasAccelLimit
    ? rampMillisFromRate(g_latestCommand.maxAccelerationPercentPerSecond, DEFAULT_RAMP_UP_MS)
    : DEFAULT_RAMP_UP_MS;
  uint32_t rampDownMs = g_latestCommand.hasDecelLimit
    ? rampMillisFromRate(g_latestCommand.maxDecelerationPercentPerSecond, DEFAULT_RAMP_DOWN_MS)
    : DEFAULT_RAMP_DOWN_MS;

  stepMotorTowardRequested(g_leftMotor, elapsedMs, rampUpMs, rampDownMs);
  stepMotorTowardRequested(g_rightMotor, elapsedMs, rampUpMs, rampDownMs);
}

// ===== I2C =====
void onReceive(int numBytes) {
  if (numBytes <= 0 || numBytes > static_cast<int>(MAX_FRAME_SIZE)) {
    while (Wire.available()) {
      Wire.read();
    }
    return;
  }

  uint8_t buffer[MAX_FRAME_SIZE];
  int count = 0;
  while (Wire.available() && count < numBytes) {
    buffer[count++] = Wire.read();
  }

  uint8_t messageType = 0;
  uint16_t sequence = 0;
  uint16_t payloadLength = 0;
  const uint8_t *payload = nullptr;
  if (!decodeFrame(buffer, count, messageType, sequence, payload, payloadLength)) {
    return;
  }

  if (messageType == MESSAGE_TYPE_WHEEL_SPEED_COMMAND) {
    WheelSpeedCommand decoded;
    if (decodeWheelSpeedCommandPayload(payload, payloadLength, decoded)) {
      g_latestCommand = decoded;
    }
  } else if (messageType == MESSAGE_TYPE_MOTOR_FEEDBACK) {
    g_lastFeedbackRequestSequence = sequence;
    g_haveFeedbackRequest = true;
  }
}

void onRequest() {
  if (!g_haveFeedbackRequest) {
    refreshFeedbackSnapshot(millis());
  }
  Wire.write(g_txFrame, g_txFrameLength);
}

// ===== Setup / loop =====
void configurePwm() {
  ledc_timer_config_t timerConfig;
  memset(&timerConfig, 0, sizeof(timerConfig));
  timerConfig.speed_mode = PWM_MODE;
  timerConfig.timer_num = PWM_TIMER;
  timerConfig.freq_hz = PWM_FREQ_HZ;
  timerConfig.duty_resolution = PWM_RESOLUTION;
  timerConfig.clk_cfg = LEDC_AUTO_CLK;
  ledc_timer_config(&timerConfig);

  ledc_channel_config_t leftChannelConfig;
  memset(&leftChannelConfig, 0, sizeof(leftChannelConfig));
  leftChannelConfig.gpio_num = LEFT_PWM_PIN;
  leftChannelConfig.speed_mode = PWM_MODE;
  leftChannelConfig.channel = LEFT_CHANNEL;
  leftChannelConfig.intr_type = LEDC_INTR_DISABLE;
  leftChannelConfig.timer_sel = PWM_TIMER;
  leftChannelConfig.duty = 0;
  ledc_channel_config(&leftChannelConfig);

  ledc_channel_config_t rightChannelConfig = leftChannelConfig;
  rightChannelConfig.gpio_num = RIGHT_PWM_PIN;
  rightChannelConfig.channel = RIGHT_CHANNEL;
  ledc_channel_config(&rightChannelConfig);
}

void setup() {
  Serial.begin(115200);

  pinMode(LEFT_DIR_PIN, OUTPUT);
  pinMode(RIGHT_DIR_PIN, OUTPUT);
  pinMode(LEFT_TACH_PIN, INPUT_PULLUP);
  pinMode(RIGHT_TACH_PIN, INPUT_PULLUP);
  pinMode(LEFT_CURRENT_SENSE_PIN, INPUT);
  pinMode(RIGHT_CURRENT_SENSE_PIN, INPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(LEFT_CURRENT_SENSE_PIN, ADC_11db);
  analogSetPinAttenuation(RIGHT_CURRENT_SENSE_PIN, ADC_11db);

  configurePwm();
  applyMotorHardware(g_leftMotor);
  applyMotorHardware(g_rightMotor);
  calibrateCurrentSensor(g_leftCurrentSensor);
  calibrateCurrentSensor(g_rightCurrentSensor);

  attachInterrupt(digitalPinToInterrupt(LEFT_TACH_PIN), onLeftPulse, FALLING);
  attachInterrupt(digitalPinToInterrupt(RIGHT_TACH_PIN), onRightPulse, FALLING);

  Wire.begin(I2C_SLAVE_ADDRESS, SDA_PIN, SCL_PIN, 400000);
  Wire.onReceive(onReceive);
  Wire.onRequest(onRequest);

  refreshFeedbackSnapshot(millis());
}

void loop() {
  uint32_t nowMillis = millis();
  if ((nowMillis - g_lastControlMillis) >= CONTROL_PERIOD_MS) {
    g_lastControlMillis = nowMillis;
    runControlStep(nowMillis);
  }

  if ((nowMillis - g_lastFeedbackMillis) >= FEEDBACK_PERIOD_MS) {
    g_lastFeedbackMillis = nowMillis;
    refreshFeedbackSnapshot(nowMillis);
  }
}
