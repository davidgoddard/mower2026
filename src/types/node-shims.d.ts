declare module "node:fs" {
  export const createWriteStream: any;
}

declare module "node:fs/promises" {
  export const mkdir: any;
  export const readdir: any;
  export const rm: any;
}

declare module "node:path" {
  export const join: (...parts: string[]) => string;
  export const resolve: (...parts: string[]) => string;
}

declare module "node:http" {
  export const createServer: any;
}

declare module "node:buffer" {
  export const Buffer: any;
}

declare module "i2c-bus" {
  const i2c: any;
  export default i2c;
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
