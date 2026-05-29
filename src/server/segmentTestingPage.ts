import { getSensorWidgetScriptTag, getSensorWidgetLayoutStyles } from "./liveSensorWidgets.js";
import { getAppDialogHtml, getAppDialogScript, getAppDialogStyles } from "./appDialogs.js";

/**
 * Segment testing web page.
 *
 * This page is a test harness around the existing turn and drive controllers.
 * It shows the live IMU/GNSS widgets on the left and the segment test flow on
 * the right.
 */


export function getSegmentTestingPageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Segment Testing - Mower Control</title>
      <style>
${getSensorWidgetLayoutStyles()}
${getAppDialogStyles()}
      :root {
        --primary-color: #2563eb;
        --primary-hover: #1d4ed8;
        --success-color: #10b981;
        --danger-color: #ef4444;
        --danger-hover: #dc2626;
        --warning-color: #f59e0b;
        --bg-primary: #ffffff;
        --bg-secondary: #f9fafb;
        --bg-tertiary: #f3f4f6;
        --text-primary: #111827;
        --text-secondary: #6b7280;
        --border-color: #e5e7eb;
        --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
        --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        background: var(--bg-secondary);
        color: var(--text-primary);
        line-height: 1.5;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }

      .header {
        background: var(--bg-primary);
        border-bottom: 1px solid var(--border-color);
        box-shadow: var(--shadow-sm);
        position: sticky;
        top: 0;
        z-index: 10;
      }

      .header-content {
        max-width: 1800px;
        margin: 0 auto;
        padding: 1.25rem 1rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
      }

      .header-title {
        font-size: 1.875rem;
        font-weight: 700;
        margin: 0;
      }

      .header-subtitle {
        color: var(--text-secondary);
        font-size: 0.875rem;
        margin-top: 0.25rem;
      }

      .back-link {
        color: var(--primary-color);
        text-decoration: none;
        font-weight: 600;
        white-space: nowrap;
      }

      .back-link:hover {
        color: var(--primary-hover);
        text-decoration: underline;
      }

      .container {
        max-width: 1800px;
        margin: 0 auto;
        padding: 1rem;
        width: 100%;
      }

      .page-layout {
        display: grid;
        grid-template-columns: minmax(380px, 420px) minmax(0, 1fr);
        gap: 1rem;
        align-items: start;
      }

      .sidebar-column {
        position: sticky;
        top: 5.5rem;
        display: grid;
        grid-template-rows: 1fr 1fr;
        gap: 1rem;
        align-self: start;
      }

      .main-column {
        min-width: 0;
      }

      .sensor-card,
      .section-card {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
        padding: 1.25rem;
        box-shadow: var(--shadow-md);
      }

      .sensor-header,
      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.875rem;
        padding-bottom: 0.875rem;
        border-bottom: 1px solid var(--border-color);
      }

      .sensor-title,
      .section-title {
        font-size: 1rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }

      .status-dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        display: inline-block;
        background: currentColor;
      }

      .status-dot.running {
        background: var(--success-color);
      }

      .status-dot.error {
        background: var(--danger-color);
      }

      .status-dot.idle {
        background: var(--text-secondary);
      }

      .metric-label {
        font-size: 0.75rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .metric-value {
        font-size: 1.25rem;
        font-weight: 600;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .metric-value.large {
        font-size: 1.5rem;
      }

      .position-display {
        text-align: center;
        padding: 0.75rem;
        background: var(--bg-tertiary);
        border-radius: 0.5rem;
        margin-top: 0.75rem;
      }

      .compass {
        width: 100px;
        height: 100px;
        margin: 0 auto;
        position: relative;
      }

      .compass-circle {
        width: 100%;
        height: 100%;
        border: 3px solid var(--border-color);
        border-radius: 50%;
        position: relative;
        background: radial-gradient(circle, var(--bg-secondary) 0%, var(--bg-primary) 70%);
      }

      .compass-needle {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 4px;
        height: 45%;
        background: linear-gradient(to top, var(--danger-color), var(--primary-color));
        transform-origin: bottom center;
        transform: translate(-50%, -100%) rotate(var(--heading-deg, 0deg));
        border-radius: 2px;
        transition: transform 0.3s ease-out;
      }

      .compass-center {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 12px;
        height: 12px;
        background: var(--text-primary);
        border-radius: 50%;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 0 3px var(--bg-primary);
      }

      .compass-label {
        position: absolute;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-secondary);
      }

      .compass-label.n { top: 8px; left: 50%; transform: translateX(-50%); }
      .compass-label.e { right: 8px; top: 50%; transform: translateY(-50%); }
      .compass-label.s { bottom: 8px; left: 50%; transform: translateX(-50%); }
      .compass-label.w { left: 8px; top: 50%; transform: translateY(-50%); }

      .tilt-indicators {
        display: flex;
        justify-content: space-around;
        gap: 1rem;
        margin-top: 1rem;
      }

      .tilt-indicator {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
      }

      .tilt-circle {
        width: 80px;
        height: 80px;
        border: 3px solid var(--border-color);
        border-radius: 50%;
        position: relative;
        background: radial-gradient(circle, var(--bg-secondary) 0%, var(--bg-primary) 70%);
      }

      .tilt-line {
        position: absolute;
        top: 50%;
        left: 10%;
        right: 10%;
        height: 3px;
        background: var(--primary-color);
        transform-origin: center center;
        transform: translateY(-50%) rotate(var(--tilt-deg, 0deg));
        border-radius: 2px;
        transition: transform 0.3s ease-out;
      }

      .tilt-center {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 8px;
        height: 8px;
        background: var(--text-primary);
        border-radius: 50%;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 0 2px var(--bg-primary);
      }

      .tilt-label {
        font-size: 0.75rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .tilt-value {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-primary);
      }

      .gnss-summary {
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
        margin-top: 1rem;
      }

      .gnss-row {
        display: grid;
        gap: 1rem;
      }

      .gnss-row.three {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .gnss-row.two {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .gnss-fix-value {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 5.25rem;
        padding: 0.35rem 0.7rem;
        border-radius: 0.5rem;
        background: var(--bg-tertiary);
      }

      .gnss-fix-value.gnss-fix-unknown,
      .gnss-fix-value.gnss-fix-none {
        background: #fee2e2;
        color: #991b1b;
      }

      .gnss-fix-value.gnss-fix-single {
        background: #ffedd5;
        color: #9a3412;
      }

      .gnss-fix-value.gnss-fix-float {
        background: #fef3c7;
        color: #92400e;
      }

      .gnss-fix-value.gnss-fix-fixed,
      .gnss-fix-value.gnss-fix-rtk-fixed {
        background: #d1fae5;
        color: #065f46;
      }

      .gnss-fix-value.gnss-fix-rtk-float {
        background: #dcfce7;
        color: #166534;
      }

      .error-message {
        background: #fef2f2;
        color: #991b1b;
        padding: 0.75rem;
        border-radius: 0.5rem;
        font-size: 0.875rem;
        margin-top: 0.5rem;
      }

      .button-row {
        display: flex;
        justify-content: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      .button {
        border: none;
        border-radius: 0.75rem;
        padding: 0.9rem 1.4rem;
        font-size: 0.95rem;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: var(--shadow-sm);
        min-width: 12rem;
      }

      .button:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: var(--shadow-md);
      }

      .button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .button-primary {
        background: var(--primary-color);
        color: white;
      }

      .button-primary:hover:not(:disabled) {
        background: var(--primary-hover);
      }

      .button-danger {
        background: var(--danger-color);
        color: white;
      }

      .button-danger:hover:not(:disabled) {
        background: var(--danger-hover);
      }

      .status-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 1rem;
      }

      .status-item {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 0.75rem;
        background: var(--bg-tertiary);
        border-radius: 0.5rem;
      }

      .status-value {
        font-size: 1.15rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      .table-wrap {
        overflow-x: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 1050px;
      }

      th, td {
        text-align: left;
        padding: 0.85rem 1rem;
        border-bottom: 1px solid var(--border-color);
        font-size: 0.92rem;
        white-space: nowrap;
      }

      th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 0.78rem;
        position: sticky;
        top: 0;
        z-index: 1;
      }

      tr:last-child td {
        border-bottom: none;
      }

      .empty-row {
        color: var(--text-secondary);
        text-align: center;
      }

      .status-success {
        color: var(--success-color);
        font-weight: 700;
      }

      .status-warn {
        color: var(--warning-color);
        font-weight: 700;
      }

      .status-error {
        color: var(--danger-color);
        font-weight: 700;
      }

      @media (max-width: 1200px) {
        .page-layout {
          grid-template-columns: 1fr;
        }

        .sidebar-column {
          position: static;
        }

        .status-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 700px) {
        .header-content {
          flex-direction: column;
          align-items: flex-start;
        }

        .status-grid {
          grid-template-columns: 1fr;
        }

        .button {
          width: 100%;
        }
      }
    </style>
${getSensorWidgetScriptTag()}
  </head>
  <body>
    <div class="header">
      <div class="header-content">
        <div>
          <div class="header-title">Segment Testing</div>
          <div class="header-subtitle">Collect 7 rough waypoints, then run segment turn-and-drive tests using the live pose path.</div>
        </div>
        <a class="back-link" href="/">← Back to Dashboard</a>
      </div>
    </div>

    <div class="container">
      <div class="page-layout">
        <div class="sidebar-column">
          <imu-sensor-widget id="imu-widget"></imu-sensor-widget>
          <gnss-position-widget id="gnss-widget"></gnss-position-widget>
        </div>

        <div class="main-column">
          <div class="section-card">
            <div class="section-header">
              <div class="section-title">Controls</div>
            </div>
            <div class="button-row">
              <button class="button button-primary" id="startSegmentTest">Run Segment Test</button>
              <button class="button button-danger" id="stopSegmentTest">STOP</button>
            </div>
          </div>

          <div class="section-card" style="margin-top: 1rem;">
            <div class="section-header">
              <div class="section-title">Status</div>
              <span class="status-dot" id="segment-status-dot"></span>
            </div>
            <div class="status-grid">
              <div class="status-item">
                <div class="metric-label">State</div>
                <div class="status-value" id="segment-state">idle</div>
              </div>
              <div class="status-item">
                <div class="metric-label">Waypoints</div>
                <div class="status-value" id="segment-waypoints">0 / 7</div>
              </div>
              <div class="status-item">
                <div class="metric-label">Runs</div>
                <div class="status-value" id="segment-runs">0 / 11</div>
              </div>
              <div class="status-item">
                <div class="metric-label">Target</div>
                <div class="status-value" id="segment-target">—</div>
              </div>
            </div>
            <div class="section-header" style="margin-top: 1rem;">
              <div class="section-title">Summary</div>
            </div>
            <div class="metric-label" id="segment-summary">Segment test idle.</div>
          </div>

          <div class="section-card" style="margin-top: 1rem;">
            <div class="section-header">
              <div class="section-title">Segment Results</div>
              <div class="metric-label" id="segment-result-count">0 runs</div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Waypoint</th>
                    <th>Distance</th>
                    <th>Heading Req</th>
                    <th>Heading Achieved</th>
                    <th>Heading Diff</th>
                    <th>Quality</th>
                    <th>Avg CTE (cm)</th>
                    <th>Max CTE (cm)</th>
                    <th>X Error (cm)</th>
                    <th>Y Error (cm)</th>
                  </tr>
                </thead>
                <tbody id="segmentResultsTableBody">
                  <tr>
                    <td colspan="12" class="empty-row">Run segment testing to see waypoint distance, heading change, CTE and arrival errors here.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

${getAppDialogHtml()}

    <script>
${getAppDialogScript()}

      function formatSignedDegrees(value) {
        if (value === null || value === undefined || Number.isNaN(value)) {
          return "—";
        }
        return (value >= 0 ? "+" : "") + value.toFixed(1) + "°";
      }

      function normalizeSignedDegrees(value) {
        return ((((value + 180) % 360) + 360) % 360) - 180;
      }

      function formatHeadingDifference(requiredDeg, achievedDeg) {
        if (
          requiredDeg === null ||
          requiredDeg === undefined ||
          Number.isNaN(requiredDeg) ||
          achievedDeg === null ||
          achievedDeg === undefined ||
          Number.isNaN(achievedDeg)
        ) {
          return "—";
        }
        return formatSignedDegrees(normalizeSignedDegrees(achievedDeg - requiredDeg));
      }

      function formatMeters2dp(value) {
        if (value === null || value === undefined || Number.isNaN(value)) {
          return "—";
        }
        return value.toFixed(2) + " m";
      }

      function formatCentimeters(value) {
        if (value === null || value === undefined || Number.isNaN(value)) {
          return "—";
        }
        return (value * 100).toFixed(1) + " cm";
      }

      function formatTime(timestamp) {
        if (!timestamp) {
          return "—";
        }
        try {
          return new Date(timestamp).toLocaleTimeString([], { hour12: false });
        } catch {
          return String(timestamp);
        }
      }

      function statusClass(value) {
        if (value === "success") return "status-success";
        if (value === "stopped") return "status-warn";
        return "status-error";
      }

      function phaseLabel(phase) {
        switch (phase) {
          case "collecting-waypoints": return "Collecting waypoints";
          case "driving-home": return "Driving home";
          case "testing-random": return "Testing random segments";
          case "stopped": return "Stopped";
          case "completed": return "Completed";
          default: return "Idle";
        }
      }

      function updateSidebar(primitives) {
        const imu = primitives?.imu ?? {};
        const gnss = primitives?.gnss ?? {};
        const poseFusion = primitives?.poseFusion ?? {};
        const imuWidget = document.getElementById('imu-widget');
        const gnssWidget = document.getElementById('gnss-widget');
        if (imuWidget) {
          imuWidget.setAttribute('status', imu.status || 'idle');
          if (imu.error != null) imuWidget.setAttribute('error', imu.error);
          if (imu.headingDeg != null) imuWidget.setAttribute('heading-deg', imu.headingDeg);
          if (imu.pitchDeg != null) imuWidget.setAttribute('pitch-deg', imu.pitchDeg);
          if (imu.rollDeg != null) imuWidget.setAttribute('roll-deg', imu.rollDeg);
          imuWidget.setAttribute('synced', poseFusion.usingGnssHeading === true ? 'true' : 'false');
        }
        if (gnssWidget) {
          gnssWidget.setAttribute('status', gnss.status || 'idle');
          if (gnss.error != null) gnssWidget.setAttribute('error', gnss.error);
          if (gnss.headingDeg != null) gnssWidget.setAttribute('heading-deg', gnss.headingDeg);
          if (gnss.headingAccuracyDeg != null) gnssWidget.setAttribute('heading-accuracy-deg', gnss.headingAccuracyDeg);
          if (gnss.xMeters != null) gnssWidget.setAttribute('x-meters', gnss.xMeters);
          if (gnss.yMeters != null) gnssWidget.setAttribute('y-meters', gnss.yMeters);
          if (gnss.positionAccuracyMeters != null) gnssWidget.setAttribute('position-accuracy-meters', gnss.positionAccuracyMeters);
          if (gnss.fixType != null) gnssWidget.setAttribute('fix-type', gnss.fixType);
          if (gnss.satellitesInUse != null) gnssWidget.setAttribute('satellites', gnss.satellitesInUse);
          gnssWidget.setAttribute('synced', poseFusion.usingGnssHeading === true ? 'true' : 'false');
        }
      }

      async function fetchStatus() {
        const [statusResponse, primitivesResponse] = await Promise.all([
          fetch("/api/segment/status?ts=" + Date.now(), { cache: "no-store" }),
          fetch("/api/primitives?ts=" + Date.now(), { cache: "no-store" }),
        ]);
        const primitivesPayload = await primitivesResponse.json();
        return {
          status: await statusResponse.json(),
          primitives: primitivesPayload.primitives ?? primitivesPayload,
        };
      }

      async function update() {
        try {
          const payload = await fetchStatus();
          updateSidebar(payload.primitives);

          const state = payload.status?.state ?? {};
          const history = Array.isArray(payload.status?.history) ? payload.status.history : [];

          const resultCount = document.getElementById("segment-result-count");
          if (resultCount) {
            resultCount.textContent = history.length + " run" + (history.length === 1 ? "" : "s");
          }

          const phase = state.phase || "idle";
          const phaseText = phaseLabel(phase);
          const summary = phase === "idle"
            ? "Segment test idle."
            : phase === "completed"
              ? "Segment test completed."
              : state.currentTargetLabel
                ? phaseText + " - " + state.currentTargetLabel + "."
                : phaseText + ".";

          const stateNode = document.getElementById("segment-state");
          const waypointsNode = document.getElementById("segment-waypoints");
          const runsNode = document.getElementById("segment-runs");
          const targetNode = document.getElementById("segment-target");
          const summaryNode = document.getElementById("segment-summary");
          const statusDot = document.getElementById("segment-status-dot");

          if (stateNode) stateNode.textContent = phaseText.toLowerCase();
          if (waypointsNode) waypointsNode.textContent = (state.collectedWaypoints ?? 0) + " / " + (state.totalWaypoints ?? 0);
          if (runsNode) runsNode.textContent = (state.completedRuns ?? 0) + " / " + (state.totalRuns ?? 0);
          if (targetNode) targetNode.textContent = state.currentTargetLabel || "—";
          if (summaryNode) summaryNode.textContent = summary;
          if (statusDot) statusDot.className = "status-dot " + (phase === "completed" ? "running" : phase === "stopped" ? "error" : phase === "idle" ? "idle" : "running");

          const startButton = document.getElementById("startSegmentTest");
          if (startButton) {
            startButton.disabled = !!state.running;
          }

          const rows = history.slice(-25).reverse();
          const tbody = document.getElementById("segmentResultsTableBody");
          if (!tbody) {
            return;
          }

          if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="12" class="empty-row">Run segment testing to see waypoint distance, heading change, CTE and arrival errors here.</td></tr>';
            return;
          }

          tbody.innerHTML = rows.map((item) => {
            const qualityClass = statusClass(item.driveStatus);
            return [
              "<tr>",
              "<td>" + formatTime(item.timestamp) + "</td>",
              "<td>" + item.phase + "</td>",
              "<td>" + item.waypointLabel + "</td>",
              "<td>" + formatMeters2dp(item.distanceToWaypointMeters) + "</td>",
              "<td>" + formatSignedDegrees(item.requiredHeadingChangeDeg) + "</td>",
              "<td>" + formatSignedDegrees(item.achievedHeadingChangeDeg) + "</td>",
              "<td>" + formatHeadingDifference(item.requiredHeadingChangeDeg, item.achievedHeadingChangeDeg) + "</td>",
              '<td class="' + qualityClass + '">' + item.driveStatus + '</td>',
              "<td>" + formatCentimeters(item.cteMeters) + "</td>",
              "<td>" + formatCentimeters(item.maxCteMeters) + "</td>",
              "<td>" + formatCentimeters(item.xErrorMeters) + "</td>",
              "<td>" + formatCentimeters(item.yErrorMeters) + "</td>",
              "</tr>",
            ].join("");
          }).join("");
        } catch (error) {
          console.error("Failed to update segment testing page:", error);
        }
      }

      async function postAction(action, body = {}) {
        const response = await fetch("/api/segment/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json();
      }

      document.getElementById("startSegmentTest").addEventListener("click", async () => {
        const button = document.getElementById("startSegmentTest");
        button.disabled = true;
        try {
          await postAction("start", {
            waypointCount: 7,
            testRunCount: 10,
            collectDriveMs: 3000,
          });
          await update();
        } catch (error) {
          alert("Failed to start segment testing: " + (error instanceof Error ? error.message : String(error)));
        } finally {
          button.disabled = false;
        }
      });

      document.getElementById("stopSegmentTest").addEventListener("click", async () => {
        try {
          await postAction("stop");
          await update();
        } catch (error) {
          alert("Failed to stop segment testing: " + (error instanceof Error ? error.message : String(error)));
        }
      });

      update();
      const updateInterval = setInterval(update, 1000);
      window.addEventListener("beforeunload", () => {
        clearInterval(updateInterval);
      });
    </script>
  </body>
</html>`;
}
