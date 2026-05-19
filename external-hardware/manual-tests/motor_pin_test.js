import i2c from "i2c-bus";

const BUS_NUMBER = Number(process.env.MOWER_I2C_BUS_NUMBER ?? 1);
const I2C_ADDRESS = Number(process.env.MOWER_MOTOR_I2C_ADDRESS ?? 0x66);
const STATUS_LENGTH = 6;

function printUsage() {
  console.log("Usage:");
  console.log("  node motor_pin_test.js <L|R> <P|D|T> [0|1]");
  console.log("");
  console.log("Examples:");
  console.log("  node motor_pin_test.js L P 1");
  console.log("  node motor_pin_test.js L P 0");
  console.log("  node motor_pin_test.js R D 1");
  console.log("  node motor_pin_test.js L T");
  console.log("");
  console.log("Behavior:");
  console.log("  - every write clears all outputs low first");
  console.log("  - only the requested PWM or DIR line is then driven high");
  console.log("  - T only reads the tach input states; it does not drive outputs");
}

function normalizeMotor(value) {
  const upper = String(value ?? "").trim().toUpperCase();
  if (upper !== "L" && upper !== "R") {
    throw new Error(`invalid motor selector: ${value}`);
  }
  return upper;
}

function normalizeSignal(value) {
  const upper = String(value ?? "").trim().toUpperCase();
  if (upper !== "P" && upper !== "D" && upper !== "T") {
    throw new Error(`invalid signal selector: ${value}`);
  }
  return upper;
}

function normalizeValue(signal, value) {
  if (signal === "T") {
    return 0;
  }

  if (value == null) {
    throw new Error(`missing value for signal ${signal}; expected 0 or 1`);
  }

  if (value !== "0" && value !== "1") {
    throw new Error(`invalid value: ${value}; expected 0 or 1`);
  }

  return Number(value);
}

function decodeStatus(buffer) {
  if (buffer.length !== STATUS_LENGTH) {
    throw new Error(`unexpected status length: ${buffer.length}`);
  }

  return {
    leftPwmHigh: buffer[0] === 1,
    leftDirHigh: buffer[1] === 1,
    rightPwmHigh: buffer[2] === 1,
    rightDirHigh: buffer[3] === 1,
    leftTachHigh: buffer[4] === 1,
    rightTachHigh: buffer[5] === 1,
  };
}

async function main() {
  const motor = normalizeMotor(process.argv[2]);
  const signal = normalizeSignal(process.argv[3]);
  const value = normalizeValue(signal, process.argv[4]);

  const command = Buffer.from([
    motor.charCodeAt(0),
    signal.charCodeAt(0),
    value,
  ]);

  const bus = await i2c.openPromisified(BUS_NUMBER);

  try {
    await bus.i2cWrite(I2C_ADDRESS, command.length, command);
    const response = Buffer.alloc(STATUS_LENGTH);
    const { bytesRead } = await bus.i2cRead(I2C_ADDRESS, response.length, response);
    if (bytesRead !== STATUS_LENGTH) {
      throw new Error(`short read from motor pin test sketch: expected ${STATUS_LENGTH}, got ${bytesRead}`);
    }

    console.log("Motor pin test");
    console.log({
      busNumber: BUS_NUMBER,
      i2cAddress: `0x${I2C_ADDRESS.toString(16)}`,
      command: {
        motor,
        signal,
        value,
      },
      status: decodeStatus(response),
    });
  } finally {
    await bus.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exitCode = 1;
});
