export const BMI160 = {
  defaultAddress: 0x69,
  expectedChipId: 0xd1,
  registers: {
    chipId: 0x00,
    gyroZLsb: 0x10,
    gyroRange: 0x43,
    command: 0x7e,
  },
  commands: {
    gyroNormalMode: 0x15,
  },
  gyroLsbPerDpsAt2000: 16.4,
} as const;
