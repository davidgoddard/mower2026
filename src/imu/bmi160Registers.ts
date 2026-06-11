export const BMI160 = {
  expectedChipId: 0xd1,
  registers: {
    chipId: 0x00,
    // Burst reads start at gyroXLsb / accXLsb and walk forward, so the
    // intermediate Y/Z LSB registers are not exposed here.
    gyroXLsb: 0x0c,
    accXLsb: 0x12,
    accRange: 0x41,
    gyroRange: 0x43,
    command: 0x7e,
  },
  commands: {
    accNormalMode: 0x11,
    gyroNormalMode: 0x15,
  },
  accLsbPerGAt2g: 16384,
  gyroLsbPerDpsAt2000: 16.4,
} as const;
