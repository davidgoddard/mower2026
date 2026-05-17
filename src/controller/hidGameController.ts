import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

interface HidGameControllerOptions {
  vendorId?: number;
  productId?: number;
  reconnectDelayMs?: number;
  steeringSign?: number;
  speedSign?: number;
}

interface ControllerButtonState {
  [label: string]: boolean;
}

interface ButtonLayoutEntry {
  readonly byteIndex: number;
  readonly mask: number;
  readonly bit: number;
  readonly label: string;
}

export interface HidGameControllerSnapshot {
  connected: boolean;
  vendorId: number;
  productId: number;
  product?: string;
  path?: string;
  steeringByte: number;
  speedByte: number;
  angleDegrees: number;
  speed: number;
  buttons: ControllerButtonState;
  lastPacketHex: string;
  lastUpdateMillis: number;
}

const DEFAULT_VENDOR_ID = 0x2563;
const DEFAULT_PRODUCT_ID = 0x0526;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const hidModuleCandidates = [
  "node-hid",
  ...(process.env.MOWER_NODE_HID_PATH ? [process.env.MOWER_NODE_HID_PATH] : []),
  path.resolve(__dirname, "../../legacy/mower/node_modules/node-hid"),
  path.resolve(__dirname, "../../../legacy/mower/node_modules/node-hid"),
];
const HID = loadHidModule();

const buttonLayout: readonly ButtonLayoutEntry[] = [
  { byteIndex: 5, mask: 0x0f, bit: 0x00, label: "top" },
  { byteIndex: 5, mask: 0x0f, bit: 0x02, label: "right" },
  { byteIndex: 5, mask: 0x0f, bit: 0x04, label: "bottom" },
  { byteIndex: 5, mask: 0x0f, bit: 0x06, label: "left" },
  { byteIndex: 6, mask: 0x00, bit: 0x10, label: "triangle" },
  { byteIndex: 6, mask: 0x00, bit: 0x02, label: "circle" },
  { byteIndex: 6, mask: 0x00, bit: 0x01, label: "cross" },
  { byteIndex: 6, mask: 0x00, bit: 0x08, label: "square" },
  { byteIndex: 6, mask: 0x00, bit: 0x40, label: "left-top" },
  { byteIndex: 6, mask: 0x00, bit: 0x80, label: "right-top" },
  { byteIndex: 7, mask: 0x00, bit: 0x04, label: "select" },
  { byteIndex: 7, mask: 0x00, bit: 0x08, label: "start" },
  { byteIndex: 7, mask: 0x00, bit: 0x10, label: "analog" },
];

function joystickToAngle(input: number, steeringSign: number): number {
  const centered = input - 128;
  const angle = (90 * centered) / 127;
  return Math.max(-90, Math.min(90, angle * steeringSign));
}

function joystickToSpeed(input: number, speedSign: number): number {
  const norm = input / 128;
  let speed = Math.max(-1, Math.min(1, 1 - norm)) * speedSign;
  if (Math.abs(speed) < 0.02) {
    speed = 0;
  }
  return Number(speed.toFixed(2));
}

function decodeButtons(data: Uint8Array, previousButtons: ControllerButtonState): {
  currentButtons: ControllerButtonState;
  pressedEvents: string[];
} {
  const currentButtons: ControllerButtonState = {};
  const pressedEvents: string[] = [];

  for (const { byteIndex, mask, bit, label } of buttonLayout) {
    const pressed = (mask ^ data[byteIndex]) === (mask ^ bit);
    currentButtons[label] = pressed;
    if (!previousButtons[label] && pressed) {
      pressedEvents.push(label);
    }
  }

  return { currentButtons, pressedEvents };
}

function loadHidModule(): any | null {
  for (const candidate of hidModuleCandidates) {
    try {
      return require(candidate);
    } catch (error: any) {
      if (error && typeof error === "object" && "code" in error && error.code === "MODULE_NOT_FOUND") {
        continue;
      }
      throw error;
    }
  }

  return null;
}

