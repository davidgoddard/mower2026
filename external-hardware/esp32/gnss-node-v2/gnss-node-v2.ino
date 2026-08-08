// GNSS rover ESP32 for mower navigation and RTCM relay.
//
// Pinout:
// - UM982 TX -> ESP32 GPIO16 (Serial2 RX)
// - UM982 RX -> ESP32 GPIO17 (Serial2 TX)
// - I2C SDA -> ESP32 GPIO21
// - I2C SCL -> ESP32 GPIO22
// - Heading status LED -> ESP32 GPIO5
// - Position status LED -> ESP32 GPIO18
// - RTCM activity LED -> ESP32 GPIO19
// - RTCM route indicator LED -> ESP32 GPIO23
// - UM982/ESP32 grounds must be common
//
// Operation:
// - receives RTCM corrections from the base station over ESP-NOW
// - accepts the current fragmented RTCM transport from configured base/relay MACs
// - assembles out-of-order fragments, suppresses duplicates, validates CRC, and
//   forwards each correction to the UM982 once
// - parses UM982 runtime logs to build a compact GNSS sample for the Pi
// - serves that GNSS sample over I2C address 0x52
// - drives LEDs for heading quality, position quality, RTCM activity, and route
//
// Notes:
// - the UM982 is expected to be provisioned already; boot-time configuration is
//   intentionally passive by default
// - base and rover must use the same fixed ESP-NOW Wi-Fi channel
// - this sketch pairs with `external-hardware/esp32/gnss-base-station-v1/gnss-base-station-v1.ino`

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
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
static const uint8_t MESSAGE_TYPE_GNSS_DEBUG_LINE = 0x02;

static const size_t FRAME_HEADER_SIZE = 9;
static const size_t FRAME_CRC_SIZE = 2;
static const size_t GNSS_SAMPLE_PAYLOAD_SIZE = 40;
static const size_t GNSS_DEBUG_PAYLOAD_SIZE = 116;
// Payload layout (single, no version fallback):
//   off 0 .. 7 : gpsTimeMillis  uint64 LE (Unix epoch ms; 0 when UTC invalid)
//   off 8 .. 11: xMeters x 1000 int32 LE mm
//   off 12..15 : yMeters x 1000 int32 LE mm
//   off 16..19 : heading deg x 100 int32 LE; sentinel 0x7FFFFFFF
//   off 20..21 : pitch deg x 100   int16 LE; sentinel 0x7FFF
//   off 22..23 : ground speed mps x 1000 uint16 LE; sentinel 0xFFFF
//   off 24..25 : position accuracy m x 1000 uint16 LE mm
//   off 26..27 : heading accuracy deg x 100 uint16 LE; sentinel 0xFFFF
//   off 28..29 : heading baseline length m x 1000 uint16 LE; sentinel 0xFFFF
//   off 30..31 : sample age ms uint16 LE
//   off 32     : fix type uint8 (0 none, 1 single, 2 float, 3 fixed)
//   off 33     : satellites in use uint8
//   off 34     : flag byte:
//                  bit0 = utc valid
//                  bit1 = heading valid (UNIHEADINGA solution status usable)
//                  bit2 = baseline valid (UNIHEADINGA length present)
//   off 35     : log config mask (PVTSLNA/RECTIMEA/UNIHEADINGA active bits)
//   off 36..39 : reserved (zero-filled)
static const size_t MAX_FRAME_SIZE = FRAME_HEADER_SIZE + GNSS_DEBUG_PAYLOAD_SIZE + FRAME_CRC_SIZE;

// ===== ESP32 pins =====
static const uint8_t I2C_SDA_PIN = 21;
static const uint8_t I2C_SCL_PIN = 22;
static const uint8_t UM982_RX_PIN = 16;
static const uint8_t UM982_TX_PIN = 17;
static const uint8_t LED_HEADING_PIN = 5;
static const uint8_t LED_POSITION_PIN = 18;
static const uint8_t LED_RTCM_PIN = 19;
static const uint8_t LED_RTCM_ROUTE_PIN = 23;

// UART baud between the ESP32 and the UM982.
// 115200 has only ~30% headroom at 10 Hz PVTSLN; 460800 gives comfortable
// headroom at 20 Hz and is handled cleanly by both HardwareSerial and the
// UM982. The receiver must be provisioned persistently with a matching
// `CONFIG COM2 460800` so it stays at this rate across power cycles.
static const uint32_t UM982_UART_BAUD = 460800;

HardwareSerial UM982(2);

// ===== Origin configuration =====
// The local X/Y origin is always taken from the RTCM1006 base station message when
// available, giving a stable coordinate frame that is consistent across power cycles
// as long as the base station hasn't moved. If RTCM1006 has not yet arrived the origin
// falls back to the mower's own first fix so that coordinates are at least valid; it
// will be corrected to the true base-station origin as soon as the first RTCM1006 is
// received (typically within a few seconds of boot).

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
static const size_t RTCM_BUFFER_SIZE = 4096;
static const uint8_t RTCM_PREAMBLE = 0xD3;
static const uint8_t RTCM_TRANSPORT_MAGIC_0 = 0x52;
static const uint8_t RTCM_TRANSPORT_MAGIC_1 = 0x54;
static const uint8_t RTCM_TRANSPORT_VERSION = 0x01;
static const uint8_t RTCM_TRANSPORT_MESSAGE_RTCM_FRAGMENT = 0x01;
static const uint8_t RTCM_WIFI_CHANNEL = 1;
static const uint8_t RTCM_TRANSPORT_HEADER_SIZE = 15;
static const uint8_t RTCM_MAX_FRAGMENT_PAYLOAD = 235;
static const uint16_t RTCM_MAX_MESSAGE_SIZE = 1029;
static const uint8_t RTCM_MAX_FRAGMENT_COUNT = 5;
static const uint8_t RTCM_ASSEMBLY_SLOT_COUNT = 4;
static const uint8_t RTCM_COMPLETED_CACHE_SIZE = 128;
static const uint32_t RTCM_FRAGMENT_TIMEOUT_MILLIS = 500;
static const uint32_t RTCM_COMPLETED_RETENTION_MILLIS = 10000;
static const uint32_t RTCM_ROUTE_FRESH_MILLIS = 3000;

// TODO: Fill both station-mode MAC addresses before flashing this mower node.
// Incoming ESP-NOW corrections are deliberately rejected while both are zero.
static const uint8_t BASE_STATION_MAC[6] = { 0, 0, 0, 0, 0, 0 };
static const uint8_t GNSS_RELAY_MAC[6] = { 0, 0, 0, 0, 0, 0 };

enum RtcmPacketSource : uint8_t {
  RTCM_SOURCE_NONE = 0,
  RTCM_SOURCE_DIRECT = 1,
  RTCM_SOURCE_RELAY = 2,
};

