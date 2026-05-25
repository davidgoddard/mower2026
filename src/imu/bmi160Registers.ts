export const BMI160 = {
  defaultAddress: 0x69,
  expectedChipId: 0xd1,
  registers: {
    chipId: 0x00,
    gyroXLsb: 0x0c,
    gyroYLsb: 0x0e,
    accXLsb: 0x12,
    accYLsb: 0x14,
    accZLsb: 0x16,
    gyroZLsb: 0x10,
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
