declare class Buffer extends Uint8Array {
  public static alloc(size: number): Buffer;
  public static from(data: readonly number[]): Buffer;
  public copy(
    target: Uint8Array,
    targetStart?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ): number;
}

declare module "i2c-bus" {
  export interface I2cBus {
    readByteSync(address: number, cmd: number): number;
    writeByteSync(address: number, cmd: number, byte: number): void;
    readI2cBlockSync(address: number, cmd: number, length: number, buffer: Buffer): number;
    closeSync?(): void;
  }

  interface I2cModule {
    openSync(busNumber: number): I2cBus;
  }

  const i2c: I2cModule;
  export default i2c;
}

declare module "node:module" {
  export function createRequire(filename: string): (id: string) => unknown;
}
