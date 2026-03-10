declare module "node:test" {
  interface TestFn {
    (name: string, fn: () => void | Promise<void>): void;
  }

  const test: TestFn;
  export default test;
}

declare module "node:assert/strict" {
  interface AssertModule {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(block: () => void, error?: RegExp): void;
  }

  const assert: AssertModule;
  export default assert;
}
