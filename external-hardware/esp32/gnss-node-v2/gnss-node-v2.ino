#include <WiFi.h>
#include <esp_now.h>
#include <HardwareSerial.h>
#include <Wire.h>

// Second-generation GNSS node for ESP32 + UM982.
// Responsibilities:
// - relay RTCM corrections from a base station via ESP-NOW
// - assume the UM982 has already been provisioned with persistent logs
// - optionally verify that the expected logs are present
// - parse PVTSLNA / RECTIMEA / UNIHEADINGA
// - expose a compact framed GNSS sample to the Pi over I2C
//
// This is a practical replacement for the legacy rover ESP code, not the final
// optimized firmware. It intentionally favors transparency and debuggability.

// ===== Transport / protocol =====
static const uint8_t I2C_SLAVE_ADDRESS = 0x52;
static const uint8_t PROTOCOL_START_OF_FRAME = 0x4D;
static const uint8_t PROTOCOL_VERSION = 0x01;
static const uint8_t NODE_ID_GNSS = 0x10;
static const uint8_t MESSAGE_TYPE_GNSS_SAMPLE = 0x01;

static const size_t FRAME_HEADER_SIZE = 9;
static const size_t FRAME_CRC_SIZE = 2;
static const size_t GNSS_PAYLOAD_SIZE = 36;
static const size_t MAX_FRAME_SIZE = FRAME_HEADER_SIZE + GNSS_PAYLOAD_SIZE + FRAME_CRC_SIZE;

// ===== ESP32 pins =====
static const uint8_t I2C_SDA_PIN = 21;
static const uint8_t I2C_SCL_PIN = 22;
static const uint8_t UM982_RX_PIN = 16;
static const uint8_t UM982_TX_PIN = 17;
static const uint8_t LED_HEADING_PIN = 5;
static const uint8_t LED_POSITION_PIN = 18;
static const uint8_t LED_RTCM_PIN = 19;

HardwareSerial UM982(2);

// ===== Development configuration =====
// Replace these with the actual fixed base station coordinates for production use.
static const double BASE_LATITUDE_DEGREES = 0.0;
static const double BASE_LONGITUDE_DEGREES = 0.0;
static const bool ALLOW_DYNAMIC_ORIGIN_IF_BASE_IS_ZERO = true;

// If you know the antenna baseline more precisely, update the command below too.
static const float ANTENNA_BASELINE_METERS = 0.30f;
static const float ANTENNA_BASELINE_TOLERANCE_METERS = 0.05f;

// Approximate front antenna offset from the axle. This is kept here for future
// debug or payload expansion, but the current compact payload does not use it directly.
static const float FRONT_ANTENNA_FORWARD_OF_AXLE_METERS = 0.07f;

// ===== Receiver startup policy =====
// Default operating model:
// - provision the UM982 once outside this sketch
// - save that receiver configuration persistently on the UM982 itself
// - let the ESP simply read the already-configured logs on every boot
//
// Re-enabling boot-time receiver configuration is kept as an escape hatch for
// bench work only because it has proven fragile on the mower hardware.
static const bool CONFIGURE_RECEIVER_AT_BOOT = false;
static const bool VERIFY_EXPECTED_LOGS_AT_BOOT = true;

// ===== RTCM relay =====
static const size_t RTCM_BUFFER_SIZE = 2048;
static uint8_t g_rtcmBuffer[RTCM_BUFFER_SIZE];
static int g_rtcmIndex = 0;
static uint16_t g_lastRtcmSequence = 0;
static uint32_t g_lastRtcmMillis = 0;
static uint32_t g_lastRtcmLedPulseMillis = 0;

// ===== LED status =====
enum LedQualityState : uint8_t {
  LED_QUALITY_NONE = 0,
  LED_QUALITY_SINGLE = 1,
  LED_QUALITY_DIFF = 2,
  LED_QUALITY_FLOAT = 3,
  LED_QUALITY_FIXED = 4,
};

static LedQualityState g_headingLedState = LED_QUALITY_NONE;
static LedQualityState g_positionLedState = LED_QUALITY_NONE;

static uint32_t g_lastHeadingLedCycleMillis = 0;
static uint32_t g_lastHeadingLedFlashMillis = 0;
static uint8_t g_headingLedFlashCount = 0;
static bool g_headingLedOn = false;

static uint32_t g_lastPositionLedCycleMillis = 0;
static uint32_t g_lastPositionLedFlashMillis = 0;
static uint8_t g_positionLedFlashCount = 0;
static bool g_positionLedOn = false;

// ===== Receiver parsing =====
static char g_lineBuffer[1024];
static size_t g_lineLength = 0;
static uint32_t g_lastAnyReceiverLineMillis = 0;
static uint32_t g_lastDebugPrintMillis = 0;
static uint32_t g_totalReceiverLineCount = 0;
static uint32_t g_totalPvtslnaCount = 0;
static uint32_t g_totalRectimeaCount = 0;
static uint32_t g_totalUniheadingaCount = 0;
static uint32_t g_totalUnknownLineCount = 0;
static uint32_t g_lastUniloglistMillis = 0;
static uint32_t g_lastDeviceReadyMillis = 0;
static uint32_t g_totalDeviceReadyCount = 0;
static uint8_t g_startupRawLinePrintCount = 0;
static const uint8_t STARTUP_RAW_LINE_PRINT_LIMIT = 24;
static bool g_waitingForResetReady = false;
static bool g_resetReadySeen = false;
static bool g_waitingForCommandResponse = false;
static bool g_commandResponseSeen = false;
static bool g_commandResponseOk = false;
static String g_expectedCommandResponse = "";
static bool g_waitingForUniloglist = false;
static bool g_seenUniloglistHeader = false;
static bool g_unilogPvtslnaActive = false;
static bool g_unilogRectimeaActive = false;
static bool g_unilogUniheadingaActive = false;
static const uint32_t COMMAND_RESPONSE_TIMEOUT_MILLIS = 3000;
static const uint32_t DELAYED_READY_TIMEOUT_MILLIS = 20000;

