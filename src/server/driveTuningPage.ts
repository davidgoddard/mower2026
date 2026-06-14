import { getSensorWidgetScriptTag, getSensorWidgetLayoutStyles } from "./liveSensorWidgets.js";
import { getAppDialogHtml, getAppDialogScript, getAppDialogStyles } from "./appDialogs.js";

/**
 * Drive tuning web page - simplified operator view for short-distance tuning.
 */


export function getDriveTuningPageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Drive Tuning - Mower Control</title>
    <style>
${getSensorWidgetLayoutStyles()}
${getAppDialogStyles()}
      :root {
        --primary-color: #2563eb;
        --primary-hover: #1d4ed8;
        --danger-color: #ef4444;
        --danger-hover: #dc2626;
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

      .sensor-card {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
        padding: 1.25rem;
        box-shadow: var(--shadow-md);
      }

      .sensor-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.875rem;
        padding-bottom: 0.875rem;
        border-bottom: 1px solid var(--border-color);
      }

      .sensor-title {
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

      /* shared live sensor widget styles injected above */

      .error-message {
        background: #fef2f2;
        color: #991b1b;
        padding: 0.75rem;
        border-radius: 0.5rem;
        font-size: 0.875rem;
        margin-top: 0.5rem;
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
        max-width: 1200px;
        margin: 0 auto;
        padding: 1rem;
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: center;
        flex-wrap: wrap;
      }

      h1 {
        margin: 0;
        font-size: 1.8rem;
      }

      .back-link {
        color: var(--primary-color);
        text-decoration: none;
        font-weight: 600;
      }

      .panel,
      .results {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
        box-shadow: var(--shadow-md);
        padding: 1rem;
        margin-top: 1rem;
      }

      .controls {
        display: grid;
        grid-template-columns: minmax(180px, 240px) minmax(220px, 280px) auto;
        gap: 1rem;
        align-items: end;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }

      label {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-secondary);
      }

      input[type="number"],
      select {
        padding: 0.7rem 0.8rem;
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        font-size: 1rem;
      }

      .buttons {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      button {
        border: none;
        border-radius: 0.5rem;
        padding: 0.7rem 1rem;
        font-size: 0.98rem;
        font-weight: 700;
        cursor: pointer;
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .primary {
        background: var(--primary-color);
        color: white;
      }

      .primary:hover:not(:disabled) {
        background: var(--primary-hover);
      }

      .danger {
        background: var(--danger-color);
        color: white;
      }

      .danger:hover:not(:disabled) {
        background: var(--danger-hover);
      }

      .summary {
        margin-top: 0.75rem;
        color: var(--text-secondary);
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.75rem;
        margin-top: 1rem;
      }

      .stat {
        padding: 0.85rem;
        border: 1px solid var(--border-color);
        border-radius: 0.65rem;
        background: #fff;
      }

      .parameter-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.75rem;
        margin-top: 1rem;
      }

      .parameter-item {
        padding: 0.85rem;
        border: 1px solid var(--border-color);
        border-radius: 0.65rem;
        background: #fff;
      }

      .parameter-name {
        font-size: 0.75rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .parameter-value {
        margin-top: 0.3rem;
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      .stat-label {
        font-size: 0.75rem;
        text-transform: uppercase;
        color: var(--text-secondary);
        letter-spacing: 0.08em;
      }

      .stat-value {
        margin-top: 0.3rem;
        font-size: 1.4rem;
        font-weight: 700;
      }

      .results h2 {
        margin: 0 0 0.75rem;
        font-size: 1.2rem;
      }

      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--border-color);
        border-radius: 0.6rem;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        padding: 0.7rem 0.8rem;
        border-bottom: 1px solid var(--border-color);
        text-align: left;
        white-space: nowrap;
      }

      thead {
        background: var(--bg-tertiary);
      }

      th {
        color: var(--text-secondary);
        font-size: 0.85rem;
      }

      tbody tr:hover {
        background: #fcfcfd;
      }

      .good {
        color: #065f46;
      }

      .warn {
        color: #92400e;
      }

      .bad {
        color: #991b1b;
      }

      .empty {
        text-align: center;
        color: var(--text-secondary);
        padding: 2rem 1rem;
      }

      @media (max-width: 760px) {
        .page-layout {
          grid-template-columns: 1fr;
        }

        .sidebar-column {
          position: static;
        }

        .controls,
        .stats {
          grid-template-columns: 1fr;
        }

        .buttons {
          flex-direction: column;
        }

        button {
          width: 100%;
        }
      }
    </style>
${getSensorWidgetScriptTag()}
  </head>
  <body>
    <div class="header">
      <div class="header-content">
        <h1>Drive Tuning</h1>
        <a class="back-link" href="/">← Back to Dashboard</a>
      </div>
    </div>

    <div class="container">
      <div class="page-layout">
        <aside class="sidebar-column" aria-label="Live primitives">
          <imu-sensor-widget id="imu-widget"></imu-sensor-widget>
          <gnss-position-widget id="gnss-widget"></gnss-position-widget>
        </aside>

        <main class="main-column">
          <section id="gnssGate" class="panel" style="display:none; background:#fff7ed; border-color:#fdba74;">
            <strong>GNSS not trusted.</strong>
            <span id="gnssGateDetail">Waiting for fixed-quality GNSS — learning is disabled until pose quality is gnss.</span>
          </section>
          <section class="panel">
            <div class="controls">
              <div class="field">
                <label for="startDistanceCm">Distance (cm)</label>
                <input id="startDistanceCm" type="number" min="10" step="5" value="10" />
              </div>
              <div class="field">
                <label for="driveTuningStage">Stage</label>
                <select id="driveTuningStage">
                  <option value="short">short distances</option>
                  <option value="long-bias">long heading bias</option>
                  <option value="long-gain">long heading gain</option>
                </select>
              </div>
              <div class="buttons">
                <button id="startDriveTuning" class="primary">start tuning</button>
                <button id="stopDriveTuning" class="danger">STOP</button>
                <button id="resetDriveLearning" class="secondary">reset learning</button>
              </div>
            </div>
            <div class="summary" id="driveSummary">Drive tuning idle.</div>
            <div class="stats">
              <div class="stat">
                <div class="stat-label">Status</div>
                <div class="stat-value" id="driveStatus">idle</div>
              </div>
              <div class="stat">
                <div class="stat-label">Runs</div>
                <div class="stat-value" id="driveRunCount">0</div>
              </div>
              <div class="stat">
                <div class="stat-label">Current Target</div>
                <div class="stat-value" id="driveCurrentTarget">-</div>
              </div>
            </div>
          </section>

          <section class="results">
            <h2>Results</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Distance</th>
                    <th>Avg CTE</th>
                    <th>Max CTE</th>
                    <th>X Error</th>
                    <th>Y Error</th>
                    <th>Status</th>
                    <th>Learned</th>
                  </tr>
                </thead>
                <tbody id="driveResultsTableBody">
                  <tr>
                    <td colspan="7" class="empty">Run drive tuning to see distance, average and maximum CTE, arrival error, and whether the learner accepted each run here.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="results">
            <h2>Parameters</h2>
            <div class="parameter-grid">
              <div class="parameter-item">
                <div class="parameter-name">Long Brake Forward</div>
                <div class="parameter-value" id="paramLongBrakeForward">-</div>
              </div>
              <div class="parameter-item">
                <div class="parameter-name">Long Brake Reverse</div>
                <div class="parameter-value" id="paramLongBrakeReverse">-</div>
              </div>
              <div class="parameter-item">
                <div class="parameter-name">Heading Bias Forward</div>
                <div class="parameter-value" id="paramLongBiasForward">-</div>
              </div>
              <div class="parameter-item">
                <div class="parameter-name">Heading Bias Reverse</div>
                <div class="parameter-value" id="paramLongBiasReverse">-</div>
              </div>
              <div class="parameter-item">
                <div class="parameter-name">Heading Gain Forward</div>
                <div class="parameter-value" id="paramLongGainForward">-</div>
              </div>
              <div class="parameter-item">
                <div class="parameter-name">Heading Gain Reverse</div>
                <div class="parameter-value" id="paramLongGainReverse">-</div>
              </div>
              <div class="parameter-item">
                <div class="parameter-name">CTE Gain Forward</div>
                <div class="parameter-value" id="paramCteForward">-</div>
              </div>
              <div class="parameter-item">
                <div class="parameter-name">CTE Gain Reverse</div>
                <div class="parameter-value" id="paramCteReverse">-</div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>

${getAppDialogHtml()}

    <script>
${getAppDialogScript()}

      function updateGnssGate(primitivesPayload) {
        const poseFusion = primitivesPayload?.primitives?.poseFusion ?? {};
        const gate = document.getElementById('gnssGate');
        const detail = document.getElementById('gnssGateDetail');
        if (!gate || !detail) return;
        const quality = poseFusion.quality ?? 'unknown';
        if (quality === 'gnss') {
          gate.style.display = 'none';
          return;
        }
        gate.style.display = '';
        const ageMs = poseFusion.gnssPositionAgeMs;
        const ageText = (typeof ageMs === 'number' && Number.isFinite(ageMs))
          ? (ageMs > 1000 ? (ageMs / 1000).toFixed(1) + 's' : Math.round(ageMs) + ' ms')
          : 'never';
        detail.textContent = 'Pose quality is ' + quality + ' (last accepted GNSS ' + ageText + ' ago). Learning is gated and the tuner will refuse to step distances until GNSS is trusted again.';
      }

      function updateSidebar(primitivesPayload) {
        const primitives = primitivesPayload?.primitives ?? {};
        const imu = primitives.imu ?? {};
        const gnss = primitives.gnss ?? {};
        const poseFusion = primitives.poseFusion ?? {};
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

      function formatCm(meters) {
        return \`\${(meters * 100).toFixed(1)} cm\`;
      }

      function formatPercent(value) {
        return \`\${(value * 100).toFixed(1)}%\`;
      }

      function formatPerDeg(value) {
        return value.toFixed(4) + " /deg";
      }

      function setText(id, text) {
        const element = document.getElementById(id);
        if (element) element.textContent = text;
      }

      function statusClass(value) {
        // Acceptance bound is 3 cm on both X and Y; 6 cm warns, beyond is bad.
        const abs = Math.abs(value);
        if (abs <= 0.03) return "good";
        if (abs <= 0.06) return "warn";
        return "bad";
      }

      function currentDriveDistanceMeters(historyItem) {
        const dx = historyItem.targetPosition.xMeters - historyItem.startPosition.xMeters;
        const dy = historyItem.targetPosition.yMeters - historyItem.startPosition.yMeters;
        return Math.hypot(dx, dy);
      }

      const maxDriveResultRows = 500;
      const driveResultKeys = new Set();
      const driveResultRows = [];
      let driveStateSnapshot = { status: "idle" };
      let startHandshakePending = false;

      function driveResultKey(item) {
        const start = item.startPosition ?? {};
        const target = item.targetPosition ?? {};
        const finalPosition = item.finalPosition ?? {};
        return [
          item.timestamp ?? "",
          item.status ?? "",
          start.xMeters ?? "",
          start.yMeters ?? "",
          target.xMeters ?? "",
          target.yMeters ?? "",
          finalPosition.xMeters ?? "",
          finalPosition.yMeters ?? "",
          item.errorX ?? "",
          item.errorY ?? "",
          item.avgCteMeters ?? "",
          item.maxCteMeters ?? "",
          item.learnApplied ?? "",
          item.learnSkipReason ?? "",
        ].join("|");
      }

      function describeLearnSkipReason(reason) {
        if (reason === "non_gnss_pose_sample") return "GNSS lost during run";
        if (reason === "learning_disabled") return "Learning disabled";
        if (reason === "drive_stopped") return "Run stopped";
        if (reason === "drive_error") return "Run errored";
        return reason || "Unknown";
      }

      function describeLearnedCell(item) {
        if (item.learnApplied === true) {
          return { className: "good", text: "Yes" };
        }
        if (item.learnApplied === false) {
          return { className: "bad", text: "No: " + describeLearnSkipReason(item.learnSkipReason) };
        }
        return { className: "warn", text: "—" };
      }

      function appendDriveRows(rows) {
        for (const item of rows) {
          const key = driveResultKey(item);
          if (driveResultKeys.has(key)) {
            continue;
          }
          driveResultKeys.add(key);
          driveResultRows.push(item);
        }
        if (driveResultRows.length > maxDriveResultRows) {
          const excess = driveResultRows.length - maxDriveResultRows;
          const removedRows = driveResultRows.splice(0, excess);
          for (const removedRow of removedRows) {
            driveResultKeys.delete(driveResultKey(removedRow));
          }
        }
      }

      function isDriveTrainingActive(driveState) {
        const status = driveState?.status ?? "idle";
        const phase = driveState?.shortTrainingProgress?.phase ?? driveState?.segmentTrainingProgress?.phase ?? null;
        return status !== "idle" || (phase !== null && phase !== "completed" && phase !== "stopped");
      }

      function syncDriveButtons() {
        const startButton = document.getElementById("startDriveTuning");
        const stopButton = document.getElementById("stopDriveTuning");
        const trainingActive = isDriveTrainingActive(driveStateSnapshot);

        if (trainingActive) {
          startHandshakePending = false;
        }

        startButton.disabled = startHandshakePending || trainingActive;
        stopButton.disabled = false;
      }

      async function fetchStatus() {
        const [statusResponse, primitivesResponse] = await Promise.all([
          fetch("/api/drive/status?ts=" + Date.now(), {
            cache: "no-store",
          }),
          fetch("/api/primitives")
        ]);
        return {
          status: await statusResponse.json(),
          primitives: await primitivesResponse.json(),
        };
      }

      async function update() {
        try {
          const payload = await fetchStatus();
          const data = payload.status;
          const history = Array.isArray(data.history) ? data.history : [];
          const parameters = data.parameters ?? {};
          updateSidebar(payload.primitives);
          updateGnssGate(payload.primitives);

          const driveState = data.state ?? {};
          driveStateSnapshot = driveState;
          const liveResults = Array.isArray(driveState.shortTrainingResults) ? driveState.shortTrainingResults : [];
          appendDriveRows(history);
          appendDriveRows(liveResults);
          syncDriveButtons();
          document.getElementById("driveStatus").textContent = driveState.status ?? "idle";
          document.getElementById("driveRunCount").textContent = String(driveResultRows.length);
          document.getElementById("driveSummary").textContent = driveState.shortTrainingProgress?.message
            ?? driveState.segmentTrainingProgress?.message
            ?? "Drive tuning idle.";
          document.getElementById("driveCurrentTarget").textContent = driveState.currentDrive
            ? "(" + formatCm(driveState.currentDrive.targetPosition.xMeters ?? 0) + ", " + formatCm(driveState.currentDrive.targetPosition.yMeters ?? 0) + ")"
            : "-";
          setText("paramLongBrakeForward", typeof parameters.longDriveBrakeDistanceForwardMeters === "number" ? formatCm(parameters.longDriveBrakeDistanceForwardMeters) : "-");
          setText("paramLongBrakeReverse", typeof parameters.longDriveBrakeDistanceReverseMeters === "number" ? formatCm(parameters.longDriveBrakeDistanceReverseMeters) : "-");
          setText("paramLongBiasForward", typeof parameters.longHeadingBiasForwardPercent === "number" ? formatPercent(parameters.longHeadingBiasForwardPercent) : "-");
          setText("paramLongBiasReverse", typeof parameters.longHeadingBiasReversePercent === "number" ? formatPercent(parameters.longHeadingBiasReversePercent) : "-");
          setText("paramLongGainForward", typeof parameters.longHeadingGainForwardPerDeg === "number" ? formatPerDeg(parameters.longHeadingGainForwardPerDeg) : "-");
          setText("paramLongGainReverse", typeof parameters.longHeadingGainReversePerDeg === "number" ? formatPerDeg(parameters.longHeadingGainReversePerDeg) : "-");
          setText("paramCteForward", typeof parameters.forwardCteGain === "number" ? parameters.forwardCteGain.toFixed(3) : "-");
          setText("paramCteReverse", typeof parameters.reverseCteGain === "number" ? parameters.reverseCteGain.toFixed(3) : "-");

          const rows = driveResultRows.slice(-maxDriveResultRows).reverse();
          const tbody = document.getElementById("driveResultsTableBody");
          if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty">Run drive tuning to see distance, average and maximum CTE, arrival error, and whether the learner accepted each run here.</td></tr>';
            return;
          }

          tbody.innerHTML = rows.map((item) => {
            const distanceMeters = currentDriveDistanceMeters(item);
            const avgCteMeters = item.avgCteMeters ?? 0;
            const maxCteMeters = item.maxCteMeters ?? 0;
            const xErrorMeters = item.errorX ?? 0;
            const yErrorMeters = item.errorY ?? 0;
            const learnedCell = describeLearnedCell(item);
            const statusText = item.status === "error" && item.errorMessage
              ? item.status + ": " + item.errorMessage
              : (item.status ?? "-");
            return \`
              <tr>
                <td>\${formatCm(distanceMeters)}</td>
                <td class="\${statusClass(avgCteMeters)}">\${formatCm(avgCteMeters)}</td>
                <td class="\${statusClass(maxCteMeters)}">\${formatCm(maxCteMeters)}</td>
                <td class="\${statusClass(xErrorMeters)}">\${formatCm(xErrorMeters)}</td>
                <td class="\${statusClass(yErrorMeters)}">\${formatCm(yErrorMeters)}</td>
                <td>\${statusText}</td>
                <td class="\${learnedCell.className}">\${learnedCell.text}</td>
              </tr>
            \`;
          }).join("");
        } catch (error) {
          console.error("Failed to update drive tuning page:", error);
          syncDriveButtons();
        }
      }

      async function postAction(action, body = {}) {
        const response = await fetch("/api/drive/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json();
      }

      document.getElementById("startDriveTuning").addEventListener("click", async () => {
        const startDistanceCm = Number(document.getElementById("startDistanceCm").value);
        const stage = document.getElementById("driveTuningStage").value;
        const isLongStage = stage === "long-bias" || stage === "long-gain";
        const requestedDistanceMeters = Number.isFinite(startDistanceCm)
          ? Math.max(isLongStage ? 2.0 : 0.10, startDistanceCm / 100)
          : (isLongStage ? 2.0 : 0.10);
        const startAtMeters = requestedDistanceMeters;
        const endAtMeters = requestedDistanceMeters < 4 ? 4 : requestedDistanceMeters;
        const startAtCm = Math.round(startAtMeters * 100).toString();
        const endAtCm = Math.round(endAtMeters * 100).toString();
        const stageLabel = stage === "short"
          ? "short-distance"
          : (stage === "long-bias" ? "long heading bias" : "long heading gain");
        document.getElementById("driveSummary").textContent = startAtCm === endAtCm
          ? "Starting " + stageLabel + " training at " + startAtCm + " cm..."
          : "Starting " + stageLabel + " training from " + startAtCm + " cm to " + endAtCm + " cm...";
        startHandshakePending = true;
        syncDriveButtons();
        try {
          const action = stage === "short"
            ? "train-short"
            : (stage === "long-bias" ? "train-long-bias" : "train-long-gain");
          await postAction(action, {
            startDistanceMeters: startAtMeters,
            maxDistanceMeters: endAtMeters,
            targetXErrorMeters: 0.03,
            targetYErrorMeters: 0.03,
            includeReverseLegs: true,
          });
          await update();
        } catch (error) {
          alert("Failed to start drive tuning: " + (error instanceof Error ? error.message : String(error)));
        } finally {
          startHandshakePending = false;
          syncDriveButtons();
        }
      });

      document.getElementById("driveTuningStage").addEventListener("change", () => {
        const stage = document.getElementById("driveTuningStage").value;
        const distanceInput = document.getElementById("startDistanceCm");
        const currentDistanceCm = Number(distanceInput.value);
        if (stage === "long-bias" || stage === "long-gain") {
          distanceInput.min = "200";
          if (!Number.isFinite(currentDistanceCm) || currentDistanceCm < 200) {
            distanceInput.value = "200";
          }
          return;
        }
        distanceInput.min = "10";
        if (!Number.isFinite(currentDistanceCm) || currentDistanceCm < 10) {
          distanceInput.value = "10";
        }
      });

      document.getElementById("stopDriveTuning").addEventListener("click", async () => {
        try {
          await fetch("/api/stop", { method: "POST" });
          await update();
        } catch (error) {
          alert("Failed to stop drive tuning: " + (error instanceof Error ? error.message : String(error)));
        }
      });

      document.getElementById("resetDriveLearning").addEventListener("click", async () => {
        if (await window.appConfirm("Are you sure you want to reset drive learning parameters to defaults?")) {
          try {
            await fetch("/api/drive/reset-learning", { method: "POST" });
            await update();
          } catch (error) {
            alert("Failed to reset drive learning: " + (error instanceof Error ? error.message : String(error)));
          }
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
