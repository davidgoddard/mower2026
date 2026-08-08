// GNSS base-station ESP32 for mower RTK corrections.
//
// Pinout:
// - UM980 TX -> ESP32 GPIO16 (Serial2 RX)
// - UM980 RX -> ESP32 GPIO17 (Serial2 TX)
// - UM980 GND -> ESP32 GND
// - UM980 VCC -> appropriate ESP32 supply rail per hardware design
//
// Operation:
// - reads RTCM3 frames from the UM980 base receiver on Serial2 at 115200 baud
// - validates RTCM framing and CRC before any radio transmission
// - fragments each RTCM frame into ESP-NOW packets with message metadata
// - sends fragments on a fixed Wi-Fi channel with power save disabled
// - prefers configured unicast rover peers; falls back to broadcast when enabled
// - pairs with `external-hardware/esp32/gnss-node-v2/gnss-node-v2.ino`
//
// Notes:
// - set `ROVER_PEERS` and `ROVER_PEER_COUNT` for best field reliability
// - keep base and rover on the same fixed ESP-NOW Wi-Fi channel
// - this sketch does not configure the UM980; it assumes the base receiver is
//   already provisioned and streaming the required RTCM output

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <HardwareSerial.h>

static const bool DEBUG_OUTPUT = false;
static const uint32_t STATUS_PRINT_INTERVAL_MILLIS = 1000;
static const uint8_t UM980_RX_PIN = 16;
static const uint8_t UM980_TX_PIN = 17;
static const uint32_t UM980_UART_BAUD = 115200;
static const size_t RTCM_BUFFER_SIZE = 4096;
static const uint8_t RTCM_PREAMBLE = 0xD3;
static const uint8_t RTCM_TRANSPORT_MAGIC_0 = 0x52;
static const uint8_t RTCM_TRANSPORT_MAGIC_1 = 0x54;
static const uint8_t RTCM_TRANSPORT_VERSION = 0x01;
static const uint8_t RTCM_TRANSPORT_MESSAGE_RTCM_FRAGMENT = 0x01;
static const uint8_t RTCM_WIFI_CHANNEL = 1;
static const uint8_t ESPNOW_MAX_PACKET_SIZE = 250;
static const uint8_t RTCM_TRANSPORT_HEADER_SIZE = 15;
static const uint8_t RTCM_MAX_FRAGMENT_PAYLOAD = ESPNOW_MAX_PACKET_SIZE - RTCM_TRANSPORT_HEADER_SIZE;
static const uint8_t ESPNOW_MAX_SEND_RETRIES = 4;
static const uint32_t ESPNOW_SEND_TIMEOUT_MILLIS = 15;
static const bool ENABLE_BROADCAST_FALLBACK = true;
static const size_t ROVER_PEER_COUNT = 0;
static const uint8_t ROVER_PEERS[1][6] = {
  { 0, 0, 0, 0, 0, 0 }
};
static const uint8_t BROADCAST_PEER_ADDRESS[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

HardwareSerial UM980(2);

static bool g_inRtcmMessage = false;
static uint8_t g_rtcmBuffer[RTCM_BUFFER_SIZE];
static uint16_t g_rtcmLength = 0;
static uint16_t g_rtcmExpectedPayloadLength = 0;
static uint16_t g_nextMessageId = 1;
static volatile bool g_sendPending = false;
static volatile esp_now_send_status_t g_lastSendStatus = ESP_NOW_SEND_FAIL;
static uint32_t g_totalRtcmMessagesRead = 0;
static uint32_t g_totalRtcmMessagesSent = 0;
static uint32_t g_totalRtcmMessagesDropped = 0;
static uint32_t g_totalRtcmMessagesRejected = 0;
static uint32_t g_totalRtcmFragmentsSent = 0;
static uint32_t g_totalEspNowRetries = 0;
static uint32_t g_totalEspNowFailures = 0;
static uint32_t g_lastStatusPrintMillis = 0;

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

void writeU16LE(uint8_t *bytes, uint16_t value) {
  bytes[0] = static_cast<uint8_t>(value & 0xFF);
  bytes[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

void writeU24LE(uint8_t *bytes, uint32_t value) {
  bytes[0] = static_cast<uint8_t>(value & 0xFF);
  bytes[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
  bytes[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
}

void printMac(const uint8_t *address) {
  for (uint8_t index = 0; index < 6; index += 1) {
    if (index > 0) {
      Serial.print(":");
    }
    if (address[index] < 0x10) {
      Serial.print("0");
    }
    Serial.print(address[index], HEX);
  }
}

void resetRtcmParser() {
  g_inRtcmMessage = false;
  g_rtcmLength = 0;
  g_rtcmExpectedPayloadLength = 0;
}

bool validateRtcmMessage(const uint8_t *message, uint16_t length) {
  if (length < 6 || message[0] != RTCM_PREAMBLE) {
    return false;
  }
  const uint16_t payloadLength = static_cast<uint16_t>(((message[1] & 0x03) << 8) | message[2]);
  if ((payloadLength + 6) != length) {
    return false;
  }
  const uint32_t expectedCrc =
    (static_cast<uint32_t>(message[length - 3]) << 16)
    | (static_cast<uint32_t>(message[length - 2]) << 8)
    | static_cast<uint32_t>(message[length - 1]);
  const uint32_t actualCrc = crc24q(message, length - 3);
  return actualCrc == expectedCrc;
}

void onDataSent(const wifi_tx_info_t *txInfo, esp_now_send_status_t status) {
  (void)txInfo;
  g_lastSendStatus = status;
  g_sendPending = false;
}

bool isBroadcastPeerAddress(const uint8_t *peerAddress) {
  return memcmp(peerAddress, BROADCAST_PEER_ADDRESS, 6) == 0;
}

bool waitForSendCompletion(uint32_t timeoutMillis) {
  const uint32_t startMillis = millis();
  while (g_sendPending && (millis() - startMillis) < timeoutMillis) {
    delay(0);
  }
  return !g_sendPending;
}

bool sendPacketToPeer(const uint8_t *peerAddress, const uint8_t *packet, uint8_t length) {
  for (uint8_t attempt = 0; attempt < ESPNOW_MAX_SEND_RETRIES; attempt += 1) {
    if (!waitForSendCompletion(ESPNOW_SEND_TIMEOUT_MILLIS)) {
      g_sendPending = false;
    }

    g_sendPending = true;
    esp_err_t result = esp_now_send(peerAddress, packet, length);
    if (result == ESP_ERR_ESPNOW_NO_MEM) {
      g_sendPending = false;
      g_totalEspNowRetries += 1;
      delay(1);
      continue;
    }
    if (result != ESP_OK) {
      g_sendPending = false;
      g_totalEspNowRetries += 1;
      delay(1);
      continue;
    }

    if (!waitForSendCompletion(ESPNOW_SEND_TIMEOUT_MILLIS)) {
      g_totalEspNowRetries += 1;
      g_sendPending = false;
      delay(1);
      continue;
    }

    if (g_lastSendStatus == ESP_NOW_SEND_SUCCESS || isBroadcastPeerAddress(peerAddress)) {
      return true;
    }

    g_totalEspNowRetries += 1;
    delay(1);
  }

  g_totalEspNowFailures += 1;
  return false;
}

bool sendPacketToConfiguredPeers(const uint8_t *packet, uint8_t length) {
  bool overallSuccess = true;
  if (ROVER_PEER_COUNT > 0) {
    for (size_t peerIndex = 0; peerIndex < ROVER_PEER_COUNT; peerIndex += 1) {
      if (!sendPacketToPeer(ROVER_PEERS[peerIndex], packet, length)) {
        overallSuccess = false;
      }
    }
    return overallSuccess;
  }

  if (ENABLE_BROADCAST_FALLBACK) {
    return sendPacketToPeer(BROADCAST_PEER_ADDRESS, packet, length);
  }

  return false;
}

bool sendRtcmMessage(const uint8_t *message, uint16_t length) {
  if (length < 6 || length > RTCM_BUFFER_SIZE) {
    return false;
  }

  const uint8_t fragmentCount = static_cast<uint8_t>((length + RTCM_MAX_FRAGMENT_PAYLOAD - 1) / RTCM_MAX_FRAGMENT_PAYLOAD);
  const uint16_t messageId = g_nextMessageId++;
  const uint32_t payloadCrc = crc24q(message, length - 3);
  uint16_t offset = 0;

  for (uint8_t fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const uint8_t fragmentPayloadLength = static_cast<uint8_t>(min(static_cast<uint16_t>(RTCM_MAX_FRAGMENT_PAYLOAD), static_cast<uint16_t>(length - offset)));
    uint8_t packet[ESPNOW_MAX_PACKET_SIZE];
    packet[0] = RTCM_TRANSPORT_MAGIC_0;
    packet[1] = RTCM_TRANSPORT_MAGIC_1;
    packet[2] = RTCM_TRANSPORT_VERSION;
    packet[3] = RTCM_TRANSPORT_MESSAGE_RTCM_FRAGMENT;
    packet[4] = 0;
    writeU16LE(&packet[5], messageId);
    packet[7] = fragmentIndex;
    packet[8] = fragmentCount;
    packet[9] = fragmentPayloadLength;
    writeU16LE(&packet[10], length);
    writeU24LE(&packet[12], payloadCrc);
    memcpy(&packet[RTCM_TRANSPORT_HEADER_SIZE], message + offset, fragmentPayloadLength);

    if (!sendPacketToConfiguredPeers(packet, static_cast<uint8_t>(RTCM_TRANSPORT_HEADER_SIZE + fragmentPayloadLength))) {
      return false;
    }

    offset = static_cast<uint16_t>(offset + fragmentPayloadLength);
    g_totalRtcmFragmentsSent += 1;
  }

  return true;
}

void maybePrintStatus() {
  const uint32_t nowMillis = millis();
  if ((nowMillis - g_lastStatusPrintMillis) < STATUS_PRINT_INTERVAL_MILLIS) {
    return;
  }
  g_lastStatusPrintMillis = nowMillis;
  Serial.print("[RTCM-BASE] messages=");
  Serial.print(g_totalRtcmMessagesRead);
  Serial.print(" sent=");
  Serial.print(g_totalRtcmMessagesSent);
  Serial.print(" dropped=");
  Serial.print(g_totalRtcmMessagesDropped);
  Serial.print(" rejected=");
  Serial.print(g_totalRtcmMessagesRejected);
  Serial.print(" fragments=");
  Serial.print(g_totalRtcmFragmentsSent);
  Serial.print(" retries=");
  Serial.print(g_totalEspNowRetries);
  Serial.print(" failures=");
  Serial.println(g_totalEspNowFailures);
}

void processRtcmByte(uint8_t value) {
  if (!g_inRtcmMessage) {
    if (value == RTCM_PREAMBLE) {
      g_inRtcmMessage = true;
      g_rtcmBuffer[0] = value;
      g_rtcmLength = 1;
      g_rtcmExpectedPayloadLength = 0;
    }
    return;
  }

  if (g_rtcmLength >= RTCM_BUFFER_SIZE) {
    g_totalRtcmMessagesDropped += 1;
    resetRtcmParser();
    return;
  }

  g_rtcmBuffer[g_rtcmLength++] = value;

  if (g_rtcmLength == 3) {
    g_rtcmExpectedPayloadLength = static_cast<uint16_t>(((g_rtcmBuffer[1] & 0x03) << 8) | g_rtcmBuffer[2]);
    if ((g_rtcmExpectedPayloadLength + 6) > RTCM_BUFFER_SIZE) {
      g_totalRtcmMessagesDropped += 1;
      resetRtcmParser();
      return;
    }
  }

  if (g_rtcmLength < 3) {
    return;
  }

  const uint16_t totalLength = static_cast<uint16_t>(g_rtcmExpectedPayloadLength + 6);
  if (g_rtcmLength < totalLength) {
    return;
  }

  g_totalRtcmMessagesRead += 1;
  if (!validateRtcmMessage(g_rtcmBuffer, totalLength)) {
    g_totalRtcmMessagesRejected += 1;
    resetRtcmParser();
    return;
  }

  if (sendRtcmMessage(g_rtcmBuffer, totalLength)) {
    g_totalRtcmMessagesSent += 1;
  } else {
    g_totalRtcmMessagesDropped += 1;
  }

  resetRtcmParser();
}

void setupEspNow() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(RTCM_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);

  uint8_t stationMac[6];
  if (esp_wifi_get_mac(WIFI_IF_STA, stationMac) == ESP_OK) {
    Serial.print("[RTCM-BASE] station MAC=");
    printMac(stationMac);
    Serial.println();
  } else {
    Serial.println("[RTCM-BASE] failed to read station MAC");
  }

  if (esp_now_init() != ESP_OK) {
    return;
  }

  esp_now_register_send_cb(onDataSent);

  for (size_t peerIndex = 0; peerIndex < ROVER_PEER_COUNT; peerIndex += 1) {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, ROVER_PEERS[peerIndex], 6);
    peerInfo.channel = RTCM_WIFI_CHANNEL;
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }

  if (ENABLE_BROADCAST_FALLBACK) {
    esp_now_peer_info_t broadcastPeer = {};
    memcpy(broadcastPeer.peer_addr, BROADCAST_PEER_ADDRESS, 6);
    broadcastPeer.channel = RTCM_WIFI_CHANNEL;
    broadcastPeer.encrypt = false;
    esp_now_add_peer(&broadcastPeer);
  }
}

void setup() {
  Serial.begin(115200);
  UM980.setRxBufferSize(RTCM_BUFFER_SIZE);
  UM980.begin(UM980_UART_BAUD, SERIAL_8N1, UM980_RX_PIN, UM980_TX_PIN);
  setupEspNow();
}

void loop() {
  while (UM980.available() > 0) {
    processRtcmByte(static_cast<uint8_t>(UM980.read()));
  }

  if (DEBUG_OUTPUT) {
    maybePrintStatus();
  }
}
