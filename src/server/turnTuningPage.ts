import { getSensorWidgetScriptTag, getSensorWidgetLayoutStyles } from "./liveSensorWidgets.js";
import { getOperatorPageCommonScriptTag } from "./operatorPageCommon.js";
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
      max-width: 100%;
      margin: 0 auto;
      padding: 0.75rem 1rem 1rem;
      width: 100%;
    }

    .page-layout {
      display: flex;
      flex-direction: column;
      gap: 0.875rem;
    }

    .top-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.875rem;
      align-items: stretch;
    }

    .widget-shell {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 0.35rem;
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border-color);
      min-width: 0;
    }

    .widget-shell imu-sensor-widget,
    .widget-shell gnss-position-widget {
      width: 100%;
      min-height: 100%;
    }

    .compact-widget {
      --widget-padding: 0.75rem;
      --widget-title-size: 0.85rem;
      --widget-value-size: 1rem;
      --widget-label-size: 0.7rem;
    }

    .top-controls {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1rem;
      box-shadow: var(--shadow-md);
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 0.875rem;
    }

    .top-stats {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1rem;
      box-shadow: var(--shadow-md);
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .stats-list {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.65rem;
    }

    .stats-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.75rem;
      align-items: baseline;
      font-variant-numeric: tabular-nums;
    }

    .stats-row .stat-label {
      margin-bottom: 0;
    }

    .stats-row .stat-value {
      font-size: 1.1rem;
      text-align: right;
    }

    .main-column {
      min-width: 0;
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
      padding: 1rem;
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
      gap: 0.75rem;
    }

    .control-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .center-row {
      display: flex;
      justify-content: flex-start;
      gap: 0.625rem;
      flex-wrap: wrap;
      align-items: center;
    }

    .single-run-panel {
      border-radius: 0.75rem;
      padding: 0.875rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
    }

    .single-run-grid {
      display: grid;
      grid-template-columns: minmax(180px, 240px) auto;
      gap: 0.75rem;
      align-items: end;
      justify-content: start;
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

    .stat-label {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }

    .stat-value {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
      padding: 1.125rem;
      box-shadow: var(--shadow-md);
    }

    .parameters-grid {
      display: grid;
      grid-template-columns: minmax(260px, 360px) minmax(360px, 1fr) minmax(460px, 1.25fr);
      gap: 0.875rem;
    }

    .parameter-card {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1rem;
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border-color);
      min-width: 0;
    }

    .parameter-card h3 {
      font-size: 0.95rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: var(--text-primary);
    }

    .parameter-list {
      display: grid;
      gap: 0.5rem;
      font-size: 0.875rem;
    }

    .parameter-row {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      font-variant-numeric: tabular-nums;
    }

    .parameter-row span:first-child {
      color: var(--text-secondary);
    }

    .parameter-table-wrap {
      max-height: 20rem;
      overflow: auto;
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
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
      font-size: 1.125rem;
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
      font-size: 0.8125rem;
    }

    thead {
      background: var(--bg-tertiary);
    }

    th {
      padding: 0.625rem 0.75rem;
      text-align: left;
      font-weight: 600;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-color);
      white-space: nowrap;
    }

    td {
      padding: 0.625rem 0.75rem;
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

      .button-group {
        flex-direction: column;
      }

      button {
        width: 100%;
        justify-content: center;
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

      .top-grid {
        grid-template-columns: 1fr;
      }

      .single-run-grid {
        grid-template-columns: 1fr;
      }

      .parameters-grid {
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
      .stats-row {
        grid-template-columns: 1fr;
      }

      .stats-row .stat-value {
        text-align: left;
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
${getOperatorPageCommonScriptTag()}
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
      <main class="main-column">
        <button class="btn-danger stop-fab" id="stopCurrentRun">
          <span class="status-dot"></span>
          STOP
        </button>

        <div class="top-grid">
          <div class="widget-shell compact-widget" aria-label="IMU widget">
            <imu-sensor-widget id="imu-widget"></imu-sensor-widget>
          </div>
          <div class="widget-shell compact-widget" aria-label="GNSS widget">
            <gnss-position-widget id="gnss-widget"></gnss-position-widget>
          </div>

          <div class="top-controls">
            <div class="controls-stack">
              <div class="center-row">
                <button class="btn-secondary" id="clearHistory">Clear History</button>
                <button class="btn-secondary" id="resetLearning">Reset Learning</button>
                <button class="btn-primary" id="runRealPoseValidation">Validate Real Pose</button>
              </div>
            </div>

            <div class="single-run-panel">
              <div class="single-run-grid">
                <div class="control-group">
                  <label for="testAngle">Turn / Training Start Angle (degrees)</label>
                  <input type="number" id="testAngle" min="-180" max="180" step="10" value="50">
                </div>
                <div class="control-group">
                  <label>&nbsp;</label>
                  <div class="controls-stack">
                    <div class="center-row">
                      <button class="btn-primary" id="runSingleTurn">Run Single Turn</button>
                      <button class="btn-primary" id="runSmallAngleTraining">Train Small Angles</button>
                      <button class="btn-primary" id="runLargeAngleTraining">Train Large Angles</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="top-stats">
            <div class="stats-list">
              <div class="stats-row">
                <div class="stat-label">Turns Completed</div>
                <div class="stat-value" id="turnsCompleted">0</div>
              </div>
              <div class="stats-row">
                <div class="stat-label">Average Error</div>
                <div class="stat-value" id="averageError">0.0°</div>
              </div>
              <div class="stats-row">
                <div class="stat-label">Last Error</div>
                <div class="stat-value" id="lastError">—</div>
              </div>
              <div class="stats-row">
                <div class="stat-label">Controller Status</div>
                <div class="stat-value" id="statusText">Idle</div>
              </div>
              <div class="stats-row">
                <div class="stat-label">Real Pose Sweep</div>
                <div class="stat-value" id="validationStatus">Idle</div>
              </div>
            </div>
          </div>
        </div>

        <div class="parameters-grid" style="margin-top: 0.125rem; margin-bottom: 0.875rem;">
          <div class="parameter-card">
            <h3>Learning Rates</h3>
            <div class="parameter-list" id="learningDiagnostics">
              <div class="parameter-row"><span>Loading…</span><span>—</span></div>
            </div>
          </div>
          <div class="parameter-card">
            <h3>Small-Angle Buckets</h3>
            <div class="parameter-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Bucket</th>
                    <th>CCW Brake Time</th>
                    <th>CW Brake Time</th>
                    <th>CCW Samples</th>
                    <th>CW Samples</th>
                  </tr>
                </thead>
                <tbody id="smallTurnParametersBody">
                  <tr><td colspan="5">Loading…</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="parameter-card">
            <h3>Large-Angle Buckets</h3>
            <div class="parameter-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Dir</th>
                    <th>Angle</th>
                    <th>Brake Scalar</th>
                    <th>Samples</th>
                    <th>Last Error</th>
                  </tr>
                </thead>
                <tbody id="largeTurnParametersBody">
                  <tr><td colspan="5">Loading…</td></tr>
                </tbody>
              </table>
            </div>
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
                  <th>Mode</th>
                  <th>Bucket</th>
                  <th>Trigger</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="resultsTableBody">
                <tr>
                  <td colspan="9">
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

    function formatMilliseconds(ms) {
      return Number(ms).toFixed(1) + 'ms';
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

    function renderLearningDiagnostics(parameters, diagnostics) {
      const diagnosticsEl = document.getElementById('learningDiagnostics');
      const smallBody = document.getElementById('smallTurnParametersBody');
      const largeBody = document.getElementById('largeTurnParametersBody');

      if (!diagnosticsEl || !smallBody || !largeBody) {
        return;
      }

      if (!parameters || !diagnostics) {
        diagnosticsEl.innerHTML = '<div class="parameter-row"><span>Unavailable</span><span>—</span></div>';
        smallBody.innerHTML = '<tr><td colspan="5">Unavailable</td></tr>';
        largeBody.innerHTML = '<tr><td colspan="5">Unavailable</td></tr>';
        return;
      }

      diagnosticsEl.innerHTML = [
        ['Learning rate', diagnostics.learningRate?.toFixed(3) ?? '—'],
        ['Small-angle threshold', formatAngle(parameters.smallAngleThresholdDeg ?? 0)],
        ['Small brake-time clamp', formatMilliseconds(diagnostics.smallTurnBrakeTimeMinMs ?? 0) + ' .. ' + formatMilliseconds(diagnostics.smallTurnBrakeTimeMaxMs ?? 0)],
        ['Large brake-scalar clamp', formatMilliseconds(diagnostics.largeTurnBrakeScalarMinMs ?? 0) + ' .. ' + formatMilliseconds(diagnostics.largeTurnBrakeScalarMaxMs ?? 0)],
      ].map(([label, value]) => '<div class="parameter-row"><span>' + label + '</span><span>' + value + '</span></div>').join('');

      const smallBuckets = parameters.smallTurnBuckets ?? [];
      smallBody.innerHTML = smallBuckets.map(bucket => (
        '<tr>' +
          '<td>' + formatAngle(bucket.bucketAngleDeg) + '</td>' +
          '<td>' + formatMilliseconds(bucket.brakeTimeCcwMs) + '</td>' +
          '<td>' + formatMilliseconds(bucket.brakeTimeCwMs) + '</td>' +
          '<td>' + bucket.sampleCountCcw + '</td>' +
          '<td>' + bucket.sampleCountCw + '</td>' +
        '</tr>'
      )).join('') || '<tr><td colspan="5">No small-angle buckets</td></tr>';

      const largeBuckets = parameters.parameters ?? [];
      largeBody.innerHTML = largeBuckets.map(bucket => (
        '<tr>' +
          '<td>' + bucket.direction.toUpperCase() + '</td>' +
          '<td>' + formatAngle(bucket.requestedAngleDeg) + '</td>' +
          '<td>' + formatMilliseconds(bucket.brakeScalarMs) + '</td>' +
          '<td>' + (bucket.sampleCount ?? 0) + '</td>' +
          '<td>' + (bucket.lastErrorDeg === undefined ? '—' : formatAngle(bucket.lastErrorDeg)) + '</td>' +
        '</tr>'
      )).join('') || '<tr><td colspan="5">No large-angle buckets</td></tr>';
    }

    function formatControlMode(mode) {
      if (mode === 'small_timeout') return 'small timeout';
      if (mode === 'large_rate_scalar') return 'rate × scalar';
      return '—';
    }

    function formatTrigger(result) {
      if (result.triggerTimeUsedMs !== undefined) {
        return formatMilliseconds(result.triggerTimeUsedMs);
      }
      if (result.triggerProgressUsedDeg !== undefined) {
        return formatAngle(result.triggerProgressUsedDeg);
      }
      return '—';
    }

    function getRequestedStartAngle() {
      const angle = parseFloat(document.getElementById('testAngle').value);
      if (!Number.isFinite(angle)) {
        throw new Error('Please enter a valid angle');
      }
      return angle;
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
        const [data, primitives] = await Promise.all([
          window.operatorPage.fetchJson('/api/turn/status'),
          window.operatorPage.fetchJson('/api/primitives')
        ]);
        updateSensorWidgets(primitives);
        turnStateSnapshot = data.state ?? { status: 'idle' };
        realPoseValidationSnapshot = data.realPoseValidation ?? null;
        renderLearningDiagnostics(data.parameters, data.learningDiagnostics);
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
        avgErrorEl.textContent = avgError.toFixed(2) + '°';
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
              <td>\${formatControlMode(result.controlMode)}</td>
              <td>\${result.learningBucketAngleDeg === undefined ? '—' : formatAngle(result.learningBucketAngleDeg)}</td>
              <td>\${formatTrigger(result)}</td>
              <td>\${formatMilliseconds(result.durationMs)}</td>
              <td><span class="status-cell status-\${result.status}">\${result.status}</span></td>
            </tr>
          \`).join('');
        } else {
          resultsCount.textContent = '0 turns';
          tbody.innerHTML = \`
            <tr>
              <td colspan="9">
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
      pendingTurnActionId = 'runSingleTurn';
      syncTurnButtons();

      try {
        const angle = getRequestedStartAngle();
        await window.operatorPage.postJson('/api/turn/execute', { angleDeg: angle, enableLearning: true });
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
        const startAngleDeg = getRequestedStartAngle();
        await window.operatorPage.postJson('/api/turn/train-large', { iterations: 1, startAngleDeg });
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
        const startAngleDeg = getRequestedStartAngle();
        await window.operatorPage.postJson('/api/turn/train-small', { targetErrorDeg: 2, startAngleDeg });
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
        await window.operatorPage.postJson('/api/turn/train-real-pose', { iterations: 20 });
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
        await window.operatorPage.stopAll();
        await updateStatus();
      } catch (error) {
        alert('Failed to stop current run: ' + error.message);
      }
    });

    // Clear history
    document.getElementById('clearHistory').addEventListener('click', async () => {
      if (await window.appConfirm('Are you sure you want to clear all turn history?')) {
        try {
          await window.operatorPage.postJson('/api/turn/clear-history', {});
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
          await window.operatorPage.postJson('/api/turn/reset-learning', {});
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
