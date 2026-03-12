import { EventEmitter } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const legacyNodeModulesPath = path.resolve(__dirname, "../../legacy/mower/node_modules/node-hid");
const require = createRequire(import.meta.url);
const HID = require(legacyNodeModulesPath);

const DEFAULT_VENDOR_ID = 0x2563;
const DEFAULT_PRODUCT_ID = 0x0526;

const buttonLayout = [
  [5, 0x0f, 0x00, "top"],
  [5, 0x0f, 0x02, "right"],
  [5, 0x0f, 0x04, "bottom"],
  [5, 0x0f, 0x06, "left"],
  [6, 0x00, 0x10, "triangle"],
  [6, 0x00, 0x02, "circle"],
  [6, 0x00, 0x01, "cross"],
  [6, 0x00, 0x08, "square"],
  [6, 0x00, 0x40, "left-top"],
  [6, 0x00, 0x80, "right-top"],
  [7, 0x00, 0x04, "select"],
  [7, 0x00, 0x08, "start"],
  [7, 0x00, 0x10, "analog"],
];

function nearlyEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) <= epsilon;
}

function joystickToAngle(input, steeringSign) {
  const dx = (90 * (input - 128)) / 128;
  const signed = dx * steeringSign;
  if (signed < -89) {
    return -90;
  }
  if (signed > 89) {
    return 90;
  }
  return signed * 0.5;
}

function joystickToSpeed(input, speedSign) {
  const norm = input / 128;
  let speed = Math.max(-1, Math.min(1, 1 - norm)) * speedSign;
  if (Math.abs(speed) < 0.02) {
    speed = 0;
  }
  return Number(speed.toFixed(2));
}

function decodeButtons(data, previousButtons) {
  const currentButtons = {};
  const pressedEvents = [];

  for (const [byteIndex, mask, bit, label] of buttonLayout) {
    const pressed = (mask ^ data[byteIndex]) === (mask ^ bit);
    currentButtons[label] = pressed;
    if (!previousButtons[label] && pressed) {
      pressedEvents.push(label);
    }
  }

  return { currentButtons, pressedEvents };
}

export class HidGameController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.vendorId = options.vendorId ?? DEFAULT_VENDOR_ID;
    this.productId = options.productId ?? DEFAULT_PRODUCT_ID;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
    this.steeringSign = options.steeringSign ?? 1;
    this.speedSign = options.speedSign ?? 1;
    this.device = undefined;
    this.connected = false;
    this.closed = false;
    this.retryTimer = undefined;
    this.product = undefined;
    this.path = undefined;
    this.lastAngleDegrees = 0;
    this.lastSpeed = 0;
    this.lastPacketHex = "";
    this.lastUpdateMillis = 0;
    this.buttons = Object.fromEntries(buttonLayout.map(([, , , label]) => [label, false]));
  }

  start() {
    this.closed = false;
    this.attach();
  }

  snapshot() {
    return {
      connected: this.connected,
      vendorId: this.vendorId,
      productId: this.productId,
      product: this.product,
      path: this.path,
      angleDegrees: this.lastAngleDegrees,
      speed: this.lastSpeed,
      buttons: { ...this.buttons },
      lastPacketHex: this.lastPacketHex,
      lastUpdateMillis: this.lastUpdateMillis,
    };
  }

  close() {
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

  attach() {
    if (this.closed) {
      return;
    }

    const devices = HID.devices();
    const target = devices.find((device) => device.vendorId === this.vendorId && device.productId === this.productId);

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
    this.device = new HID.HID(target.path);
    this.connected = true;
    this.emit("connected", this.snapshot());
    this.emit("update", this.snapshot());

    this.device.on("data", (data) => {
      this.handleData(data);
    });

    this.device.on("error", (error) => {
      this.connected = false;
      this.emit("error", error);
      this.emit("update", this.snapshot());
      this.scheduleReconnect();
    });
  }

  handleData(data) {
    const speed = joystickToSpeed(data[4], this.speedSign);
    const angleDegrees = joystickToAngle(data[3], this.steeringSign);
    const { currentButtons, pressedEvents } = decodeButtons(data, this.buttons);

    this.buttons = currentButtons;
    this.lastPacketHex = Buffer.from(data).toString("hex");
    this.lastUpdateMillis = Date.now();

    if (!nearlyEqual(speed, this.lastSpeed, 0.01) || !nearlyEqual(angleDegrees, this.lastAngleDegrees, 0.5)) {
      this.lastSpeed = speed;
      this.lastAngleDegrees = angleDegrees;
    }

    for (const label of pressedEvents) {
      this.emit(label, this.snapshot());
    }

    this.emit("update", this.snapshot());
  }

  scheduleReconnect() {
    if (this.closed || this.retryTimer !== undefined) {
      return;
    }

    if (this.device !== undefined) {
      this.device.removeAllListeners();
      try {
        this.device.close();
      } catch {
        // ignore close failures during reconnect
      }
      this.device = undefined;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.attach();
    }, this.reconnectDelayMs);
  }
}
