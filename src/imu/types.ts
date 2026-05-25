export interface ImuSample {
  timestampMillis: number;
  angularVelocity: {
    xDegreesPerSecond: number;
    yDegreesPerSecond: number;
    zDegreesPerSecond: number;
  };
  acceleration?: {
    xMetersPerSecondSquared: number;
    yMetersPerSecondSquared: number;
    zMetersPerSecondSquared: number;
  };
  pitchDeg?: number;
  rollDeg?: number;
}

export interface ImuSensor {
  initialise(): Promise<void>;
  calibrateGyro(sampleCount?: number): Promise<void>;
  read(): Promise<ImuSample>;
  close(): Promise<void>;
}
