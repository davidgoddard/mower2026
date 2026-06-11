// `@types/node` provides correct typings for `node:fs`, `node:fs/promises`,
// `node:http`, `node:events`, `node:module`, `node:url`, `node:buffer`, and
// `node:worker_threads`. The shims that previously typed those modules as
// `any` would silently regress callsites that have since been tightened, so
// they are no longer declared here.
//
// `node:path` is shimmed only to keep an existing default-import call site
// working without enabling `esModuleInterop` project-wide. New code should
// prefer named imports (e.g. `import { join } from "node:path"`).

declare module "node:path" {
  const path: any;
  export default path;
  export const join: (...parts: string[]) => string;
  export const resolve: (...parts: string[]) => string;
  export const dirname: (value: string) => string;
}

declare module "i2c-bus" {
  const i2c: any;
  export default i2c;
}

declare module "node-hid" {
  const hid: any;
  export default hid;
}
