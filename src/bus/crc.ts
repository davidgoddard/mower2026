const CRC16_CCITT_INITIAL = 0xffff;
const CRC16_CCITT_POLYNOMIAL = 0x1021;

export function crc16Ccitt(data: Uint8Array): number {
  let crc = CRC16_CCITT_INITIAL;

  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0
        ? ((crc << 1) ^ CRC16_CCITT_POLYNOMIAL) & 0xffff
        : (crc << 1) & 0xffff;
    }
  }

  return crc;
}
