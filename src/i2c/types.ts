export interface I2cTransport {
  write(address: number, payload: Uint8Array): Promise<void>;
  read(address: number, length: number): Promise<Uint8Array>;
  writeRead(address: number, writePayload: Uint8Array, responseLength: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface QueuedI2cReadRequest {
  key: string;
  priority: number;
  address: number;
  requestPayload: Uint8Array;
  responseLength: number;
}

export interface QueuedI2cWriteRequest {
  key: string;
  priority: number;
  address: number;
  payload: Uint8Array;
}
