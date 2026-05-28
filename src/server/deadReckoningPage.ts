import { getLiveSensorWidgetsHtml, getLiveSensorWidgetsScript, getLiveSensorWidgetsStyles } from "./liveSensorWidgets.js";
import { getAppDialogHtml, getAppDialogScript, getAppDialogStyles } from "./appDialogs.js";

export function getDeadReckoningPageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dead-Reckoning Calibration - Mower Control</title>
    <style>
${getLiveSensorWidgetsStyles()}
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
        padding: 1rem 1.5rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
      }

      h1 { margin: 0; font-size: 1.8rem; }

      .back-link {
        color: var(--primary-color);
        text-decoration: none;
        font-weight: 600;
      }

      .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 1rem 1.5rem;
        width: 100%;
        flex: 1;
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

      .main-column { min-width: 0; }

      .panel {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
        box-shadow: var(--shadow-md);
        padding: 1.25rem;
        margin-bottom: 1rem;
      }

      .panel h2 {
        margin: 0 0 1rem;
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 0.75rem;
      }

      .buttons {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin-bottom: 1rem;
      }

      button {
        border: none;
        border-radius: 0.5rem;
        padding: 0.75rem 1.5rem;
        font-size: 1rem;
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
        gap: 0.375rem;
        margin-bottom: 1rem;
      }

      .phase-step {
        flex: 1;
        padding: 0.4rem 0.5rem;
        border-radius: 0.375rem;
        font-size: 0.72rem;
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
        padding: 0.75rem 1rem;
        border-radius: 0.5rem;
        font-size: 0.9rem;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        color: var(--text-secondary);
        margin-bottom: 1rem;
        min-height: 2.5rem;
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
        gap: 0.75rem;
        margin-bottom: 1rem;
      }

      .stat {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        padding: 0.75rem;
      }

      .stat-label {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
        margin-bottom: 0.25rem;
      }

      .stat-value {
        font-size: 1.2rem;
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
        padding: 1rem;
        margin-bottom: 0.75rem;
      }

      .phase-result h3 {
        margin: 0 0 0.75rem;
        font-size: 0.95rem;
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
        gap: 0.5rem;
      }

      .phase-metric {
        background: var(--bg-tertiary);
        border-radius: 0.375rem;
        padding: 0.5rem 0.6rem;
      }

      .phase-metric-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
      }

      .phase-metric-value {
        font-size: 1rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }

      /* Canvas for arc visualisation */
      .canvas-wrap {
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        background: var(--bg-tertiary);
        overflow: hidden;
        margin-top: 0.75rem;
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
        padding: 1rem 1.25rem;
        margin-bottom: 1rem;
        display: none;
      }

      .suggestion-banner.visible { display: block; }

      .suggestion-title {
        font-size: 0.85rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #065f46;
        margin-bottom: 0.5rem;
      }

      .suggestion-value {
        font-size: 1.6rem;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        color: #065f46;
        margin-bottom: 0.5rem;
      }

      .suggestion-prev {
        font-size: 0.85rem;
        color: var(--text-secondary);
      }

      .warning-list {
        margin: 0.5rem 0 0;
        padding: 0 0 0 1.25rem;
        color: #92400e;
        font-size: 0.85rem;
      }

      .gnss-warn-banner {
        background: #fffbeb;
        border: 1px solid var(--warning-color);
        border-radius: 0.5rem;
        padding: 0.75rem 1rem;
        font-size: 0.85rem;
        color: #92400e;
        margin-bottom: 0.75rem;
        display: none;
      }

      .gnss-warn-banner.visible { display: block; }

      .apply-button-wrap {
        display: flex;
        gap: 0.75rem;
        align-items: center;
        margin-top: 0.75rem;
      }

      .apply-note {
        font-size: 0.82rem;
        color: var(--text-secondary);
      }

      @media (max-width: 760px) {
        .page-layout { grid-template-columns: 1fr; }
        .sidebar-column { position: static; }
        .stats-grid { grid-template-columns: repeat(2, 1fr); }
        .buttons { flex-direction: column; }
        button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="header-content">
        <h1>Dead-Reckoning Calibration</h1>
        <a class="back-link" href="/">← Back to Dashboard</a>
      </div>
    </div>

    <div class="container">
      <div class="page-layout">
        <!-- ================================================================
             Left sidebar – live sensor widgets
        ================================================================ -->
        <aside class="sidebar-column" aria-label="Live sensors">
${getLiveSensorWidgetsHtml({
  imuCardId: "imu-card",
  imuCompassId: "compass",
  imuHeadingId: "imu-heading",
  imuPitchId: "imu-pitch",
  imuRollId: "imu-roll",
  imuPitchIndicatorId: "pitch-indicator",
  imuRollIndicatorId: "roll-indicator",
  imuStatusId: "imu-status",
  imuErrorId: "imu-error",
  gnssCardId: "gnss-card",
  gnssCompassId: "gnss-compass",
  gnssHeadingId: "gnss-heading",
  gnssHeadingAccuracyId: "gnss-heading-accuracy",
  gnssAccuracyId: "gnss-accuracy",
  gnssStatusId: "gnss-status",
  gnssErrorId: "gnss-error",
  gnssFixId: "gnss-fix",
  gnssSatsId: "gnss-sats",
  gnssXMetersId: "gnss-x",
  gnssYMetersId: "gnss-y",
  includeGnsPosition: true,
  includeTilt: true,
})}
        </aside>

        <!-- ================================================================
             Main column – controls + results
        ================================================================ -->
        <main class="main-column">

          <!-- Control panel -->
          <section class="panel">
            <h2>Controls</h2>

            <div class="gnss-warn-banner" id="gnssWarnBanner"></div>

            <!-- Phase progress indicator -->
            <div class="phase-bar">
              <div class="phase-step" id="phaseWait">Waiting for fix</div>
              <div class="phase-step" id="phaseStraight">1 – Straight</div>
              <div class="phase-step" id="phaseArcRight">2 – Arc right</div>
              <div class="phase-step" id="phaseArcLeft">3 – Arc left</div>
              <div class="phase-step" id="phaseAnalyse">Analysis</div>
            </div>

            <div class="status-message" id="statusMessage">Idle – press Start to begin calibration.</div>

            <div class="buttons">
              <button id="startBtn" class="primary">Start Calibration</button>
              <button id="stopBtn" class="danger" disabled>STOP</button>
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
                <div class="stat-label">GNSS Accuracy</div>
                <div class="stat-value" id="statAccuracy">—</div>
              </div>
            </div>
          </section>

          <!-- Suggested calibration value -->
          <div class="suggestion-banner" id="suggestionBanner">
            <div class="suggestion-title">Suggested Calibration</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.6rem;margin-bottom:0.75rem">
              <div>
                <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#065f46;font-weight:600">Left m/tick</div>
                <div class="suggestion-value" id="suggestedLeft">—</div>
              </div>
              <div>
                <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#065f46;font-weight:600">Right m/tick</div>
                <div class="suggestion-value" id="suggestedRight">—</div>
              </div>
              <div>
                <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#065f46;font-weight:600">Wheelbase</div>
                <div class="suggestion-value" id="suggestedWheelbase">—</div>
              </div>
              <div>
                <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#065f46;font-weight:600">Avg DR error</div>
                <div class="suggestion-value" id="suggestedDrError">—</div>
              </div>
            </div>
            <div class="suggestion-prev" id="prevValue"></div>
            <ul class="warning-list" id="warningList" style="display:none"></ul>
            <div class="apply-button-wrap">
              <button id="applyBtn" class="primary">Apply & Save</button>
              <span class="apply-note" id="applyNote"></span>
            </div>
          </div>

          <!-- Phase result cards -->
          <div id="phaseResults"></div>

          <!-- Arc tracking canvas -->
          <section class="panel" id="canvasSection" style="display:none">
            <h2>Arc Encoder Tracking</h2>
            <p style="font-size:0.85rem;color:var(--text-secondary);margin:0 0 0.75rem">
              Steady-state samples only (middle second of each arc drive).
              Blue = encoder arc fraction, orange = IMU heading fraction.
              Closer to the diagonal = better tracking.
            </p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
              <div>
                <div style="font-size:0.8rem;font-weight:600;color:var(--text-secondary);margin-bottom:0.4rem">Arc Right</div>
                <div class="canvas-wrap"><canvas id="canvasArcRight" width="400" height="400"></canvas></div>
              </div>
              <div>
                <div style="font-size:0.8rem;font-weight:600;color:var(--text-secondary);margin-bottom:0.4rem">Arc Left</div>
                <div class="canvas-wrap"><canvas id="canvasArcLeft" width="400" height="400"></canvas></div>
              </div>
            </div>
          </section>

        </main>
      </div>
    </div>

${getAppDialogHtml()}

    <script>
${getAppDialogScript()}
${getLiveSensorWidgetsScript()}

      // -----------------------------------------------------------------------
      // Sidebar updates
      // -----------------------------------------------------------------------
      function formatMeters(v) {
        if (v === null || v === undefined) return '—';
        return v.toFixed(3) + ' m';
      }

      function formatDegrees(v) {
        if (v === null || v === undefined) return '—';
        return v.toFixed(1) + '°';
      }

      function getGnssFixClass(fixType) {
        switch ((fixType || 'unknown').toLowerCase()) {
          case 'fixed':    return 'gnss-fix-fixed';
          case 'rtk-fixed': return 'gnss-fix-rtk-fixed';
          case 'float':    return 'gnss-fix-float';
          case 'rtk-float': return 'gnss-fix-rtk-float';
          case 'single':   return 'gnss-fix-single';
          case 'none':     return 'gnss-fix-none';
          default:         return 'gnss-fix-unknown';
        }
      }

      function updateSidebar(payload) {
        const primitives = payload?.primitives ?? {};
        const imu  = primitives.imu  ?? {};
        const gnss = primitives.gnss ?? {};
        const poseFusion = primitives.poseFusion ?? {};

        const imuStatus = document.getElementById('imu-status');
        if (imuStatus) imuStatus.className = 'status-dot ' + (imu.status || 'idle');

        const imuError = document.getElementById('imu-error');
        if (imuError) {
          imuError.textContent = imu.error || '';
          imuError.style.display = imu.status === 'error' ? 'block' : 'none';
        }

        updateWidgetHeading('compass', 'imu-heading', imu.status === 'error' ? null : imu.headingDeg);
        updateTiltIndicator('pitch-indicator', 'imu-pitch', imu.status === 'error' ? null : imu.pitchDeg);
        updateTiltIndicator('roll-indicator',  'imu-roll',  imu.status === 'error' ? null : imu.rollDeg);

        const gnssStatus = document.getElementById('gnss-status');
        if (gnssStatus) gnssStatus.className = 'status-dot ' + (gnss.status || 'idle');

        const gnssError = document.getElementById('gnss-error');
        if (gnssError) {
          gnssError.textContent = gnss.error || '';
          gnssError.style.display = gnss.status === 'error' ? 'block' : 'none';
        }

        const gnssX = document.getElementById('gnss-x');
        const gnssY = document.getElementById('gnss-y');
        const gnssAcc = document.getElementById('gnss-accuracy');
        const gnssHAcc = document.getElementById('gnss-heading-accuracy');
        const gnssSats = document.getElementById('gnss-sats');
        const gnssFix = document.getElementById('gnss-fix');

        if (gnssX) gnssX.textContent = formatMeters(gnss.xMeters);
        if (gnssY) gnssY.textContent = formatMeters(gnss.yMeters);
        if (gnssFix) {
          gnssFix.textContent = gnss.fixType || '—';
          gnssFix.className = 'metric-value gnss-fix-value ' + getGnssFixClass(gnss.fixType);
        }
        if (gnssAcc) gnssAcc.textContent = formatMeters(gnss.positionAccuracyMeters);
        if (gnssHAcc) gnssHAcc.textContent = formatDegrees(gnss.headingAccuracyDeg);
        if (gnssSats) gnssSats.textContent = gnss.satellitesInUse ?? '—';

        updateWidgetHeading('gnss-compass', 'gnss-heading', gnss.status === 'error' ? null : gnss.headingDeg);
        updateWidgetSyncState(['imu-card', 'gnss-card'], poseFusion.usingGnssHeading === true);

        // Update summary stats if running
        const statFix = document.getElementById('statFix');
        const statAcc = document.getElementById('statAccuracy');
        if (statFix) statFix.textContent = gnss.fixType || '—';
        if (statAcc) {
          const acc = gnss.positionAccuracyMeters;
          const txt = acc !== null && acc !== undefined ? (acc * 100).toFixed(1) + ' cm' : '—';
          statAcc.textContent = txt;
          statAcc.className = 'stat-value ' + (acc === null ? '' : acc <= 0.10 ? 'good' : acc <= 0.20 ? 'warn' : 'bad');
        }

        // GNSS warning banner
        const gnssWarnBanner = document.getElementById('gnssWarnBanner');
        if (gnssWarnBanner) {
          const isGood = (gnss.fixType === 'fixed' || gnss.fixType === 'float' || gnss.fixType === 'rtk-fixed' || gnss.fixType === 'rtk-float')
            && gnss.positionAccuracyMeters !== null
            && gnss.positionAccuracyMeters <= 0.10;
          if (!isGood && gnss.status && gnss.status !== 'idle') {
            const fixOk = gnss.fixType === 'fixed' || gnss.fixType === 'float' || gnss.fixType === 'rtk-fixed' || gnss.fixType === 'rtk-float';
            const accOk = gnss.positionAccuracyMeters !== null && gnss.positionAccuracyMeters <= 0.10;
            let msg = 'GNSS quality insufficient for accurate calibration.';
            if (!fixOk) msg += \` Fix type "\${gnss.fixType || 'unknown'}" — need fixed or float.\`;
            if (fixOk && !accOk) msg += \` Position accuracy \${gnss.positionAccuracyMeters !== null ? (gnss.positionAccuracyMeters*100).toFixed(1)+'cm' : '?'} — need ≤10 cm.\`;
            gnssWarnBanner.textContent = '⚠ ' + msg;
            gnssWarnBanner.classList.add('visible');
          } else {
            gnssWarnBanner.classList.remove('visible');
          }
        }
      }

      // -----------------------------------------------------------------------
      // Phase indicator
      // -----------------------------------------------------------------------
      const PHASE_IDS = {
        'waiting-for-fix': 'phaseWait',
        'straight':        'phaseStraight',
        'arc-right':       'phaseArcRight',
        'arc-left':        'phaseArcLeft',
        'analysing':       'phaseAnalyse',
        'done':            'phaseAnalyse',
        'stopped':         null,
        'error':           null,
        'idle':            null,
      };

      const PHASE_ORDER = ['waiting-for-fix', 'straight', 'arc-right', 'arc-left', 'analysing'];

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
          renderPhaseResult('Arc Right', 'badge-arc-right', 'arc-right', result.arcRightPhase) +
          renderPhaseResult('Arc Left',  'badge-arc-left',  'arc-left',  result.arcLeftPhase);
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

        // Background
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, 0, W, H);

        // Diagonal (ideal tracking)
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

        // Compute fractions
        const first = samples[0];
        const last  = samples[samples.length - 1];
        const totalEnc = Math.max(1, (last.leftTicksTotal - first.leftTicksTotal + last.rightTicksTotal - first.rightTicksTotal) / 2);
        const totalImu = Math.max(0.001, Math.abs(normalizeAngle(last.imuHeadingDeg - first.imuHeadingDeg)));

        const points = samples.map(s => {
          const encFrac = ((s.leftTicksTotal - first.leftTicksTotal + s.rightTicksTotal - first.rightTicksTotal) / 2) / totalEnc;
          const imuFrac = Math.abs(normalizeAngle(s.imuHeadingDeg - first.imuHeadingDeg)) / totalImu;
          return { x: encFrac, y: imuFrac };
        });

        // Draw encoder line (x-axis = enc, y-axis = imu)
        const toCanvasX = (f) => pad + f * (W - 2 * pad);
        const toCanvasY = (f) => (H - pad) - f * (H - 2 * pad);

        // Plot points
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

        // Dots
        ctx.fillStyle = '#2563eb';
        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(toCanvasX(p.x), toCanvasY(p.y), 3, 0, Math.PI * 2);
          ctx.fill();
        });

        // Axis labels
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
      // Main status polling
      // -----------------------------------------------------------------------
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

      let lastPhase = 'idle';

      async function update() {
        try {
          const payload = await fetchStatus();
          updateSidebar(payload.primitives);

          const data = payload.status;
          const phase = data.phase ?? 'idle';
          const message = data.phaseMessage ?? '';
          const running = data.running ?? false;
          const result  = data.result ?? null;

          // Update phase bar
          updatePhaseBar(phase);

          // Status message
          const msgEl = document.getElementById('statusMessage');
          if (msgEl) {
            msgEl.textContent = message || 'Idle.';
            msgEl.className = 'status-message';
            if (phase === 'error') msgEl.className += ' error';
            else if (phase === 'done') msgEl.className += ' success';
            else if (phase === 'stopped') msgEl.className += ' warning';
          }

          // Summary stats visibility
          const summaryStats = document.getElementById('summaryStats');
          if (summaryStats) summaryStats.style.display = running ? 'grid' : 'none';

          const statPhase = document.getElementById('statPhase');
          if (statPhase) statPhase.textContent = phase;

          // Buttons
          document.getElementById('startBtn').disabled = running;
          document.getElementById('stopBtn').disabled = !running;

          // Phase result cards
          if (result) {
            renderPhaseResults(result);
            updateSuggestionBanner(result);

            // Arc canvases
            const canvasSection = document.getElementById('canvasSection');
            if (canvasSection) canvasSection.style.display = '';
            if (result.arcRightPhase) {
              drawArcCanvas('canvasArcRight', result.arcRightPhase.steadyStateSamples);
            }
            if (result.arcLeftPhase) {
              drawArcCanvas('canvasArcLeft', result.arcLeftPhase.steadyStateSamples);
            }
          }

          lastPhase = phase;
        } catch (err) {
          console.error('Status update failed:', err);
        }
      }

      // -----------------------------------------------------------------------
      // Button handlers
      // -----------------------------------------------------------------------
      document.getElementById('startBtn').addEventListener('click', async () => {
        document.getElementById('startBtn').disabled = true;
        document.getElementById('stopBtn').disabled = false;
        document.getElementById('phaseResults').innerHTML = '';
        document.getElementById('suggestionBanner').classList.remove('visible');
        document.getElementById('canvasSection').style.display = 'none';
        pendingSuggestedValue = null;
        try {
          const res = await fetch('/api/dead-reckoning/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (!res.ok) {
            const err = await res.json();
            await appAlert('Failed to start: ' + (err.error || res.statusText));
          }
          await update();
        } catch (err) {
          document.getElementById('startBtn').disabled = false;
          await appAlert('Network error: ' + err.message);
        }
      });

      document.getElementById('stopBtn').addEventListener('click', async () => {
        try {
          await fetch('/api/dead-reckoning/stop', {
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
      // Start polling
      // -----------------------------------------------------------------------
      update();
      const interval = setInterval(update, 1000);
      window.addEventListener('beforeunload', () => clearInterval(interval));
    </script>
  </body>
</html>`;
}
