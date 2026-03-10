import test from "node:test";
import assert from "node:assert/strict";
import { crc16Ccitt } from "../../src/bus/crc.js";

test("crc16Ccitt matches the standard 123456789 check value", () => {
  assert.equal(crc16Ccitt(new Uint8Array([49, 50, 51, 52, 53, 54, 55, 56, 57])), 0x29b1);
});
