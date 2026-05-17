#include <Arduino.h>
#include <Wire.h>

// Simple motor-board pin diagnostic sketch.
//
// Purpose:
// - expose the motor control pins over a tiny I2C command interface
// - keep all outputs low unless a test explicitly asks for one line high
// - allow basic tach input readback while the motors are unplugged
//
// Positive behavior is intentionally simple:
// - every write command clears all motor outputs low first
// - if the command targets a PWM or DIR line with value 1, only that line is set high
// - tach commands never drive outputs; they just refresh the status snapshot
//
// I2C command format: 3 bytes
//   [0] motor selector: 'L' or 'R'
//   [1] signal selector: 'P', 'D', or 'T'
//   [2] value: 0 or 1 (ignored for 'T')
//
// I2C readback format: 6 bytes
//   [0] left PWM output state  (0/1)
//   [1] left DIR output state  (0/1)
//   [2] right PWM output state (0/1)
//   [3] right DIR output state (0/1)
//   [4] left tach input state  (0/1)
//   [5] right tach input state (0/1)

static const uint8_t I2C_SLAVE_ADDRESS = 0x66;

static const uint8_t SDA_PIN = 16;
static const uint8_t SCL_PIN = 17;

static const uint8_t LEFT_PWM_PIN = 5;
static const uint8_t LEFT_DIR_PIN = 18;
static const uint8_t RIGHT_PWM_PIN = 14;
static const uint8_t RIGHT_DIR_PIN = 19;

static const uint8_t LEFT_TACH_PIN = 21;
static const uint8_t RIGHT_TACH_PIN = 22;
static const uint32_t SERIAL_STATUS_PERIOD_MS = 2000;

struct StatusSnapshot {
  uint8_t leftPwm;
  uint8_t leftDir;
  uint8_t rightPwm;
  uint8_t rightDir;
  uint8_t leftTach;
  uint8_t rightTach;
};

volatile StatusSnapshot g_status = { 0, 0, 0, 0, 1, 1 };
volatile char g_lastMotorSelector = '-';
volatile char g_lastSignalSelector = '-';
volatile uint8_t g_lastValue = 0;
volatile bool g_lastCommandAccepted = false;
uint32_t g_lastSerialStatusMillis = 0;

void clearOutputs() {
  digitalWrite(LEFT_PWM_PIN, LOW);
  digitalWrite(LEFT_DIR_PIN, LOW);
  digitalWrite(RIGHT_PWM_PIN, LOW);
  digitalWrite(RIGHT_DIR_PIN, LOW);
  g_status.leftPwm = 0;
  g_status.leftDir = 0;
  g_status.rightPwm = 0;
  g_status.rightDir = 0;
}

void refreshTachInputs() {
  g_status.leftTach = static_cast<uint8_t>(digitalRead(LEFT_TACH_PIN) == HIGH ? 1 : 0);
  g_status.rightTach = static_cast<uint8_t>(digitalRead(RIGHT_TACH_PIN) == HIGH ? 1 : 0);
}

void printStatusSnapshot(const char *prefix) {
  refreshTachInputs();
  Serial.print(prefix);
  Serial.print(" requested=");
  Serial.print(g_lastMotorSelector);
  Serial.print(" ");
  Serial.print(g_lastSignalSelector);
  Serial.print(" ");
  Serial.print(g_lastValue);
  Serial.print(" accepted=");
  Serial.print(g_lastCommandAccepted ? "yes" : "no");
  Serial.print(" status={LP:");
  Serial.print(g_status.leftPwm);
  Serial.print(", LD:");
  Serial.print(g_status.leftDir);
  Serial.print(", RP:");
  Serial.print(g_status.rightPwm);
  Serial.print(", RD:");
  Serial.print(g_status.rightDir);
  Serial.print(", LT:");
  Serial.print(g_status.leftTach);
  Serial.print(", RT:");
  Serial.print(g_status.rightTach);
  Serial.println("}");
}

