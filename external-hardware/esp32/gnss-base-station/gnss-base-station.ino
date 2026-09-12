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
// - broadcasts twice with stable fragment identities for direct/relay deduplication
// - pairs with `external-hardware/esp32/gnss-mower/gnss-mower.ino`
//
// Notes:
// - broadcast delivery is not acknowledged by the mower; send counts are local only
// - keep base and rover on the same fixed ESP-NOW Wi-Fi channel
// - this sketch does not configure the UM980; it assumes the base receiver is
//   already provisioned and streaming the required RTCM output

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <HardwareSerial.h>
#include <atomic>

static const bool DEBUG_OUTPUT = true;
static const uint32_t STATUS_PRINT_INTERVAL_MILLIS = 10000;
// Diagnostic probes are consumed only by the configured base/relay receivers.
static const bool ENABLE_LINK_PROBE = true;
static const uint32_t LINK_PROBE_INTERVAL_MILLIS = 1000;
static const uint8_t LINK_PROBE_PAYLOAD[] = { 0x52, 0x50, 0x01, 0x01 }; // "RP", v1, probe
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
// Never abandon an outstanding send and reuse its callback for another packet.
static const uint32_t ESPNOW_CALLBACK_TIMEOUT_MILLIS = 1000;
static const uint16_t RTCM_MAX_MESSAGE_SIZE = 1029;
static const uint8_t RTCM_TX_QUEUE_CAPACITY = 8;
static const uint8_t RTCM_BROADCAST_PASSES = 2;
static const uint32_t RTCM_MAX_QUEUE_AGE_MILLIS = 500;
static const uint32_t RTCM_BYTE_TIMEOUT_MILLIS = 250;
static const uint32_t PACKET_SPACING_MILLIS = 2;
static const uint32_t REPEAT_SPACING_MILLIS = 10;
static const uint8_t BROADCAST_PEER_ADDRESS[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

HardwareSerial UM980(2);

struct PendingRtcmMessage {
  uint8_t data[RTCM_MAX_MESSAGE_SIZE];
  uint16_t length;
  uint16_t id;
  uint32_t crc;
  uint32_t receivedMillis;
};
static PendingRtcmMessage g_txQueue[RTCM_TX_QUEUE_CAPACITY];
static uint8_t g_txHead = 0, g_txCount = 0;
static uint8_t g_fragmentIndex = 0, g_broadcastPass = 0, g_sendAttempts = 0;
static uint8_t g_rtcmBuffer[RTCM_MAX_MESSAGE_SIZE];
static uint16_t g_rtcmLength = 0;
static uint32_t g_lastRtcmByteMillis = 0;
static uint16_t g_nextMessageId = 1;
static bool g_sendPending = false;
static bool g_sendingProbe = false;
static uint32_t g_sendStartedMillis = 0, g_nextSendMillis = 0;
static uint8_t g_sendPacket[ESPNOW_MAX_PACKET_SIZE];
// One callback result, published by Wi-Fi and consumed by the main loop.
static std::atomic<int> g_sendResult{-1};
static std::atomic<uint32_t> g_uartErrors{0};
static uint32_t g_totalEspNowSendCallbacksSucceeded = 0;
static uint32_t g_totalEspNowSendCallbacksFailed = 0;
static uint32_t g_totalRtcmMessagesRead = 0;
static uint32_t g_totalRtcmMessagesSent = 0;
static uint32_t g_totalRtcmMessagesDropped = 0;
static uint32_t g_totalRtcmMessagesRejected = 0;
static uint32_t g_totalRtcmFragmentsSent = 0;
static uint32_t g_totalEspNowRetries = 0;
static uint32_t g_totalEspNowFailures = 0;
static uint32_t g_totalLinkProbesSent = 0;
static uint32_t g_totalLinkProbesDropped = 0;
static uint32_t g_lastStatusPrintMillis = 0;
static uint32_t g_lastLinkProbeMillis = 0;
static bool g_espNowReady = false;

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
  g_rtcmLength = 0;
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
  g_sendResult.store(static_cast<int>(status), std::memory_order_release);
}

