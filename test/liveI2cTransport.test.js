import test from "node:test";
import assert from "node:assert/strict";
import { LiveI2cTransport } from "../dist/i2c/liveI2cTransport.js";

test("LiveI2cTransport reopens the bus and retries after a controller timeout", async () => {
  let openCount = 0;
  const closed = [];
  const openBus = async () => {
    openCount += 1;
    if (openCount === 1) {
      return {
        async i2cWrite() {
          throw new Error("ETIMEDOUT: controller timed out, write");
        },
        async i2cRead() {
          throw new Error("should not reach read on failed first bus");
        },
        async close() {
          closed.push("first");
        },
      };
    }

    return {
      async i2cWrite(_address, length) {
        return { bytesWritten: length };
      },
      async i2cRead(_address, length, buffer) {
        buffer.fill(0x5a);
        return { bytesRead: length };
      },
      async close() {
        closed.push("second");
      },
    };
  };

  const transport = await LiveI2cTransport.create(1, { openBus, maxRetries: 1 });
  const response = await transport.writeRead(0x69, new Uint8Array([0x12]), 4);

  assert.deepEqual(Array.from(response), [0x5a, 0x5a, 0x5a, 0x5a]);
  assert.equal(openCount, 2);

  await transport.close();
  assert.deepEqual(closed, ["first", "second"]);
});

test("LiveI2cTransport retries a client EIO without reopening the shared bus", async () => {
  let openCount = 0;
  let writeCount = 0;
  let closeCount = 0;
  const openBus = async () => {
    openCount += 1;
    return {
      async i2cWrite(_address, length) {
        writeCount += 1;
        if (writeCount === 1) {
          throw new Error("EIO: i/o error, write");
        }
        return { bytesWritten: length };
      },
      async i2cRead(_address, length, buffer) {
        buffer.fill(0x42);
        return { bytesRead: length };
      },
      async close() {
        closeCount += 1;
      },
    };
  };

  const transport = await LiveI2cTransport.create(1, { openBus, maxRetries: 1 });
  const response = await transport.writeRead(0x52, new Uint8Array([0x12]), 2);

  assert.deepEqual(Array.from(response), [0x42, 0x42]);
  assert.equal(writeCount, 2);
  assert.equal(openCount, 1);
  assert.equal(closeCount, 0);

  await transport.close();
  assert.equal(closeCount, 1);
});

test("LiveI2cTransport does not retry non-recoverable errors", async () => {
  let openCount = 0;
  const openBus = async () => {
    openCount += 1;
    return {
      async i2cWrite() {
        throw new Error("permission denied");
      },
      async i2cRead() {
        throw new Error("should not read");
      },
      async close() {},
    };
  };

  const transport = await LiveI2cTransport.create(1, { openBus, maxRetries: 1 });
  await assert.rejects(
    transport.write(0x69, new Uint8Array([0x12])),
    /permission denied/,
  );
  assert.equal(openCount, 1);
});
