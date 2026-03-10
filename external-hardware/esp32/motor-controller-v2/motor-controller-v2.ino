#include <Arduino.h>
#include <Wire.h>
#include "driver/ledc.h"

// Second-generation motor controller for ESP32.
// It accepts explicit left/right wheel speed targets over I2C and returns
// a coherent feedback snapshot with encoder deltas, estimated wheel speeds,
// applied PWM, and watchdog/fault state.

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
static const size_t MOTOR_FEEDBACK_PAYLOAD_SIZE = 26;
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
static const uint32_t DEFAULT_TIMEOUT_MS = 250;
static const uint32_t DEFAULT_RAMP_UP_MS = 1200;
static const uint32_t DEFAULT_RAMP_DOWN_MS = 300;
static const float DEFAULT_MAX_WHEEL_SPEED_MPS = 0.75f;
static const float DEFAULT_SPEED_KP = 60.0f;       // PWM percent per m/s error
static const float DEFAULT_ENCODER_FAULT_SPEED_THRESHOLD = 0.20f;
static const float DEFAULT_ENCODER_FAULT_MOVEMENT_THRESHOLD = 0.02f;
static const uint32_t ENCODER_FAULT_DELAY_MS = 500;

// ===== Geometry / scaling =====
static const float DEFAULT_WHEEL_CIRCUMFERENCE_METERS = 0.70f;
static const int32_t DEFAULT_ENCODER_COUNTS_PER_WHEEL_REV = 1620;

// ===== Fault bits =====
static const uint16_t MOTOR_FAULT_WATCHDOG_EXPIRED = (1u << 0);
static const uint16_t MOTOR_FAULT_LEFT_ENCODER = (1u << 1);
static const uint16_t MOTOR_FAULT_RIGHT_ENCODER = (1u << 2);
static const uint16_t MOTOR_FAULT_LEFT_DRIVER = (1u << 3);
static const uint16_t MOTOR_FAULT_RIGHT_DRIVER = (1u << 4);
static const uint16_t MOTOR_FAULT_OVERCURRENT = (1u << 5);

struct WheelSpeedCommand {
  uint32_t timestampMillis;
  float leftWheelTargetMetersPerSecond;
  float rightWheelTargetMetersPerSecond;
  bool enableDrive;
  uint16_t commandTimeoutMillis;
  bool hasAccelLimit;
  float maxAccelerationMetersPerSecondSquared;
  bool hasDecelLimit;
  float maxDecelerationMetersPerSecondSquared;
};

struct FeedbackSnapshot {
  uint32_t timestampMillis;
  float leftWheelActualMetersPerSecond;
  float rightWheelActualMetersPerSecond;
  int32_t leftEncoderDelta;
  int32_t rightEncoderDelta;
  int8_t leftPwmAppliedPercent;
  int8_t rightPwmAppliedPercent;
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
  float targetMetersPerSecond;
  float actualMetersPerSecond;
  uint32_t encoderFaultSinceMillis;
};

volatile int32_t g_leftPulseAccumulator = 0;
volatile int32_t g_rightPulseAccumulator = 0;
volatile uint32_t g_lastLeftPulseMicros = 0;
volatile uint32_t g_lastRightPulseMicros = 0;
static const uint32_t ENCODER_DEBOUNCE_MICROS = 800;

MotorState g_leftMotor = { "left", LEFT_CHANNEL, LEFT_PWM_PIN, LEFT_DIR_PIN, false, 0, 0, 1, false, 0.0f, 0.0f, 0 };
MotorState g_rightMotor = { "right", RIGHT_CHANNEL, RIGHT_PWM_PIN, RIGHT_DIR_PIN, true, 0, 0, 1, false, 0.0f, 0.0f, 0 };

WheelSpeedCommand g_latestCommand = { 0, 0.0f, 0.0f, false, DEFAULT_TIMEOUT_MS, false, 0.0f, false, 0.0f };
FeedbackSnapshot g_latestFeedback = { 0, 0.0f, 0.0f, 0, 0, 0, 0, false, 0 };

uint32_t g_lastAcceptedCommandMillis = 0;
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

// ===== Encoder ISR =====
void IRAM_ATTR onLeftPulse() {
  uint32_t now = micros();
  if (now - g_lastLeftPulseMicros > ENCODER_DEBOUNCE_MICROS) {
    g_leftPulseAccumulator += 1;
    g_lastLeftPulseMicros = now;
  }
}