void discardTxMessage() {
  g_txHead = static_cast<uint8_t>((g_txHead + 1) % RTCM_TX_QUEUE_CAPACITY);
  g_txCount -= 1;
  g_fragmentIndex = g_broadcastPass = g_sendAttempts = 0;
}

bool queueRtcmMessage(const uint8_t *message, uint16_t length) {
  if (!g_espNowReady || g_txCount == RTCM_TX_QUEUE_CAPACITY) {
    return false;
  }
  PendingRtcmMessage &pending = g_txQueue[(g_txHead + g_txCount) % RTCM_TX_QUEUE_CAPACITY];
  memcpy(pending.data, message, length);
  pending.length = length;
  pending.id = g_nextMessageId++;
  pending.crc = crc24q(message, length - 3);
  pending.receivedMillis = millis();
  g_txCount += 1;
  return true;
}

void serviceRadio() {
  const uint32_t now = millis();
  if (!g_espNowReady) return;
  if (g_sendPending) {
    const int result = g_sendResult.exchange(-1, std::memory_order_acquire);
    if (result < 0) {
      if ((now - g_sendStartedMillis) >= ESPNOW_CALLBACK_TIMEOUT_MILLIS) {
        // A reboot clears driver/callback state together. Never issue a second
        // send while the first can still call back. UART remains serviced until here.
        g_espNowReady = false;
        ESP.restart();
      }
      return;
    }
    g_sendPending = false;
    const bool success = result == ESP_NOW_SEND_SUCCESS;
    if (success) g_totalEspNowSendCallbacksSucceeded += 1;
    else g_totalEspNowSendCallbacksFailed += 1;
    if (g_sendingProbe) {
      if (success) g_totalLinkProbesSent += 1;
      else g_totalLinkProbesDropped += 1;
    } else if (success) {
      g_sendAttempts = 0;
      g_totalRtcmFragmentsSent += 1;
      const uint8_t count = (g_txQueue[g_txHead].length + RTCM_MAX_FRAGMENT_PAYLOAD - 1) / RTCM_MAX_FRAGMENT_PAYLOAD;
      if (++g_fragmentIndex == count) {
        g_fragmentIndex = 0;
        if (++g_broadcastPass == RTCM_BROADCAST_PASSES) {
          g_totalRtcmMessagesSent += 1; // Local transmission, NOT mower delivery.
          discardTxMessage();
        } else {
          g_nextSendMillis = now + REPEAT_SPACING_MILLIS;
        }
      }
    } else {
      g_totalEspNowRetries += 1;
    }
  }
  if (static_cast<int32_t>(now - g_nextSendMillis) < 0) return;
  while (g_txCount > 0) {
    if ((now - g_txQueue[g_txHead].receivedMillis) <= RTCM_MAX_QUEUE_AGE_MILLIS
        && g_sendAttempts < ESPNOW_MAX_SEND_RETRIES) break;
    g_totalRtcmMessagesDropped += 1;
    discardTxMessage();
  }

  uint8_t length = 0;
  g_sendingProbe = g_txCount == 0;
  if (g_sendingProbe) {
    if (!ENABLE_LINK_PROBE || (now - g_lastLinkProbeMillis) < LINK_PROBE_INTERVAL_MILLIS) return;
    g_lastLinkProbeMillis = now;
    length = sizeof(LINK_PROBE_PAYLOAD);
    memcpy(g_sendPacket, LINK_PROBE_PAYLOAD, length);
  } else {
    const PendingRtcmMessage &message = g_txQueue[g_txHead];
    const uint16_t offset = g_fragmentIndex * RTCM_MAX_FRAGMENT_PAYLOAD;
    const uint8_t payloadLength = min(static_cast<uint16_t>(RTCM_MAX_FRAGMENT_PAYLOAD), static_cast<uint16_t>(message.length - offset));
    g_sendPacket[0] = RTCM_TRANSPORT_MAGIC_0;
    g_sendPacket[1] = RTCM_TRANSPORT_MAGIC_1;
    g_sendPacket[2] = RTCM_TRANSPORT_VERSION;
    g_sendPacket[3] = RTCM_TRANSPORT_MESSAGE_RTCM_FRAGMENT;
    g_sendPacket[4] = 0;
    writeU16LE(&g_sendPacket[5], message.id);
    g_sendPacket[7] = g_fragmentIndex;
    g_sendPacket[8] = (message.length + RTCM_MAX_FRAGMENT_PAYLOAD - 1) / RTCM_MAX_FRAGMENT_PAYLOAD;
    g_sendPacket[9] = payloadLength;
    writeU16LE(&g_sendPacket[10], message.length);
    writeU24LE(&g_sendPacket[12], message.crc);
    memcpy(&g_sendPacket[RTCM_TRANSPORT_HEADER_SIZE], message.data + offset, payloadLength);
    length = RTCM_TRANSPORT_HEADER_SIZE + payloadLength;
    g_sendAttempts += 1;
  }
  g_sendResult.store(-1, std::memory_order_release);
  g_sendStartedMillis = now;
  g_sendPending = true;
  g_nextSendMillis = now + PACKET_SPACING_MILLIS;
  if (esp_now_send(BROADCAST_PEER_ADDRESS, g_sendPacket, length) != ESP_OK) {
    // Immediate rejection does not produce a callback.
    g_sendPending = false;
    g_totalEspNowFailures += 1;
    if (g_sendingProbe) g_totalLinkProbesDropped += 1;
    else g_totalEspNowRetries += 1;
  }
}

