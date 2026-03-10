export const enum GnssFaultFlag {
  StaleSample = 1 << 0,
  InvalidFix = 1 << 1,
  HeadingUnavailable = 1 << 2,
  ReceiverWarning = 1 << 3,
}

export const enum MotorFaultFlag {
  WatchdogExpired = 1 << 0,
  LeftEncoderFault = 1 << 1,
  RightEncoderFault = 1 << 2,
  LeftDriverFault = 1 << 3,
  RightDriverFault = 1 << 4,
  OverCurrent = 1 << 5,
}