struct RtcmAssembly {
  bool active;
  uint16_t messageId;
  uint8_t fragmentCount;
  uint16_t totalLength;
  uint32_t payloadCrc;
  uint8_t receivedMask;
  uint8_t directMask;
  uint8_t relayMask;
  uint32_t lastFragmentMillis;
  uint8_t data[RTCM_MAX_MESSAGE_SIZE];
};

struct CompletedRtcmMessage {
  bool active;
  uint16_t messageId;
  uint8_t fragmentCount;
  uint16_t totalLength;
  uint32_t payloadCrc;
  uint8_t directMask;
  uint8_t relayMask;
  uint32_t completedMillis;
};

static uint8_t g_rtcmBuffer[RTCM_BUFFER_SIZE];
static int g_rtcmIndex = 0;
static uint16_t g_lastRtcmSequence = 0;
static uint32_t g_lastRtcmMillis = 0;
static uint32_t g_lastRtcmLedPulseMillis = 0;
static uint32_t g_totalRtcmMessagesVerified = 0;
static uint32_t g_totalRtcmMessagesRejected = 0;
static uint32_t g_totalRtcmFragmentsAccepted = 0;
static uint32_t g_totalRtcmFragmentsRejected = 0;
static uint32_t g_totalRtcmFragmentsDuplicated = 0;
static uint32_t g_totalRtcmAssemblyTimeouts = 0;
static uint32_t g_totalRtcmUnknownSenders = 0;
static uint32_t g_totalRtcm1006Messages = 0;
static uint32_t g_lastRtcm1006Millis = 0;
static RtcmAssembly g_rtcmAssemblies[RTCM_ASSEMBLY_SLOT_COUNT] = {};
static CompletedRtcmMessage g_completedRtcmMessages[RTCM_COMPLETED_CACHE_SIZE] = {};
static uint8_t g_nextCompletedRtcmSlot = 0;
static uint8_t g_lastRtcmRouteSourceMask = RTCM_SOURCE_NONE;
static uint32_t g_lastRtcmRouteMillis = 0;

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
static bool g_lowSatelliteTraceLatched = false;
static uint32_t g_lastLowSatelliteTraceMillis = 0;
static char g_lastLowSatelliteRawText[GNSS_DEBUG_PAYLOAD_SIZE - 4 + 1] = {0};
static uint8_t g_lastLowSatelliteRawTextLength = 0;
static bool g_lastLowSatelliteRawTextTruncated = false;
static uint8_t g_lastLowSatelliteFixType = 0;
static uint8_t g_lastLowSatelliteSatellitesInUse = 0;
static bool g_haveLowSatelliteTrace = false;
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
  // UTC fields from RECTIMEA / RECTIMEB (utc year/month/day/hour/min/ms).
  // The receiver returns these as integers.  utcMs is the millisecond
  // component of the second; we combine all of them into utcEpochMillis.
  uint64_t utcEpochMillis;
};

struct ParsedUniheading {
  bool valid;
  bool headingValid;
  uint32_t localMillis;
  float headingDegrees;
  float pitchDegrees;
  float headingStdDevDegrees;
  bool headingStdDevValid;
  float baselineLengthMeters;
  bool baselineLengthValid;
};

ParsedPvtsln g_latestPvtsln = { false, 0, FIX_NONE, 0.0, 0.0, 99.0f, 0.0f, false, 0.0f, false, 0.0f, false, 0, 0.0f, false };
ParsedRectime g_latestRectime = { false, false, 0, 0 };
ParsedUniheading g_latestUniheading = { false, false, 0, 0.0f, 0.0f, 0.0f, false, 0.0f, false };

enum OriginSource : uint8_t {
  ORIGIN_NONE = 0,
  ORIGIN_RTCM1006 = 1,
  ORIGIN_DYNAMIC = 2,
};

OriginSource g_originSource = ORIGIN_NONE;
double g_originLatitudeDegrees = 0.0;
double g_originLongitudeDegrees = 0.0;
double g_originHeightMeters = 0.0;

uint16_t g_lastRequestSequence = 0;
uint8_t g_lastRequestMessageType = MESSAGE_TYPE_GNSS_SAMPLE;
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

void writeU64LE(uint8_t *bytes, uint64_t value) {
  for (uint8_t i = 0; i < 8; ++i) {
    bytes[i] = static_cast<uint8_t>(value & 0xFF);
    value >>= 8;
  }
}

void writeI16LE(uint8_t *bytes, int16_t value) {
  writeU16LE(bytes, static_cast<uint16_t>(value));
}

void writeI32LE(uint8_t *bytes, int32_t value) {
  writeU32LE(bytes, static_cast<uint32_t>(value));
}

uint32_t readU24LE(const uint8_t *bytes) {
  return static_cast<uint32_t>(bytes[0])
    | (static_cast<uint32_t>(bytes[1]) << 8)
    | (static_cast<uint32_t>(bytes[2]) << 16);
}

uint16_t readU16LE(const uint8_t *bytes) {
  return static_cast<uint16_t>(bytes[0]) | (static_cast<uint16_t>(bytes[1]) << 8);
}

