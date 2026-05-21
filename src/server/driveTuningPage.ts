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
        display: flex;
        flex-direction: column;
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
        grid-template-columns: minmax(180px, 240px) auto;
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

      input[type="number"] {
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
          <div class="sensor-card">
            <div class="sensor-header">
              <div class="sensor-title">IMU Sensor</div>
              <span class="status-dot" id="imu-status"></span>
            </div>
            <div class="compass" id="compass">
              <div class="compass-circle">
                <div class="compass-label n">N</div>
                <div class="compass-label e">E</div>
                <div class="compass-label s">S</div>
                <div class="compass-label w">W</div>
                <div class="compass-needle"></div>
                <div class="compass-center"></div>
              </div>
            </div>
            <div class="position-display">
              <div class="metric-label">Heading</div>
              <div class="metric-value large" id="imu-heading">—</div>
            </div>
            <div class="metric-label" style="margin-top: 0.75rem;">Pitch</div>
            <div class="metric-value" id="imu-pitch">—</div>
            <div class="metric-label" style="margin-top: 0.5rem;">Roll</div>
            <div class="metric-value" id="imu-roll">—</div>
            <div id="imu-error" class="error-message" style="display: none;"></div>
          </div>

          <div class="sensor-card">
            <div class="sensor-header">
              <div class="sensor-title">GNSS Position</div>
              <span class="status-dot" id="gnss-status"></span>
            </div>
            <div class="compass" id="gnss-compass">
              <div class="compass-circle">
                <div class="compass-label n">N</div>
                <div class="compass-label e">E</div>
                <div class="compass-label s">S</div>
                <div class="compass-label w">W</div>
                <div class="compass-needle"></div>
                <div class="compass-center"></div>
              </div>
            </div>
            <div class="gnss-summary">
              <div class="gnss-row three">
                <div class="metric">
                  <div class="metric-label">X</div>
                  <div class="metric-value" id="gnss-x">—</div>
                </div>
                <div class="metric">
                  <div class="metric-label">Y</div>
                  <div class="metric-value" id="gnss-y">—</div>
                </div>
                <div class="metric">
                  <div class="metric-label">Accuracy</div>
                  <div class="metric-value" id="gnss-accuracy">—</div>
                </div>
              </div>
              <div class="gnss-row two">
                <div class="metric">
                  <div class="metric-label">Heading</div>
                  <div class="metric-value" id="gnss-heading">—</div>
                </div>
                <div class="metric">
                  <div class="metric-label">Heading Accuracy</div>
                  <div class="metric-value" id="gnss-heading-accuracy">—</div>
                </div>
              </div>
              <div class="gnss-row two">
                <div class="metric">
                  <div class="metric-label">Fix Type</div>
                  <div class="metric-value gnss-fix-value" id="gnss-fix">—</div>
                </div>
                <div class="metric">
                  <div class="metric-label">Satellites</div>
                  <div class="metric-value" id="gnss-sats">—</div>
                </div>
              </div>
            </div>
            <div id="gnss-error" class="error-message" style="display: none;"></div>
          </div>
        </aside>

        <main class="main-column">
          <section class="panel">
            <div class="controls">
              <div class="field">
                <label for="startDistanceCm">Start at (cm)</label>
                <input id="startDistanceCm" type="number" min="50" step="5" value="50" />
              </div>
              <div class="buttons">
                <button id="startDriveTuning" class="primary">start tuning</button>
                <button id="stopDriveTuning" class="danger">STOP</button>
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
                    <th>CTE</th>
                    <th>X Error</th>
                    <th>Y Error</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody id="driveResultsTableBody">
                  <tr>
                    <td colspan="5" class="empty">Run drive tuning to see distance, CTE and arrival error here.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>
    </div>

    <script>
      function formatMeters(value) {
        if (value === null || value === undefined) return '—';
        return value.toFixed(3) + ' m';
      }

      function formatDegrees(value) {
        if (value === null || value === undefined) return '—';
        return value.toFixed(1) + '°';
      }

      function internalToNavigationHeading(internalDeg) {
        if (internalDeg === null || internalDeg === undefined) return null;
        let navHeading = 90 - internalDeg;
        while (navHeading < 0) navHeading += 360;
        while (navHeading >= 360) navHeading -= 360;
        return navHeading;
      }

      function getGnssFixClass(fixType) {
        switch ((fixType || 'unknown').toLowerCase()) {
          case 'fixed':
            return 'gnss-fix-fixed';
          case 'rtk-fixed':
            return 'gnss-fix-rtk-fixed';
          case 'float':
            return 'gnss-fix-float';
          case 'rtk-float':
            return 'gnss-fix-rtk-float';
          case 'single':
            return 'gnss-fix-single';
          case 'none':
            return 'gnss-fix-none';
          default:
            return 'gnss-fix-unknown';
        }
      }

      function applyGnssFixStyle(fixType) {
        const fixValue = document.getElementById("gnss-fix");
        if (!fixValue) return;
        fixValue.className = "metric-value gnss-fix-value " + getGnssFixClass(fixType);
      }

      function updateSidebar(primitivesPayload) {
        const primitives = primitivesPayload?.primitives ?? {};
        const imu = primitives.imu ?? {};
        const gnss = primitives.gnss ?? {};

        const imuStatusDot = document.getElementById("imu-status");
        if (imuStatusDot) {
          imuStatusDot.className = "status-dot " + (imu.status || "idle");
        }

        const imuError = document.getElementById("imu-error");
        if (imu.status === "error") {
          if (imuError) {
            imuError.textContent = imu.error;
            imuError.style.display = "block";
          }
          const imuHeading = document.getElementById("imu-heading");
          const imuPitch = document.getElementById("imu-pitch");
          const imuRoll = document.getElementById("imu-roll");
          if (imuHeading) imuHeading.textContent = "—";
          if (imuPitch) imuPitch.textContent = "—";
          if (imuRoll) imuRoll.textContent = "—";
        } else {
          if (imuError) {
            imuError.style.display = "none";
          }
          if (imu.headingDeg !== null && imu.headingDeg !== undefined) {
            const navHeading = internalToNavigationHeading(imu.headingDeg);
            const imuHeading = document.getElementById("imu-heading");
            const compass = document.getElementById("compass");
            if (imuHeading) imuHeading.textContent = formatDegrees(navHeading);
            if (compass) compass.style.setProperty("--heading-deg", navHeading + "deg");
          }
          if (imu.pitchDeg !== null && imu.pitchDeg !== undefined) {
            const imuPitch = document.getElementById("imu-pitch");
            if (imuPitch) imuPitch.textContent = formatDegrees(imu.pitchDeg);
          }
          if (imu.rollDeg !== null && imu.rollDeg !== undefined) {
            const imuRoll = document.getElementById("imu-roll");
            if (imuRoll) imuRoll.textContent = formatDegrees(imu.rollDeg);
          }
        }

        const gnssStatusDot = document.getElementById("gnss-status");
        if (gnssStatusDot) {
          gnssStatusDot.className = "status-dot " + (gnss.status || "idle");
        }

        const gnssError = document.getElementById("gnss-error");
        if (gnss.status === "error") {
          if (gnssError) {
            gnssError.textContent = gnss.error;
            gnssError.style.display = "block";
          }
        } else if (gnssError) {
          gnssError.style.display = "none";
        }

        const gnssX = document.getElementById("gnss-x");
        const gnssY = document.getElementById("gnss-y");
        const gnssAccuracy = document.getElementById("gnss-accuracy");
        const gnssHeadingAccuracy = document.getElementById("gnss-heading-accuracy");
        const gnssSats = document.getElementById("gnss-sats");
        const gnssFix = document.getElementById("gnss-fix");
        const gnssHeading = document.getElementById("gnss-heading");
        const gnssCompass = document.getElementById("gnss-compass");

        if (gnssX) gnssX.textContent = formatMeters(gnss.xMeters);
        if (gnssY) gnssY.textContent = formatMeters(gnss.yMeters);
        if (gnssFix) gnssFix.textContent = gnss.fixType || "—";
        applyGnssFixStyle(gnss.fixType);
        if (gnssAccuracy) {
          gnssAccuracy.textContent = gnss.positionAccuracyMeters !== null && gnss.positionAccuracyMeters !== undefined
            ? formatMeters(gnss.positionAccuracyMeters)
            : "—";
        }
        if (gnssHeadingAccuracy) {
          gnssHeadingAccuracy.textContent = gnss.headingAccuracyDeg !== null && gnss.headingAccuracyDeg !== undefined
            ? formatDegrees(gnss.headingAccuracyDeg)
            : "—";
        }
        if (gnssSats) {
          gnssSats.textContent = gnss.satellitesInUse !== null && gnss.satellitesInUse !== undefined
            ? gnss.satellitesInUse
            : "—";
        }
        if (gnss.headingDeg !== null && gnss.headingDeg !== undefined) {
          const navHeading = internalToNavigationHeading(gnss.headingDeg);
          if (gnssHeading) gnssHeading.textContent = formatDegrees(navHeading);
          if (gnssCompass) gnssCompass.style.setProperty("--heading-deg", navHeading + "deg");
        } else if (gnssHeading) {
          gnssHeading.textContent = "—";
        }
      }

      function formatCm(meters) {
        return \`\${(meters * 100).toFixed(1)} cm\`;
      }

      function statusClass(value) {
        const abs = Math.abs(value);
        if (abs <= 0.04) return "good";
        if (abs <= 0.12) return "warn";
        return "bad";
      }

      function currentDriveDistanceMeters(historyItem) {
        const dx = historyItem.targetPosition.xMeters - historyItem.startPosition.xMeters;
        const dy = historyItem.targetPosition.yMeters - historyItem.startPosition.yMeters;
        return Math.hypot(dx, dy);
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
          updateSidebar(payload.primitives);

          const driveState = data.state ?? {};
          document.getElementById("driveStatus").textContent = driveState.status ?? "idle";
          const results = Array.isArray(driveState.shortTrainingResults) && driveState.shortTrainingResults.length > 0
            ? driveState.shortTrainingResults
            : history;
          document.getElementById("driveRunCount").textContent = String(results.length ?? history.length ?? 0);
          document.getElementById("driveSummary").textContent = driveState.shortTrainingProgress?.message
            ?? driveState.segmentTrainingProgress?.message
            ?? "Drive tuning idle.";
          document.getElementById("driveCurrentTarget").textContent = driveState.currentDrive
            ? \`(\${formatCm(driveState.currentDrive.targetPosition.xMeters ?? 0)}, \${formatCm(driveState.currentDrive.targetPosition.yMeters ?? 0)})\`
            : "-";

          const rows = results.slice(-25).reverse();
          const tbody = document.getElementById("driveResultsTableBody");
          if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty">Run drive tuning to see distance, CTE and arrival error here.</td></tr>';
            return;
          }

          tbody.innerHTML = rows.map((item) => {
            const distanceMeters = currentDriveDistanceMeters(item);
            const avgCteMeters = item.avgCteMeters ?? 0;
            const xErrorMeters = item.errorX ?? 0;
            const yErrorMeters = item.errorY ?? 0;
            return \`
              <tr>
                <td>\${formatCm(distanceMeters)}</td>
                <td class="\${statusClass(avgCteMeters)}">\${formatCm(avgCteMeters)}</td>
                <td class="\${statusClass(xErrorMeters)}">\${formatCm(xErrorMeters)}</td>
                <td class="\${statusClass(yErrorMeters)}">\${formatCm(yErrorMeters)}</td>
                <td>\${item.status ?? "-"}</td>
              </tr>
            \`;
          }).join("");
        } catch (error) {
          console.error("Failed to update drive tuning page:", error);
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
        const button = document.getElementById("startDriveTuning");
        const startDistanceCm = Number(document.getElementById("startDistanceCm").value);
        const startAtCm = Number.isFinite(startDistanceCm) ? Math.max(50, startDistanceCm).toFixed(0) : "50";
        document.getElementById("driveSummary").textContent = "Starting short-distance training from " + startAtCm + " cm...";
        button.disabled = true;
        try {
          await postAction("train-short", {
            startDistanceMeters: Number.isFinite(startDistanceCm) ? Math.max(0.5, startDistanceCm / 100) : 0.5,
            targetXErrorMeters: 0.04,
            includeReverseLegs: true,
          });
          await update();
        } catch (error) {
          alert("Failed to start drive tuning: " + (error instanceof Error ? error.message : String(error)));
        } finally {
          button.disabled = false;
        }
      });

      document.getElementById("stopDriveTuning").addEventListener("click", async () => {
        try {
          await postAction("stop");
          await update();
        } catch (error) {
          alert("Failed to stop drive tuning: " + (error instanceof Error ? error.message : String(error)));
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
