import { getSensorWidgetScriptTag, getSensorWidgetLayoutStyles } from "./liveSensorWidgets.js";
import { getAppDialogHtml, getAppDialogScript, getAppDialogStyles } from "./appDialogs.js";


export function getDeadReckoningPageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dead-Reckoning Calibration - Mower Control</title>
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

      * { box-sizing: border-box; }

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
        max-width: 1400px;
        margin: 0 auto;
        padding: 0.75rem 1.5rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
      }

      h1 { margin: 0; font-size: 1.5rem; }

      .back-link {
        color: var(--primary-color);
        text-decoration: none;
        font-weight: 600;
      }

      .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 0.75rem 1.5rem;
        width: 100%;
        flex: 1;
      }

      /* Widgets row across the top, scaled smaller than full size */
      .widgets-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.75rem;
        margin-bottom: 0.75rem;
        align-items: start;
      }

      .widgets-row > * {
        zoom: 0.82;
      }

      /* Two-column layout for Controls + Test Moves */
      .work-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 1rem;
        align-items: start;
        margin-bottom: 1rem;
      }

      .panel {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
        box-shadow: var(--shadow-md);
        padding: 1rem 1.1rem;
        margin-bottom: 0.75rem;
      }

      .panel h2 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 0.5rem;
      }

      .buttons {
        display: flex;
        gap: 0.6rem;
        flex-wrap: wrap;
        margin-bottom: 0.75rem;
      }

      .input-row {
        display: grid;
        grid-template-columns: minmax(180px, 1fr) auto;
        gap: 0.75rem;
        align-items: end;
        margin-bottom: 0.75rem;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
      }

      .field label {
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }

      .field input {
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        padding: 0.55rem 0.75rem;
        font-size: 0.95rem;
        background: var(--bg-primary);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      .field input:focus {
        outline: 2px solid rgba(37, 99, 235, 0.18);
        border-color: var(--primary-color);
      }

      button {
        border: none;
        border-radius: 0.5rem;
        padding: 0.55rem 1.1rem;
        font-size: 0.95rem;
        font-weight: 700;
        cursor: pointer;
        transition: background 0.15s;
      }

      button:disabled { opacity: 0.45; cursor: not-allowed; }

      .primary { background: var(--primary-color); color: white; }
      .primary:hover:not(:disabled) { background: var(--primary-hover); }
      .danger { background: var(--danger-color); color: white; }
      .danger:hover:not(:disabled) { background: var(--danger-hover); }
      .secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border: 1px solid var(--border-color);
      }
      .secondary:hover:not(:disabled) { background: var(--border-color); }

      /* Phase progress */
      .phase-bar {
        display: flex;
        gap: 0.3rem;
        margin-bottom: 0.5rem;
      }

      .phase-step {
        flex: 1;
        padding: 0.3rem 0.4rem;
        border-radius: 0.375rem;
        font-size: 0.7rem;
        font-weight: 600;
        text-align: center;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        border: 1px solid var(--border-color);
        transition: all 0.2s;
      }

      .phase-step.active {
        background: #eff6ff;
        border-color: var(--primary-color);
        color: var(--primary-color);
      }

      .phase-step.done {
        background: #ecfdf5;
        border-color: var(--success-color);
        color: #065f46;
      }

      .phase-step.error {
        background: #fef2f2;
        border-color: var(--danger-color);
        color: #991b1b;
      }

      /* Status message */
      .status-message {
        padding: 0.5rem 0.75rem;
        border-radius: 0.5rem;
        font-size: 0.85rem;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        color: var(--text-secondary);
        margin-bottom: 0.6rem;
        min-height: 2rem;
      }

      .status-message.warning {
        background: #fffbeb;
        border-color: var(--warning-color);
        color: #92400e;
      }

      .status-message.error {
        background: #fef2f2;
        border-color: var(--danger-color);
        color: #991b1b;
      }

      .status-message.success {
        background: #ecfdf5;
        border-color: var(--success-color);
        color: #065f46;
      }

      /* Stats grid */
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.5rem;
        margin-bottom: 0.5rem;
      }

      .stat {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        padding: 0.5rem 0.6rem;
      }

      .stat-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
        margin-bottom: 0.2rem;
      }

      .stat-value {
        font-size: 1rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      .stat-value.good { color: #065f46; }
      .stat-value.warn { color: #92400e; }
      .stat-value.bad  { color: #991b1b; }

      /* Phase result cards */
      .phase-result {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        padding: 0.75rem;
        margin-bottom: 0.6rem;
      }

      .phase-result h3 {
        margin: 0 0 0.5rem;
        font-size: 0.9rem;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .phase-badge {
        display: inline-flex;
        align-items: center;
        padding: 0.15rem 0.5rem;
        border-radius: 1rem;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .badge-straight { background: #dbeafe; color: #1e40af; }
      .badge-arc-right { background: #fce7f3; color: #9d174d; }
      .badge-arc-left  { background: #e0e7ff; color: #3730a3; }

      .phase-metrics {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 0.4rem;
      }

      .phase-metric {
        background: var(--bg-tertiary);
        border-radius: 0.375rem;
        padding: 0.4rem 0.5rem;
      }

      .phase-metric-label {
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
      }

      .phase-metric-value {
        font-size: 0.95rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }

      /* Canvas for arc visualisation */
      .canvas-wrap {
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        background: var(--bg-tertiary);
        overflow: hidden;
        margin-top: 0.5rem;
      }

      canvas {
        display: block;
        width: 100%;
        height: auto;
      }

      /* Suggestion banner */
      .suggestion-banner {
        background: #ecfdf5;
        border: 1px solid var(--success-color);
        border-radius: 0.5rem;
        padding: 0.85rem 1rem;
        margin-bottom: 0.75rem;
        display: none;
      }

      .suggestion-banner.visible { display: block; }

      .suggestion-title {
        font-size: 0.8rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #065f46;
        margin-bottom: 0.4rem;
      }

      .suggestion-value {
        font-size: 1.4rem;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        color: #065f46;
        margin-bottom: 0.3rem;
      }

      .suggestion-prev {
        font-size: 0.8rem;
        color: var(--text-secondary);
      }

      .warning-list {
        margin: 0.4rem 0 0;
        padding: 0 0 0 1.25rem;
        color: #92400e;
        font-size: 0.8rem;
      }

      .gnss-warn-banner {
        background: #fffbeb;
        border: 1px solid var(--warning-color);
        border-radius: 0.5rem;
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
        color: #92400e;
        margin-bottom: 0.5rem;
        display: none;
      }

      .gnss-warn-banner.visible { display: block; }

      .apply-button-wrap {
        display: flex;
        gap: 0.6rem;
        align-items: center;
        margin-top: 0.5rem;
      }

      .apply-note {
        font-size: 0.78rem;
        color: var(--text-secondary);
      }

      /* Test-moves direction pad */
      .move-pad {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.4rem;
        margin-bottom: 0.6rem;
      }

      .move-pad button {
        padding: 0.55rem 0.4rem;
        font-size: 0.85rem;
        font-weight: 700;
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        font-variant-numeric: tabular-nums;
        line-height: 1.1;
      }

      .move-pad button:hover:not(:disabled) {
        background: #dbeafe;
        border-color: var(--primary-color);
        color: var(--primary-color);
      }

      .move-pad .pad-center {
        font-size: 0.7rem;
        color: var(--text-secondary);
        background: transparent;
        border: 1px dashed var(--border-color);
        cursor: default;
      }

      .move-pad .pad-center:hover { background: transparent; color: var(--text-secondary); border-color: var(--border-color); }

      .move-controls {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 0.6rem;
        align-items: center;
        flex-wrap: wrap;
      }

      .move-status {
        font-size: 0.8rem;
        color: var(--text-secondary);
        flex: 1;
        min-width: 8rem;
      }

      .move-results {
        margin-top: 0.5rem;
        max-height: 14rem;
        overflow: auto;
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
      }

      .move-results table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.78rem;
        font-variant-numeric: tabular-nums;
      }

      .move-results th,
      .move-results td {
        padding: 0.35rem 0.5rem;
        border-bottom: 1px solid var(--border-color);
        text-align: right;
        white-space: nowrap;
      }

      .move-results th:first-child,
      .move-results td:first-child { text-align: left; }

      .move-results thead th {
        background: var(--bg-tertiary);
        position: sticky;
        top: 0;
        z-index: 1;
        font-weight: 700;
        text-transform: uppercase;
        font-size: 0.68rem;
        color: var(--text-secondary);
      }

      .move-results .err-good { color: #065f46; }
      .move-results .err-warn { color: #92400e; }
      .move-results .err-bad  { color: #991b1b; }

      @media (max-width: 1024px) {
        .work-row { grid-template-columns: 1fr; }
      }

      @media (max-width: 760px) {
        .widgets-row { grid-template-columns: 1fr; }
        .widgets-row > * { zoom: 1; }
        .stats-grid { grid-template-columns: repeat(2, 1fr); }
      }
    </style>
${getSensorWidgetScriptTag()}
  </head>
  <body>
    <div class="header">
      <div class="header-content">
        <h1>Dead-Reckoning Calibration</h1>
        <a class="back-link" href="/">← Back to Dashboard</a>
      </div>
    </div>

    <div class="container">
      <!-- ================================================================
           Live sensors row — IMU, GNSS, Motor Odometry (scaled smaller)
      ================================================================ -->
      <section class="widgets-row" aria-label="Live sensors">
        <imu-sensor-widget id="imu-widget"></imu-sensor-widget>
        <gnss-position-widget id="gnss-widget"></gnss-position-widget>
        <motor-odometry-widget id="motor-odometry-widget"></motor-odometry-widget>
      </section>

      <!-- ================================================================
           Controls + Test Moves side-by-side
      ================================================================ -->
      <div class="work-row">
        <!-- Calibration controls -->
        <section class="panel">
          <h2>Controls</h2>

          <div class="gnss-warn-banner" id="gnssWarnBanner"></div>

          <div class="input-row">
            <div class="field">
              <label for="lineDistanceMeters">Straight distance</label>
              <input id="lineDistanceMeters" type="number" min="0.5" max="20" step="0.5" value="5" inputmode="decimal" />
            </div>
          </div>

          <!-- Phase progress indicator -->
          <div class="phase-bar">
            <div class="phase-step" id="phaseWait">Wait fix</div>
            <div class="phase-step" id="phaseStraight">1 – Straight</div>
            <div class="phase-step" id="phaseArcRight">2 – CW</div>
            <div class="phase-step" id="phaseArcLeft">3 – CCW</div>
            <div class="phase-step" id="phaseAnalyse">Analyse</div>
          </div>

          <div class="status-message" id="statusMessage">Idle – press Start to begin calibration.</div>

          <div class="buttons">
            <button id="startBtn" class="primary">Start Calibration</button>
            <button id="stopBtn" class="danger">STOP</button>
          </div>

          <!-- Summary stats shown while / after running -->
          <div class="stats-grid" id="summaryStats" style="display:none">
            <div class="stat">
              <div class="stat-label">Phase</div>
              <div class="stat-value" id="statPhase">—</div>
            </div>
            <div class="stat">
              <div class="stat-label">GNSS Fix</div>
              <div class="stat-value" id="statFix">—</div>
            </div>
            <div class="stat">
              <div class="stat-label">GNSS Acc</div>
              <div class="stat-value" id="statAccuracy">—</div>
            </div>
          </div>
        </section>

        <!-- Test Moves panel -->
        <section class="panel">
          <h2>Test Moves (1 m, 45° steps)</h2>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin:-0.25rem 0 0.6rem">
            Drives to <code>current&nbsp;pose&nbsp;+&nbsp;Δ</code>. Compares GNSS-measured vs encoder-DR
            position and heading change.
          </p>

          <div class="move-pad">
            <button data-dx="-0.7071" data-dy="0.7071"  data-label="–X +Y">–X +Y</button>
            <button data-dx="0"       data-dy="1"       data-label="+Y">+Y</button>
            <button data-dx="0.7071"  data-dy="0.7071"  data-label="+X +Y">+X +Y</button>
            <button data-dx="-1"      data-dy="0"       data-label="–X">–X</button>
            <button class="pad-center" disabled>Δ&nbsp;=&nbsp;1 m</button>
            <button data-dx="1"       data-dy="0"       data-label="+X">+X</button>
            <button data-dx="-0.7071" data-dy="-0.7071" data-label="–X –Y">–X –Y</button>
            <button data-dx="0"       data-dy="-1"      data-label="–Y">–Y</button>
            <button data-dx="0.7071"  data-dy="-0.7071" data-label="+X –Y">+X –Y</button>
          </div>

          <div class="move-controls">
            <button id="moveStopBtn" class="danger" disabled>STOP MOVE</button>
            <button id="moveClearBtn" class="secondary">Clear results</button>
            <span class="move-status" id="moveStatus">Idle.</span>
          </div>

          <div class="move-results">
            <table>
              <thead>
                <tr>
                  <th>Cmd Δ</th>
                  <th>GNSS Δx</th>
                  <th>GNSS Δy</th>
                  <th>DR Δx</th>
                  <th>DR Δy</th>
                  <th>Δ pos err</th>
                  <th>GNSS Δhdg</th>
                  <th>DR Δhdg</th>
                  <th>Δ hdg err</th>
                </tr>
              </thead>
              <tbody id="moveResultsBody">
                <tr><td colspan="9" style="text-align:center;color:var(--text-secondary);font-style:italic">No moves yet.</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <!-- ================================================================
           Calibration outputs (suggestion banner, phase cards, canvases)
      ================================================================ -->

      <!-- Suggested calibration value -->
      <div class="suggestion-banner" id="suggestionBanner">
        <div class="suggestion-title">Suggested Calibration</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.6rem;margin-bottom:0.6rem">
          <div>
            <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:.06em;color:#065f46;font-weight:600">Left m/tick</div>
            <div class="suggestion-value" id="suggestedLeft">—</div>
          </div>
          <div>
            <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:.06em;color:#065f46;font-weight:600">Right m/tick</div>
            <div class="suggestion-value" id="suggestedRight">—</div>
          </div>
          <div>
            <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:.06em;color:#065f46;font-weight:600">Wheelbase</div>
            <div class="suggestion-value" id="suggestedWheelbase">—</div>
          </div>
          <div>
            <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:.06em;color:#065f46;font-weight:600">Avg DR error</div>
            <div class="suggestion-value" id="suggestedDrError">—</div>
          </div>
        </div>
        <div class="suggestion-prev" id="prevValue"></div>
        <ul class="warning-list" id="warningList" style="display:none"></ul>
        <div class="apply-button-wrap">
          <button id="applyBtn" class="primary">Apply &amp; Save</button>
          <span class="apply-note" id="applyNote"></span>
        </div>
      </div>

      <!-- Phase result cards -->
      <div id="phaseResults"></div>

      <!-- Arc tracking canvas -->
      <section class="panel" id="canvasSection" style="display:none">
        <h2>Arc Encoder Tracking</h2>
        <p style="font-size:0.8rem;color:var(--text-secondary);margin:0 0 0.5rem">
          Pivot diagnostics. Retained for continuity, not used in the final wheelbase calculation.
        </p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
          <div>
            <div style="font-size:0.78rem;font-weight:600;color:var(--text-secondary);margin-bottom:0.3rem">Pivot CW</div>
            <div class="canvas-wrap"><canvas id="canvasArcRight" width="400" height="400"></canvas></div>
          </div>
          <div>
            <div style="font-size:0.78rem;font-weight:600;color:var(--text-secondary);margin-bottom:0.3rem">Pivot CCW</div>
            <div class="canvas-wrap"><canvas id="canvasArcLeft" width="400" height="400"></canvas></div>
          </div>
        </div>
      </section>
    </div>

${getAppDialogHtml()}

    <script>
${getAppDialogScript()}

      // -----------------------------------------------------------------------
      // Live sidebar widgets (IMU + GNSS + Motor Odometry)
      // -----------------------------------------------------------------------
      function updateSidebar(payload) {
        const primitives = payload?.primitives ?? {};
        const imu        = primitives.imu        ?? {};
        const gnss       = primitives.gnss       ?? {};
        const poseFusion = primitives.poseFusion ?? {};

        const imuWidget = document.getElementById('imu-widget');
        const gnssWidget = document.getElementById('gnss-widget');
        const motorOdoWidget = document.getElementById('motor-odometry-widget');

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
        if (motorOdoWidget) {
          motorOdoWidget.setAttribute('status', poseFusion.status || 'idle');
          if (poseFusion.encoderOnlyHeadingDeg != null) motorOdoWidget.setAttribute('heading-deg', poseFusion.encoderOnlyHeadingDeg);
          if (poseFusion.encoderOnlyXMeters != null) motorOdoWidget.setAttribute('x-meters', poseFusion.encoderOnlyXMeters);
          if (poseFusion.encoderOnlyYMeters != null) motorOdoWidget.setAttribute('y-meters', poseFusion.encoderOnlyYMeters);
          motorOdoWidget.setAttribute('confidence', poseFusion.drConfidence ?? 1);
          motorOdoWidget.setAttribute('synced', poseFusion.encoderSynced === true ? 'true' : 'false');
        }

        // Page-specific summary stats and GNSS warning banner
        const statFix = document.getElementById('statFix');
        const statAcc = document.getElementById('statAccuracy');
        if (statFix) statFix.textContent = gnss.fixType || '—';
        if (statAcc) {
          const acc = gnss.positionAccuracyMeters;
          statAcc.textContent = acc != null ? (acc * 100).toFixed(1) + ' cm' : '—';
          statAcc.className = 'stat-value ' + (acc == null ? '' : acc <= 0.10 ? 'good' : acc <= 0.20 ? 'warn' : 'bad');
        }

        const gnssWarnBanner = document.getElementById('gnssWarnBanner');
        if (gnssWarnBanner) {
          const fixOk = gnss.fixType === 'fixed' || gnss.fixType === 'float' || gnss.fixType === 'rtk-fixed' || gnss.fixType === 'rtk-float';
          const accOk = gnss.positionAccuracyMeters != null && gnss.positionAccuracyMeters <= 0.10;
          const isActiveBad = gnss.status && gnss.status !== 'idle' && (!fixOk || !accOk);
          if (isActiveBad) {
            let msg = 'GNSS quality insufficient for accurate calibration.';
            if (!fixOk) msg += \` Fix "\${gnss.fixType || 'unknown'}" — need fixed or float.\`;
            else        msg += \` Accuracy \${gnss.positionAccuracyMeters != null ? (gnss.positionAccuracyMeters*100).toFixed(1)+'cm' : '?'} — need ≤10 cm.\`;
            gnssWarnBanner.textContent = '⚠ ' + msg;
            gnssWarnBanner.classList.add('visible');
          } else {
            gnssWarnBanner.classList.remove('visible');
          }
        }
      }

      // -----------------------------------------------------------------------
      // Phase indicator (for calibration procedure)
      // -----------------------------------------------------------------------
      const PHASE_IDS = {
        'waiting-for-fix': 'phaseWait',
        'straight':        'phaseStraight',
        'pivot-cw':        'phaseArcRight',
        'pivot-ccw':       'phaseArcLeft',
        'analysing':       'phaseAnalyse',
        'done':            'phaseAnalyse',
        'stopped':         null,
        'error':           null,
        'idle':            null,
      };

      const PHASE_ORDER = ['waiting-for-fix', 'straight', 'pivot-cw', 'pivot-ccw', 'analysing'];

      function updatePhaseBar(phase) {
        const activeIdx = PHASE_ORDER.indexOf(phase);
        PHASE_ORDER.forEach((p, idx) => {
          const el = document.getElementById(PHASE_IDS[p]);
          if (!el) return;
          el.className = 'phase-step';
          if (phase === 'error') {
            if (idx === activeIdx || (activeIdx === -1 && idx === PHASE_ORDER.length - 1)) {
              el.className = 'phase-step error';
            } else if (idx < activeIdx) {
              el.className = 'phase-step done';
            }
          } else if (phase === 'stopped') {
            if (idx < activeIdx) el.className = 'phase-step done';
          } else {
            if (idx < activeIdx) el.className = 'phase-step done';
            else if (idx === activeIdx) el.className = 'phase-step active';
          }
        });
        if (phase === 'done') {
          document.getElementById('phaseAnalyse').className = 'phase-step done';
        }
      }

      // -----------------------------------------------------------------------
      // Phase result cards
      // -----------------------------------------------------------------------
      function fmt(v, decimals, unit) {
        if (v === null || v === undefined) return '—';
        return v.toFixed(decimals) + (unit || '');
      }

      function renderPhaseResult(title, badgeClass, badgeLabel, phase) {
        if (!phase) return '';
        const acc = phase.startAnchor?.positionAccuracyMeters;
        const accClass = acc === null ? '' : acc <= 0.10 ? 'good' : acc <= 0.20 ? 'warn' : 'bad';
        const rms = phase.arcTrackingRmsErrorFraction;
        const rmsClass = rms === null ? '' : rms <= 0.05 ? 'good' : rms <= 0.10 ? 'warn' : 'bad';
        const geo = phase.arcGeometry;
        const drErrCm = geo ? geo.drEndpointErrorMeters * 100 : null;
        const drErrClass = drErrCm === null ? '' : drErrCm <= 2 ? 'good' : drErrCm <= 5 ? 'warn' : 'bad';
        return \`
          <div class="phase-result">
            <h3>\${title} <span class="phase-badge \${badgeClass}">\${badgeLabel}</span></h3>
            <div class="phase-metrics">
              <div class="phase-metric">
                <div class="phase-metric-label">GNSS Chord</div>
                <div class="phase-metric-value">\${fmt(phase.gnssDistanceMeters, 3, ' m')}</div>
              </div>
              <div class="phase-metric">
                <div class="phase-metric-label">Heading Change</div>
                <div class="phase-metric-value">\${geo ? fmt(geo.imuHeadingChangeDeg, 1, '°') : fmt(phase.gnssHeadingChangeDeg, 1, '°')}</div>
              </div>
              <div class="phase-metric">
                <div class="phase-metric-label">Left Ticks</div>
                <div class="phase-metric-value">\${phase.leftTotalTicks ?? '—'}</div>
              </div>
              <div class="phase-metric">
                <div class="phase-metric-label">Right Ticks</div>
                <div class="phase-metric-value">\${phase.rightTotalTicks ?? '—'}</div>
              </div>
              \${phase.derivedEncoderMetersPerTick !== null ? \`
              <div class="phase-metric">
                <div class="phase-metric-label">Avg m/tick</div>
                <div class="phase-metric-value">\${fmt(phase.derivedEncoderMetersPerTick, 6, '')}</div>
              </div>\` : ''}
              \${geo ? \`
              <div class="phase-metric">
                <div class="phase-metric-label">Left m/tick</div>
                <div class="phase-metric-value">\${fmt(geo.leftMetersPerTick, 6, '')}</div>
              </div>
              <div class="phase-metric">
                <div class="phase-metric-label">Right m/tick</div>
                <div class="phase-metric-value">\${fmt(geo.rightMetersPerTick, 6, '')}</div>
              </div>
              <div class="phase-metric">
                <div class="phase-metric-label">Wheelbase</div>
                <div class="phase-metric-value">\${fmt(geo.wheelbaseMeters, 4, ' m')}</div>
              </div>
              <div class="phase-metric">
                <div class="phase-metric-label">DR endpoint error</div>
                <div class="phase-metric-value \${drErrClass}">\${fmt(drErrCm, 1, ' cm')}</div>
              </div>\` : ''}
              \${rms !== null ? \`
              <div class="phase-metric">
                <div class="phase-metric-label">Arc RMS Error</div>
                <div class="phase-metric-value \${rmsClass}">\${fmt(rms * 100, 2, '%')}</div>
              </div>\` : ''}
              <div class="phase-metric">
                <div class="phase-metric-label">Start Accuracy</div>
                <div class="phase-metric-value \${accClass}">\${acc !== null && acc !== undefined ? (acc*100).toFixed(1)+' cm' : '—'}</div>
              </div>
              <div class="phase-metric">
                <div class="phase-metric-label">GNSS Fix</div>
                <div class="phase-metric-value">\${phase.startAnchor?.fixType ?? '—'}</div>
              </div>
              <div class="phase-metric">
                <div class="phase-metric-label">Steady Samples</div>
                <div class="phase-metric-value">\${phase.steadyStateSamples?.length ?? 0}</div>
              </div>
            </div>
          </div>
        \`;
      }

      function renderPhaseResults(result) {
        const container = document.getElementById('phaseResults');
        if (!result) { container.innerHTML = ''; return; }

        container.innerHTML =
          renderPhaseResult('Straight', 'badge-straight', 'straight', result.straightPhase) +
          renderPhaseResult('Pivot CW', 'badge-arc-right', 'pivot-cw', result.arcRightPhase) +
          renderPhaseResult('Pivot CCW',  'badge-arc-left',  'pivot-ccw',  result.arcLeftPhase);
      }

      // -----------------------------------------------------------------------
      // Arc tracking canvas
      // -----------------------------------------------------------------------
      function drawArcCanvas(canvasId, samples) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;
        const pad = 40;
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, 0, W, H);

        ctx.strokeStyle = '#d1d5db';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(pad, H - pad);
        ctx.lineTo(W - pad, pad);
        ctx.stroke();
        ctx.setLineDash([]);

        if (!samples || samples.length < 2) {
          ctx.fillStyle = '#9ca3af';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('No steady-state data', W / 2, H / 2);
          return;
        }

        const first = samples[0];
        const last  = samples[samples.length - 1];
        const totalEnc = Math.max(1, (last.leftTicksTotal - first.leftTicksTotal + last.rightTicksTotal - first.rightTicksTotal) / 2);
        const totalImu = Math.max(0.001, Math.abs(normalizeAngle(last.imuHeadingDeg - first.imuHeadingDeg)));

        const points = samples.map(s => {
          const encFrac = ((s.leftTicksTotal - first.leftTicksTotal + s.rightTicksTotal - first.rightTicksTotal) / 2) / totalEnc;
          const imuFrac = Math.abs(normalizeAngle(s.imuHeadingDeg - first.imuHeadingDeg)) / totalImu;
          return { x: encFrac, y: imuFrac };
        });

        const toCanvasX = (f) => pad + f * (W - 2 * pad);
        const toCanvasY = (f) => (H - pad) - f * (H - 2 * pad);

        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2;
        ctx.beginPath();
        points.forEach((p, i) => {
          const cx = toCanvasX(p.x);
          const cy = toCanvasY(p.y);
          if (i === 0) ctx.moveTo(cx, cy);
          else ctx.lineTo(cx, cy);
        });
        ctx.stroke();

        ctx.fillStyle = '#2563eb';
        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(toCanvasX(p.x), toCanvasY(p.y), 3, 0, Math.PI * 2);
          ctx.fill();
        });

        ctx.fillStyle = '#6b7280';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Encoder fraction →', W / 2, H - 8);
        ctx.save();
        ctx.translate(12, H / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('IMU fraction →', 0, 0);
        ctx.restore();
      }

      function normalizeAngle(deg) {
        while (deg > 180) deg -= 360;
        while (deg <= -180) deg += 360;
        return deg;
      }

      // -----------------------------------------------------------------------
      // Suggestion banner
      // -----------------------------------------------------------------------
      let pendingCalibration = null;

      function updateSuggestionBanner(result) {
        const banner = document.getElementById('suggestionBanner');
        const prevEl = document.getElementById('prevValue');
        const warnEl = document.getElementById('warningList');
        const applyNote = document.getElementById('applyNote');
        applyNote.textContent = '';

        const hasValues = result &&
          (result.suggestedLeftMetersPerTick !== null || result.suggestedEncoderMetersPerTick !== null);

        if (!hasValues) {
          banner.classList.remove('visible');
          pendingCalibration = null;
          return;
        }

        pendingCalibration = {
          leftMetersPerTick:   result.suggestedLeftMetersPerTick,
          rightMetersPerTick:  result.suggestedRightMetersPerTick,
          wheelbaseMeters:     result.suggestedWheelbaseMeters,
          encoderMetersPerTick: result.suggestedEncoderMetersPerTick,
        };

        const setEl = (id, val, decimals, unit) => {
          const el = document.getElementById(id);
          if (el) el.textContent = val !== null && val !== undefined ? val.toFixed(decimals) + unit : '—';
        };
        setEl('suggestedLeft',      result.suggestedLeftMetersPerTick,       6, ' m/tick');
        setEl('suggestedRight',     result.suggestedRightMetersPerTick,      6, ' m/tick');
        setEl('suggestedWheelbase', result.suggestedWheelbaseMeters,         4, ' m');
        const drErrCm = result.averageDrEndpointErrorMeters !== null ? result.averageDrEndpointErrorMeters * 100 : null;
        setEl('suggestedDrError',   drErrCm,                                 1, ' cm');

        prevEl.textContent = \`Previous: left \${result.previousLeftMetersPerTick.toFixed(6)}, right \${result.previousRightMetersPerTick.toFixed(6)}, wheelbase \${result.previousWheelbaseMeters.toFixed(4)} m\`;

        if (result.warnings && result.warnings.length > 0) {
          warnEl.style.display = '';
          warnEl.innerHTML = result.warnings.map(w => \`<li>\${w}</li>\`).join('');
        } else {
          warnEl.style.display = 'none';
        }

        banner.classList.add('visible');
      }

      // -----------------------------------------------------------------------
      // Status polling (calibration procedure + live primitives)
      // -----------------------------------------------------------------------
      let cachedPrimitives = null;
      let calibrationRunning = false;

      async function fetchStatus() {
        const [statusRes, primitivesRes] = await Promise.all([
          fetch('/api/dead-reckoning/status?ts=' + Date.now(), { cache: 'no-store' }),
          fetch('/api/primitives'),
        ]);
        return {
          status: await statusRes.json(),
          primitives: await primitivesRes.json(),
        };
      }

      async function update() {
        try {
          const payload = await fetchStatus();
          cachedPrimitives = payload.primitives;
          updateSidebar(payload.primitives);

          const data = payload.status;
          const phase = data.phase ?? 'idle';
          const message = data.phaseMessage ?? '';
          const running = data.running ?? false;
          const result  = data.result ?? null;
          calibrationRunning = running;

          updatePhaseBar(phase);

          const msgEl = document.getElementById('statusMessage');
          if (msgEl) {
            msgEl.textContent = message || 'Idle.';
            msgEl.className = 'status-message';
            if (phase === 'error') msgEl.className += ' error';
            else if (phase === 'done') msgEl.className += ' success';
            else if (phase === 'stopped') msgEl.className += ' warning';
          }

          const summaryStats = document.getElementById('summaryStats');
          if (summaryStats) summaryStats.style.display = running ? 'grid' : 'none';

          const statPhase = document.getElementById('statPhase');
          if (statPhase) statPhase.textContent = phase;

          document.getElementById('startBtn').disabled = running || moveRunning;
          document.getElementById('stopBtn').disabled = false;
          const lineDistanceInput = document.getElementById('lineDistanceMeters');
          if (lineDistanceInput) lineDistanceInput.disabled = running;

          // Disable test-move pad while calibration is running
          updateMoveButtonsEnabled();

          if (result) {
            renderPhaseResults(result);
            updateSuggestionBanner(result);

            const canvasSection = document.getElementById('canvasSection');
            if (canvasSection) canvasSection.style.display = '';
            if (result.arcRightPhase) {
              drawArcCanvas('canvasArcRight', result.arcRightPhase.steadyStateSamples);
            }
            if (result.arcLeftPhase) {
              drawArcCanvas('canvasArcLeft', result.arcLeftPhase.steadyStateSamples);
            }
          }
        } catch (err) {
          console.error('Status update failed:', err);
        }
      }

      // -----------------------------------------------------------------------
      // Calibration button handlers
      // -----------------------------------------------------------------------
      document.getElementById('startBtn').addEventListener('click', async () => {
        const lineDistanceInput = document.getElementById('lineDistanceMeters');
        document.getElementById('startBtn').disabled = true;
        lineDistanceInput.disabled = true;
        document.getElementById('phaseResults').innerHTML = '';
        document.getElementById('suggestionBanner').classList.remove('visible');
        document.getElementById('canvasSection').style.display = 'none';
        try {
          const lineDistanceMeters = Number(lineDistanceInput.value);
          if (!Number.isFinite(lineDistanceMeters) || lineDistanceMeters <= 0) {
            document.getElementById('startBtn').disabled = false;
            lineDistanceInput.disabled = false;
            await appAlert('Please enter a valid straight distance in metres.');
            return;
          }
          const res = await fetch('/api/dead-reckoning/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lineDistanceMeters }),
          });
          if (!res.ok) {
            const err = await res.json();
            await appAlert('Failed to start: ' + (err.error || res.statusText));
          }
          await update();
        } catch (err) {
          document.getElementById('startBtn').disabled = false;
          lineDistanceInput.disabled = false;
          await appAlert('Network error: ' + err.message);
        }
      });

      document.getElementById('stopBtn').addEventListener('click', async () => {
        try {
          await fetch('/api/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          await update();
        } catch (err) {
          console.error('Stop failed:', err);
        }
      });

      document.getElementById('applyBtn').addEventListener('click', async () => {
        if (!pendingCalibration) return;
        const c = pendingCalibration;
        const msg = c.leftMetersPerTick !== null
          ? \`Apply per-wheel calibration?\nLeft: \${c.leftMetersPerTick.toFixed(6)} m/tick\nRight: \${c.rightMetersPerTick.toFixed(6)} m/tick\nWheelbase: \${c.wheelbaseMeters.toFixed(4)} m\`
          : \`Apply encoder calibration of \${c.encoderMetersPerTick.toFixed(6)} m/tick?\`;
        const confirmed = await appConfirm(msg, 'Apply Calibration');
        if (!confirmed) return;
        try {
          const body = c.leftMetersPerTick !== null
            ? { leftMetersPerTick: c.leftMetersPerTick, rightMetersPerTick: c.rightMetersPerTick, wheelbaseMeters: c.wheelbaseMeters }
            : { encoderMetersPerTick: c.encoderMetersPerTick };
          const res = await fetch('/api/dead-reckoning/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!res.ok) {
            await appAlert('Failed to apply: ' + (data.error || res.statusText));
          } else {
            const note = data.leftMetersPerTick !== undefined
              ? \`Saved! L:\${data.leftMetersPerTick.toFixed(6)} R:\${data.rightMetersPerTick.toFixed(6)} wb:\${data.wheelbaseMeters.toFixed(4)}m\`
              : \`Saved! \${data.encoderMetersPerTick.toFixed(6)} m/tick\`;
            document.getElementById('applyNote').textContent = note;
          }
        } catch (err) {
          await appAlert('Network error: ' + err.message);
        }
      });

      // -----------------------------------------------------------------------
      // Test-move logic — drive 1m relative to current pose, then compare
      // GNSS-measured displacement / heading change vs encoder-DR-measured.
      // -----------------------------------------------------------------------
      let moveRunning = false;

      function setMoveStatus(text, kind) {
        const el = document.getElementById('moveStatus');
        if (!el) return;
        el.textContent = text;
        el.style.color = kind === 'error' ? '#991b1b'
                       : kind === 'success' ? '#065f46'
                       : kind === 'running' ? 'var(--primary-color)'
                       : 'var(--text-secondary)';
      }

      function updateMoveButtonsEnabled() {
        const padButtons = document.querySelectorAll('.move-pad button[data-dx]');
        const disable = moveRunning || calibrationRunning;
        padButtons.forEach((btn) => { btn.disabled = disable; });
        document.getElementById('moveStopBtn').disabled = !moveRunning;
      }

      function readPoseSnapshot(prim) {
        const p = prim?.primitives ?? {};
        const gnss = p.gnss ?? {};
        const pf = p.poseFusion ?? {};
        return {
          gnssX: gnss.xMeters,
          gnssY: gnss.yMeters,
          gnssHeadingDeg: gnss.headingDeg,
          gnssHeadingValid: gnss.headingDeg != null && gnss.headingAccuracyDeg != null && gnss.headingAccuracyDeg < 180,
          encX: pf.encoderOnlyXMeters,
          encY: pf.encoderOnlyYMeters,
          encHeadingDeg: pf.encoderOnlyHeadingDeg,
          fixType: gnss.fixType,
          posAccuracy: gnss.positionAccuracyMeters,
        };
      }

      async function fetchPoseSnapshot() {
        const res = await fetch('/api/primitives', { cache: 'no-store' });
        const data = await res.json();
        return readPoseSnapshot(data);
      }

      function angleDiff(a, b) {
        // Smallest signed difference a-b in (-180, 180]
        if (a == null || b == null || isNaN(a) || isNaN(b)) return null;
        let d = a - b;
        while (d > 180) d -= 360;
        while (d <= -180) d += 360;
        return d;
      }

      function classifyError(meters) {
        if (meters == null || isNaN(meters)) return '';
        const cm = Math.abs(meters) * 100;
        if (cm <= 5)  return 'err-good';
        if (cm <= 15) return 'err-warn';
        return 'err-bad';
      }

      function classifyHeadingError(deg) {
        if (deg == null || isNaN(deg)) return '';
        const a = Math.abs(deg);
        if (a <= 2)  return 'err-good';
        if (a <= 5)  return 'err-warn';
        return 'err-bad';
      }

      function appendMoveResult(row) {
        const tbody = document.getElementById('moveResultsBody');
        // Clear placeholder row
        if (tbody.children.length === 1 && tbody.children[0].children.length === 1) {
          tbody.innerHTML = '';
        }

        const tr = document.createElement('tr');
        const fmtNum = (v, d) => (v == null || isNaN(v)) ? '—' : v.toFixed(d);

        const gnssDxStr = fmtNum(row.gnssDx, 3) + ' m';
        const gnssDyStr = fmtNum(row.gnssDy, 3) + ' m';
        const drDxStr   = fmtNum(row.drDx,   3) + ' m';
        const drDyStr   = fmtNum(row.drDy,   3) + ' m';

        const posErrM = (row.gnssDx != null && row.drDx != null && row.gnssDy != null && row.drDy != null)
          ? Math.hypot(row.drDx - row.gnssDx, row.drDy - row.gnssDy)
          : null;
        const posErrCls = classifyError(posErrM);
        const posErrStr = posErrM != null ? (posErrM * 100).toFixed(1) + ' cm' : '—';

        const hdgErr = (row.gnssDHeading != null && row.drDHeading != null) ? angleDiff(row.drDHeading, row.gnssDHeading) : null;
        const hdgErrCls = classifyHeadingError(hdgErr);
        const hdgErrStr = hdgErr != null ? hdgErr.toFixed(1) + '°' : '—';

        const gnssHdgStr = row.gnssDHeading != null ? row.gnssDHeading.toFixed(1) + '°' : '—';
        const drHdgStr   = row.drDHeading   != null ? row.drDHeading.toFixed(1)   + '°' : '—';

        tr.innerHTML =
          '<td>' + row.label + '</td>' +
          '<td>' + gnssDxStr + '</td>' +
          '<td>' + gnssDyStr + '</td>' +
          '<td>' + drDxStr   + '</td>' +
          '<td>' + drDyStr   + '</td>' +
          '<td class="' + posErrCls + '">' + posErrStr + '</td>' +
          '<td>' + gnssHdgStr + '</td>' +
          '<td>' + drHdgStr   + '</td>' +
          '<td class="' + hdgErrCls + '">' + hdgErrStr + '</td>';
        tbody.insertBefore(tr, tbody.firstChild);
      }

      async function runTestMove(dx, dy, label) {
        if (moveRunning || calibrationRunning) return;

        // Snapshot starting pose
        let before;
        try {
          before = await fetchPoseSnapshot();
        } catch (err) {
          await appAlert('Could not read current pose: ' + err.message);
          return;
        }
        if (before.gnssX == null || before.gnssY == null) {
          await appAlert('No GNSS position available — cannot compute target.');
          return;
        }

        const targetX = before.gnssX + dx;
        const targetY = before.gnssY + dy;

        moveRunning = true;
        updateMoveButtonsEnabled();
        setMoveStatus('Driving ' + label + ' toward (' + targetX.toFixed(2) + ', ' + targetY.toFixed(2) + ')…', 'running');

        let driveResult = null;
        try {
          const res = await fetch('/api/drive/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetX,
              targetY,
              learningEnabled: false,
            }),
          });
          driveResult = await res.json();
          if (!res.ok) {
            setMoveStatus('Drive failed: ' + (driveResult?.error || res.statusText), 'error');
            return;
          }
        } catch (err) {
          setMoveStatus('Network error during drive: ' + err.message, 'error');
          return;
        } finally {
          moveRunning = false;
          updateMoveButtonsEnabled();
        }

        // Snapshot ending pose
        let after;
        try {
          after = await fetchPoseSnapshot();
        } catch (err) {
          setMoveStatus('Drive complete but failed to read end pose: ' + err.message, 'error');
          return;
        }

        const status = driveResult?.status ?? 'unknown';
        const kind = status === 'success' ? 'success' : (status === 'stopped' ? 'error' : 'error');
        setMoveStatus('Move ' + label + ' finished (' + status + ').', kind);

        appendMoveResult({
          label,
          gnssDx: (before.gnssX != null && after.gnssX != null) ? (after.gnssX - before.gnssX) : null,
          gnssDy: (before.gnssY != null && after.gnssY != null) ? (after.gnssY - before.gnssY) : null,
          drDx:   (before.encX != null && after.encX != null) ? (after.encX - before.encX) : null,
          drDy:   (before.encY != null && after.encY != null) ? (after.encY - before.encY) : null,
          gnssDHeading: angleDiff(after.gnssHeadingDeg, before.gnssHeadingDeg),
          drDHeading:   angleDiff(after.encHeadingDeg, before.encHeadingDeg),
        });
      }

      document.querySelectorAll('.move-pad button[data-dx]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const dx = Number(btn.getAttribute('data-dx'));
          const dy = Number(btn.getAttribute('data-dy'));
          const label = btn.getAttribute('data-label') || '';
          await runTestMove(dx, dy, label);
        });
      });

      document.getElementById('moveStopBtn').addEventListener('click', async () => {
        try {
          await fetch('/api/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          setMoveStatus('Stop requested.', 'error');
        } catch (err) {
          setMoveStatus('Failed to send stop: ' + err.message, 'error');
        }
      });

      document.getElementById('moveClearBtn').addEventListener('click', () => {
        document.getElementById('moveResultsBody').innerHTML =
          '<tr><td colspan="9" style="text-align:center;color:var(--text-secondary);font-style:italic">No moves yet.</td></tr>';
      });

      // -----------------------------------------------------------------------
      // Start polling
      // -----------------------------------------------------------------------
      update();
      const interval = setInterval(update, 1000);
      window.addEventListener('beforeunload', () => clearInterval(interval));
    </script>
  </body>
</html>`;
}