uint32_t crc24q(const uint8_t *data, size_t length) {
  uint32_t crc = 0;
  for (size_t index = 0; index < length; index += 1) {
    crc ^= static_cast<uint32_t>(data[index]) << 16;
    for (uint8_t bit = 0; bit < 8; bit += 1) {
      crc <<= 1;
      if ((crc & 0x1000000u) != 0) {
        crc ^= 0x1864CFBu;
      }
    }
  }
  return crc & 0xFFFFFFu;
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

size_t encodeFrame(uint8_t messageType, uint8_t flags, uint16_t sequence, const uint8_t *payload, uint16_t payloadLength, uint8_t *outFrame) {
  outFrame[0] = PROTOCOL_START_OF_FRAME;
  outFrame[1] = PROTOCOL_VERSION;
  outFrame[2] = NODE_ID_GNSS;
  outFrame[3] = messageType;
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

bool tryParseInt32Strict(const String &value, int32_t &out) {
  if (value.length() == 0) {
    return false;
  }
  char *end = nullptr;
  const long parsed = strtol(value.c_str(), &end, 10);
  if (end == value.c_str() || (end != nullptr && *end != '\0')) {
    return false;
  }
  out = static_cast<int32_t>(parsed);
  return true;
}

bool tryParseFloatStrict(const String &value, float &out) {
  if (value.length() == 0) {
    return false;
  }
  char *end = nullptr;
  const float parsed = strtof(value.c_str(), &end);
  if (end == value.c_str() || (end != nullptr && *end != '\0')) {
    return false;
  }
  out = parsed;
  return true;
}

bool tryParseDoubleStrict(const String &value, double &out) {
  if (value.length() == 0) {
    return false;
  }
  char *end = nullptr;
  const double parsed = strtod(value.c_str(), &end);
  if (end == value.c_str() || (end != nullptr && *end != '\0')) {
    return false;
  }
  out = parsed;
  return true;
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

const char *originSourceLabel() {
  switch (g_originSource) {
    case ORIGIN_RTCM1006:
      return "rtcm1006";
    case ORIGIN_DYNAMIC:
      return "dynamic";
    case ORIGIN_NONE:
    default:
      return "none";
  }
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
  const uint32_t rtcm1006AgeMillis = g_lastRtcm1006Millis == 0 ? 0xFFFFFFFFu : nowMillis - g_lastRtcm1006Millis;
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
  Serial.print(" rtcmFrags=");
  Serial.print(g_totalRtcmFragmentsAccepted);
  Serial.print("/");
  Serial.print(g_totalRtcmFragmentsRejected);
  Serial.print("/");
  Serial.print(g_totalRtcmFragmentsDuplicated);
  Serial.print("/");
  Serial.print(g_totalRtcmAssemblyTimeouts);
  Serial.print(" unknownRtcmSenders=");
  Serial.print(g_totalRtcmUnknownSenders);
  Serial.print(" rtcmRoute=");
  if (g_lastRtcmRouteSourceMask == (RTCM_SOURCE_DIRECT | RTCM_SOURCE_RELAY)) {
    Serial.print("mixed");
  } else if (g_lastRtcmRouteSourceMask == RTCM_SOURCE_RELAY) {
    Serial.print("relay");
  } else if (g_lastRtcmRouteSourceMask == RTCM_SOURCE_DIRECT) {
    Serial.print("direct");
  } else {
    Serial.print("none");
  }
  Serial.print(" rtcm1006=");
  Serial.print(g_totalRtcm1006Messages);
  Serial.print(" rtcm1006AgeMs=");
  if (rtcm1006AgeMillis == 0xFFFFFFFFu) {
    Serial.print("none");
  } else {
    Serial.print(rtcm1006AgeMillis);
  }
  Serial.print(" origin=");
  Serial.print(originSourceLabel());
  Serial.print("(");
  Serial.print(g_originLatitudeDegrees, 8);
  Serial.print(",");
  Serial.print(g_originLongitudeDegrees, 8);
  Serial.print(",");
  Serial.print(g_originHeightMeters, 3);
  Serial.print(")");
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

void traceLowSatellitePvtslna(const char *line, CompactFixType fixType, int32_t satellitesInUse) {
  const bool lowSatellite = satellitesInUse < 8;
  if (!lowSatellite) {
    g_lowSatelliteTraceLatched = false;
    return;
  }

  g_lowSatelliteTraceLatched = true;

  String payload = payloadAfterSemicolon(line);
  const size_t maxLength = sizeof(g_lastLowSatelliteRawText) - 1;
  const size_t sourceLength = payload.length();
  const size_t copyLength = sourceLength > maxLength ? maxLength : sourceLength;
  memcpy(g_lastLowSatelliteRawText, payload.c_str(), copyLength);
  g_lastLowSatelliteRawText[copyLength] = '\0';
  g_lastLowSatelliteRawTextLength = static_cast<uint8_t>(copyLength);
  g_lastLowSatelliteRawTextTruncated = sourceLength > maxLength;
  g_lastLowSatelliteFixType = static_cast<uint8_t>(fixType);
  g_lastLowSatelliteSatellitesInUse = static_cast<uint8_t>(satellitesInUse);
  g_haveLowSatelliteTrace = true;
  g_lastLowSatelliteTraceMillis = millis();
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
    digitalWrite(LED_RTCM_ROUTE_PIN, HIGH);
    delay(100);
    digitalWrite(LED_HEADING_PIN, LOW);
    digitalWrite(LED_POSITION_PIN, LOW);
    digitalWrite(LED_RTCM_ROUTE_PIN, LOW);
    delay(100);
  }
}

void updateRtcmRouteLed(uint32_t nowMillis) {
  if (g_lastRtcmRouteMillis == 0 || (nowMillis - g_lastRtcmRouteMillis) > RTCM_ROUTE_FRESH_MILLIS) {
    digitalWrite(LED_RTCM_ROUTE_PIN, LOW);
    return;
  }

  const uint16_t phaseMillis = static_cast<uint16_t>(nowMillis % 1000u);
  if (g_lastRtcmRouteSourceMask == RTCM_SOURCE_DIRECT) {
    digitalWrite(LED_RTCM_ROUTE_PIN, HIGH);
  } else if (g_lastRtcmRouteSourceMask == RTCM_SOURCE_RELAY) {
    digitalWrite(LED_RTCM_ROUTE_PIN, phaseMillis < 200u ? HIGH : LOW);
  } else {
    const bool doubleFlash = phaseMillis < 120u || (phaseMillis >= 240u && phaseMillis < 360u);
    digitalWrite(LED_RTCM_ROUTE_PIN, doubleFlash ? HIGH : LOW);
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
  updateRtcmRouteLed(nowMillis);
}

void ensureOriginFromCurrentFix() {
  // Only use the dynamic fallback if RTCM1006 has never arrived. Once a real
  // base-station origin is established it is never replaced by a dynamic one.
  if (g_originSource == ORIGIN_RTCM1006 || g_originSource == ORIGIN_DYNAMIC) {
    return;
  }
  if (g_latestPvtsln.valid && g_latestPvtsln.fixType != FIX_NONE) {
    g_originLatitudeDegrees = g_latestPvtsln.latitudeDegrees;
    g_originLongitudeDegrees = g_latestPvtsln.longitudeDegrees;
    g_originHeightMeters = 0.0;
    g_originSource = ORIGIN_DYNAMIC;
  }
}

void localXYFromLatLon(double latitudeDegrees, double longitudeDegrees, int32_t &xMillimeters, int32_t &yMillimeters) {
  ensureOriginFromCurrentFix();

  if (g_originSource == ORIGIN_NONE) {
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

  double eastMillimeters = eastMeters * 1000.0;
  double northMillimeters = northMeters * 1000.0;
  if (
    !isfinite(eastMillimeters) ||
    !isfinite(northMillimeters) ||
    eastMillimeters < static_cast<double>(INT32_MIN) ||
    eastMillimeters >= static_cast<double>(INT32_MAX) ||
    northMillimeters < static_cast<double>(INT32_MIN) ||
    northMillimeters >= static_cast<double>(INT32_MAX)
  ) {
    xMillimeters = INT32_MAX;
    yMillimeters = INT32_MAX;
    return;
  }

  xMillimeters = static_cast<int32_t>(eastMillimeters);
  yMillimeters = static_cast<int32_t>(northMillimeters);
}

uint64_t readRtcmBits(const uint8_t *payload, size_t bitOffset, size_t bitCount) {
  uint64_t value = 0;
  for (size_t index = 0; index < bitCount; index += 1) {
    const size_t absoluteBit = bitOffset + index;
    const uint8_t byteValue = payload[absoluteBit / 8];
    const uint8_t bitValue = (byteValue >> (7 - (absoluteBit % 8))) & 0x01;
    value = (value << 1) | bitValue;
  }
  return value;
}

int64_t readRtcmSignedBits(const uint8_t *payload, size_t bitOffset, size_t bitCount) {
  uint64_t rawValue = readRtcmBits(payload, bitOffset, bitCount);
  const uint64_t signBit = 1ULL << (bitCount - 1);
  if ((rawValue & signBit) == 0) {
    return static_cast<int64_t>(rawValue);
  }
  const uint64_t magnitude = (1ULL << bitCount) - rawValue;
  return -static_cast<int64_t>(magnitude);
}

bool ecefToGeodetic(
  double xMeters,
  double yMeters,
  double zMeters,
  double &latitudeDegrees,
  double &longitudeDegrees,
  double &heightMeters
) {
  const double semiMajorAxisMeters = 6378137.0;
  const double flattening = 1.0 / 298.257223563;
  const double eccentricitySquared = flattening * (2.0 - flattening);
  const double radToDeg = 180.0 / 3.14159265358979323846;

  const double horizontalMeters = sqrt((xMeters * xMeters) + (yMeters * yMeters));
  if (!isfinite(horizontalMeters) || horizontalMeters <= 0.0) {
    return false;
  }

  double latitudeRadians = atan2(zMeters, horizontalMeters * (1.0 - eccentricitySquared));
  const double longitudeRadians = atan2(yMeters, xMeters);
  double height = 0.0;

  for (uint8_t iteration = 0; iteration < 8; iteration += 1) {
    const double sinLatitude = sin(latitudeRadians);
    const double normalRadius =
      semiMajorAxisMeters / sqrt(1.0 - (eccentricitySquared * sinLatitude * sinLatitude));
    height = (horizontalMeters / cos(latitudeRadians)) - normalRadius;
    latitudeRadians =
      atan2(zMeters, horizontalMeters * (1.0 - (eccentricitySquared * normalRadius / (normalRadius + height))));
  }

  latitudeDegrees = latitudeRadians * radToDeg;
  longitudeDegrees = longitudeRadians * radToDeg;
  heightMeters = height;

  return
    isfinite(latitudeDegrees) &&
    isfinite(longitudeDegrees) &&
    isfinite(heightMeters) &&
    latitudeDegrees >= -90.0 &&
    latitudeDegrees <= 90.0 &&
    longitudeDegrees >= -180.0 &&
    longitudeDegrees <= 180.0;
}

bool noteRtcm1006BasePosition(const uint8_t *payload, int payloadLength) {
  const int requiredBits = 12 + 12 + 6 + 1 + 1 + 1 + 1 + 38 + 1 + 1 + 38 + 2 + 38 + 16;
  if (payloadLength * 8 < requiredBits) {
    return false;
  }

  const uint16_t messageType = static_cast<uint16_t>(readRtcmBits(payload, 0, 12));
  if (messageType != 1006) {
    return false;
  }

  size_t bitOffset = 12 + 12 + 6 + 1 + 1 + 1 + 1;
  const int64_t ecefXRaw = readRtcmSignedBits(payload, bitOffset, 38);
  bitOffset += 38;
  bitOffset += 1 + 1;
  const int64_t ecefYRaw = readRtcmSignedBits(payload, bitOffset, 38);
  bitOffset += 38;
  bitOffset += 2;
  const int64_t ecefZRaw = readRtcmSignedBits(payload, bitOffset, 38);
  bitOffset += 38;
  const uint16_t antennaHeightRaw = static_cast<uint16_t>(readRtcmBits(payload, bitOffset, 16));

  const double ecefX = static_cast<double>(ecefXRaw) * 0.0001;
  const double ecefY = static_cast<double>(ecefYRaw) * 0.0001;
  const double ecefZ = static_cast<double>(ecefZRaw) * 0.0001;

  double latitudeDegrees = 0.0;
  double longitudeDegrees = 0.0;
  double heightMeters = 0.0;
  if (!ecefToGeodetic(ecefX, ecefY, ecefZ, latitudeDegrees, longitudeDegrees, heightMeters)) {
    return false;
  }

  g_originLatitudeDegrees = latitudeDegrees;
  g_originLongitudeDegrees = longitudeDegrees;
  g_originHeightMeters = heightMeters;
  g_originSource = ORIGIN_RTCM1006;

  g_totalRtcm1006Messages += 1;
  g_lastRtcm1006Millis = millis();

  Serial.print("[RTCM1006] base=");
  Serial.print(latitudeDegrees, 10);
  Serial.print(",");
  Serial.print(longitudeDegrees, 10);
  Serial.print(",");
  Serial.print(heightMeters, 3);
  Serial.print(" antennaHeight=");
  Serial.print(static_cast<double>(antennaHeightRaw) * 0.0001, 4);
  Serial.print(" origin=");
  Serial.println(originSourceLabel());

  return true;
}

bool isConfiguredMac(const uint8_t *address) {
  for (uint8_t index = 0; index < 6; index += 1) {
    if (address[index] != 0) {
      return true;
    }
  }
  return false;
}

RtcmPacketSource classifyRtcmSender(const uint8_t *address) {
  if (isConfiguredMac(BASE_STATION_MAC) && memcmp(address, BASE_STATION_MAC, 6) == 0) {
    return RTCM_SOURCE_DIRECT;
  }
  if (isConfiguredMac(GNSS_RELAY_MAC) && memcmp(address, GNSS_RELAY_MAC, 6) == 0) {
    return RTCM_SOURCE_RELAY;
  }
  return RTCM_SOURCE_NONE;
}

uint8_t completeFragmentMask(uint8_t fragmentCount) {
  return static_cast<uint8_t>((1u << fragmentCount) - 1u);
}

void expireRtcmState(uint32_t nowMillis) {
  for (uint8_t index = 0; index < RTCM_ASSEMBLY_SLOT_COUNT; index += 1) {
    RtcmAssembly &assembly = g_rtcmAssemblies[index];
    if (assembly.active && (nowMillis - assembly.lastFragmentMillis) > RTCM_FRAGMENT_TIMEOUT_MILLIS) {
      assembly.active = false;
      g_totalRtcmAssemblyTimeouts += 1;
    }
  }
  for (uint8_t index = 0; index < RTCM_COMPLETED_CACHE_SIZE; index += 1) {
    CompletedRtcmMessage &completed = g_completedRtcmMessages[index];
    if (completed.active && (nowMillis - completed.completedMillis) > RTCM_COMPLETED_RETENTION_MILLIS) {
      completed.active = false;
    }
  }
}

CompletedRtcmMessage *findCompletedRtcmMessage(uint16_t messageId, uint16_t totalLength, uint32_t payloadCrc) {
  for (uint8_t index = 0; index < RTCM_COMPLETED_CACHE_SIZE; index += 1) {
    CompletedRtcmMessage &completed = g_completedRtcmMessages[index];
    if (completed.active
      && completed.messageId == messageId
      && completed.totalLength == totalLength
      && completed.payloadCrc == payloadCrc) {
      return &completed;
    }
  }
  return nullptr;
}

void noteCompletedRoute(CompletedRtcmMessage &completed, RtcmPacketSource source, uint8_t fragmentIndex) {
  const uint8_t fragmentBit = static_cast<uint8_t>(1u << fragmentIndex);
  if (source == RTCM_SOURCE_DIRECT) {
    completed.directMask |= fragmentBit;
  } else if (source == RTCM_SOURCE_RELAY) {
    completed.relayMask |= fragmentBit;
  }

  const uint8_t fullMask = completeFragmentMask(completed.fragmentCount);
  uint8_t completeSources = RTCM_SOURCE_NONE;
  if (completed.directMask == fullMask) {
    completeSources |= RTCM_SOURCE_DIRECT;
  }
  if (completed.relayMask == fullMask) {
    completeSources |= RTCM_SOURCE_RELAY;
  }
  if (completeSources != RTCM_SOURCE_NONE) {
    g_lastRtcmRouteSourceMask = completeSources;
    g_lastRtcmRouteMillis = millis();
  }
}

RtcmAssembly *findOrAllocateRtcmAssembly(
  uint16_t messageId,
  uint8_t fragmentCount,
  uint16_t totalLength,
  uint32_t payloadCrc,
  uint32_t nowMillis
) {
  RtcmAssembly *freeSlot = nullptr;
  RtcmAssembly *oldestSlot = &g_rtcmAssemblies[0];
  for (uint8_t index = 0; index < RTCM_ASSEMBLY_SLOT_COUNT; index += 1) {
    RtcmAssembly &assembly = g_rtcmAssemblies[index];
    if (assembly.active
      && assembly.messageId == messageId
      && assembly.totalLength == totalLength
      && assembly.payloadCrc == payloadCrc) {
      return &assembly;
    }
    if (!assembly.active && freeSlot == nullptr) {
      freeSlot = &assembly;
    }
    if (assembly.lastFragmentMillis < oldestSlot->lastFragmentMillis) {
      oldestSlot = &assembly;
    }
  }

  RtcmAssembly *assembly = freeSlot == nullptr ? oldestSlot : freeSlot;
  if (assembly->active) {
    g_totalRtcmAssemblyTimeouts += 1;
  }
  assembly->active = true;
  assembly->messageId = messageId;
  assembly->fragmentCount = fragmentCount;
  assembly->totalLength = totalLength;
  assembly->payloadCrc = payloadCrc;
  assembly->receivedMask = 0;
  assembly->directMask = 0;
  assembly->relayMask = 0;
  assembly->lastFragmentMillis = nowMillis;
  return assembly;
}

bool handleCompleteRtcmMessage(const uint8_t *message, int totalLength) {
  if (totalLength < 6) {
    g_totalRtcmMessagesRejected += 1;
    return false;
  }
  if (message[0] != RTCM_PREAMBLE) {
    g_totalRtcmMessagesRejected += 1;
    return false;
  }

  const int payloadLength = ((message[1] & 0x03) << 8) | message[2];
  if ((payloadLength + 6) != totalLength) {
    g_totalRtcmMessagesRejected += 1;
    return false;
  }

  const uint32_t expectedCrc =
    (static_cast<uint32_t>(message[totalLength - 3]) << 16)
    | (static_cast<uint32_t>(message[totalLength - 2]) << 8)
    | static_cast<uint32_t>(message[totalLength - 1]);
  const uint32_t actualCrc = crc24q(message, totalLength - 3);
  if (actualCrc != expectedCrc) {
    g_totalRtcmMessagesRejected += 1;
    return false;
  }

  noteRtcm1006BasePosition(&message[3], payloadLength);
  UM982.write(message, totalLength);
  g_lastRtcmMillis = millis();
  g_lastRtcmLedPulseMillis = g_lastRtcmMillis;
  g_totalRtcmMessagesVerified += 1;
  digitalWrite(LED_RTCM_PIN, HIGH);
  return true;
}

void appendLegacyRtcmChunk(const uint8_t *incomingData, int len) {
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

  if (g_rtcmIndex >= 1 && g_rtcmBuffer[0] != RTCM_PREAMBLE) {
    g_rtcmIndex = 0;
    g_totalRtcmMessagesRejected += 1;
    return;
  }

  if (g_rtcmIndex >= 3) {
    const int payloadLength = ((g_rtcmBuffer[1] & 0x03) << 8) | g_rtcmBuffer[2];
    const int totalLength = payloadLength + 6;
    if (payloadLength < 0 || totalLength > static_cast<int>(RTCM_BUFFER_SIZE)) {
      g_rtcmIndex = 0;
      g_totalRtcmMessagesRejected += 1;
      return;
    }
    if (g_rtcmIndex >= totalLength) {
      handleCompleteRtcmMessage(g_rtcmBuffer, totalLength);
      g_rtcmIndex = 0;
    }
  }
}

bool isNewRtcmTransportPacket(const uint8_t *incomingData, int len) {
  return len >= static_cast<int>(RTCM_TRANSPORT_HEADER_SIZE)
    && incomingData[0] == RTCM_TRANSPORT_MAGIC_0
    && incomingData[1] == RTCM_TRANSPORT_MAGIC_1
    && incomingData[2] == RTCM_TRANSPORT_VERSION;
}

void appendFragmentedRtcmPacket(const uint8_t *incomingData, int len, RtcmPacketSource source) {
  if (len < static_cast<int>(RTCM_TRANSPORT_HEADER_SIZE)) {
    g_totalRtcmFragmentsRejected += 1;
    return;
  }

  const uint32_t nowMillis = millis();
  expireRtcmState(nowMillis);

  const uint8_t messageType = incomingData[3];
  const uint16_t messageId = readU16LE(&incomingData[5]);
  const uint8_t fragmentIndex = incomingData[7];
  const uint8_t fragmentCount = incomingData[8];
  const uint8_t fragmentPayloadLength = incomingData[9];
  const uint16_t totalLength = readU16LE(&incomingData[10]);
  const uint32_t payloadCrc = readU24LE(&incomingData[12]);

  if (messageType != RTCM_TRANSPORT_MESSAGE_RTCM_FRAGMENT
    || fragmentCount == 0
    || fragmentCount > RTCM_MAX_FRAGMENT_COUNT
    || fragmentIndex >= fragmentCount
    || totalLength < 6
    || totalLength > RTCM_MAX_MESSAGE_SIZE
    || len != static_cast<int>(RTCM_TRANSPORT_HEADER_SIZE + fragmentPayloadLength)
    || fragmentPayloadLength == 0
    || fragmentPayloadLength > RTCM_MAX_FRAGMENT_PAYLOAD
    || fragmentCount != static_cast<uint8_t>((totalLength + RTCM_MAX_FRAGMENT_PAYLOAD - 1) / RTCM_MAX_FRAGMENT_PAYLOAD)) {
    g_totalRtcmFragmentsRejected += 1;
    return;
  }

  const uint16_t fragmentOffset = static_cast<uint16_t>(fragmentIndex) * RTCM_MAX_FRAGMENT_PAYLOAD;
  const uint16_t expectedFragmentLength = min(
    static_cast<uint16_t>(RTCM_MAX_FRAGMENT_PAYLOAD),
    static_cast<uint16_t>(totalLength - fragmentOffset)
  );
  if (fragmentOffset >= totalLength || fragmentPayloadLength != expectedFragmentLength) {
    g_totalRtcmFragmentsRejected += 1;
    return;
  }

  CompletedRtcmMessage *completed = findCompletedRtcmMessage(messageId, totalLength, payloadCrc);
  if (completed != nullptr) {
    noteCompletedRoute(*completed, source, fragmentIndex);
    g_totalRtcmFragmentsDuplicated += 1;
    return;
  }

  RtcmAssembly *assembly = findOrAllocateRtcmAssembly(
    messageId,
    fragmentCount,
    totalLength,
    payloadCrc,
    nowMillis
  );
  if (assembly->fragmentCount != fragmentCount) {
    g_totalRtcmFragmentsRejected += 1;
    assembly->active = false;
    return;
  }

  const uint8_t fragmentBit = static_cast<uint8_t>(1u << fragmentIndex);
  if ((assembly->receivedMask & fragmentBit) != 0) {
    if (source == RTCM_SOURCE_DIRECT) {
      assembly->directMask |= fragmentBit;
    } else if (source == RTCM_SOURCE_RELAY) {
      assembly->relayMask |= fragmentBit;
    }
    assembly->lastFragmentMillis = nowMillis;
    g_totalRtcmFragmentsDuplicated += 1;
    return;
  }

  memcpy(assembly->data + fragmentOffset, incomingData + RTCM_TRANSPORT_HEADER_SIZE, fragmentPayloadLength);
  assembly->receivedMask |= fragmentBit;
  if (source == RTCM_SOURCE_DIRECT) {
    assembly->directMask |= fragmentBit;
  } else if (source == RTCM_SOURCE_RELAY) {
    assembly->relayMask |= fragmentBit;
  }
  assembly->lastFragmentMillis = nowMillis;
  g_totalRtcmFragmentsAccepted += 1;

  if (assembly->receivedMask != completeFragmentMask(fragmentCount)) {
    return;
  }

  const uint32_t actualPayloadCrc = crc24q(assembly->data, static_cast<size_t>(totalLength - 3));
  if (actualPayloadCrc != payloadCrc) {
    g_totalRtcmFragmentsRejected += 1;
    assembly->active = false;
    return;
  }

  if (!handleCompleteRtcmMessage(assembly->data, totalLength)) {
    assembly->active = false;
    return;
  }

  CompletedRtcmMessage &newCompleted = g_completedRtcmMessages[g_nextCompletedRtcmSlot];
  g_nextCompletedRtcmSlot = static_cast<uint8_t>((g_nextCompletedRtcmSlot + 1) % RTCM_COMPLETED_CACHE_SIZE);
  newCompleted.active = true;
  newCompleted.messageId = messageId;
  newCompleted.fragmentCount = fragmentCount;
  newCompleted.totalLength = totalLength;
  newCompleted.payloadCrc = payloadCrc;
  newCompleted.directMask = assembly->directMask;
  newCompleted.relayMask = assembly->relayMask;
  newCompleted.completedMillis = nowMillis;
  assembly->active = false;

  // A message assembled from a mixture of direct and relayed fragments proves
  // that both routes contributed even if neither route supplied every part.
  g_lastRtcmRouteSourceMask = RTCM_SOURCE_NONE;
  if (newCompleted.directMask != 0) {
    g_lastRtcmRouteSourceMask |= RTCM_SOURCE_DIRECT;
  }
  if (newCompleted.relayMask != 0) {
    g_lastRtcmRouteSourceMask |= RTCM_SOURCE_RELAY;
  }
  g_lastRtcmRouteMillis = nowMillis;
}

// ===== RTCM relay =====
void onEspNowDataReceived(const esp_now_recv_info_t *info, const uint8_t *incomingData, int len) {
  if (info == nullptr) {
    return;
  }
  const RtcmPacketSource source = classifyRtcmSender(info->src_addr);
  if (source == RTCM_SOURCE_NONE) {
    g_totalRtcmUnknownSenders += 1;
    return;
  }
  if (isNewRtcmTransportPacket(incomingData, len)) {
    appendFragmentedRtcmPacket(incomingData, len, source);
    return;
  }

  // The legacy transport has no stable message identity and cannot safely be
  // deduplicated across direct and relayed paths.
  g_totalRtcmFragmentsRejected += 1;
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
  // 20 Hz PVTSLN (0.05 s). Requires CONFIG COM2 460800 already persisted on the
  // UM982 to match UM982_UART_BAUD above; the boot-config path cannot change
  // baud mid-session because the ESP is already open at the new rate.
  // RECTIME stays at 1 Hz, UNIHEADING at 5 Hz as diagnostic-only cross-checks.
  { "PVTSLNA COM2 0.05", WAIT_OK_ONLY },
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

  double latitudeDegrees = 0.0;
  double longitudeDegrees = 0.0;
  float latStd = 0.0f;
  float lonStd = 0.0f;
  int32_t satellitesInUse = 0;
  float groundSpeedMetersPerSecond = 0.0f;
  float headingDegrees = 0.0f;

  const bool hasCoreNumbers =
    tryParseDoubleStrict(latField, latitudeDegrees) &&
    tryParseDoubleStrict(lonField, longitudeDegrees) &&
    tryParseFloatStrict(latStdField, latStd) &&
    tryParseFloatStrict(lonStdField, lonStd) &&
    tryParseInt32Strict(solnSatsField, satellitesInUse);

  if (!hasCoreNumbers || satellitesInUse < 0 || satellitesInUse > 80) {
    return;
  }

  g_latestPvtsln.valid = true;
  g_latestPvtsln.localMillis = millis();
  g_latestPvtsln.fixType = mapPositionType(bestposType);
  g_headingLedState = mapHeadingLedState(headingTypeField);
  g_positionLedState = mapPositionLedState(bestposType);
  g_latestPvtsln.latitudeDegrees = latitudeDegrees;
  g_latestPvtsln.longitudeDegrees = longitudeDegrees;
  g_latestPvtsln.positionAccuracyMeters = conservativeHorizontalAccuracy(latStd, lonStd);
  g_latestPvtsln.satellitesInUse = static_cast<uint8_t>(satellitesInUse);

  g_latestPvtsln.groundSpeedValid = tryParseFloatStrict(groundSpeedField, groundSpeedMetersPerSecond);
  g_latestPvtsln.groundSpeedMetersPerSecond = g_latestPvtsln.groundSpeedValid ? groundSpeedMetersPerSecond : 0.0f;

  g_latestPvtsln.headingValid = isHeadingTypeUsable(headingTypeField);
  const bool headingParsed = tryParseFloatStrict(headingField, headingDegrees);
  g_latestPvtsln.headingValid = g_latestPvtsln.headingValid && headingParsed;
  g_latestPvtsln.headingDegrees = headingParsed ? headingDegrees : 0.0f;

  g_latestPvtsln.pitchValid = tryParseFloatStrict(pitchField, g_latestPvtsln.pitchDegrees);
  if (!g_latestPvtsln.pitchValid) {
    g_latestPvtsln.pitchDegrees = 0.0f;
  }

  if (g_latestUniheading.valid && g_latestUniheading.headingStdDevValid && (millis() - g_latestUniheading.localMillis) < 1000) {
    g_latestPvtsln.headingAccuracyDegrees = g_latestUniheading.headingStdDevDegrees;
    g_latestPvtsln.headingAccuracyValid = true;
  } else {
    float estimated = estimateHeadingAccuracyFromType(headingTypeField);
    g_latestPvtsln.headingAccuracyDegrees = estimated;
    g_latestPvtsln.headingAccuracyValid = estimated > 0.0f;
  }

  traceLowSatellitePvtslna(line, g_latestPvtsln.fixType, satellitesInUse);
}

// Convert UTC year/month/day/hour/min/sec/ms to milliseconds since the
// Unix epoch (1970-01-01 00:00:00 UTC).  Uses the civil-from-days
// algorithm by Howard Hinnant — leap years and the Gregorian calendar
// are handled correctly without timezone conversions.
// y is the four-digit year (e.g. 2026), m is 1..12, d is 1..31.
uint64_t utcToEpochMillis(int year, int month, int day,
                          int hour, int minute, int second, int millisecond) {
  // Days from civil (Hinnant): days since 1970-01-01.
  int y = year - (month <= 2 ? 1 : 0);
  int era = (y >= 0 ? y : y - 399) / 400;
  unsigned yoe = static_cast<unsigned>(y - era * 400);                // [0, 399]
  unsigned doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1; // [0, 365]
  unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;               // [0, 146096]
  long long daysSinceEpoch = static_cast<long long>(era) * 146097 + static_cast<long long>(doe) - 719468;

  uint64_t totalSeconds = static_cast<uint64_t>(daysSinceEpoch) * 86400ULL
                        + static_cast<uint64_t>(hour) * 3600ULL
                        + static_cast<uint64_t>(minute) * 60ULL
                        + static_cast<uint64_t>(second);
  return totalSeconds * 1000ULL + static_cast<uint64_t>(millisecond);
}

void parseRectimea(const char *line) {
  g_totalRectimeaCount += 1;
  String payload = payloadAfterSemicolon(line);
  if (payload.length() == 0) {
    return;
  }
  // RECTIMEA fields per UM982 manual section 7.3.47 (1-based per spec, here 0-based):
  //   0  clock status
  //   1  offset (s)
  //   2  offset std (s)
  //   3  utc offset (s)
  //   4  utc year
  //   5  utc month
  //   6  utc day
  //   7  utc hour
  //   8  utc min
  //   9  utc ms (millisecond of the minute as integer)
  //   10 utc status
  String clockStatus = fieldAt(payload.c_str(), 0);
  String utcYear     = fieldAt(payload.c_str(), 4);
  String utcMonth    = fieldAt(payload.c_str(), 5);
  String utcDay      = fieldAt(payload.c_str(), 6);
  String utcHour     = fieldAt(payload.c_str(), 7);
  String utcMin      = fieldAt(payload.c_str(), 8);
  String utcMs       = fieldAt(payload.c_str(), 9);
  String utcStatus   = fieldAt(payload.c_str(), 10);

  g_latestRectime.valid = true;
  g_latestRectime.localMillis = millis();
  const bool utcStatusUsable = (clockStatus == "VALID")
                            && (utcStatus == "VALID" || utcStatus == "WARNING");
  g_latestRectime.utcValid = utcStatusUsable;

  if (utcStatusUsable && utcYear.length() > 0 && utcMonth.length() > 0 && utcDay.length() > 0) {
    int year   = utcYear.toInt();
    int month  = utcMonth.toInt();
    int day    = utcDay.toInt();
    int hour   = utcHour.toInt();
    int minute = utcMin.toInt();
    long msOfMinute = utcMs.toInt();
    int second = static_cast<int>((msOfMinute / 1000) % 60);
    int millisOfSec = static_cast<int>(msOfMinute % 1000);
    if (year >= 2000 && year < 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      g_latestRectime.utcEpochMillis = utcToEpochMillis(year, month, day, hour, minute, second, millisOfSec);
    }
  }
}

void parseUniheadinga(const char *line) {
  g_totalUniheadingaCount += 1;
  String payload = payloadAfterSemicolon(line);
  if (payload.length() == 0) {
    return;
  }

  // UNIHEADINGA fields per UM982 manual section 7.3.48 (0-based):
  //   0  sol stat
  //   1  pos type
  //   2  length (baseline length, m)
  //   3  heading
  //   4  pitch
  //   5  reserved
  //   6  hdgstddev
  String solStat        = fieldAt(payload.c_str(), 0);
  String posType        = fieldAt(payload.c_str(), 1);
  String baselineField  = fieldAt(payload.c_str(), 2);
  String headingField   = fieldAt(payload.c_str(), 3);
  String pitchField     = fieldAt(payload.c_str(), 4);
  String headingStdField = fieldAt(payload.c_str(), 6);

  g_latestUniheading.valid = true;
  g_latestUniheading.localMillis = millis();
  g_latestUniheading.headingValid = (solStat != "INSUFFICIENT_OBS" && posType != "NONE");
  g_latestUniheading.headingDegrees = headingField.toFloat();
  g_latestUniheading.pitchDegrees = pitchField.toFloat();
  g_latestUniheading.headingStdDevDegrees = headingStdField.toFloat();
  g_latestUniheading.headingStdDevValid = headingStdField.length() > 0 && g_latestUniheading.headingStdDevDegrees > 0.0f;
  g_latestUniheading.baselineLengthMeters = baselineField.toFloat();
  g_latestUniheading.baselineLengthValid = baselineField.length() > 0 && g_latestUniheading.baselineLengthMeters > 0.0f;
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
  // Zero-fill so reserved bytes are deterministic.
  memset(payloadOut, 0, GNSS_SAMPLE_PAYLOAD_SIZE);

  const uint32_t nowMillis = millis();

  uint16_t sampleAgeMillis = 0xFFFF;
  if (g_latestPvtsln.valid) {
    uint32_t age = nowMillis - g_latestPvtsln.localMillis;
    sampleAgeMillis = age > 65535u ? 65535u : static_cast<uint16_t>(age);
  }

  int32_t xMillimeters = 0;
  int32_t yMillimeters = 0;
  if (g_latestPvtsln.valid) {
    localXYFromLatLon(g_latestPvtsln.latitudeDegrees, g_latestPvtsln.longitudeDegrees, xMillimeters, yMillimeters);
  }

  // off 0..7: UTC fix time in Unix epoch ms.  When UTC is not yet valid the
  // field is zero and the Pi will use its own decode-time wallclock.
  uint64_t utcEpochMillis = 0;
  if (g_latestRectime.valid && g_latestRectime.utcValid && g_latestRectime.utcEpochMillis != 0) {
    // Project the receiver-clock UTC forward by the elapsed time since the
    // RECTIMEA line was parsed so the timestamp is "now" not "last RECTIMEA".
    uint32_t elapsed = nowMillis - g_latestRectime.localMillis;
    utcEpochMillis = g_latestRectime.utcEpochMillis + static_cast<uint64_t>(elapsed);
  }
  writeU64LE(&payloadOut[0], utcEpochMillis);

  // off 8..15: position
  writeI32LE(&payloadOut[8],  xMillimeters);
  writeI32LE(&payloadOut[12], yMillimeters);

  // off 16..19: heading deg x 100 as int32 (sentinel 0x7FFFFFFF)
  if (g_latestPvtsln.headingValid) {
    writeI32LE(&payloadOut[16], static_cast<int32_t>(g_latestPvtsln.headingDegrees * 100.0f));
  } else {
    writeI32LE(&payloadOut[16], 0x7FFFFFFF);
  }

  // off 20..21: pitch deg x 100 as int16 (sentinel 0x7FFF)
  if (g_latestPvtsln.pitchValid) {
    writeI16LE(&payloadOut[20], static_cast<int16_t>(g_latestPvtsln.pitchDegrees * 100.0f));
  } else {
    writeI16LE(&payloadOut[20], 0x7FFF);
  }

  // off 22..23: ground speed mm/s
  if (g_latestPvtsln.groundSpeedValid) {
    writeU16LE(&payloadOut[22], static_cast<uint16_t>(max(0.0f, g_latestPvtsln.groundSpeedMetersPerSecond) * 1000.0f));
  } else {
    writeU16LE(&payloadOut[22], 0xFFFF);
  }

  // off 24..25: position accuracy mm
  writeU16LE(&payloadOut[24], static_cast<uint16_t>(max(0.0f, g_latestPvtsln.positionAccuracyMeters) * 1000.0f));

  // off 26..27: heading accuracy centideg
  if (g_latestPvtsln.headingAccuracyValid) {
    writeU16LE(&payloadOut[26], static_cast<uint16_t>(max(0.0f, g_latestPvtsln.headingAccuracyDegrees) * 100.0f));
  } else {
    writeU16LE(&payloadOut[26], 0xFFFF);
  }

  // off 28..29: heading baseline length mm (from UNIHEADINGA when fresh)
  if (g_latestUniheading.valid && g_latestUniheading.baselineLengthValid && (nowMillis - g_latestUniheading.localMillis) < 2000) {
    writeU16LE(&payloadOut[28], static_cast<uint16_t>(max(0.0f, g_latestUniheading.baselineLengthMeters) * 1000.0f));
  } else {
    writeU16LE(&payloadOut[28], 0xFFFF);
  }

  // off 30..31: PVTSLNA sample age (ms since last receive)
  writeU16LE(&payloadOut[30], sampleAgeMillis);

  // off 32: fix type
  payloadOut[32] = static_cast<uint8_t>(g_latestPvtsln.fixType);

  // off 33: satellites in use
  payloadOut[33] = g_latestPvtsln.satellitesInUse;

  // off 34: flags
  uint8_t flags = 0;
  if (g_latestRectime.valid && g_latestRectime.utcValid) flags |= 0x01;
  if (g_latestUniheading.valid && g_latestUniheading.headingValid) flags |= 0x02;
  if (g_latestUniheading.valid && g_latestUniheading.baselineLengthValid) flags |= 0x04;
  payloadOut[34] = flags;

  // off 35: log config mask
  payloadOut[35] =
    (g_unilogPvtslnaActive ? 0x01 : 0x00) |
    (g_unilogRectimeaActive ? 0x02 : 0x00) |
    (g_unilogUniheadingaActive ? 0x04 : 0x00);

  // off 36..39: reserved (zero-filled by memset)
}

void buildGnssDebugPayload(uint8_t *payloadOut) {
  memset(payloadOut, 0, GNSS_DEBUG_PAYLOAD_SIZE);

  if (!g_haveLowSatelliteTrace) {
    return;
  }

  const size_t textCapacity = GNSS_DEBUG_PAYLOAD_SIZE - 4;
  const size_t textLength = static_cast<size_t>(g_lastLowSatelliteRawTextLength);
  const size_t copyLength = textLength > textCapacity ? textCapacity : textLength;

  uint8_t flags = 0x01;
  if (g_lastLowSatelliteRawTextTruncated) {
    flags |= 0x02;
  }
  payloadOut[0] = flags;
  payloadOut[1] = g_lastLowSatelliteSatellitesInUse;
  payloadOut[2] = g_lastLowSatelliteFixType;
  payloadOut[3] = static_cast<uint8_t>(copyLength);
  memcpy(&payloadOut[4], g_lastLowSatelliteRawText, copyLength);
}

void refreshTxFrame() {
  uint8_t flags = 0;
  if (g_lastRequestMessageType == MESSAGE_TYPE_GNSS_DEBUG_LINE) {
    uint8_t payload[GNSS_DEBUG_PAYLOAD_SIZE];
    buildGnssDebugPayload(payload);
    g_txFrameLength = encodeFrame(MESSAGE_TYPE_GNSS_DEBUG_LINE, flags, g_lastRequestSequence, payload, GNSS_DEBUG_PAYLOAD_SIZE, g_txFrame);
    return;
  }

  uint8_t payload[GNSS_SAMPLE_PAYLOAD_SIZE];
  buildGnssPayload(payload);

  if (!g_latestPvtsln.valid || g_latestPvtsln.fixType == FIX_NONE) {
    flags |= 0x01;
  }
  if (!g_latestPvtsln.headingValid) {
    flags |= 0x02;
  }
  g_txFrameLength = encodeFrame(MESSAGE_TYPE_GNSS_SAMPLE, flags, g_lastRequestSequence, payload, GNSS_SAMPLE_PAYLOAD_SIZE, g_txFrame);
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

  if (messageType == MESSAGE_TYPE_GNSS_SAMPLE || messageType == MESSAGE_TYPE_GNSS_DEBUG_LINE) {
    g_lastRequestMessageType = messageType;
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
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(RTCM_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  if (esp_now_init() != ESP_OK) {
    return;
  }
  esp_now_register_recv_cb(onEspNowDataReceived);
}

void setup() {
  Serial.begin(115200);
  UM982.begin(UM982_UART_BAUD, SERIAL_8N1, UM982_RX_PIN, UM982_TX_PIN);

  pinMode(LED_HEADING_PIN, OUTPUT);
  pinMode(LED_POSITION_PIN, OUTPUT);
  pinMode(LED_RTCM_PIN, OUTPUT);
  pinMode(LED_RTCM_ROUTE_PIN, OUTPUT);
  digitalWrite(LED_HEADING_PIN, LOW);
  digitalWrite(LED_POSITION_PIN, LOW);
  digitalWrite(LED_RTCM_PIN, LOW);
  digitalWrite(LED_RTCM_ROUTE_PIN, LOW);
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