void IRAM_ATTR onRightPulse() {
  uint32_t now = micros();
  if (now - g_lastRightPulseMicros > ENCODER_DEBOUNCE_MICROS) {
    g_rightPulseAccumulator += 1;
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
  command.leftWheelTargetMetersPerSecond = static_cast<float>(readI16LE(&payload[4])) / 1000.0f;
  command.rightWheelTargetMetersPerSecond = static_cast<float>(readI16LE(&payload[6])) / 1000.0f;
  command.enableDrive = payload[8] == 1;
  command.commandTimeoutMillis = readU16LE(&payload[9]);

  uint16_t accelRaw = readU16LE(&payload[11]);
  command.hasAccelLimit = accelRaw != 0xFFFF;
  command.maxAccelerationMetersPerSecondSquared = command.hasAccelLimit ? static_cast<float>(accelRaw) / 1000.0f : 0.0f;

  uint16_t decelRaw = readU16LE(&payload[13]);
  command.hasDecelLimit = decelRaw != 0xFFFF;
  command.maxDecelerationMetersPerSecondSquared = command.hasDecelLimit ? static_cast<float>(decelRaw) / 1000.0f : 0.0f;
  return true;
}

void encodeMotorFeedbackPayload(const FeedbackSnapshot &feedback, uint8_t *payloadOut) {
  writeU32LE(&payloadOut[0], feedback.timestampMillis);
  writeI16LE(&payloadOut[4], static_cast<int16_t>(feedback.leftWheelActualMetersPerSecond * 1000.0f));
  writeI16LE(&payloadOut[6], static_cast<int16_t>(feedback.rightWheelActualMetersPerSecond * 1000.0f));
  writeI32LE(&payloadOut[8], feedback.leftEncoderDelta);
  writeI32LE(&payloadOut[12], feedback.rightEncoderDelta);
  payloadOut[16] = static_cast<uint8_t>(feedback.leftPwmAppliedPercent);
  payloadOut[17] = static_cast<uint8_t>(feedback.rightPwmAppliedPercent);
  writeU16LE(&payloadOut[18], 0xFFFF);  // current sensing unavailable for now
  writeU16LE(&payloadOut[20], 0xFFFF);
  payloadOut[22] = feedback.watchdogHealthy ? 1 : 0;
  writeU16LE(&payloadOut[23], feedback.faultFlags);
  payloadOut[25] = 0;
}

// ===== Low-level motor output =====
void applyMotorHardware(MotorState &motor) {
  int directionBit = motor.currentDirectionSign >= 0 ? 0 : 1;
  digitalWrite(motor.dirPin, directionBit ^ (motor.inverted ? 1 : 0));

  int duty = (abs(motor.appliedPwmPercent) * PWM_MAX_DUTY) / 100;
  ledc_set_duty(PWM_MODE, motor.pwmChannel, duty);
  ledc_update_duty(PWM_MODE, motor.pwmChannel);
}

void stepMotorTowardRequested(MotorState &motor, uint32_t elapsedMs, uint32_t rampUpMs, uint32_t rampDownMs) {
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

  if (motor.appliedPwmPercent > 0) {
    motor.currentDirectionSign = 1;
  } else if (motor.appliedPwmPercent < 0) {
    motor.currentDirectionSign = -1;
  }
  applyMotorHardware(motor);
}

// ===== Control / feedback =====
float pulsesToMeters(int32_t pulses) {
  return (static_cast<float>(pulses) / static_cast<float>(DEFAULT_ENCODER_COUNTS_PER_WHEEL_REV)) * DEFAULT_WHEEL_CIRCUMFERENCE_METERS;
}

void updateEncoderFault(MotorState &motor, bool leftMotor, uint32_t nowMillis) {
  bool commandedToMove = fabs(motor.targetMetersPerSecond) >= DEFAULT_ENCODER_FAULT_SPEED_THRESHOLD;
  bool measuredMoving = fabs(motor.actualMetersPerSecond) >= DEFAULT_ENCODER_FAULT_MOVEMENT_THRESHOLD;

  if (commandedToMove && !measuredMoving) {
    if (motor.encoderFaultSinceMillis == 0) {
      motor.encoderFaultSinceMillis = nowMillis;
    }
  } else {
    motor.encoderFaultSinceMillis = 0;
  }

  uint16_t faultBit = leftMotor ? MOTOR_FAULT_LEFT_ENCODER : MOTOR_FAULT_RIGHT_ENCODER;
  if (motor.encoderFaultSinceMillis != 0 && (nowMillis - motor.encoderFaultSinceMillis) >= ENCODER_FAULT_DELAY_MS) {
    g_latestFeedback.faultFlags |= faultBit;
  } else {
    g_latestFeedback.faultFlags = static_cast<uint16_t>(g_latestFeedback.faultFlags & ~faultBit);
  }
}

int8_t estimateOpenLoopPwm(float targetMetersPerSecond, float actualMetersPerSecond) {
  float normalizedFeedForward = (targetMetersPerSecond / DEFAULT_MAX_WHEEL_SPEED_MPS) * 100.0f;
  float speedError = targetMetersPerSecond - actualMetersPerSecond;
  float assist = speedError * DEFAULT_SPEED_KP;
  return clampPercent(static_cast<int>(normalizedFeedForward + assist));
}

void refreshFeedbackSnapshot(uint32_t nowMillis) {
  static uint32_t lastSnapshotMillis = 0;
  uint32_t elapsedMs = nowMillis - lastSnapshotMillis;
  if (elapsedMs == 0) {
    elapsedMs = FEEDBACK_PERIOD_MS;
  }
  lastSnapshotMillis = nowMillis;

  int32_t leftPulses = 0;
  int32_t rightPulses = 0;
  noInterrupts();
  leftPulses = g_leftPulseAccumulator;
  rightPulses = g_rightPulseAccumulator;
  g_leftPulseAccumulator = 0;
  g_rightPulseAccumulator = 0;
  interrupts();

  int32_t signedLeftPulses = leftPulses * g_leftMotor.currentDirectionSign;
  int32_t signedRightPulses = rightPulses * g_rightMotor.currentDirectionSign;
  float elapsedSeconds = static_cast<float>(elapsedMs) / 1000.0f;

  g_leftMotor.actualMetersPerSecond = pulsesToMeters(signedLeftPulses) / elapsedSeconds;
  g_rightMotor.actualMetersPerSecond = pulsesToMeters(signedRightPulses) / elapsedSeconds;

  g_latestFeedback.timestampMillis = nowMillis;
  g_latestFeedback.leftWheelActualMetersPerSecond = g_leftMotor.actualMetersPerSecond;
  g_latestFeedback.rightWheelActualMetersPerSecond = g_rightMotor.actualMetersPerSecond;
  g_latestFeedback.leftEncoderDelta = signedLeftPulses;
  g_latestFeedback.rightEncoderDelta = signedRightPulses;
  g_latestFeedback.leftPwmAppliedPercent = g_leftMotor.appliedPwmPercent;
  g_latestFeedback.rightPwmAppliedPercent = g_rightMotor.appliedPwmPercent;

  bool commandFresh = g_lastAcceptedCommandMillis != 0 && (nowMillis - g_lastAcceptedCommandMillis) <= g_latestCommand.commandTimeoutMillis;
  g_latestFeedback.watchdogHealthy = commandFresh && g_latestCommand.enableDrive;
  if (!g_latestFeedback.watchdogHealthy) {
    g_latestFeedback.faultFlags |= MOTOR_FAULT_WATCHDOG_EXPIRED;
  } else {
    g_latestFeedback.faultFlags = static_cast<uint16_t>(g_latestFeedback.faultFlags & ~MOTOR_FAULT_WATCHDOG_EXPIRED);
  }

  updateEncoderFault(g_leftMotor, true, nowMillis);
  updateEncoderFault(g_rightMotor, false, nowMillis);

  uint8_t payload[MOTOR_FEEDBACK_PAYLOAD_SIZE];
  encodeMotorFeedbackPayload(g_latestFeedback, payload);
  g_txFrameLength = encodeFrame(MESSAGE_TYPE_MOTOR_FEEDBACK, g_lastFeedbackRequestSequence, g_latestFeedback.faultFlags == 0 ? 0 : 0x01, payload, MOTOR_FEEDBACK_PAYLOAD_SIZE, g_txFrame);
}

void runControlStep(uint32_t nowMillis) {
  bool commandFresh = g_lastAcceptedCommandMillis != 0 && (nowMillis - g_lastAcceptedCommandMillis) <= g_latestCommand.commandTimeoutMillis;
  bool allowDrive = commandFresh && g_latestCommand.enableDrive;

  float leftTarget = allowDrive ? g_latestCommand.leftWheelTargetMetersPerSecond : 0.0f;
  float rightTarget = allowDrive ? g_latestCommand.rightWheelTargetMetersPerSecond : 0.0f;
  g_leftMotor.targetMetersPerSecond = leftTarget;
  g_rightMotor.targetMetersPerSecond = rightTarget;

  g_leftMotor.requestedPwmPercent = estimateOpenLoopPwm(leftTarget, g_leftMotor.actualMetersPerSecond);
  g_rightMotor.requestedPwmPercent = estimateOpenLoopPwm(rightTarget, g_rightMotor.actualMetersPerSecond);

  static uint32_t lastStepMillis = 0;
  uint32_t elapsedMs = nowMillis - lastStepMillis;
  if (elapsedMs == 0) {
    elapsedMs = CONTROL_PERIOD_MS;
  }
  lastStepMillis = nowMillis;

  stepMotorTowardRequested(g_leftMotor, elapsedMs, DEFAULT_RAMP_UP_MS, DEFAULT_RAMP_DOWN_MS);
  stepMotorTowardRequested(g_rightMotor, elapsedMs, DEFAULT_RAMP_UP_MS, DEFAULT_RAMP_DOWN_MS);
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
      if (g_latestCommand.commandTimeoutMillis == 0) {
        g_latestCommand.commandTimeoutMillis = DEFAULT_TIMEOUT_MS;
      }
      g_lastAcceptedCommandMillis = millis();
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

  configurePwm();
  applyMotorHardware(g_leftMotor);
  applyMotorHardware(g_rightMotor);

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