enum CommandWaitMode : uint8_t {
  WAIT_OK_ONLY = 0,
  WAIT_OK_THEN_READY = 1,
};

struct ReceiverCommandStep {
  const char *command;
  CommandWaitMode waitMode;
};

enum CompactFixType : uint8_t {
  FIX_NONE = 0,
  FIX_SINGLE = 1,
  FIX_FLOAT = 2,
  FIX_FIXED = 3,
};

struct ParsedPvtsln {
  bool valid;
  uint32_t localMillis;
  CompactFixType fixType;
  double latitudeDegrees;
  double longitudeDegrees;
  float positionAccuracyMeters;
  float headingDegrees;
  bool headingValid;
  float pitchDegrees;
  bool pitchValid;
  float groundSpeedMetersPerSecond;
  bool groundSpeedValid;
  uint8_t satellitesInUse;
  float headingAccuracyDegrees;
  bool headingAccuracyValid;
};

struct ParsedRectime {
  bool valid;
  bool utcValid;
  uint32_t localMillis;
};

struct ParsedUniheading {
  bool valid;
  bool headingValid;
  uint32_t localMillis;
  float headingDegrees;
  float pitchDegrees;
  float headingStdDevDegrees;
  bool headingStdDevValid;
};

ParsedPvtsln g_latestPvtsln = { false, 0, FIX_NONE, 0.0, 0.0, 99.0f, 0.0f, false, 0.0f, false, 0.0f, false, 0, 0.0f, false };
ParsedRectime g_latestRectime = { false, false, 0 };
ParsedUniheading g_latestUniheading = { false, false, 0, 0.0f, 0.0f, 0.0f, false };

bool g_haveDynamicOrigin = false;
double g_originLatitudeDegrees = 0.0;
double g_originLongitudeDegrees = 0.0;

uint16_t g_lastRequestSequence = 0;
uint8_t g_txFrame[MAX_FRAME_SIZE];
size_t g_txFrameLength = 0;

void readUm982Lines();

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

uint16_t readU16LE(const uint8_t *bytes) {
  return static_cast<uint16_t>(bytes[0]) | (static_cast<uint16_t>(bytes[1]) << 8);
}

