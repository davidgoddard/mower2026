export interface ImuSample {
  timestampMillis: number;
  angularVelocity: {
    zDegreesPerSecond: number;
  };
}

export interface ImuSensor {
  initialise(): Promise<void>;
  calibrateGyro(sampleCount?: number): Promise<void>;
  read(): Promise<ImuSample>;
  close(): Promise<void>;
}
