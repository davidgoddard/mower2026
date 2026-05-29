import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const _dir = dirname(fileURLToPath(import.meta.url));

/**
 * Raw bytes of sensorWidgets.js — served at GET /sensor-widgets.js.
 * Read once at module load so the file is cached for the server lifetime.
 */
export const SENSOR_WIDGETS_JS: Buffer = readFileSync(
  join(_dir, "sensorWidgets.js"),
);

/**
 * HTML <script> tag that loads the web components.
 * All pages include this once in <head>.
 */
export function getSensorWidgetScriptTag(): string {
  return `<script src="/sensor-widgets.js" defer></script>`;
}

/**
 * Minimal page-level CSS needed to place the widgets inside a sidebar or grid.
 * Contains only layout rules — no typography or colour overrides that would
 * compete with the component's own shadow CSS.
 */
export function getSensorWidgetLayoutStyles(): string {
  return `
    .sidebar-widgets {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    imu-sensor-widget,
    gnss-position-widget {
      display: block;
    }
  `;
}