bool decodeFrame(const uint8_t *frame, size_t length, uint8_t &messageType, uint16_t &sequence, const uint8_t *&payload, uint16_t &payloadLength) {
  if (length < FRAME_HEADER_SIZE + FRAME_CRC_SIZE) {
    return false;
  }
  if (frame[0] != PROTOCOL_START_OF_FRAME || frame[1] != PROTOCOL_VERSION || frame[2] != NODE_ID_GNSS) {
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

size_t encodeFrame(uint8_t flags, uint16_t sequence, const uint8_t *payload, uint16_t payloadLength, uint8_t *outFrame) {
  outFrame[0] = PROTOCOL_START_OF_FRAME;
  outFrame[1] = PROTOCOL_VERSION;
  outFrame[2] = NODE_ID_GNSS;
  outFrame[3] = MESSAGE_TYPE_GNSS_SAMPLE;
  outFrame[4] = flags;
  writeU16LE(&outFrame[5], sequence);
  writeU16LE(&outFrame[7], payloadLength);
  memcpy(&outFrame[FRAME_HEADER_SIZE], payload, payloadLength);
  uint16_t crc = crc16Ccitt(&outFrame[1], FRAME_HEADER_SIZE - 1 + payloadLength);
  writeU16LE(&outFrame[FRAME_HEADER_SIZE + payloadLength], crc);
  return FRAME_HEADER_SIZE + payloadLength + FRAME_CRC_SIZE;
}

String fieldAt(const char *payload, int targetIndex) {
  int currentIndex = 0;
  const char *start = payload;
  for (const char *cursor = payload;; ++cursor) {
    if (*cursor == ',' || *cursor == '\0') {
      if (currentIndex == targetIndex) {
        return String(start).substring(0, cursor - start);
      }
      if (*cursor == '\0') {
        return String("");
      }
      currentIndex += 1;
      start = cursor + 1;
    }
  }
}

String payloadAfterSemicolon(const char *line) {
  const char *semicolon = strchr(line, ';');
  if (semicolon == nullptr) {
    return String("");
  }
  const char *payloadStart = semicolon + 1;
  const char *asterisk = strchr(payloadStart, '*');
  if (asterisk == nullptr) {
    return String(payloadStart);
  }
  return String(payloadStart).substring(0, asterisk - payloadStart);
}

CompactFixType mapPositionType(const String &type) {
  if (type == "RTKFIXED" || type == "NARROW_INT" || type == "L1_INT" || type == "WIDE_INT") {
    return FIX_FIXED;
  }
  if (type == "RTKFLOAT" || type == "NARROW_FLOAT" || type == "L1_FLOAT" || type == "IONOFREE_FLOAT") {
    return FIX_FLOAT;
  }
  if (type == "SINGLE" || type == "SBAS" || type == "PSRDIFF") {
    return FIX_SINGLE;
  }
  return FIX_NONE;
}

LedQualityState mapHeadingLedState(const String &type) {
  if (type == "NARROW_INT" || type == "L1_INT") {
    return LED_QUALITY_FIXED;
  }
  if (type == "NARROW_FLOAT" || type == "L1_FLOAT") {
    return LED_QUALITY_FLOAT;
  }
  if (type == "PSRDIFF") {
    return LED_QUALITY_DIFF;
  }
  if (type == "SINGLE") {
    return LED_QUALITY_SINGLE;
  }
  return LED_QUALITY_NONE;
}

LedQualityState mapPositionLedState(const String &type) {
  if (type == "RTKFIXED" || type == "NARROW_INT" || type == "L1_INT" || type == "WIDE_INT") {
    return LED_QUALITY_FIXED;
  }
  if (type == "RTKFLOAT" || type == "NARROW_FLOAT" || type == "L1_FLOAT" || type == "IONOFREE_FLOAT") {
    return LED_QUALITY_FLOAT;
  }
  if (type == "PSRDIFF") {
    return LED_QUALITY_DIFF;
  }
  if (type == "SINGLE" || type == "SBAS") {
    return LED_QUALITY_SINGLE;
  }
  return LED_QUALITY_NONE;
}

bool isHeadingTypeUsable(const String &type) {
  return type == "NARROW_INT" || type == "L1_INT" || type == "NARROW_FLOAT" || type == "L1_FLOAT" || type == "PSRDIFF";
}

float estimateHeadingAccuracyFromType(const String &type) {
  if (type == "NARROW_INT" || type == "L1_INT") {
    return 0.5f;
  }
  if (type == "NARROW_FLOAT" || type == "L1_FLOAT") {
    return 2.0f;
  }
  if (type == "PSRDIFF") {
    return 5.0f;
  }
  return 0.0f;
}

float conservativeHorizontalAccuracy(float latStd, float lonStd) {
  float value = max(latStd, lonStd);
  if (value <= 0.0f) {
    return 99.0f;
  }
  return value;
}

const char *fixTypeLabel(CompactFixType fixType) {
  switch (fixType) {
    case FIX_FIXED:
      return "fixed";
    case FIX_FLOAT:
      return "float";
    case FIX_SINGLE:
      return "single";
    case FIX_NONE:
    default:
      return "none";
  }
}

const char *logVerificationLabel() {
  if (g_lastUniloglistMillis == 0) {
    return "unknown";
  }
  const uint8_t activeCount =
    (g_unilogPvtslnaActive ? 1 : 0) +
    (g_unilogRectimeaActive ? 1 : 0) +
    (g_unilogUniheadingaActive ? 1 : 0);
  if (activeCount == 3) {
    return "ok";
  }
  if (activeCount == 0) {
    return "none";
  }
  return "partial";
}

void printDebugStatus() {
  const uint32_t nowMillis = millis();
  if ((nowMillis - g_lastDebugPrintMillis) < 1000u) {
    return;
  }
  g_lastDebugPrintMillis = nowMillis;

  const uint32_t receiverAgeMillis = g_lastAnyReceiverLineMillis == 0 ? 0xFFFFFFFFu : nowMillis - g_lastAnyReceiverLineMillis;
  const uint32_t pvtslnaAgeMillis = g_latestPvtsln.valid ? nowMillis - g_latestPvtsln.localMillis : 0xFFFFFFFFu;
  const uint32_t uniheadingAgeMillis = g_latestUniheading.valid ? nowMillis - g_latestUniheading.localMillis : 0xFFFFFFFFu;
  const uint32_t rtcmAgeMillis = g_lastRtcmMillis == 0 ? 0xFFFFFFFFu : nowMillis - g_lastRtcmMillis;
  const uint32_t uniloglistAgeMillis = g_lastUniloglistMillis == 0 ? 0xFFFFFFFFu : nowMillis - g_lastUniloglistMillis;
  const uint32_t deviceReadyAgeMillis = g_lastDeviceReadyMillis == 0 ? 0xFFFFFFFFu : nowMillis - g_lastDeviceReadyMillis;

  Serial.print("[GNSS] lines=");
  Serial.print(g_totalReceiverLineCount);
  Serial.print(" pvtslna=");
  Serial.print(g_totalPvtslnaCount);
  Serial.print(" rectimea=");
  Serial.print(g_totalRectimeaCount);
  Serial.print(" uniheadinga=");
  Serial.print(g_totalUniheadingaCount);
  Serial.print(" unknown=");
  Serial.print(g_totalUnknownLineCount);
  Serial.print(" readyEvents=");
  Serial.print(g_totalDeviceReadyCount);
  Serial.print(" logConfig=");
  Serial.print(logVerificationLabel());
  Serial.print("(");
  Serial.print(g_unilogPvtslnaActive ? 1 : 0);
  Serial.print(g_unilogRectimeaActive ? 1 : 0);
  Serial.print(g_unilogUniheadingaActive ? 1 : 0);
  Serial.print(")");
  Serial.print(" fix=");
  Serial.print(fixTypeLabel(g_latestPvtsln.fixType));
  Serial.print(" sats=");
  Serial.print(g_latestPvtsln.satellitesInUse);
  Serial.print(" headingValid=");
  Serial.print(g_latestPvtsln.headingValid ? "yes" : "no");
  Serial.print(" receiverAgeMs=");
  if (receiverAgeMillis == 0xFFFFFFFFu) {
    Serial.print("none");
  } else {
    Serial.print(receiverAgeMillis);
  }
  Serial.print(" pvtslnaAgeMs=");
  if (pvtslnaAgeMillis == 0xFFFFFFFFu) {
    Serial.print("none");
  } else {
    Serial.print(pvtslnaAgeMillis);
  }
  Serial.print(" uniheadingAgeMs=");
  if (uniheadingAgeMillis == 0xFFFFFFFFu) {
    Serial.print("none");
  } else {
    Serial.print(uniheadingAgeMillis);
  }
  Serial.print(" rtcmAgeMs=");
  if (rtcmAgeMillis == 0xFFFFFFFFu) {
    Serial.print("none");
  } else {
    Serial.print(rtcmAgeMillis);
  }
  Serial.print(" uniloglistAgeMs=");
  if (uniloglistAgeMillis == 0xFFFFFFFFu) {
    Serial.print("none");
  } else {
    Serial.print(uniloglistAgeMillis);
  }
  Serial.print(" readyAgeMs=");
  if (deviceReadyAgeMillis == 0xFFFFFFFFu) {
    Serial.print("none");
  } else {
    Serial.print(deviceReadyAgeMillis);
  }
  Serial.println();
}

void printStartupRawLine(const char *line) {
  if (strncmp(line, "$devicename,", 12) == 0) {
    g_lastDeviceReadyMillis = millis();
    g_totalDeviceReadyCount += 1;
    g_lastUniloglistMillis = 0;
    g_seenUniloglistHeader = false;
    g_unilogPvtslnaActive = false;
    g_unilogRectimeaActive = false;
    g_unilogUniheadingaActive = false;
    Serial.print("[GNSS-EVENT] ");
    Serial.println(line);
    return;
  }
  if (g_startupRawLinePrintCount >= STARTUP_RAW_LINE_PRINT_LIMIT) {
    return;
  }
  g_startupRawLinePrintCount += 1;
  Serial.print("[GNSS-RAW] ");
  Serial.println(line);
}

bool waitForReceiverReadyEvent(uint32_t timeoutMillis) {
  const uint32_t startMillis = millis();
  g_waitingForResetReady = true;
  g_resetReadySeen = false;

  while ((millis() - startMillis) < timeoutMillis) {
    readUm982Lines();
    if (g_resetReadySeen) {
      g_waitingForResetReady = false;
      return true;
    }
    delay(10);
  }

  g_waitingForResetReady = false;
  return false;
}

void noteCommandResponse(const char *line) {
  const char *responseMarker = strstr(line, ",response:");
  if (responseMarker == nullptr) {
    return;
  }
  String command = String(line + 9).substring(0, responseMarker - (line + 9));
  if (!g_waitingForCommandResponse || command != g_expectedCommandResponse) {
    return;
  }
  g_commandResponseSeen = true;
  g_commandResponseOk = strstr(responseMarker, "OK") != nullptr;
}

bool sendCommandAndWait(const char *command, CommandWaitMode waitMode, uint32_t timeoutMillis) {
  Serial.print("[GNSS-CONFIG] ");
  Serial.println(command);
  g_expectedCommandResponse = String(command);
  g_waitingForCommandResponse = true;
  g_commandResponseSeen = false;
  g_commandResponseOk = false;
  UM982.println(command);

  const uint32_t startMillis = millis();
  while ((millis() - startMillis) < timeoutMillis) {
    readUm982Lines();
    if (g_commandResponseSeen) {
      g_waitingForCommandResponse = false;
      if (!g_commandResponseOk) {
        return false;
      }
      if (waitMode == WAIT_OK_THEN_READY) {
        Serial.println("[GNSS-CONFIG] waiting for delayed $devicename readiness marker");
        const bool ready = waitForReceiverReadyEvent(DELAYED_READY_TIMEOUT_MILLIS);
        if (ready) {
          Serial.println("[GNSS-CONFIG] delayed receiver ready marker seen");
        } else {
          Serial.println("[GNSS-CONFIG] delayed receiver ready marker timeout");
        }
        return ready;
      }
      return true;
    }
    delay(10);
  }

  g_waitingForCommandResponse = false;
  return false;
}

void updateQualityLed(
  uint8_t pin,
  LedQualityState state,
  uint32_t &lastCycleStartMillis,
  uint32_t &lastFlashMillis,
  uint8_t &flashCount,
  bool &ledOn
) {
  const uint32_t cycleDurationMillis = 2000;
  const uint32_t flashIntervalMillis = 200;

  if (state == LED_QUALITY_FIXED) {
    digitalWrite(pin, HIGH);
    flashCount = 0;
    ledOn = false;
    lastFlashMillis = 0;
    lastCycleStartMillis = millis();
    return;
  }

  if (state == LED_QUALITY_NONE) {
    digitalWrite(pin, LOW);
    flashCount = 0;
    ledOn = false;
    lastFlashMillis = 0;
    lastCycleStartMillis = millis();
    return;
  }

  if ((millis() - lastCycleStartMillis) > cycleDurationMillis) {
    lastCycleStartMillis = millis();
    flashCount = 0;
    ledOn = false;
    digitalWrite(pin, LOW);
    lastFlashMillis = 0;
  }

  if (flashCount < static_cast<uint8_t>(state)) {
    if ((millis() - lastFlashMillis) >= flashIntervalMillis) {
      ledOn = !ledOn;
      digitalWrite(pin, ledOn ? HIGH : LOW);
      lastFlashMillis = millis();
      if (!ledOn) {
        flashCount += 1;
      }
    }
  } else {
    digitalWrite(pin, LOW);
  }
}

void flashStartupLeds() {
  for (int index = 0; index < 10; index += 1) {
    digitalWrite(LED_HEADING_PIN, HIGH);
    digitalWrite(LED_POSITION_PIN, HIGH);
    delay(100);
    digitalWrite(LED_HEADING_PIN, LOW);
    digitalWrite(LED_POSITION_PIN, LOW);
    delay(100);
  }
}

void updateIndicatorLeds() {
  const uint32_t nowMillis = millis();
  const bool freshFix = g_latestPvtsln.valid && ((nowMillis - g_latestPvtsln.localMillis) <= 2000u);

  if (!freshFix) {
    digitalWrite(LED_HEADING_PIN, LOW);
    digitalWrite(LED_POSITION_PIN, LOW);
  } else {
    updateQualityLed(
      LED_HEADING_PIN,
      g_headingLedState,
      g_lastHeadingLedCycleMillis,
      g_lastHeadingLedFlashMillis,
      g_headingLedFlashCount,
      g_headingLedOn
    );
    updateQualityLed(
      LED_POSITION_PIN,
      g_positionLedState,
      g_lastPositionLedCycleMillis,
      g_lastPositionLedFlashMillis,
      g_positionLedFlashCount,
      g_positionLedOn
    );
  }

  if ((nowMillis - g_lastRtcmLedPulseMillis) > 100u) {
    digitalWrite(LED_RTCM_PIN, LOW);
  }
}

void ensureOriginFromCurrentFix() {
  if (g_haveDynamicOrigin) {
    return;
  }
  if (BASE_LATITUDE_DEGREES != 0.0 || BASE_LONGITUDE_DEGREES != 0.0) {
    g_originLatitudeDegrees = BASE_LATITUDE_DEGREES;
    g_originLongitudeDegrees = BASE_LONGITUDE_DEGREES;
    g_haveDynamicOrigin = true;
    return;
  }
  if (ALLOW_DYNAMIC_ORIGIN_IF_BASE_IS_ZERO && g_latestPvtsln.valid && g_latestPvtsln.fixType != FIX_NONE) {
    g_originLatitudeDegrees = g_latestPvtsln.latitudeDegrees;
    g_originLongitudeDegrees = g_latestPvtsln.longitudeDegrees;
    g_haveDynamicOrigin = true;
  }
}

void localXYFromLatLon(double latitudeDegrees, double longitudeDegrees, int32_t &xMillimeters, int32_t &yMillimeters) {
  ensureOriginFromCurrentFix();

  if (!g_haveDynamicOrigin) {
    xMillimeters = 0;
    yMillimeters = 0;
    return;
  }

  const double earthRadiusMeters = 6378137.0;
  const double degToRad = 3.14159265358979323846 / 180.0;
  double originLatRad = g_originLatitudeDegrees * degToRad;
  double dLat = (latitudeDegrees - g_originLatitudeDegrees) * degToRad;
  double dLon = (longitudeDegrees - g_originLongitudeDegrees) * degToRad;

  double northMeters = dLat * earthRadiusMeters;
  double eastMeters = dLon * earthRadiusMeters * cos(originLatRad);

  xMillimeters = static_cast<int32_t>(eastMeters * 1000.0);
  yMillimeters = static_cast<int32_t>(northMeters * 1000.0);
}

// ===== RTCM relay =====
void onEspNowDataReceived(const esp_now_recv_info_t *info, const uint8_t *incomingData, int len) {
  (void)info;
  if (len < 3) {
    return;
  }

  uint16_t sequenceNumber = static_cast<uint16_t>(incomingData[0]) | (static_cast<uint16_t>(incomingData[1]) << 8);
  const uint8_t *messageData = incomingData + 2;
  int messageLength = len - 2;

  if (g_lastRtcmSequence != 0 && sequenceNumber != static_cast<uint16_t>(g_lastRtcmSequence + 1)) {
    g_rtcmIndex = 0;
  }
  g_lastRtcmSequence = sequenceNumber;

  if ((g_rtcmIndex + messageLength) > static_cast<int>(RTCM_BUFFER_SIZE)) {
    g_rtcmIndex = 0;
    return;
  }

  memcpy(g_rtcmBuffer + g_rtcmIndex, messageData, messageLength);
  g_rtcmIndex += messageLength;

  if (g_rtcmIndex >= 3) {
    int expectedLength = ((g_rtcmBuffer[1] & 0x03) << 8) | g_rtcmBuffer[2];
    if (g_rtcmIndex >= expectedLength + 6) {
      UM982.write(g_rtcmBuffer, g_rtcmIndex);
      g_rtcmIndex = 0;
      g_lastRtcmMillis = millis();
      g_lastRtcmLedPulseMillis = g_lastRtcmMillis;
      digitalWrite(LED_RTCM_PIN, HIGH);
    }
  }
}

// ===== UM982 configuration =====
const ReceiverCommandStep UM982_CONFIG_COMMANDS[] = {
  { "CONFIG ANTENNA POWERON", WAIT_OK_ONLY },
  { "CONFIG NMEAVERSION V410", WAIT_OK_ONLY },
  { "CONFIG RTK TIMEOUT 600", WAIT_OK_ONLY },
  { "CONFIG RTK RELIABILITY 3 1", WAIT_OK_ONLY },
  { "CONFIG PPP TIMEOUT 120", WAIT_OK_ONLY },
  { "CONFIG HEADING OFFSET 0.0 0.0", WAIT_OK_ONLY },
  { "CONFIG HEADING RELIABILITY 3", WAIT_OK_ONLY },
  { "CONFIG HEADING FIXLENGTH", WAIT_OK_ONLY },
  { "CONFIG HEADING LENGTH 30.00 5.00", WAIT_OK_ONLY },
  { "CONFIG DGPS TIMEOUT 600", WAIT_OK_ONLY },
  { "CONFIG RTCMB1CB2A ENABLE", WAIT_OK_ONLY },
  { "CONFIG ANTENNADELTAHEN 0.0000 0.0000 0.0000", WAIT_OK_ONLY },
  { "CONFIG PPS ENABLE GPS POSITIVE 500000 1000 0 0", WAIT_OK_ONLY },
  { "CONFIG SIGNALGROUP 3 6", WAIT_OK_THEN_READY },
  { "CONFIG AGNSS DISABLE", WAIT_OK_ONLY },
  { "CONFIG BASEOBSFILTER DISABLE", WAIT_OK_ONLY },
  { "CONFIG LOGSEQ 1", WAIT_OK_ONLY },
  { "PVTSLNA COM2 0.1", WAIT_OK_ONLY },
  { "RECTIMEA COM2 1", WAIT_OK_ONLY },
  { "UNIHEADINGA COM2 0.2", WAIT_OK_ONLY }
};

void resetReceiverConfiguration() {
  Serial.println("[GNSS-CONFIG] freset");
  UM982.println("freset");
  Serial.println("[GNSS-CONFIG] waiting for $devicename readiness marker");
  const bool ready = waitForReceiverReadyEvent(8000);
  if (ready) {
    Serial.println("[GNSS-CONFIG] receiver ready marker seen");
  } else {
    Serial.println("[GNSS-CONFIG] receiver ready marker timeout");
  }
  delay(250);
}

void verifyReceiverLogConfiguration() {
  if (!VERIFY_EXPECTED_LOGS_AT_BOOT) {
    return;
  }

  g_waitingForUniloglist = true;
  g_seenUniloglistHeader = false;
  g_unilogPvtslnaActive = false;
  g_unilogRectimeaActive = false;
  g_unilogUniheadingaActive = false;
  const bool ok = sendCommandAndWait("UNILOGLIST", WAIT_OK_ONLY, COMMAND_RESPONSE_TIMEOUT_MILLIS);
  if (!ok) {
    Serial.println("[GNSS-CONFIG] command failed or timed out: UNILOGLIST");
  }
}

void sendReceiverConfiguration() {
  if (!CONFIGURE_RECEIVER_AT_BOOT) {
    Serial.println("[GNSS-CONFIG] boot-time receiver programming is disabled");
    Serial.println("[GNSS-CONFIG] expecting persisted UM982 configuration and verifying active logs only");
    verifyReceiverLogConfiguration();
    return;
  }

  resetReceiverConfiguration();
  for (size_t index = 0; index < sizeof(UM982_CONFIG_COMMANDS) / sizeof(UM982_CONFIG_COMMANDS[0]); index += 1) {
    const bool ok = sendCommandAndWait(
      UM982_CONFIG_COMMANDS[index].command,
      UM982_CONFIG_COMMANDS[index].waitMode,
      COMMAND_RESPONSE_TIMEOUT_MILLIS
    );
    if (!ok) {
      Serial.print("[GNSS-CONFIG] command failed or timed out: ");
      Serial.println(UM982_CONFIG_COMMANDS[index].command);
      Serial.println("[GNSS-CONFIG] aborting remaining startup configuration");
      return;
    }
  }
  verifyReceiverLogConfiguration();
}

// ===== Parsing =====
void parsePvtslna(const char *line) {
  g_totalPvtslnaCount += 1;
  String payload = payloadAfterSemicolon(line);
  if (payload.length() == 0) {
    return;
  }

  String bestposType = fieldAt(payload.c_str(), 0);
  String latField = fieldAt(payload.c_str(), 2);
  String lonField = fieldAt(payload.c_str(), 3);
  String latStdField = fieldAt(payload.c_str(), 5);
  String lonStdField = fieldAt(payload.c_str(), 6);
  String solnSatsField = fieldAt(payload.c_str(), 14);
  String groundSpeedField = fieldAt(payload.c_str(), 19);
  String headingTypeField = fieldAt(payload.c_str(), 20);
  String headingField = fieldAt(payload.c_str(), 22);
  String pitchField = fieldAt(payload.c_str(), 23);

  g_latestPvtsln.valid = true;
  g_latestPvtsln.localMillis = millis();
  g_latestPvtsln.fixType = mapPositionType(bestposType);
  g_headingLedState = mapHeadingLedState(headingTypeField);
  g_positionLedState = mapPositionLedState(bestposType);
  g_latestPvtsln.latitudeDegrees = latField.toDouble();
  g_latestPvtsln.longitudeDegrees = lonField.toDouble();
  g_latestPvtsln.positionAccuracyMeters = conservativeHorizontalAccuracy(latStdField.toFloat(), lonStdField.toFloat());
  g_latestPvtsln.satellitesInUse = static_cast<uint8_t>(solnSatsField.toInt());

  g_latestPvtsln.groundSpeedMetersPerSecond = groundSpeedField.toFloat();
  g_latestPvtsln.groundSpeedValid = groundSpeedField.length() > 0;

  g_latestPvtsln.headingValid = isHeadingTypeUsable(headingTypeField);
  g_latestPvtsln.headingDegrees = headingField.toFloat();

  g_latestPvtsln.pitchValid = pitchField.length() > 0;
  g_latestPvtsln.pitchDegrees = pitchField.toFloat();

  if (g_latestUniheading.valid && g_latestUniheading.headingStdDevValid && (millis() - g_latestUniheading.localMillis) < 1000) {
    g_latestPvtsln.headingAccuracyDegrees = g_latestUniheading.headingStdDevDegrees;
    g_latestPvtsln.headingAccuracyValid = true;
  } else {
    float estimated = estimateHeadingAccuracyFromType(headingTypeField);
    g_latestPvtsln.headingAccuracyDegrees = estimated;
    g_latestPvtsln.headingAccuracyValid = estimated > 0.0f;
  }
}

void parseRectimea(const char *line) {
  g_totalRectimeaCount += 1;
  String payload = payloadAfterSemicolon(line);
  if (payload.length() == 0) {
    return;
  }
  String clockStatus = fieldAt(payload.c_str(), 0);
  String utcStatus = fieldAt(payload.c_str(), 10);

  g_latestRectime.valid = true;
  g_latestRectime.localMillis = millis();
  g_latestRectime.utcValid = (clockStatus == "VALID") && (utcStatus == "VALID" || utcStatus == "WARNING");
}

void parseUniheadinga(const char *line) {
  g_totalUniheadingaCount += 1;
  String payload = payloadAfterSemicolon(line);
  if (payload.length() == 0) {
    return;
  }

  String solStat = fieldAt(payload.c_str(), 0);
  String posType = fieldAt(payload.c_str(), 1);
  String headingField = fieldAt(payload.c_str(), 3);
  String pitchField = fieldAt(payload.c_str(), 4);
  String headingStdField = fieldAt(payload.c_str(), 6);

  g_latestUniheading.valid = true;
  g_latestUniheading.localMillis = millis();
  g_latestUniheading.headingValid = (solStat != "INSUFFICIENT_OBS" && posType != "NONE");
  g_latestUniheading.headingDegrees = headingField.toFloat();
  g_latestUniheading.pitchDegrees = pitchField.toFloat();
  g_latestUniheading.headingStdDevDegrees = headingStdField.toFloat();
  g_latestUniheading.headingStdDevValid = headingStdField.length() > 0 && g_latestUniheading.headingStdDevDegrees > 0.0f;
}

void parseUniloglistHeader() {
  g_lastUniloglistMillis = millis();
  g_seenUniloglistHeader = true;
  g_unilogPvtslnaActive = false;
  g_unilogRectimeaActive = false;
  g_unilogUniheadingaActive = false;
}

void parseUniloglistEntry(const char *line) {
  g_lastUniloglistMillis = millis();
  if (strstr(line, "PVTSLNA COM2") != nullptr) {
    g_unilogPvtslnaActive = true;
  }
  if (strstr(line, "RECTIMEA COM2") != nullptr) {
    g_unilogRectimeaActive = true;
  }
  if (strstr(line, "UNIHEADINGA COM2") != nullptr) {
    g_unilogUniheadingaActive = true;
  }
}

void handleUm982Line(const char *line) {
  g_totalReceiverLineCount += 1;
  g_lastAnyReceiverLineMillis = millis();
  printStartupRawLine(line);
  if (g_waitingForResetReady && strncmp(line, "$devicename,", 12) == 0) {
    g_resetReadySeen = true;
  }
  if (strncmp(line, "$command,", 9) == 0) {
    noteCommandResponse(line);
  }
  if (strncmp(line, "#PVTSLNA", 8) == 0) {
    parsePvtslna(line);
  } else if (strncmp(line, "#RECTIMEA", 9) == 0) {
    parseRectimea(line);
  } else if (strncmp(line, "#UNIHEADINGA", 12) == 0) {
    parseUniheadinga(line);
  } else if (strncmp(line, "#UNILOGLIST", 11) == 0) {
    parseUniloglistHeader();
  } else if (line[0] == '<') {
    if (g_waitingForUniloglist || g_seenUniloglistHeader) {
      parseUniloglistEntry(line);
    } else {
      g_totalUnknownLineCount += 1;
    }
  } else {
    g_totalUnknownLineCount += 1;
  }
}

void readUm982Lines() {
  while (UM982.available() > 0) {
    char c = static_cast<char>(UM982.read());
    if (c == '\r') {
      continue;
    }
    if (c == '\n') {
      g_lineBuffer[g_lineLength] = '\0';
      if (g_lineLength > 0) {
        handleUm982Line(g_lineBuffer);
      }
      g_lineLength = 0;
      continue;
    }
    if (g_lineLength < (sizeof(g_lineBuffer) - 1)) {
      g_lineBuffer[g_lineLength++] = c;
    } else {
      g_lineLength = 0;
    }
  }
}

// ===== GNSS payload =====
void buildGnssPayload(uint8_t *payloadOut) {
  uint32_t nowMillis = millis();
  uint16_t sampleAgeMillis = 0xFFFF;
  uint16_t receiverLineAgeMillis = 0xFFFF;
  uint16_t pvtslnaAgeMillis = 0xFFFF;
  uint16_t uniheadingAgeMillis = 0xFFFF;
  uint16_t rtcmAgeMillis = 0xFFFF;
  if (g_latestPvtsln.valid) {
    uint32_t age = nowMillis - g_latestPvtsln.localMillis;
    sampleAgeMillis = age > 65535u ? 65535u : static_cast<uint16_t>(age);
  }
  if (g_lastAnyReceiverLineMillis != 0) {
    uint32_t age = nowMillis - g_lastAnyReceiverLineMillis;
    receiverLineAgeMillis = age > 65535u ? 65535u : static_cast<uint16_t>(age);
  }
  if (g_latestPvtsln.valid) {
    uint32_t age = nowMillis - g_latestPvtsln.localMillis;
    pvtslnaAgeMillis = age > 65535u ? 65535u : static_cast<uint16_t>(age);
  }
  if (g_latestUniheading.valid) {
    uint32_t age = nowMillis - g_latestUniheading.localMillis;
    uniheadingAgeMillis = age > 65535u ? 65535u : static_cast<uint16_t>(age);
  }
  if (g_lastRtcmMillis != 0) {
    uint32_t age = nowMillis - g_lastRtcmMillis;
    rtcmAgeMillis = age > 65535u ? 65535u : static_cast<uint16_t>(age);
  }

  int32_t xMillimeters = 0;
  int32_t yMillimeters = 0;
  if (g_latestPvtsln.valid) {
    localXYFromLatLon(g_latestPvtsln.latitudeDegrees, g_latestPvtsln.longitudeDegrees, xMillimeters, yMillimeters);
  }

  writeU32LE(&payloadOut[0], nowMillis);
  writeI32LE(&payloadOut[4], xMillimeters);
  writeI32LE(&payloadOut[8], yMillimeters);

  if (g_latestPvtsln.headingValid) {
    writeI16LE(&payloadOut[12], static_cast<int16_t>(g_latestPvtsln.headingDegrees * 100.0f));
  } else {
    writeI16LE(&payloadOut[12], 0x7FFF);
  }

  if (g_latestPvtsln.pitchValid) {
    writeI16LE(&payloadOut[14], static_cast<int16_t>(g_latestPvtsln.pitchDegrees * 100.0f));
  } else {
    writeI16LE(&payloadOut[14], 0x7FFF);
  }

  if (g_latestPvtsln.groundSpeedValid) {
    writeU16LE(&payloadOut[16], static_cast<uint16_t>(max(0.0f, g_latestPvtsln.groundSpeedMetersPerSecond) * 1000.0f));
  } else {
    writeU16LE(&payloadOut[16], 0xFFFF);
  }

  writeU16LE(&payloadOut[18], static_cast<uint16_t>(max(0.0f, g_latestPvtsln.positionAccuracyMeters) * 1000.0f));

  if (g_latestPvtsln.headingAccuracyValid) {
    writeU16LE(&payloadOut[20], static_cast<uint16_t>(max(0.0f, g_latestPvtsln.headingAccuracyDegrees) * 100.0f));
  } else {
    writeU16LE(&payloadOut[20], 0xFFFF);
  }

  payloadOut[22] = static_cast<uint8_t>(g_latestPvtsln.fixType);
  payloadOut[23] = g_latestPvtsln.satellitesInUse;
  writeU16LE(&payloadOut[24], sampleAgeMillis);
  writeU16LE(&payloadOut[26], receiverLineAgeMillis);
  writeU16LE(&payloadOut[28], pvtslnaAgeMillis);
  writeU16LE(&payloadOut[30], uniheadingAgeMillis);
  writeU16LE(&payloadOut[32], rtcmAgeMillis);
  payloadOut[34] =
    (g_unilogPvtslnaActive ? 0x01 : 0x00) |
    (g_unilogRectimeaActive ? 0x02 : 0x00) |
    (g_unilogUniheadingaActive ? 0x04 : 0x00);
  payloadOut[35] = 0;
}

void refreshTxFrame() {
  uint8_t payload[GNSS_PAYLOAD_SIZE];
  buildGnssPayload(payload);

  uint8_t flags = 0;
  if (!g_latestPvtsln.valid || g_latestPvtsln.fixType == FIX_NONE) {
    flags |= 0x01;
  }
  if (!g_latestPvtsln.headingValid) {
    flags |= 0x02;
  }
  g_txFrameLength = encodeFrame(flags, g_lastRequestSequence, payload, GNSS_PAYLOAD_SIZE, g_txFrame);
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

  if (messageType == MESSAGE_TYPE_GNSS_SAMPLE) {
    g_lastRequestSequence = sequence;
    refreshTxFrame();
  }
}

void onRequest() {
  refreshTxFrame();
  Wire.write(g_txFrame, g_txFrameLength);
}

// ===== Setup / loop =====
void setupEspNow() {
  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) {
    return;
  }
  esp_now_register_recv_cb(onEspNowDataReceived);
}

void setup() {
  Serial.begin(115200);
  UM982.begin(115200, SERIAL_8N1, UM982_RX_PIN, UM982_TX_PIN);

  pinMode(LED_HEADING_PIN, OUTPUT);
  pinMode(LED_POSITION_PIN, OUTPUT);
  pinMode(LED_RTCM_PIN, OUTPUT);
  digitalWrite(LED_HEADING_PIN, LOW);
  digitalWrite(LED_POSITION_PIN, LOW);
  digitalWrite(LED_RTCM_PIN, LOW);
  flashStartupLeds();

  Wire.begin(I2C_SLAVE_ADDRESS, I2C_SDA_PIN, I2C_SCL_PIN, 400000);
  Wire.onReceive(onReceive);
  Wire.onRequest(onRequest);

  setupEspNow();
  delay(200);
  sendReceiverConfiguration();
  refreshTxFrame();
}

void loop() {
  readUm982Lines();
  refreshTxFrame();
  updateIndicatorLeds();
  printDebugStatus();
  delay(5);
}
