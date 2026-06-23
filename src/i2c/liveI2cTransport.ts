import { I2cTransport } from "./types.js";
import { Buffer } from "node:buffer";

interface PromisifiedI2cBus {
  i2cWrite(address: number, length: number, buffer: any): Promise<{ bytesWritten: number }>;
  i2cRead(address: number, length: number, buffer: any): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

interface LiveI2cTransportOptions {
  readonly maxRetries?: number;
  readonly openBus?: (busNumber: number) => Promise<PromisifiedI2cBus>;
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
  private readonly busNumber: number;
  private readonly maxRetries: number;
  private readonly openBus: (busNumber: number) => Promise<PromisifiedI2cBus>;
  private bus: PromisifiedI2cBus;

  private constructor(
    busNumber: number,
    bus: PromisifiedI2cBus,
    options: Required<LiveI2cTransportOptions>,
  ) {
    this.busNumber = busNumber;
    this.bus = bus;
    this.maxRetries = Math.max(0, options.maxRetries);
    this.openBus = options.openBus;
  }

  static async create(busNumber: number, options: LiveI2cTransportOptions = {}): Promise<LiveI2cTransport> {
    const resolvedOptions: Required<LiveI2cTransportOptions> = {
      maxRetries: options.maxRetries ?? 1,
      openBus: options.openBus ?? openPromisifiedI2cBus,
    };
    const bus = await resolvedOptions.openBus(busNumber);
    return new LiveI2cTransport(busNumber, bus, resolvedOptions);
  }

  async write(address: number, payload: Uint8Array): Promise<void> {
    await this.performWithRecovery(() => this.writeOnce(address, payload));
  }

  async read(address: number, length: number): Promise<Uint8Array> {
    return this.performWithRecovery(() => this.readOnce(address, length));
  }

  async writeRead(address: number, writePayload: Uint8Array, responseLength: number): Promise<Uint8Array> {
    return this.performWithRecovery(async () => {
      if (writePayload.length > 0) {
        await this.writeOnce(address, writePayload);
      }
      return this.readOnce(address, responseLength);
    });
  }

  async close(): Promise<void> {
    await this.bus.close();
  }

  private async performWithRecovery<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries || !isRecoverableI2cError(error)) {
          throw error;
        }
        await this.reopenBus();
        attempt += 1;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async reopenBus(): Promise<void> {
    try {
      await this.bus.close();
    } catch {
      // Best effort; if the handle is already broken we still want to reopen.
    }
    this.bus = await this.openBus(this.busNumber);
  }

  private async writeOnce(address: number, payload: Uint8Array): Promise<void> {
    const writeBuffer = Buffer.from(payload);
    const result = await this.bus.i2cWrite(address, writeBuffer.length, writeBuffer);
    if (result.bytesWritten !== payload.length) {
      throw new Error(`short i2c write ${result.bytesWritten}/${payload.length}`);
    }
  }

  private async readOnce(address: number, length: number): Promise<Uint8Array> {
    const readBuffer = Buffer.alloc(length);
    const result = await this.bus.i2cRead(address, length, readBuffer);
    if (result.bytesRead !== length) {
      throw new Error(`short i2c read ${result.bytesRead}/${length}`);
    }
    return Uint8Array.from(readBuffer);
  }
}

async function openPromisifiedI2cBus(busNumber: number): Promise<PromisifiedI2cBus> {
  let moduleExports: any;
  try {
    moduleExports = await import("i2c-bus");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load i2c-bus. Install runtime dependency first. Cause: ${message}`);
  }

  const i2c = resolveI2cModule(moduleExports);
  return i2c.openPromisified(busNumber) as Promise<PromisifiedI2cBus>;
}

function isRecoverableI2cError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(EIO|EREMOTEIO|ENXIO|EBUSY|ETIMEDOUT)\b/i.test(message)
    || /short i2c (read|write)/i.test(message)
    || /i\/o error/i.test(message);
}