export class HidGameController extends EventEmitter {
  private readonly vendorId: number;
  private readonly productId: number;
  private readonly reconnectDelayMs: number;
  private readonly steeringSign: number;
  private readonly speedSign: number;

  private device: any;
  private connected = false;
  private closed = false;
  private retryTimer: any;
  private product: string | undefined;
  private path: string | undefined;
  private lastAngleDegrees = 0;
  private lastSpeed = 0;
  private lastSteeringByte = 128;
  private lastSpeedByte = 128;
  private lastPacketHex = "";
  private lastUpdateMillis = 0;
  private buttons: ControllerButtonState = Object.fromEntries(
    buttonLayout.map(({ label }) => [label, false]),
  ) as ControllerButtonState;

  constructor(options: HidGameControllerOptions = {}) {
    super();
    this.vendorId = options.vendorId ?? DEFAULT_VENDOR_ID;
    this.productId = options.productId ?? DEFAULT_PRODUCT_ID;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
    this.steeringSign = options.steeringSign ?? 1;
    this.speedSign = options.speedSign ?? 1;
  }

  start(): void {
    this.closed = false;
    void this.attach();
  }

  snapshot(): HidGameControllerSnapshot {
    return {
      connected: this.connected,
      vendorId: this.vendorId,
      productId: this.productId,
      product: this.product,
      path: this.path,
      steeringByte: this.lastSteeringByte,
      speedByte: this.lastSpeedByte,
      angleDegrees: this.lastAngleDegrees,
      speed: this.lastSpeed,
      buttons: { ...this.buttons },
      lastPacketHex: this.lastPacketHex,
      lastUpdateMillis: this.lastUpdateMillis,
    };
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.device !== undefined) {
      this.device.removeAllListeners();
      this.device.close();
      this.device = undefined;
    }
  }

  private async attach(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (HID === null) {
      this.connected = false;
      this.product = "node-hid unavailable";
      this.path = undefined;
      this.emit("update", this.snapshot());
      this.scheduleReconnect();
      return;
    }

    const devices = HID.devices();
    const target = devices.find((device: any) => device.vendorId === this.vendorId && device.productId === this.productId);

    if (!target) {
      this.connected = false;
      this.product = undefined;
      this.path = undefined;
      this.emit("update", this.snapshot());
      this.scheduleReconnect();
      return;
    }

    this.product = target.product;
    this.path = target.path;

    try {
      this.device = new HID.HID(target.path);
    } catch (error) {
      this.connected = false;
      this.emit("error", error);
      this.emit("update", this.snapshot());
      this.scheduleReconnect();
      return;
    }

    this.connected = true;
    this.emit("connected", this.snapshot());
    this.emit("update", this.snapshot());

    this.device.on("data", (data: Uint8Array) => {
      this.handleData(data);
    });

    this.device.on("error", (error: unknown) => {
      this.connected = false;
      this.emit("error", error);
      this.emit("update", this.snapshot());
      this.scheduleReconnect();
    });
  }

  private handleData(data: Uint8Array): void {
    const steeringByte = data[3];
    const speedByte = data[4];
    const speed = joystickToSpeed(speedByte, this.speedSign);
    const angleDegrees = joystickToAngle(steeringByte, this.steeringSign);
    const { currentButtons, pressedEvents } = decodeButtons(data, this.buttons);

    this.buttons = currentButtons;
    this.lastSteeringByte = steeringByte;
    this.lastSpeedByte = speedByte;
    this.lastPacketHex = Buffer.from(data).toString("hex");
    this.lastUpdateMillis = Date.now();
    this.lastSpeed = speed;
    this.lastAngleDegrees = angleDegrees;

    for (const label of pressedEvents) {
      this.emit(label, this.snapshot());
    }

    this.emit("update", this.snapshot());
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer !== undefined) {
      return;
    }

    if (this.device !== undefined) {
      this.device.removeAllListeners();
      try {
        this.device.close();
      } catch {
        // Ignore close failures while reconnecting.
      }
      this.device = undefined;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.attach();
    }, this.reconnectDelayMs);
  }
}