void maybePrintStatus() {
  if (!DEBUG_OUTPUT || (millis() - g_lastStatusPrintMillis) < STATUS_PRINT_INTERVAL_MILLIS) return;
  g_lastStatusPrintMillis = millis();
  char status[256];
  const int length = snprintf(status, sizeof(status),
    "[RTCM-BASE] read=%lu sentLocal=%lu drop=%lu reject=%lu retry=%lu uartError=%lu queue=%u callbacks=%lu/%lu\n",
    (unsigned long)g_totalRtcmMessagesRead, (unsigned long)g_totalRtcmMessagesSent,
    (unsigned long)g_totalRtcmMessagesDropped, (unsigned long)g_totalRtcmMessagesRejected,
    (unsigned long)g_totalEspNowRetries, (unsigned long)g_uartErrors.load(), g_txCount,
    (unsigned long)g_totalEspNowSendCallbacksSucceeded, (unsigned long)g_totalEspNowSendCallbacksFailed);
  if (length > 0 && length < static_cast<int>(sizeof(status)) && Serial.availableForWrite() >= length)
    Serial.write(reinterpret_cast<const uint8_t *>(status), length);
}

void processRtcmByte(uint8_t value) {
  const uint32_t now = millis();
  if (g_rtcmLength && (now - g_lastRtcmByteMillis) > RTCM_BYTE_TIMEOUT_MILLIS) {
    g_totalRtcmMessagesRejected += 1;
    resetRtcmParser();
  }
  g_lastRtcmByteMillis = now;
  g_rtcmBuffer[g_rtcmLength++] = value;
  while (g_rtcmLength > 0) {
    if (g_rtcmBuffer[0] == RTCM_PREAMBLE) {
      if (g_rtcmLength < 3) return;
      if ((g_rtcmBuffer[1] & 0xFC) == 0) {
        const uint16_t length = 6 + ((g_rtcmBuffer[1] & 3) << 8) + g_rtcmBuffer[2];
        if (g_rtcmLength < length) return;
        g_totalRtcmMessagesRead += 1;
        if (validateRtcmMessage(g_rtcmBuffer, length)) {
          if (!queueRtcmMessage(g_rtcmBuffer, length)) g_totalRtcmMessagesDropped += 1;
          g_rtcmLength -= length;
          memmove(g_rtcmBuffer, g_rtcmBuffer + length, g_rtcmLength);
          continue;
        }
      }
      g_totalRtcmMessagesRejected += 1;
    }
    // Slide to the next candidate instead of throwing away valid frames
    // embedded in a damaged/truncated candidate.
    g_rtcmLength -= 1;
    memmove(g_rtcmBuffer, g_rtcmBuffer + 1, g_rtcmLength);
  }
}

