import type { BusAdapter } from "./busAdapter.js";

export interface I2cPort {
  write(address: number, payload: Uint8Array): Promise<void>;
  transfer(address: number, payload: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class I2cBusAdapter implements BusAdapter {
  public constructor(private readonly port: I2cPort) {}

  public async send(nodeId: number, payload: Uint8Array): Promise<void> {
    await this.port.write(nodeId, payload);
  }

  public async request(nodeId: number, payload: Uint8Array): Promise<Uint8Array> {
    return await this.port.transfer(nodeId, payload);
  }

  public async close(): Promise<void> {
    await this.port.close();
  }
}
