import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAppDialogHtml, getAppDialogScript, getAppDialogStyles } from "./appDialogs.js";
import { getOperatorPageCommonScriptTag } from "./operatorPageCommon.js";
import { getSensorWidgetScriptTag } from "./liveSensorWidgets.js";

const MANUAL_DRIVE_ASSET_DIR_CANDIDATES = [
  resolve(process.cwd(), "src/server/manual-drive-page"),
  resolve(process.cwd(), "dist/server/manual-drive-page"),
];

const assetCache = new Map<string, string>();

function getManualDriveAssetPath(filename: string): string {
  for (const directory of MANUAL_DRIVE_ASSET_DIR_CANDIDATES) {
    const candidate = resolve(directory, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`manual_drive_asset_not_found:${filename}`);
}

function readManualDriveAsset(filename: string): string {
  const cached = assetCache.get(filename);
  if (cached !== undefined) {
    return cached;
  }

  const content = readFileSync(getManualDriveAssetPath(filename), "utf-8");
  assetCache.set(filename, content);
  return content;
}

function renderManualDriveAsset(filename: string, replacements: Record<string, string>): string {
  let content = readManualDriveAsset(filename);
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    content = content.replaceAll(placeholder, replacement);
  }
  return content;
}

export function getManualDrivePageHtml(): string {
  return renderManualDriveAsset("page.html", {
    "__APP_DIALOG_STYLE_TAG__": `<style>\n${getAppDialogStyles()}\n</style>`,
    "__APP_DIALOG_HTML__": getAppDialogHtml(),
    "__APP_DIALOG_SCRIPT_TAG__": `<script>\n${getAppDialogScript()}\n</script>`,
    "__OPERATOR_PAGE_COMMON_SCRIPT_TAG__": getOperatorPageCommonScriptTag(),
    "__SENSOR_WIDGET_SCRIPT_TAG__": getSensorWidgetScriptTag(),
  });
}

export function getManualDrivePageCss(): string {
  return readManualDriveAsset("page.css");
}

export function getManualDrivePageJs(): string {
  return readManualDriveAsset("page.js");
}