void setupEspNow() {
  const bool stationModeReady = WiFi.mode(WIFI_STA);
  const bool sleepDisabled = WiFi.setSleep(false);
  const esp_err_t powerSaveResult = esp_wifi_set_ps(WIFI_PS_NONE);
  const esp_err_t channelResult = esp_wifi_set_channel(RTCM_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);

  uint8_t primaryChannel = 0;
  wifi_second_chan_t secondaryChannel = WIFI_SECOND_CHAN_NONE;
  const esp_err_t readChannelResult = esp_wifi_get_channel(&primaryChannel, &secondaryChannel);

  Serial.print("[RTCM-BASE] wifi stationMode=");
  Serial.print(stationModeReady ? "ok" : "failed");
  Serial.print(" sleepDisabled=");
  Serial.print(sleepDisabled ? "yes" : "no");
  Serial.print(" powerSaveResult=");
  Serial.print(static_cast<int>(powerSaveResult));
  Serial.print(" channelSetResult=");
  Serial.print(static_cast<int>(channelResult));
  Serial.print(" channelReadResult=");
  Serial.print(static_cast<int>(readChannelResult));
  Serial.print(" actualChannel=");
  Serial.println(primaryChannel);

  uint8_t stationMac[6];
  if (esp_wifi_get_mac(WIFI_IF_STA, stationMac) == ESP_OK) {
    Serial.print("[RTCM-BASE] station MAC=");
    printMac(stationMac);
    Serial.println();
  } else {
    Serial.println("[RTCM-BASE] failed to read station MAC");
  }

  const esp_err_t initResult = esp_now_init();
  Serial.print("[RTCM-BASE] espNowInitResult=");
  Serial.println(static_cast<int>(initResult));
  if (initResult != ESP_OK) {
    return;
  }

  const esp_err_t callbackResult = esp_now_register_send_cb(onDataSent);
  Serial.print("[RTCM-BASE] sendCallbackResult=");
  Serial.println(static_cast<int>(callbackResult));
  if (callbackResult != ESP_OK) {
    return;
  }

  esp_now_peer_info_t broadcastPeer = {};
  memcpy(broadcastPeer.peer_addr, BROADCAST_PEER_ADDRESS, 6);
  broadcastPeer.channel = RTCM_WIFI_CHANNEL;
  broadcastPeer.ifidx = WIFI_IF_STA;
  broadcastPeer.encrypt = false;
  const esp_err_t peerResult = esp_now_add_peer(&broadcastPeer);
  g_espNowReady = peerResult == ESP_OK && stationModeReady && sleepDisabled
    && powerSaveResult == ESP_OK && channelResult == ESP_OK
    && readChannelResult == ESP_OK && primaryChannel == RTCM_WIFI_CHANNEL;
  Serial.print("[RTCM-BASE] espNowReady=");
  Serial.println(g_espNowReady ? "yes" : "no");
}

void setup() {
  Serial.setTxBufferSize(1024);
  Serial.begin(115200);
  if (UM980.setRxBufferSize(RTCM_BUFFER_SIZE) != RTCM_BUFFER_SIZE) {
    Serial.println("[RTCM-BASE] UART buffer allocation failed");
    ESP.restart();
    return;
  }
  UM980.onReceiveError([](hardwareSerial_error_t) { g_uartErrors.fetch_add(1); });
  UM980.begin(UM980_UART_BAUD, SERIAL_8N1, UM980_RX_PIN, UM980_TX_PIN);
  setupEspNow();
}

void loop() {
  static uint32_t observedUartErrors = 0;
  const uint32_t errors = g_uartErrors.load();
  if (errors != observedUartErrors) {
    observedUartErrors = errors;
    resetRtcmParser();
  }
  // Bound each batch so UART and radio both make progress under continuous input.
  for (size_t count = 0; count < 512 && UM980.available() > 0; count += 1)
    processRtcmByte(static_cast<uint8_t>(UM980.read()));
  serviceRadio();
  maybePrintStatus();
  delay(1);
}
