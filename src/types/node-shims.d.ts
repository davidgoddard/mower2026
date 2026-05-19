declare module "node:fs" {
  export const createWriteStream: any;
}

declare module "node:fs/promises" {
  export const mkdir: any;
  export const readdir: any;
  export const rm: any;
}

declare module "node:path" {
  const path: any;
  export default path;
  export const join: (...parts: string[]) => string;
  export const resolve: (...parts: string[]) => string;
  export const dirname: (value: string) => string;
}

declare module "node:http" {
  export const createServer: any;
}

declare module "node:events" {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
    removeAllListeners(): void;
  }
}

declare module "node:module" {
  export const createRequire: (filename: string) => any;
}

declare module "node:url" {
  export const fileURLToPath: (url: string) => string;
}

declare module "node:buffer" {
  export const Buffer: any;
}

declare module "i2c-bus" {
  const i2c: any;
  export default i2c;
}

declare module "node-hid" {
  const hid: any;
  export default hid;
}

declare module "node:worker_threads" {
  export const Worker: any;
  export const parentPort: any;
  export const workerData: any;
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  cwd: () => string;
  on: (event: string, handler: () => void) => void;
  exit: (code?: number) => never;
};
