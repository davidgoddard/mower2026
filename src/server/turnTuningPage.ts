import { getSensorWidgetScriptTag, getSensorWidgetLayoutStyles } from "./liveSensorWidgets.js";
import { getAppDialogHtml, getAppDialogScript, getAppDialogStyles } from "./appDialogs.js";

/**
 * Turn tuning web page - modern, responsive UI for turn controller
 */


export function getTurnTuningPageHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Turn Tuning - Mower Control</title>
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
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: var(--bg-secondary);
      color: var(--text-primary);
      line-height: 1.6;
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
      border-radius: 0.75rem;
      padding: 1.25rem;
      box-shadow: var(--shadow-md);
      border: 1px solid var(--border-color);
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

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1rem;
    }

    .metric {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
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

    .header {
      background: var(--bg-primary);
      border-bottom: 1px solid var(--border-color);
      padding: 1rem 0;
      box-shadow: var(--shadow-sm);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-content {
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }

    .header-left {
      flex: 1;
    }

    .back-link {
      color: var(--primary-color);
      text-decoration: none;
      font-weight: 500;
      font-size: 0.875rem;
      transition: all 0.2s;
    }

    .back-link:hover {
      color: var(--primary-hover);
      text-decoration: underline;
    }

    h1 {
      font-size: 1.875rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.75rem;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .status-badge.running {
      background: #dbeafe;
      color: var(--primary-color);
    }

    .status-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: currentColor;
    }

    .controls-panel {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: var(--shadow-md);
    }

    .controls-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1rem;
      align-items: end;
    }

    .controls-stack {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .control-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .center-row {
      display: flex;
      justify-content: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      align-items: center;
    }

    .single-run-panel {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.25rem;
      box-shadow: var(--shadow-sm);
    }

    .single-run-grid {
      display: grid;
      grid-template-columns: minmax(220px, 320px) auto;
      gap: 1rem;
      align-items: end;
      justify-content: center;
    }

    label {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-secondary);
    }

    input[type="number"] {
      padding: 0.625rem 0.875rem;
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      font-size: 1rem;
      background: var(--bg-primary);
      color: var(--text-primary);
      transition: all 0.2s;
    }

    input[type="number"]:focus {
      outline: none;
      border-color: var(--primary-color);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }

    .button-group {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .start-button-row {
      display: flex;
      gap: 0.75rem;
      flex-wrap: nowrap;
      align-items: center;
      overflow-x: auto;
      padding-bottom: 0.25rem;
      scrollbar-width: thin;
    }

    .start-button-row button {
      flex: 0 0 auto;
      min-width: max-content;
    }

    .start-button-row .btn-primary {
      border-radius: 9999px;
    }

    button {
      padding: 0.625rem 1.25rem;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.9375rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      white-space: nowrap;
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--primary-color);
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--primary-hover);
      box-shadow: var(--shadow-md);
    }

    .btn-danger {
      background: var(--danger-color);
      color: white;
      font-weight: 600;
    }

    .btn-danger:hover:not(:disabled) {
      background: var(--danger-hover);
      box-shadow: var(--shadow-md);
    }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--border-color);
    }

    .stop-fab {
      position: fixed;
      top: 5.5rem;
      right: 1rem;
      z-index: 250;
      box-shadow: var(--shadow-lg);
      border-radius: 9999px;
      padding: 0.9rem 1.2rem;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .stat-card {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.25rem;
      box-shadow: var(--shadow-sm);
    }

    .stat-label {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }

    .stat-value {
      font-size: 1.875rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .stat-value.good {
      color: var(--success-color);
    }

    .stat-value.warning {
      color: var(--warning-color);
    }

    .results-section {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.5rem;
      box-shadow: var(--shadow-md);
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.25rem;
      gap: 1rem;
      flex-wrap: wrap;
    }

    h2 {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .table-container {
      overflow-x: auto;
      border-radius: 0.5rem;
      border: 1px solid var(--border-color);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }

    thead {
      background: var(--bg-tertiary);
    }

    th {
      padding: 0.75rem 1rem;
      text-align: left;
      font-weight: 600;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-color);
      white-space: nowrap;
    }

    td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border-color);
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    tbody tr:hover {
      background: var(--bg-secondary);
    }

    .angle-cell {
      font-weight: 600;
      color: var(--text-primary);
    }

    .error-cell {
      font-weight: 500;
    }

    .error-good {
      color: var(--success-color);
    }

    .error-warning {
      color: var(--warning-color);
    }

    .error-bad {
      color: var(--danger-color);
    }

    .status-cell {
      display: inline-block;
      padding: 0.25rem 0.625rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .status-success {
      background: #d1fae5;
      color: #065f46;
    }

    .status-timeout {
      background: #fed7aa;
      color: #92400e;
    }

    .status-stopped {
      background: #fee2e2;
      color: #991b1b;
    }

    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-secondary);
    }

    .empty-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    /* Mobile responsiveness */
    @media (max-width: 768px) {
      h1 {
        font-size: 1.25rem;
      }

      .controls-grid {
        grid-template-columns: 1fr;
      }

      .button-group {
        flex-direction: column;
      }

      button {
        width: 100%;
        justify-content: center;
      }

      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .stat-value {
        font-size: 1.5rem;
      }

      .header-content {
        flex-direction: column;
        align-items: flex-start;
      }

      .stop-fab {
        top: auto;
        bottom: 1rem;
        right: 1rem;
      }

      .page-layout {
        grid-template-columns: 1fr;
      }

      .sidebar-column {
        position: static;
      }

      .single-run-grid {
        grid-template-columns: 1fr;
      }

      table {
        font-size: 0.8125rem;
      }

      th, td {
        padding: 0.5rem 0.75rem;
      }
    }

    @media (max-width: 480px) {
      .stats-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Loading spinner */
    .spinner {
      display: inline-block;
      width: 1rem;
      height: 1rem;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
${getSensorWidgetScriptTag()}
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="header-left">
        <h1>🔄 Turn Tuning</h1>
      </div>
      <div class="status-badge" id="controllerStatus">
        <span class="status-dot"></span>
        <span>Idle</span>
      </div>
      <a href="/" class="back-link">← Back to Dashboard</a>
    </div>
  </div>

      <div class="container">
        <div class="page-layout">
          <aside class="sidebar-column" aria-label="Live primitives">
            <imu-sensor-widget id="imu-widget"></imu-sensor-widget>
            <gnss-position-widget id="gnss-widget"></gnss-position-widget>
      </aside>

      <main class="main-column">
        <button class="btn-danger stop-fab" id="stopCurrentRun">
          <span class="status-dot"></span>
          STOP
        </button>

        <!-- Controls Panel -->
        <div class="controls-panel">
          <div class="controls-stack">
            <div class="center-row">
              <button class="btn-primary" id="runLargeAngleTraining">Train Large Angles</button>
              <button class="btn-primary" id="runSmallAngleTraining">Train Small Angles</button>
              <button class="btn-primary" id="runRealPoseValidation">Validate Real Pose</button>
            </div>

            <div class="center-row">
              <button class="btn-secondary" id="clearHistory">Clear History</button>
              <button class="btn-secondary" id="resetLearning">Reset Learning</button>
            </div>
          </div>

          <div class="single-run-panel" style="margin-top: 1rem;">
            <div class="single-run-grid">
              <div class="control-group">
                <label for="testAngle">Test Angle (degrees)</label>
                <input type="number" id="testAngle" min="-180" max="180" step="10" value="50">
              </div>
              <div class="control-group">
                <label>&nbsp;</label>
                <button class="btn-primary" id="runSingleTurn">Run Single Turn</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Statistics -->
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Turns Completed</div>
            <div class="stat-value" id="turnsCompleted">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Average Error</div>
            <div class="stat-value" id="averageError">0.0°</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Last Error</div>
            <div class="stat-value" id="lastError">—</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Controller Status</div>
            <div class="stat-value" id="statusText">Idle</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Real Pose Sweep</div>
            <div class="stat-value" id="validationStatus">Idle</div>
          </div>
        </div>

        <!-- Results Table -->
        <div class="results-section">
          <div class="section-header">
            <h2>Turn Results</h2>
            <span style="font-size: 0.875rem; color: var(--text-secondary);" id="resultsCount">0 turns</span>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Requested</th>
                  <th>Achieved</th>
                  <th>Error</th>
                  <th>Duration</th>
                  <th>Brake Distance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="resultsTableBody">
                <tr>
                  <td colspan="7">
                    <div class="empty-state">
                      <div class="empty-icon">📊</div>
                      <div>No turn results yet. Run a turn to see results here.</div>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Real Pose Validation -->
        <div class="results-section" style="margin-top: 1.5rem;">
          <div class="section-header">
            <h2>Real Pose Validation</h2>
            <span style="font-size: 0.875rem; color: var(--text-secondary);" id="validationResultsCount">0 turns</span>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Start Heading</th>
                  <th>Target Heading</th>
                  <th>Turn Angle</th>
                  <th>IMU Achieved</th>
                  <th>Real Pose Change</th>
                  <th>Real Pose Heading</th>
                  <th>Pose Error</th>
                  <th>Pose Quality</th>
                </tr>
              </thead>
              <tbody id="validationResultsTableBody">
                <tr>
                  <td colspan="9">
                    <div class="empty-state">
                      <div class="empty-icon">📍</div>
                      <div>No real-pose validation results yet. Run a sweep to compare IMU and pose results here.</div>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  </div>

${getAppDialogHtml()}

  <script>
${getAppDialogScript()}
    let updateInterval = null;


    // Format time
    function formatTime(isoString) {
      const date = new Date(isoString);
      return date.toLocaleTimeString();
    }

    // Format angle
    function formatAngle(deg) {
      return deg >= 0 ? \`+\${deg.toFixed(1)}°\` : \`\${deg.toFixed(1)}°\`;
    }

    // Get error class
    function getErrorClass(errorDeg) {
      const abs = Math.abs(errorDeg);
      if (abs <= 2) return 'error-good';
      if (abs <= 5) return 'error-warning';
      return 'error-bad';
    }

    function getPoseQualityClass(quality) {
      if (quality === 'gnss') return 'status-success';
      if (quality === 'dead-reckoning') return 'status-timeout';
      return 'status-stopped';
    }

    function updateSensorWidgets(primitivesPayload) {
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

    function formatValidationStatus(validationState) {
      if (!validationState) return 'Idle';
      if (validationState.running) {
        return \`Running \${validationState.completedIterations}/\${validationState.totalIterations}\`;
      }
      if (validationState.stopRequested) {
        return \`Stopped \${validationState.completedIterations}/\${validationState.totalIterations}\`;
      }
      return validationState.completedIterations > 0
        ? \`Complete \${validationState.completedIterations}/\${validationState.totalIterations}\`
        : 'Idle';
    }

    const turnActionButtons = [
      { id: 'runSingleTurn', idleLabel: 'Run Single Turn', pendingLabel: '<span class="spinner"></span> Running...' },
      { id: 'runLargeAngleTraining', idleLabel: 'Train Large Angles', pendingLabel: '<span class="spinner"></span> Training Large Angles...' },
      { id: 'runSmallAngleTraining', idleLabel: 'Train Small Angles', pendingLabel: '<span class="spinner"></span> Training Small Angles...' },
      { id: 'runRealPoseValidation', idleLabel: 'Validate Real Pose', pendingLabel: '<span class="spinner"></span> Validating Real Pose...' },
    ];
    let turnStateSnapshot = { status: 'idle' };
    let realPoseValidationSnapshot = null;
    let pendingTurnActionId = null;
    let stopRequestPending = false;

    function isTurnRunActive(turnState, validationState) {
      const turnStatus = turnState?.status ?? 'idle';
      if (turnStatus !== 'idle' && turnStatus !== 'stopped') {
        return true;
      }
      return Boolean(validationState?.running);
    }

    function syncTurnButtons() {
      const runActive = isTurnRunActive(turnStateSnapshot, realPoseValidationSnapshot);
      if (runActive) {
        pendingTurnActionId = null;
      }

      for (const config of turnActionButtons) {
        const button = document.getElementById(config.id);
        if (!button) continue;
        const isPending = pendingTurnActionId === config.id;
        button.disabled = runActive || isPending;
        button.innerHTML = isPending ? config.pendingLabel : config.idleLabel;
      }

      const stopButton = document.getElementById('stopCurrentRun');
      if (stopButton) {
        stopButton.disabled = false;
      }
    }

    // Update UI with status data
    async function updateStatus() {
      try {
        const [turnResponse, primitivesResponse] = await Promise.all([
          fetch('/api/turn/status'),
          fetch('/api/primitives')
        ]);
        const data = await turnResponse.json();
        const primitives = await primitivesResponse.json();
        updateSensorWidgets(primitives);
        turnStateSnapshot = data.state ?? { status: 'idle' };
        realPoseValidationSnapshot = data.realPoseValidation ?? null;
        syncTurnButtons();

        // Update controller status badge
        const statusBadge = document.getElementById('controllerStatus');
        const statusSpan = statusBadge.querySelector('span:last-child');
        statusSpan.textContent = data.state.status.charAt(0).toUpperCase() + data.state.status.slice(1);
        statusBadge.className = 'status-badge';
        if (data.state.status !== 'idle') {
          statusBadge.classList.add('running');
        }

        // Update stats
        document.getElementById('turnsCompleted').textContent = data.state.turnsCompleted;
        document.getElementById('statusText').textContent = data.state.status.charAt(0).toUpperCase() + data.state.status.slice(1);
        document.getElementById('validationStatus').textContent = formatValidationStatus(data.realPoseValidation);

        const avgError = data.state.averageErrorDeg;
        const avgErrorEl = document.getElementById('averageError');
        avgErrorEl.textContent = \`\${avgError.toFixed(2)}°\`;
        avgErrorEl.className = 'stat-value ' + (avgError <= 2 ? 'good' : avgError <= 5 ? 'warning' : '');

        // Update last error
        if (data.history && data.history.length > 0) {
          const lastResult = data.history[data.history.length - 1];
          const lastErrorDeg = lastResult.errorAngle;
          const lastErrorEl = document.getElementById('lastError');
          lastErrorEl.textContent = formatAngle(lastErrorDeg);
          lastErrorEl.className = 'stat-value ' + getErrorClass(lastErrorDeg);
        }

        // Update results table
        const tbody = document.getElementById('resultsTableBody');
        const resultsCount = document.getElementById('resultsCount');
        const validationTbody = document.getElementById('validationResultsTableBody');
        const validationResultsCount = document.getElementById('validationResultsCount');

        if (data.history && data.history.length > 0) {
          resultsCount.textContent = \`\${data.history.length} turn\${data.history.length !== 1 ? 's' : ''}\`;

          tbody.innerHTML = data.history.slice().reverse().slice(0, 50).map(result => \`
            <tr>
              <td>\${formatTime(result.timestamp)}</td>
              <td class="angle-cell">\${formatAngle(result.requestedAngle)}</td>
              <td class="angle-cell">\${formatAngle(result.achievedAngle)}</td>
              <td class="error-cell \${getErrorClass(result.errorAngle)}">\${formatAngle(result.errorAngle)}</td>
              <td>\${result.durationMs}ms</td>
              <td>\${formatAngle(result.brakeDistanceUsed)}</td>
              <td><span class="status-cell status-\${result.status}">\${result.status}</span></td>
            </tr>
          \`).join('');
        } else {
          resultsCount.textContent = '0 turns';
          tbody.innerHTML = \`
            <tr>
              <td colspan="7">
                <div class="empty-state">
                  <div class="empty-icon">📊</div>
                  <div>No turn results yet. Run a turn to see results here.</div>
                </div>
              </td>
            </tr>
          \`;
        }

        if (data.realPoseHistory && data.realPoseHistory.length > 0) {
          validationResultsCount.textContent = \`\${data.realPoseHistory.length} turn\${data.realPoseHistory.length !== 1 ? 's' : ''}\`;
          validationTbody.innerHTML = data.realPoseHistory.slice().reverse().slice(0, 50).map(result => \`
            <tr>
              <td>\${formatTime(result.timestamp)}</td>
              <td class="angle-cell">\${formatAngle(result.startHeading)}</td>
              <td class="angle-cell">\${formatAngle(result.targetHeading)}</td>
              <td class="angle-cell">\${formatAngle(result.targetAngle)}</td>
              <td class="angle-cell">\${formatAngle(result.imuAchievedAngle)}</td>
              <td class="angle-cell">\${result.realPoseChange === null ? '—' : formatAngle(result.realPoseChange)}</td>
              <td class="angle-cell">\${result.realPoseHeading === null ? '—' : formatAngle(result.realPoseHeading)}</td>
              <td class="error-cell \${result.poseErrorAngle === null ? '' : getErrorClass(result.poseErrorAngle)}">\${result.poseErrorAngle === null ? '—' : formatAngle(result.poseErrorAngle)}</td>
              <td><span class="status-cell \${getPoseQualityClass(result.poseQuality)}">\${result.poseQuality ?? 'unknown'}</span></td>
            </tr>
          \`).join('');
        } else {
          validationResultsCount.textContent = '0 turns';
          validationTbody.innerHTML = \`
            <tr>
              <td colspan="9">
                <div class="empty-state">
                  <div class="empty-icon">📍</div>
                  <div>No real-pose validation results yet. Run a sweep to compare IMU and pose results here.</div>
                </div>
              </td>
            </tr>
          \`;
        }
      } catch (error) {
        console.error('Failed to update status:', error);
        syncTurnButtons();
      }
    }

    // Run single turn
    document.getElementById('runSingleTurn').addEventListener('click', async () => {
      const angle = parseFloat(document.getElementById('testAngle').value);
      pendingTurnActionId = 'runSingleTurn';
      syncTurnButtons();

      try {
        await fetch('/api/turn/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ angleDeg: angle, enableLearning: true })
        });
        await updateStatus();
      } catch (error) {
        alert('Failed to execute turn: ' + error.message);
      } finally {
        pendingTurnActionId = null;
        syncTurnButtons();
      }
    });

    // Run large-angle training sequence
    document.getElementById('runLargeAngleTraining').addEventListener('click', async () => {
      pendingTurnActionId = 'runLargeAngleTraining';
      syncTurnButtons();

      try {
        await fetch('/api/turn/train-large', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ iterations: 1 })
        });
        await updateStatus();
      } catch (error) {
        alert('Failed to train large angles: ' + error.message);
      } finally {
        pendingTurnActionId = null;
        syncTurnButtons();
      }
    });

    // Run small-angle training sequence
    document.getElementById('runSmallAngleTraining').addEventListener('click', async () => {
      pendingTurnActionId = 'runSmallAngleTraining';
      syncTurnButtons();

      try {
        await fetch('/api/turn/train-small', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetErrorDeg: 2 })
        });
        await updateStatus();
      } catch (error) {
        alert('Failed to train small angles: ' + error.message);
      } finally {
        pendingTurnActionId = null;
        syncTurnButtons();
      }
    });

    // Run real-pose validation sequence
    document.getElementById('runRealPoseValidation').addEventListener('click', async () => {
      pendingTurnActionId = 'runRealPoseValidation';
      syncTurnButtons();

      try {
        await updateStatus();
        await fetch('/api/turn/train-real-pose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ iterations: 20 })
        });
        await updateStatus();
      } catch (error) {
        alert('Failed to validate real pose: ' + error.message);
      } finally {
        pendingTurnActionId = null;
        syncTurnButtons();
      }
    });

    document.getElementById('stopCurrentRun').addEventListener('click', async () => {
      try {
        await fetch('/api/stop', { method: 'POST' });
        await updateStatus();
      } catch (error) {
        alert('Failed to stop current run: ' + error.message);
      }
    });

    // Clear history
    document.getElementById('clearHistory').addEventListener('click', async () => {
      if (await window.appConfirm('Are you sure you want to clear all turn history?')) {
        try {
          await fetch('/api/turn/clear-history', { method: 'POST' });
          await updateStatus();
        } catch (error) {
          alert('Failed to clear history: ' + error.message);
        }
      }
    });

    // Reset learning
    document.getElementById('resetLearning').addEventListener('click', async () => {
      if (await window.appConfirm('Are you sure you want to reset turn learning parameters to defaults?')) {
        try {
          await fetch('/api/turn/reset-learning', { method: 'POST' });
          await updateStatus();
        } catch (error) {
          alert('Failed to reset learning: ' + error.message);
        }
      }
    });

    // Initial update and start polling
    updateStatus();
    updateInterval = setInterval(updateStatus, 1000);

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
      if (updateInterval) {
        clearInterval(updateInterval);
      }
    });
  </script>
</body>
</html>
  `;
}
