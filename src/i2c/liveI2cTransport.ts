import { I2cTransport } from "./types.js";
import { Buffer } from "node:buffer";

interface PromisifiedI2cBus {
  i2cWrite(address: number, length: number, buffer: any): Promise<{ bytesWritten: number }>;
  i2cRead(address: number, length: number, buffer: any): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

function resolveI2cModule(moduleExports: any): any {
  if (moduleExports?.default?.openPromisified) {
    return moduleExports.default;
  }

  if (moduleExports?.openPromisified) {
    return moduleExports;
  }

  throw new Error("i2c-bus module loaded but does not expose openPromisified");
}

export class LiveI2cTransport implements I2cTransport {
  private readonly bus: PromisifiedI2cBus;

  private constructor(bus: PromisifiedI2cBus) {
    this.bus = bus;
  }

  static async create(busNumber: number): Promise<LiveI2cTransport> {
    let moduleExports: any;
    try {
      moduleExports = await import("i2c-bus");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load i2c-bus. Install runtime dependency first. Cause: ${message}`);
    }

    const i2c = resolveI2cModule(moduleExports);
    const bus = await i2c.openPromisified(busNumber);
    return new LiveI2cTransport(bus as PromisifiedI2cBus);
  }

  async write(address: number, payload: Uint8Array): Promise<void> {
    const writeBuffer = Buffer.from(payload);
    const result = await this.bus.i2cWrite(address, writeBuffer.length, writeBuffer);
    if (result.bytesWritten !== payload.length) {
      throw new Error(`short i2c write ${result.bytesWritten}/${payload.length}`);
    }
  }

  async read(address: number, length: number): Promise<Uint8Array> {
    const readBuffer = Buffer.alloc(length);
    const result = await this.bus.i2cRead(address, length, readBuffer);
    if (result.bytesRead !== length) {
      throw new Error(`short i2c read ${result.bytesRead}/${length}`);
    }
    return Uint8Array.from(readBuffer);
  }

  async writeRead(address: number, writePayload: Uint8Array, responseLength: number): Promise<Uint8Array> {
    if (writePayload.length > 0) {
      await this.write(address, writePayload);
    }

    return this.read(address, responseLength);
  }

  async close(): Promise<void> {
    await this.bus.close();
  }
}
