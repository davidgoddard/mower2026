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
        display: flex;
        flex-direction: column;
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
          <div class="sensor-card">
            <div class="sensor-header">
              <div class="sensor-title">IMU Sensor</div>
              <span class="status-dot" id="imu-status"></span>
            </div>
            <div class="compass" id="imu-compass">
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
            <div class="tilt-indicators">
              <div class="tilt-indicator">
                <div class="tilt-circle" id="pitch-indicator">
                  <div class="tilt-line"></div>
                  <div class="tilt-center"></div>
                </div>
                <div class="tilt-label">Pitch</div>
                <div class="tilt-value" id="imu-pitch">—</div>
              </div>
              <div class="tilt-indicator">
                <div class="tilt-circle" id="roll-indicator">
                  <div class="tilt-line"></div>
                  <div class="tilt-center"></div>
                </div>
                <div class="tilt-label">Roll</div>
                <div class="tilt-value" id="imu-roll">—</div>
              </div>
            </div>
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
                    <th>Quality</th>
                    <th>Avg CTE</th>
                    <th>Max CTE</th>
                    <th>X Error</th>
                    <th>Y Error</th>
                  </tr>
                </thead>
                <tbody id="segmentResultsTableBody">
                  <tr>
                    <td colspan="11" class="empty-row">Run segment testing to see waypoint distance, heading change, CTE and arrival errors here.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>
      function internalToNavigationHeading(headingDeg) {
        return (90 - headingDeg + 360) % 360;
      }

      function formatDegrees(value) {
        if (value === null || value === undefined || Number.isNaN(value)) {
          return "—";
        }
        return (value >= 0 ? "+" : "") + value.toFixed(1) + "°";
      }

      function formatMeters(value) {
        if (value === null || value === undefined || Number.isNaN(value)) {
          return "—";
        }
        return value.toFixed(2) + " m";
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

      function applyFixStyle(element, fixType) {
        if (!element) {
          return;
        }
        const classes = ["gnss-fix-unknown", "gnss-fix-none", "gnss-fix-single", "gnss-fix-float", "gnss-fix-fixed", "gnss-fix-rtk-fixed", "gnss-fix-rtk-float"];
        element.classList.remove(...classes);
        element.classList.add("gnss-fix-" + String(fixType || "unknown"));
      }

      function updateSidebar(primitives) {
        const imu = primitives?.imu ?? {};
        const gnss = primitives?.gnss ?? {};

        const imuStatusDot = document.getElementById("imu-status");
        if (imuStatusDot) {
          imuStatusDot.className = "status-dot " + (imu.status || "idle");
        }
        const imuError = document.getElementById("imu-error");
        if (imu.status === "error") {
          if (imuError) {
            imuError.textContent = imu.error || "IMU error";
            imuError.style.display = "block";
          }
        } else if (imuError) {
          imuError.style.display = "none";
        }

        const imuHeading = document.getElementById("imu-heading");
        const imuPitch = document.getElementById("imu-pitch");
        const imuRoll = document.getElementById("imu-roll");
        const imuCompass = document.getElementById("imu-compass");
        const pitchIndicator = document.getElementById("pitch-indicator");
        const rollIndicator = document.getElementById("roll-indicator");
        if (imuHeading) imuHeading.textContent = imu.headingDeg !== null && imu.headingDeg !== undefined ? formatDegrees(internalToNavigationHeading(imu.headingDeg)) : "—";
        if (imuPitch) {
          imuPitch.textContent = imu.pitchDeg !== null && imu.pitchDeg !== undefined ? formatDegrees(imu.pitchDeg) : "—";
        }
        if (pitchIndicator) {
          pitchIndicator.style.setProperty("--tilt-deg", (imu.pitchDeg !== null && imu.pitchDeg !== undefined ? imu.pitchDeg : 0) + "deg");
        }
        if (imuRoll) {
          imuRoll.textContent = imu.rollDeg !== null && imu.rollDeg !== undefined ? formatDegrees(imu.rollDeg) : "—";
        }
        if (rollIndicator) {
          rollIndicator.style.setProperty("--tilt-deg", (imu.rollDeg !== null && imu.rollDeg !== undefined ? imu.rollDeg : 0) + "deg");
        }
        if (imu.headingDeg !== null && imu.headingDeg !== undefined && imuCompass) {
          imuCompass.style.setProperty("--heading-deg", internalToNavigationHeading(imu.headingDeg) + "deg");
        }

        const gnssStatusDot = document.getElementById("gnss-status");
        if (gnssStatusDot) {
          gnssStatusDot.className = "status-dot " + (gnss.status || "idle");
        }
        const gnssError = document.getElementById("gnss-error");
        if (gnss.status === "error") {
          if (gnssError) {
            gnssError.textContent = gnss.error || "GNSS error";
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
        applyFixStyle(gnssFix, gnss.fixType);
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
            tbody.innerHTML = '<tr><td colspan="11" class="empty-row">Run segment testing to see waypoint distance, heading change, CTE and arrival errors here.</td></tr>';
            return;
          }

          tbody.innerHTML = rows.map((item) => {
            const qualityClass = statusClass(item.driveStatus);
            return [
              "<tr>",
              "<td>" + formatTime(item.timestamp) + "</td>",
              "<td>" + item.phase + "</td>",
              "<td>" + item.waypointLabel + "</td>",
              "<td>" + formatMeters(item.distanceToWaypointMeters) + "</td>",
              "<td>" + formatDegrees(item.requiredHeadingChangeDeg) + "</td>",
              "<td>" + formatDegrees(item.achievedHeadingChangeDeg) + "</td>",
              '<td class="' + qualityClass + '">' + item.driveStatus + '</td>',
              "<td>" + formatMeters(item.cteMeters) + "</td>",
              "<td>" + formatMeters(item.maxCteMeters) + "</td>",
              "<td>" + formatMeters(item.xErrorMeters) + "</td>",
              "<td>" + formatMeters(item.yErrorMeters) + "</td>",
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
