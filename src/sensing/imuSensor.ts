export interface AngularVelocitySample {
  readonly xDegreesPerSecond: number;
  readonly yDegreesPerSecond: number;
  readonly zDegreesPerSecond: number;
}

export interface AccelerationSample {
  readonly xMetersPerSecondSquared: number;
  readonly yMetersPerSecondSquared: number;
  readonly zMetersPerSecondSquared: number;
}

export interface RawImuSample {
  readonly timestampMillis: number;
  readonly angularVelocity: AngularVelocitySample;
  readonly acceleration: AccelerationSample;
}

export interface ImuSensor {
  read(): Promise<RawImuSample>;
}
