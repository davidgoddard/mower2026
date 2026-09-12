#pragma once
// Deterministic host substitutes for hardware only. Tests include the actual sketches.
#include <algorithm>
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <string>
#include <vector>
using std::min;
using std::max;
using std::isfinite;
#define CONFIG_IDF_TARGET_ESP32 1
#define SERIAL_8N1 0
#define OUTPUT 1
#define LOW 0
#define HIGH 1
#define HEX 16
using portMUX_TYPE = int;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(x) ((void)(x))
#define portEXIT_CRITICAL(x) ((void)(x))
inline uint32_t clockMillis = 100;
inline uint32_t millis() { return clockMillis; }
inline void delay(uint32_t ms) { clockMillis += ms; }
inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
class String {
  std::string value;
public:
  String(const char *s = "") : value(s) {}
  String(const std::string &s) : value(s) {}
  size_t length() const { return value.size(); }
  const char *c_str() const { return value.c_str(); }
  String substring(size_t begin, size_t end) const { return value.substr(begin, end - begin); }
  bool operator==(const String &s) const { return value == s.value; }
  bool operator!=(const String &s) const { return value != s.value; }
};
using hardwareSerial_error_t = int;
struct HardwareSerial {
  std::deque<uint8_t> rx;
  std::vector<uint8_t> tx;
  int room = 4096;
  explicit HardwareSerial(int = 0) {}
  void begin(unsigned long, int = 0, int = 0, int = 0) {}
  size_t setRxBufferSize(size_t n) { return n; }
  size_t setTxBufferSize(size_t n) { return n; }
  void onReceiveError(std::function<void(hardwareSerial_error_t)>) {}
  int available() { return rx.size(); }
  int availableForWrite() { return room; }
  int read() { int b = rx.front(); rx.pop_front(); return b; }
  size_t write(const uint8_t *p, size_t n) {
    assert(n <= static_cast<size_t>(room)); // Detect potentially blocking writes.
    tx.insert(tx.end(), p, p + n); return n;
  }
  template<class... T> void print(T...) {}
  template<class... T> void println(T...) {}
};
inline HardwareSerial Serial;
struct MockEsp { unsigned restarts = 0; void restart() { ++restarts; } };
inline MockEsp ESP;
inline uint32_t esp_random() { return 42; }
inline int esp_reset_reason() { return 1; }
using esp_err_t = int;
constexpr int ESP_OK = 0, ESP_ERR_ESPNOW_NO_MEM = 1;
constexpr int WIFI_STA = 1, WIFI_IF_STA = 0, WIFI_PS_NONE = 0, WIFI_SECOND_CHAN_NONE = 0;
using wifi_second_chan_t = int;
struct MockWiFi { bool mode(int) { return true; } bool setSleep(bool) { return true; } };
inline MockWiFi WiFi;
inline esp_err_t esp_wifi_set_ps(int) { return ESP_OK; }
inline esp_err_t esp_wifi_set_channel(int, int) { return ESP_OK; }
inline esp_err_t esp_wifi_get_channel(uint8_t *p, wifi_second_chan_t *) { *p = 1; return ESP_OK; }
inline esp_err_t esp_wifi_get_mac(int, uint8_t *p) { memset(p, 1, 6); return ESP_OK; }
enum esp_now_send_status_t { ESP_NOW_SEND_SUCCESS = 0, ESP_NOW_SEND_FAIL = 1 };
struct wifi_tx_info_t {};
struct esp_now_recv_info_t { uint8_t src_addr[6]; };
struct esp_now_peer_info_t { uint8_t peer_addr[6]; int channel, ifidx; bool encrypt; };
inline std::vector<std::vector<uint8_t>> radioPackets;
inline esp_err_t radioResult = ESP_OK;
inline esp_err_t esp_now_send(const uint8_t *mac, const uint8_t *p, size_t n) {
  for (int i = 0; i < 6; ++i) assert(mac[i] == 0xFF); // Broadcast only.
  if (radioResult == ESP_OK) radioPackets.emplace_back(p, p + n);
  return radioResult;
}
inline esp_err_t esp_now_init() { return ESP_OK; }
inline esp_err_t esp_now_register_send_cb(void (*)(const wifi_tx_info_t *, esp_now_send_status_t)) { return ESP_OK; }
inline esp_err_t esp_now_register_recv_cb(void (*)(const esp_now_recv_info_t *, const uint8_t *, int)) { return ESP_OK; }
inline esp_err_t esp_now_add_peer(const esp_now_peer_info_t *) { return ESP_OK; }
struct MockWire {
  std::deque<uint8_t> rx;
  std::vector<uint8_t> tx;
  bool shortWrite = false;
  size_t setBufferSize(size_t n) { return n; }
  void setTimeOut(int) {}
  void onReceive(void (*)(int)) {}
  bool begin(uint8_t, uint8_t, uint8_t, uint32_t) { return true; }
  int available() { return rx.size(); }
  int read() { int b = rx.front(); rx.pop_front(); return b; }
  size_t slaveWrite(const uint8_t *p, size_t n) {
    tx.assign(p, p + n); return shortWrite ? n - 1 : n;
  }
};
inline MockWire Wire;
