// ESP-NOW packet relay for mower GNSS RTCM corrections.
//
// Configure BASE_STATION_MAC before flashing. The relay only accepts packets
// from that sender, then forwards each packet unchanged as an ESP-NOW
// broadcast on the same fixed channel. Keeping the packet unchanged preserves
// the base-generated message ID, fragment index, and CRC used by the mower for
// duplicate suppression and reassembly.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

static const uint8_t RTCM_WIFI_CHANNEL = 1;
static const size_t ESPNOW_MAX_PACKET_SIZE = 250;
static const size_t FORWARD_QUEUE_CAPACITY = 32;
static const uint32_t STATUS_PRINT_INTERVAL_MILLIS = 1000;
static const uint8_t FORWARD_LED_PIN = 2;
static const uint32_t FORWARD_LED_PULSE_MILLIS = 40;

// TODO: Replace with the station-mode MAC printed by the base ESP32.
static const uint8_t BASE_STATION_MAC[6] = { 0x68, 0x09, 0x47, 0x9D, 0x30, 0x48 };
static const uint8_t BROADCAST_MAC[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

struct QueuedPacket {
  uint8_t length;
  uint8_t data[ESPNOW_MAX_PACKET_SIZE];
};

static QueuedPacket g_forwardQueue[FORWARD_QUEUE_CAPACITY];
static volatile uint8_t g_queueHead = 0;
static volatile uint8_t g_queueTail = 0;
static volatile bool g_sendPending = false;
static volatile bool g_forwardLedPulsePending = false;
static uint32_t g_forwardLedOffMillis = 0;
static uint32_t g_receivedPackets = 0;
static uint32_t g_forwardedPackets = 0;
static uint32_t g_rejectedSenders = 0;
static uint32_t g_queueDrops = 0;
static uint32_t g_sendFailures = 0;
static uint32_t g_lastStatusPrintMillis = 0;

bool isConfiguredMac(const uint8_t *address) {
  for (uint8_t index = 0; index < 6; index += 1) {
    if (address[index] != 0) {
      return true;
    }
  }
  return false;
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

void onDataSent(const wifi_tx_info_t *txInfo, esp_now_send_status_t status) {
  (void)txInfo;
  if (status != ESP_NOW_SEND_SUCCESS) {
    g_sendFailures += 1;
  } else {
    g_forwardedPackets += 1;
    g_forwardLedPulsePending = true;
  }
  g_sendPending = false;
}

void onDataReceived(const esp_now_recv_info_t *info, const uint8_t *data, int length) {
  if (info == nullptr || data == nullptr || length <= 0 || length > static_cast<int>(ESPNOW_MAX_PACKET_SIZE)) {
    return;
  }
  if (!isConfiguredMac(BASE_STATION_MAC) || memcmp(info->src_addr, BASE_STATION_MAC, 6) != 0) {
    g_rejectedSenders += 1;
    return;
  }

  const uint8_t nextHead = static_cast<uint8_t>((g_queueHead + 1) % FORWARD_QUEUE_CAPACITY);
  if (nextHead == g_queueTail) {
    g_queueDrops += 1;
    return;
  }

  QueuedPacket &packet = g_forwardQueue[g_queueHead];
  packet.length = static_cast<uint8_t>(length);
  memcpy(packet.data, data, static_cast<size_t>(length));
  g_queueHead = nextHead;
  g_receivedPackets += 1;
}

void forwardNextPacket() {
  if (g_sendPending || g_queueTail == g_queueHead) {
    return;
  }

  QueuedPacket &packet = g_forwardQueue[g_queueTail];
  g_sendPending = true;
  const esp_err_t result = esp_now_send(BROADCAST_MAC, packet.data, packet.length);
  if (result != ESP_OK) {
    g_sendPending = false;
    g_sendFailures += 1;
  }
  g_queueTail = static_cast<uint8_t>((g_queueTail + 1) % FORWARD_QUEUE_CAPACITY);
}

void updateForwardLed() {
  const uint32_t nowMillis = millis();
  if (g_forwardLedPulsePending) {
    g_forwardLedPulsePending = false;
    digitalWrite(FORWARD_LED_PIN, HIGH);
    g_forwardLedOffMillis = nowMillis + FORWARD_LED_PULSE_MILLIS;
  }
  if (g_forwardLedOffMillis != 0 && static_cast<int32_t>(nowMillis - g_forwardLedOffMillis) >= 0) {
    digitalWrite(FORWARD_LED_PIN, LOW);
    g_forwardLedOffMillis = 0;
  }
}

void printStatus() {
  const uint32_t nowMillis = millis();
  if ((nowMillis - g_lastStatusPrintMillis) < STATUS_PRINT_INTERVAL_MILLIS) {
    return;
  }
  g_lastStatusPrintMillis = nowMillis;
  Serial.print("[RTCM-RELAY] received=");
  Serial.print(g_receivedPackets);
  Serial.print(" forwarded=");
  Serial.print(g_forwardedPackets);
  Serial.print(" rejectedSenders=");
  Serial.print(g_rejectedSenders);
  Serial.print(" queueDrops=");
  Serial.print(g_queueDrops);
  Serial.print(" sendFailures=");
  Serial.println(g_sendFailures);
}

void setup() {
  pinMode(FORWARD_LED_PIN, OUTPUT);
  digitalWrite(FORWARD_LED_PIN, LOW);
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(RTCM_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);

  Serial.print("[RTCM-RELAY] station MAC=");
  uint8_t relayMac[6];
  esp_wifi_get_mac(WIFI_IF_STA, relayMac);
  printMac(relayMac);
  Serial.println();

  if (!isConfiguredMac(BASE_STATION_MAC)) {
    Serial.println("[RTCM-RELAY] BASE_STATION_MAC is not configured; forwarding disabled");
    return;
  }
  if (esp_now_init() != ESP_OK) {
    Serial.println("[RTCM-RELAY] esp_now_init failed");
    return;
  }

  esp_now_register_recv_cb(onDataReceived);
  esp_now_register_send_cb(onDataSent);

  esp_now_peer_info_t broadcastPeer = {};
  memcpy(broadcastPeer.peer_addr, BROADCAST_MAC, 6);
  broadcastPeer.channel = RTCM_WIFI_CHANNEL;
  broadcastPeer.encrypt = false;
  if (esp_now_add_peer(&broadcastPeer) != ESP_OK) {
    Serial.println("[RTCM-RELAY] failed to add broadcast peer");
  }
}

void loop() {
  forwardNextPacket();
  updateForwardLed();
  printStatus();
  delay(1);
}
