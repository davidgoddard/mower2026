import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LoggerScope } from "../logging/types.js";

const execFileAsync = promisify(execFile);

/** Simple Raspberry Pi digital output using the Bookworm `pinctrl` utility. */
export class PiGpioOutput {
  private available = true;
  private lastValue: boolean | null = null;

  constructor(
    private readonly bcmPin: number,
    private readonly logger: LoggerScope,
  ) {}

  async set(value: boolean): Promise<void> {
    if (!this.available || this.lastValue === value) return;
    try {
      await execFileAsync("pinctrl", ["set", String(this.bcmPin), "op", value ? "dh" : "dl"]);
      this.lastValue = value;
    } catch (error) {
      this.available = false;
      this.logger.warn("gpio_output.unavailable", {
        bcmPin: this.bcmPin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
