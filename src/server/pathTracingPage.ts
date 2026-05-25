import { getManualDrivePageHtml } from "./manualDrivePage.js";

/**
 * Path Tracing Web UI
 *
 * Legacy entry point that now serves the combined Drive & Paths page.
 */
export function renderPathTracingPage(): string {
  return getManualDrivePageHtml();
}
