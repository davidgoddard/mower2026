import test from "node:test";
import assert from "node:assert/strict";
import { I2cBusAdapter } from "../../src/bus/i2cBusAdapter.js";

test("I2cBusAdapter delegates send and request to the port", async () => {
  const calls: string[] = [];
  const adapter = new I2cBusAdapter({
    async write(address, payload) {
      calls.push(`write:${address}:${payload.length}`);
    },
    async transfer(address, payload) {
      calls.push(`transfer:${address}:${payload.length}`);
      return new Uint8Array([7, 8, 9]);
    },
    async close() {
      calls.push("close");
    },
  });

  await adapter.send(0x20, new Uint8Array([1, 2]));
  const response = await adapter.request(0x10, new Uint8Array([3]));
  await adapter.close();

  assert.deepEqual(calls, ["write:32:2", "transfer:16:1", "close"]);
  assert.deepEqual(Array.from(response), [7, 8, 9]);
});
