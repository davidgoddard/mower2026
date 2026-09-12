#include "Arduino.h"
#include <cerrno>
#include <climits>
namespace base {
#include "../../external-hardware/esp32/gnss-base-station/gnss-base-station.ino"
}
namespace rover {
#include "../../external-hardware/esp32/gnss-mower/gnss-mower.ino"
}

std::vector<uint8_t> correction(size_t payloadLength = 1023) {
  std::vector<uint8_t> bytes(payloadLength + 6, 0x11);
  bytes[0] = 0xD3; bytes[1] = payloadLength >> 8; bytes[2] = payloadLength;
  const uint32_t crc = base::crc24q(bytes.data(), bytes.size() - 3);
  bytes[bytes.size()-3] = crc >> 16; bytes[bytes.size()-2] = crc >> 8; bytes.back() = crc;
  return bytes;
}
void feedBase(const std::vector<uint8_t> &bytes) {
  for (uint8_t byte : bytes) base::processRtcmByte(byte);
}
void receive(const std::vector<uint8_t> &packet, bool relay = false) {
  esp_now_recv_info_t info{};
  memcpy(info.src_addr, relay ? rover::GNSS_RELAY_MAC : rover::BASE_STATION_MAC, 6);
  rover::onEspNowDataReceived(&info, packet.data(), packet.size());
  rover::processPendingEspNowPackets();
}
void resetBase() {
  base::g_txCount = base::g_txHead = 0;
  base::g_fragmentIndex = base::g_broadcastPass = base::g_sendAttempts = 0;
  base::g_sendPending = false;
  base::g_sendResult = -1;
  base::g_nextSendMillis = 0;
  base::g_espNowReady = true;
  base::resetRtcmParser();
  radioPackets.clear(); radioResult = ESP_OK;
}
void request(uint8_t type, uint16_t sequence) {
  uint8_t bytes[127];
  const size_t n = rover::encodeFrame(type, 0, sequence, nullptr, 0, bytes);
  Wire.rx.assign(bytes, bytes+n);
  rover::onReceive(n);
  uint8_t decodedType; uint16_t decodedSequence, payloadLength; const uint8_t *payload;
  assert(rover::decodeFrame(Wire.tx.data(), Wire.tx.size(), decodedType, decodedSequence, payload, payloadLength));
  assert(decodedType == type && decodedSequence == sequence);
}
// Independent bit-at-a-time implementation to sign synthetic receiver fixtures.
std::string receiverLine(const std::string &text) {
  uint32_t crc = 0;
  for (unsigned char c : text) for (unsigned bit = 0; bit < 8; ++bit) {
    bool low = (crc ^ (c >> bit)) & 1;
    crc >>= 1;
    if (low) crc ^= 0xEDB88320;
  }
  char suffix[10]; snprintf(suffix, sizeof(suffix), "*%08x", crc);
  return "#" + text + suffix;
}
std::string pvt(const char *latitude = "51.0", const char *heading = "90.0") {
  return receiverLine(std::string("PVTSLNA,97,GPS,FINE,2190,364536000,0,0,18,13;RTKFIXED,10,")
    + latitude + ",-1,0,0.02,0.03,0,SINGLE,0,0,0,0,20,20,0,0,0,0,0,NARROW_INT,0.3,"
    + heading + ",0,0,0,0,0,1,1,1,1,1,0");
}
int main() {
  // End-to-end max-size RTCM, out-of-order fragments, missing direct packet
  // recovered by relay, and the second broadcast suppressed at UART.
  resetBase();
  const auto message = correction();
  feedBase(message);
  assert(base::g_txCount == 1);
  while (base::g_txCount) {
    base::serviceRadio();
    if (base::g_sendPending) base::onDataSent(nullptr, ESP_NOW_SEND_SUCCESS);
    clockMillis += 12;
  }
  assert(radioPackets.size() == 10);
  for (size_t i = 0; i < 5; ++i) assert(radioPackets[i] == radioPackets[i+5]);
  for (int i = 4; i >= 0; --i) receive(radioPackets[i], i == 2);
  assert(rover::UM982.tx == message);
  for (size_t i = 5; i < 10; ++i) receive(radioPackets[i], true);
  assert(rover::UM982.tx == message);
  puts("PASS broadcast/relay reassembly, repeats and deduplication");

  // No second send is issued after 15 ms; the late callback belongs to the
  // same fragment. Ingress still runs while that callback is pending.
  resetBase(); feedBase(message); base::serviceRadio();
  clockMillis += 30; feedBase(correction(20)); base::serviceRadio();
  assert(radioPackets.size() == 1 && base::g_txCount == 2);
  base::onDataSent(nullptr, ESP_NOW_SEND_SUCCESS); base::serviceRadio();
  assert(radioPackets.size() == 2 && radioPackets.back()[7] == 1);
  clockMillis += 1001; base::serviceRadio();
  assert(ESP.restarts == 1 && !base::g_espNowReady);
  assert(radioPackets.size() == 2);
  puts("PASS delayed/missing callbacks do not overlap sends");

  resetBase();
  for (int i = 0; i < 9; ++i) feedBase(message);
  assert(base::g_txCount == 8);
  clockMillis += 501; base::serviceRadio();
  assert(base::g_txCount == 0);
  resetBase(); feedBase(message); radioResult = ESP_ERR_ESPNOW_NO_MEM;
  for (int i = 0; i < 5; ++i) { base::serviceRadio(); clockMillis += 5; }
  assert(base::g_txCount == 0 && !base::g_sendPending);
  radioResult = ESP_OK;
  puts("PASS bounded queue, expired corrections and immediate-send failures");

  resetBase(); auto damaged = correction(20); damaged.back() ^= 1;
  feedBase(damaged); feedBase(message);
  assert(base::g_txCount == 1);
  puts("PASS base CRC rejection and stream resynchronization");

  // Failed UART admission is not remembered as successful delivery.
  rover::UM982.room = 0;
  assert(!rover::handleCompleteRtcmMessage(message.data(), message.size()));
  assert(rover::g_rtcmUartDrops == 1);
  rover::UM982.room = 4096;

  // Published Unicore N4 manual fixture establishes the real CRC convention.
  const char *manual = "#UNIHEADINGA,97,GPS,FINE,2190,365174000,0,0,18,12;INSUFFICIENT_OBS,NONE,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,\"\",0,0,0,0,0,00,0,0*ee072604";
  assert(rover::validReceiverChecksum(manual));
  auto line = pvt(); assert(rover::validReceiverChecksum(line.c_str()));
  rover::handleUm982Line(line.c_str()); assert(rover::g_latestPvtsln.valid);
  const auto count = rover::g_totalPvtslnaCount;
  auto corrupt = line; corrupt[corrupt.find("51.0")] = '6';
  rover::handleUm982Line(corrupt.c_str());
  rover::handleUm982Line("#PVTSLNA,broken;RTKFIXED");
  assert(rover::g_totalPvtslnaCount == count && rover::g_receiverChecksumErrors == 2);
  clockMillis += 10;
  auto nan = pvt("nan"); rover::handleUm982Line(nan.c_str());
  assert(rover::g_latestPvtsln.localMillis != millis());
  auto badHeading = pvt("51", "inf"); rover::handleUm982Line(badHeading.c_str());
  assert(!rover::g_latestPvtsln.headingValid);
  puts("PASS receiver checksums and finite/range validation");

  std::string overflow(1100, 'x'); overflow += line + "\n";
  rover::UM982.rx.assign(overflow.begin(), overflow.end()); rover::readUm982Lines();
  assert(rover::g_receiverLineOverflows == 1);
  const auto afterOverflow = rover::g_totalPvtslnaCount;
  line += "\n"; rover::UM982.rx.assign(line.begin(), line.end()); rover::readUm982Lines();
  assert(rover::g_totalPvtslnaCount == afterOverflow + 1);
  puts("PASS oversized lines discard through newline and then recover");

  rover::g_originSource = rover::ORIGIN_RTCM1006;
  rover::g_originLatitudeDegrees = 51; rover::g_originLongitudeDegrees = -1;
  auto heading = receiverLine("UNIHEADINGA,97,GPS,FINE,2190,365174000,0,0,18,12;SOL_COMPUTED,NARROW_INT,0.3,90,0,0,0.2,0.2,\"\",20,20,20,20,0,00,0,0");
  rover::handleUm982Line(heading.c_str());
  auto time = receiverLine("RECTIMEA,97,GPS,FINE,2190,365121000,0,0,18,12;VALID,0,0,-18,2026,9,12,5,25,3000,VALID");
  rover::handleUm982Line(time.c_str());
  rover::handleUm982Line(pvt().c_str());
  rover::refreshPayloadSnapshots();
  clockMillis += 50; request(rover::MESSAGE_TYPE_GNSS_SAMPLE, 7);
  assert(Wire.tx.size() == 51 && rover::readU16LE(&Wire.tx[9+30]) == 50);
  assert(Wire.tx[9+34] == 7);
  request(rover::MESSAGE_TYPE_GNSS_DEBUG_LINE, 8); assert(Wire.tx.size() == 127);
  request(rover::MESSAGE_TYPE_GNSS_SAMPLE, 9); assert(Wire.tx.size() == 51);
  clockMillis += 251; request(rover::MESSAGE_TYPE_GNSS_SAMPLE, 10);
  assert(rover::readU16LE(&Wire.tx[9+30]) == 0xFFFF && Wire.tx[9+32] == 0 && Wire.tx[9+34] == 0);
  clockMillis += 2000;
  rover::handleUm982Line(pvt().c_str()); rover::refreshPayloadSnapshots();
  request(rover::MESSAGE_TYPE_GNSS_SAMPLE, 11);
  assert(Wire.tx[9+34] == 0 && rover::readU16LE(&Wire.tx[9+28]) == 0xFFFF);
  Wire.shortWrite = true; request(rover::MESSAGE_TYPE_GNSS_SAMPLE, 12);
  assert(rover::g_i2cWriteErrors == 1); Wire.shortWrite = false;
  puts("PASS I2C preload, alternating frames, age advancement and independent validity expiry");

  auto invalidTime = receiverLine("RECTIMEA,97,GPS,FINE,2190,365121000,0,0,18,12;VALID,0,0,-18,2026,2,30,5,25,3000,VALID");
  rover::handleUm982Line(invalidTime.c_str()); assert(!rover::g_latestRectime.utcValid);
  puts("PASS invalid dates clear earlier UTC");
}
