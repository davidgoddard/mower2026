import { HidGameController } from "./hidGameController.js";
import { loadSystemParameters } from "./systemConfig.js";

let lastPrintedMillis = 0;

function summariseButtons(buttons) {
  return Object.entries(buttons)
    .filter(([, pressed]) => pressed)
    .map(([label]) => label)
    .join(", ");
}

controller.on("connected", (snapshot) => {
  console.log("Controller connected:", {
    product: snapshot.product,
    path: snapshot.path,
    vendorId: snapshot.vendorId,
    productId: snapshot.productId,
  });
});

controller.on("update", (snapshot) => {
  const now = Date.now();
  if (now - lastPrintedMillis < 150) {
    return;
  }
  lastPrintedMillis = now;

  console.log({
    connected: snapshot.connected,
    product: snapshot.product ?? "unknown",
    angleDegrees: snapshot.angleDegrees,
    speed: snapshot.speed,
    pressedButtons: summariseButtons(snapshot.buttons) || "none",
    rawPacketHex: snapshot.lastPacketHex,
  });
});

for (const label of [
  "top",
  "right",
  "bottom",
  "left",
  "triangle",
  "circle",
  "cross",
  "square",
  "left-top",
  "right-top",
  "select",
  "start",
  "analog",
]) {
  controller.on(label, () => {
    console.log(`Button pressed: ${label}`);
  });
}

controller.on("error", (error) => {
  console.error("Controller error:", error instanceof Error ? error.message : String(error));
});

process.on("SIGINT", () => {
  controller.close();
  process.exitCode = 0;
});

const { parameters } = await loadSystemParameters();
const controller = new HidGameController({
  steeringSign: parameters.controllerSteeringSign,
  speedSign: parameters.controllerSpeedSign,
});

controller.start();
