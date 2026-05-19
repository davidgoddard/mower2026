export interface ImuSample {
  timestampMillis: number;
  angularVelocity: {
    zDegreesPerSecond: number;
  };
  acceleration?: {
    xMetersPerSecondSquared: number;
    yMetersPerSecondSquared: number;
    zMetersPerSecondSquared: number;
  };
}

export interface ImuSensor {
  initialise(): Promise<void>;
  calibrateGyro(sampleCount?: number): Promise<void>;
  read(): Promise<ImuSample>;
  close(): Promise<void>;
}