void setRequestedOutput(char motorSelector, char signalSelector, uint8_t value) {
  clearOutputs();
  g_lastCommandAccepted = false;

  if (value == 0) {
    refreshTachInputs();
    g_lastCommandAccepted = true;
    return;
  }

  uint8_t targetPin = 0;

  if (motorSelector == 'L' && signalSelector == 'P') {
    targetPin = LEFT_PWM_PIN;
  } else if (motorSelector == 'L' && signalSelector == 'D') {
    targetPin = LEFT_DIR_PIN;
  } else if (motorSelector == 'R' && signalSelector == 'P') {
    targetPin = RIGHT_PWM_PIN;
  } else if (motorSelector == 'R' && signalSelector == 'D') {
    targetPin = RIGHT_DIR_PIN;
  } else {
    refreshTachInputs();
    return;
  }

  digitalWrite(targetPin, HIGH);
  if (motorSelector == 'L' && signalSelector == 'P') g_status.leftPwm = 1;
  if (motorSelector == 'L' && signalSelector == 'D') g_status.leftDir = 1;
  if (motorSelector == 'R' && signalSelector == 'P') g_status.rightPwm = 1;
  if (motorSelector == 'R' && signalSelector == 'D') g_status.rightDir = 1;
  refreshTachInputs();
  g_lastCommandAccepted = true;
}

void onReceive(int byteCount) {
  if (byteCount < 3) {
    while (Wire.available() > 0) {
      Wire.read();
    }
    clearOutputs();
    refreshTachInputs();
    g_lastMotorSelector = '?';
    g_lastSignalSelector = '?';
    g_lastValue = 0;
    g_lastCommandAccepted = false;
    printStatusSnapshot("short_command");
    return;
  }

  char motorSelector = static_cast<char>(Wire.read());
  char signalSelector = static_cast<char>(Wire.read());
  uint8_t value = static_cast<uint8_t>(Wire.read());

  g_lastMotorSelector = motorSelector;
  g_lastSignalSelector = signalSelector;
  g_lastValue = value == 0 ? 0 : 1;

  while (Wire.available() > 0) {
    Wire.read();
  }

  if (signalSelector == 'T') {
    clearOutputs();
    refreshTachInputs();
    g_lastCommandAccepted = true;
    printStatusSnapshot("tach_read");
    return;
  }

  setRequestedOutput(motorSelector, signalSelector, value == 0 ? 0 : 1);
  printStatusSnapshot("command");
}

void onRequest() {
  refreshTachInputs();
  uint8_t snapshot[6] = {
    g_status.leftPwm,
    g_status.leftDir,
    g_status.rightPwm,
    g_status.rightDir,
    g_status.leftTach,
    g_status.rightTach,
  };
  Wire.write(snapshot, sizeof(snapshot));
}

void setup() {
  Serial.begin(115200);

  pinMode(LEFT_PWM_PIN, OUTPUT);
  pinMode(LEFT_DIR_PIN, OUTPUT);
  pinMode(RIGHT_PWM_PIN, OUTPUT);
  pinMode(RIGHT_DIR_PIN, OUTPUT);

  pinMode(LEFT_TACH_PIN, INPUT_PULLUP);
  pinMode(RIGHT_TACH_PIN, INPUT_PULLUP);

  clearOutputs();
  refreshTachInputs();

  Wire.setPins(SDA_PIN, SCL_PIN);
  Wire.begin(static_cast<int>(I2C_SLAVE_ADDRESS));
  Wire.onReceive(onReceive);
  Wire.onRequest(onRequest);

  printStatusSnapshot("boot");
}

void loop() {
  refreshTachInputs();
  uint32_t now = millis();
  if (now - g_lastSerialStatusMillis >= SERIAL_STATUS_PERIOD_MS) {
    g_lastSerialStatusMillis = now;
    printStatusSnapshot("periodic");
  }
  delay(5);
}
