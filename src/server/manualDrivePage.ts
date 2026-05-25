import { getAppDialogHtml, getAppDialogScript, getAppDialogStyles } from "./appDialogs.js";

/**
 * Drive & Paths dashboard - live controller view with position map and path management
 */

export function getManualDrivePageHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Drive & Paths - Mower Control</title>
  <style>
    :root {
      --primary-color: #2563eb;
      --primary-hover: #1d4ed8;
      --success-color: #10b981;
      --danger-color: #ef4444;
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
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: var(--bg-secondary);
      color: var(--text-primary);
      line-height: 1.6;
    }

    .container {
      max-width: 1600px;
      margin: 0 auto;
      padding: 1rem;
    }

    .main-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
      gap: 1.5rem;
      align-items: start;
    }

    .left-column {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      min-width: 0;
    }

    .right-column {
      display: flex;
      flex-direction: column;
      gap: 1rem;
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

    .subtitle {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .map-section {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 1rem;
      box-shadow: var(--shadow-md);
    }

    .section-title {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 1rem;
    }

    #mapCanvas {
      width: 100%;
      aspect-ratio: 3 / 2;
      height: auto;
      max-height: min(70vh, 720px);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      display: block;
    }

    .map-stats {
      margin-top: 0.75rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: 'SFMono-Regular', Consolas, monospace;
    }

    .section {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.5rem;
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border-color);
    }

    .path-layout {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1rem;
      align-items: start;
    }

    .section-title {
      font-size: 1.15rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: var(--text-primary);
    }

    .section-description {
      color: var(--text-secondary);
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }

    .instructions {
      background: rgba(37, 99, 235, 0.05);
      border: 1px solid rgba(37, 99, 235, 0.2);
      border-radius: 0.5rem;
      padding: 1rem;
      margin-bottom: 1rem;
    }

    .instructions-title {
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--primary-color);
    }

    .instructions-list {
      list-style-position: inside;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    .instructions-list li {
      margin-bottom: 0.25rem;
    }

    .controls {
      display: flex;
      gap: 1rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
      align-items: center;
    }

    .input-group {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
      flex: 1;
      min-width: 220px;
    }

    .input-group label {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .input-group input[type="text"] {
      padding: 0.625rem 0.875rem;
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-family: inherit;
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .input-group input[type="text"]:focus {
      outline: none;
      border-color: var(--primary-color);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }

    .button {
      padding: 0.75rem 1.5rem;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      box-shadow: var(--shadow-sm);
    }

    .button:hover {
      box-shadow: var(--shadow-md);
      transform: translateY(-1px);
    }

    .button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    .button-primary {
      background: var(--primary-color);
      color: white;
    }

    .button-primary:hover:not(:disabled) {
      background: var(--primary-hover);
    }

    .button-success {
      background: var(--success-color);
      color: white;
    }

    .button-success:hover:not(:disabled) {
      background: #059669;
    }

    .button-danger {
      background: var(--danger-color);
      color: white;
    }

    .button-danger:hover:not(:disabled) {
      background: #dc2626;
    }

    .button-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }

    .button-secondary:hover:not(:disabled) {
      background: var(--border-color);
    }

    .button-small {
      padding: 0.5rem 1rem;
      font-size: 0.75rem;
    }

    .recording-indicator {
      display: none;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background: rgba(220, 38, 38, 0.1);
      border: 1px solid var(--danger-color);
      border-radius: 0.5rem;
      color: var(--danger-color);
      font-weight: 600;
      font-size: 0.875rem;
    }

    .recording-indicator.active {
      display: flex;
    }

    .recording-dot {
      width: 0.75rem;
      height: 0.75rem;
      background: var(--danger-color);
      border-radius: 50%;
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .status-box {
      padding: 1rem;
      background: var(--bg-tertiary);
      border-radius: 0.5rem;
      border: 1px solid var(--border-color);
      font-size: 0.875rem;
    }

    .status-row {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
    }

    .status-row:not(:last-child) {
      border-bottom: 1px solid var(--border-color);
    }

    .status-label {
      color: var(--text-secondary);
      font-weight: 500;
    }

    .status-value {
      color: var(--text-primary);
      font-weight: 600;
    }

    .paths-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .path-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      background: var(--bg-tertiary);
      border-radius: 0.5rem;
      border: 1px solid var(--border-color);
    }

    .path-info {
      flex: 1;
      min-width: 0;
    }

    .path-name {
      font-weight: 600;
      font-size: 1rem;
      margin-bottom: 0.25rem;
    }

    .path-meta {
      color: var(--text-secondary);
      font-size: 0.75rem;
    }

    .path-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .path-toolbar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }

    .empty-state {
      text-align: center;
      padding: 2rem 1rem;
      color: var(--text-secondary);
    }

    .empty-state-icon {
      font-size: 3rem;
      margin-bottom: 0.75rem;
    }

${getAppDialogStyles()}

    @media (max-width: 1024px) {
      .path-layout {
        grid-template-columns: 1fr;
      }

      .path-item {
        flex-direction: column;
        align-items: stretch;
      }

      .path-actions {
        justify-content: stretch;
      }

      .path-actions .button-small {
        flex: 1;
      }
    }

    @media (max-width: 768px) {
      h1 {
        font-size: 1.25rem;
      }

      .controls {
        flex-direction: column;
        align-items: stretch;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="header-left">
        <h1>🧭 Drive &amp; Paths</h1>
        <p class="subtitle">Manual drive, live position tracking, and path recording in one place</p>
      </div>
      <a href="/" class="back-link">← Back to Dashboard</a>
    </div>
  </div>

  <div class="container">
    <div class="map-section">
      <div class="section-title">Position Map (Last 10 Minutes)</div>
      <canvas id="mapCanvas" width="1200" height="800"></canvas>
      <div class="map-stats" id="mapStats">Waiting for position data...</div>
    </div>

    <div class="path-layout">
        <div class="section">
          <div class="section-title">Record New Path</div>
          <p class="section-description">
            Record a path by manually driving or dragging the mower. Position samples are captured every 10cm of movement.
          </p>

          <div class="instructions">
            <div class="instructions-title">How to Record</div>
            <ol class="instructions-list">
              <li>Enter a name for your path or keep the suggested obstacle name.</li>
              <li>Click Start Recording and move the mower around the obstacle.</li>
              <li>Click Stop &amp; Save when you have finished tracing the path.</li>
            </ol>
          </div>

          <div class="controls">
            <div class="input-group">
              <label for="pathName">Path Name</label>
              <input type="text" id="pathName" placeholder="e.g., Obstacle 1" />
            </div>

            <button id="startRecordingBtn" class="button button-success" type="button">
              <span>⏺</span> Start Recording
            </button>

            <button id="stopRecordingBtn" class="button button-danger" type="button" disabled>
              <span>⏹</span> Stop &amp; Save
            </button>

            <button id="cancelRecordingBtn" class="button button-secondary" type="button" disabled>
              <span>✖</span> Cancel
            </button>

            <div id="recordingIndicator" class="recording-indicator">
              <div class="recording-dot"></div>
              <span>Recording...</span>
            </div>
          </div>

          <div class="status-box">
            <div class="status-row">
              <span class="status-label">Status:</span>
              <span class="status-value" id="recordingStatus">Ready</span>
            </div>
            <div class="status-row">
              <span class="status-label">Points Captured:</span>
              <span class="status-value" id="pointCount">0</span>
            </div>
            <div class="status-row">
              <span class="status-label">Current Path:</span>
              <span class="status-value" id="currentPathName">—</span>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Stored Paths</div>
          <p class="section-description">
            Manage and execute recorded paths. Drive a path to follow it autonomously, or verify it by joining at the nearest point and looping back to that join point.
          </p>

          <div class="path-toolbar">
            <button id="stopPathBtn" class="button button-danger" type="button" onclick="stopPathOperation()">
              <span>⏹</span> STOP
            </button>
          </div>

          <div id="pathsList" class="paths-list">
            <div class="empty-state">
              <div class="empty-state-icon">📭</div>
              <div>No paths recorded yet</div>
            </div>
          </div>
        </div>
    </div>
  </div>

${getAppDialogHtml()}

  <script>
${getAppDialogScript()}
    const $ = (id) => document.getElementById(id);

    function format(value, decimals = 2) {
      return Number(value).toFixed(decimals);
    }

    // Position history tracking
    const positionHistory = [];
    const MAX_HISTORY_MS = 10 * 60 * 1000; // 10 minutes
    const canvas = $("mapCanvas");
    const ctx = canvas.getContext("2d");

    // Path recording / management state
    let recording = false;
    let currentPathName = '';
    let pointCount = 0;
    let storedPaths = [];
    let statusPollInterval = null;

    // Elements
    const pathNameInput = $("pathName");
    const startRecordingBtn = $("startRecordingBtn");
    const stopRecordingBtn = $("stopRecordingBtn");
    const cancelRecordingBtn = $("cancelRecordingBtn");
    const recordingIndicator = $("recordingIndicator");
    const recordingStatusEl = $("recordingStatus");
    const pointCountEl = $("pointCount");
    const currentPathNameEl = $("currentPathName");
    const pathsListEl = $("pathsList");

    function addPositionToHistory(x, y, heading, timestamp) {
      positionHistory.push({ x, y, heading, timestamp });

      // Remove old points beyond 10 minutes
      const cutoff = timestamp - MAX_HISTORY_MS;
      while (positionHistory.length > 0 && positionHistory[0].timestamp < cutoff) {
        positionHistory.shift();
      }
    }

    function drawMap() {
      if (positionHistory.length === 0 && storedPaths.length === 0) {
        ctx.fillStyle = "#f3f4f6";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        $("mapStats").textContent = "Waiting for position data...";
        return;
      }

      const width = canvas.width;
      const height = canvas.height;
      const padding = 60;

      // Clear canvas
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(0, 0, width, height);

      // Find bounds (include position history and stored paths)
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;

      for (const pos of positionHistory) {
        minX = Math.min(minX, pos.x);
        maxX = Math.max(maxX, pos.x);
        minY = Math.min(minY, pos.y);
        maxY = Math.max(maxY, pos.y);
      }

      for (const path of storedPaths) {
        for (const point of path.points) {
          minX = Math.min(minX, point.xMeters);
          maxX = Math.max(maxX, point.xMeters);
          minY = Math.min(minY, point.yMeters);
          maxY = Math.max(maxY, point.yMeters);
        }
      }

      // Add padding to bounds
      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;
      minX -= rangeX * 0.1;
      maxX += rangeX * 0.1;
      minY -= rangeY * 0.1;
      maxY += rangeY * 0.1;

      // Calculate scale to fit canvas
      const scaleX = (width - 2 * padding) / (maxX - minX);
      const scaleY = (height - 2 * padding) / (maxY - minY);
      const scale = Math.min(scaleX, scaleY);

      // Transform functions
      const toCanvasX = (x) => padding + (x - minX) * scale;
      const toCanvasY = (y) => height - padding - (y - minY) * scale;

      // Draw grid
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 1;
      const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(rangeX, rangeY) / 5)));

      for (let x = Math.floor(minX / gridSize) * gridSize; x <= maxX; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(toCanvasX(x), padding);
        ctx.lineTo(toCanvasX(x), height - padding);
        ctx.stroke();
      }
      for (let y = Math.floor(minY / gridSize) * gridSize; y <= maxY; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(padding, toCanvasY(y));
        ctx.lineTo(width - padding, toCanvasY(y));
        ctx.stroke();
      }

      // Draw axes labels
      ctx.fillStyle = "#6b7280";
      ctx.font = "12px monospace";
      ctx.textAlign = "center";
      ctx.fillText("X (meters)", width / 2, height - 10);
      ctx.save();
      ctx.translate(15, height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("Y (meters)", 0, 0);
      ctx.restore();

      // Draw stored paths first (underneath)
      const pathColors = [
        'rgba(16, 185, 129, 0.4)', // green
        'rgba(245, 158, 11, 0.4)',  // amber
        'rgba(139, 92, 246, 0.4)',  // purple
        'rgba(236, 72, 153, 0.4)',  // pink
        'rgba(14, 165, 233, 0.4)',  // sky
      ];

      storedPaths.forEach((path, pathIndex) => {
        const color = pathColors[pathIndex % pathColors.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;

        ctx.beginPath();
        for (let i = 0; i < path.points.length; i++) {
          const point = path.points[i];
          const x = toCanvasX(point.xMeters);
          const y = toCanvasY(point.yMeters);
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();

        // Draw path name at start point
        if (path.points.length > 0) {
          const startPoint = path.points[0];
          const sx = toCanvasX(startPoint.xMeters);
          const sy = toCanvasY(startPoint.yMeters);

          ctx.fillStyle = color.replace('0.4', '0.9');
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 3;
          ctx.font = 'bold 14px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.strokeText(path.name, sx, sy - 10);
          ctx.fillText(path.name, sx, sy - 10);

          // Draw start marker
          ctx.fillStyle = color.replace('0.4', '0.8');
          ctx.beginPath();
          ctx.arc(sx, sy, 6, 0, 2 * Math.PI);
          ctx.fill();
        }
      });

      if (positionHistory.length > 0) {
        // Draw trail with fading (on top of stored paths)
        const now = positionHistory[positionHistory.length - 1].timestamp;
        ctx.lineWidth = 3;

        for (let i = 1; i < positionHistory.length; i++) {
          const prev = positionHistory[i - 1];
          const curr = positionHistory[i];
          const age = now - curr.timestamp;
          const opacity = 1 - (age / MAX_HISTORY_MS);

          ctx.strokeStyle = \`rgba(37, 99, 235, \${opacity * 0.6})\`;
          ctx.beginPath();
          ctx.moveTo(toCanvasX(prev.x), toCanvasY(prev.y));
          ctx.lineTo(toCanvasX(curr.x), toCanvasY(curr.y));
          ctx.stroke();
        }

        // Draw current position as arrow
        const current = positionHistory[positionHistory.length - 1];
        const cx = toCanvasX(current.x);
        const cy = toCanvasY(current.y);
        const headingRad = (current.heading * Math.PI) / 180;
        const arrowSize = 20;

        ctx.fillStyle = "#2563eb";
        ctx.strokeStyle = "#1e3a8a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(
          cx + Math.cos(headingRad) * arrowSize,
          cy - Math.sin(headingRad) * arrowSize
        );
        ctx.lineTo(
          cx + Math.cos(headingRad + 2.6) * arrowSize * 0.6,
          cy - Math.sin(headingRad + 2.6) * arrowSize * 0.6
        );
        ctx.lineTo(cx, cy);
        ctx.lineTo(
          cx + Math.cos(headingRad - 2.6) * arrowSize * 0.6,
          cy - Math.sin(headingRad - 2.6) * arrowSize * 0.6
        );
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Update stats
        const distance = Math.max(rangeX, rangeY);
        $("mapStats").textContent = \`\${positionHistory.length} points | range: \${format(distance, 2)}m | scale: \${format(1/scale, 3)}m/px | current: (\${format(current.x, 2)}, \${format(current.y, 2)})\`;
      } else {
        $("mapStats").textContent = \`\${storedPaths.length} stored path\${storedPaths.length === 1 ? '' : 's'} | scale: \${format(1/scale, 3)}m/px\`;
      }
    }

    async function loadStoredPaths() {
      try {
        const response = await fetch('/api/paths');
        const data = await response.json();

        // Load full path data for each path
        const pathPromises = (data.paths ?? []).map(async (pathInfo) => {
          const pathResponse = await fetch(\`/api/paths/\${encodeURIComponent(pathInfo.name)}\`);
          return await pathResponse.json();
        });

        storedPaths = await Promise.all(pathPromises);
        renderPaths();
        drawMap();
      } catch (error) {
        console.error('Failed to load stored paths:', error);
      }
    }

    function getNextPathName() {
      const obstaclePattern = /^Obstacle (\d+)$/;
      let maxNum = 0;

      storedPaths.forEach((path) => {
        const match = path.name?.match(obstaclePattern);
        if (match) {
          maxNum = Math.max(maxNum, parseInt(match[1], 10));
        }
      });

      return \`Obstacle \${maxNum + 1}\`;
    }

    function updateRecordingUi() {
      startRecordingBtn.disabled = recording;
      stopRecordingBtn.disabled = !recording;
      cancelRecordingBtn.disabled = !recording;
      pathNameInput.disabled = recording;

      if (recording) {
        recordingIndicator.classList.add('active');
        recordingStatusEl.textContent = 'Recording';
        recordingStatusEl.style.color = 'var(--danger-color)';
        currentPathNameEl.textContent = currentPathName;
      } else {
        recordingIndicator.classList.remove('active');
        recordingStatusEl.textContent = 'Ready';
        recordingStatusEl.style.color = 'var(--success-color)';
        currentPathNameEl.textContent = '—';
      }

      pointCountEl.textContent = String(pointCount);
    }

    function renderPaths() {
      if (storedPaths.length === 0) {
        pathsListEl.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <div>No paths recorded yet</div>
          </div>
        \`;
        return;
      }

      pathsListEl.innerHTML = storedPaths.map((path) => {
        const pointTotal = path.points?.length ?? path.pointCount ?? 0;
        const totalDistance = path.metadata?.totalDistance ?? 0;
        const createdAt = path.createdAt ? new Date(path.createdAt).toLocaleString() : 'Unknown';

        return \`
          <div class="path-item">
            <div class="path-info">
              <div class="path-name">\${path.name}</div>
              <div class="path-meta">
                \${pointTotal} points • \${totalDistance.toFixed(1)}m total distance
                • Created \${createdAt}
              </div>
            </div>
            <div class="path-actions">
              <button class="button button-primary button-small" type="button" onclick="drivePath('\${path.name}')">
                <span>▶️</span> Drive
              </button>
              <button class="button button-success button-small" type="button" onclick="verifyPath('\${path.name}')">
                <span>✓</span> Verify
              </button>
              <button class="button button-danger button-small" type="button" onclick="deletePath('\${path.name}')">
                <span>🗑️</span> Delete
              </button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function startStatusPolling() {
      stopStatusPolling();
      statusPollInterval = setInterval(async () => {
        try {
          const response = await fetch('/api/path/record/status');
          if (response.ok) {
            const status = await response.json();
            pointCount = status.pointCount ?? 0;
            updateRecordingUi();
          }
        } catch (error) {
          console.error('Failed to fetch recording status:', error);
        }
      }, 500);
    }

    function stopStatusPolling() {
      if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
      }
    }

    startRecordingBtn.addEventListener('click', async () => {
      const pathName = pathNameInput.value.trim() || getNextPathName();

      try {
        const response = await fetch('/api/path/record/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pathName }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Failed to start recording');
        }

        recording = true;
        currentPathName = pathName;
        pointCount = 0;
        updateRecordingUi();
        startStatusPolling();
      } catch (error) {
        alert('Failed to start recording: ' + error.message);
      }
    });

    stopRecordingBtn.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/path/record/stop', {
          method: 'POST',
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Failed to stop recording');
        }

        const result = await response.json();
        recording = false;
        currentPathName = '';
        pointCount = 0;
        pathNameInput.value = '';
        updateRecordingUi();
        stopStatusPolling();
        await loadStoredPaths();
        pathNameInput.value = getNextPathName();

        const savedPointCount = result.pointCount ?? result.metadata?.pointCount ?? 0;
        alert(\`Path saved: \${result.name}\n\${savedPointCount} points recorded\`);
      } catch (error) {
        alert('Failed to save path: ' + error.message);
      }
    });

    cancelRecordingBtn.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/path/record/cancel', {
          method: 'POST',
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Failed to cancel recording');
        }

        recording = false;
        currentPathName = '';
        pointCount = 0;
        updateRecordingUi();
        stopStatusPolling();
      } catch (error) {
        alert('Failed to cancel recording: ' + error.message);
      }
    });

    window.drivePath = async function(pathName) {
      if (recording) {
        alert('Stop recording before starting a path drive.');
        return;
      }

      await runPathAction(pathName, '/api/path/drive', 'drive', 'Path drive complete');
    };

    window.verifyPath = async function(pathName) {
      if (recording) {
        alert('Stop recording before starting a path verification run.');
        return;
      }

      await runPathAction(pathName, '/api/path/verify', 'verify', 'Path verification complete');
    };

    async function runPathAction(pathName, endpoint, actionName, successLabel) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pathName }),
        });

        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || 'Failed to start path action');
        }

        const reason = result.completed ? '' : \`\nReason: \${result.reason ?? 'unknown'}\`;
        alert(\`\${successLabel}: \${pathName}\${reason}\`);
      } catch (error) {
        alert(\`Failed to \${actionName} path: \${error.message}\`);
      }
    }

    window.stopPathOperation = async function() {
      try {
        const response = await fetch('/api/path/stop', {
          method: 'POST',
        });

        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || 'Failed to stop path following');
        }

        alert('Path stop requested.');
      } catch (error) {
        alert('Failed to stop path operation: ' + error.message);
      }
    };

    window.deletePath = async function(pathName) {
      try {
        const response = await fetch('/api/path/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pathName }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Failed to delete path');
        }

        await loadStoredPaths();
        pathNameInput.value = getNextPathName();
      } catch (error) {
        alert('Failed to delete path: ' + error.message);
      }
    };

    async function updateStatus() {
      try {
        const response = await fetch('/api/primitives');
        const data = await response.json();
        const primitives = data.primitives;

        if (primitives.poseFusion && primitives.poseFusion.status === 'ok') {
          const pose = primitives.poseFusion;
          $("mapStats").textContent = \`Pose: \${format(pose.headingDeg, 1)}° | speed: \${format(pose.speedMetersPerSecond, 3)} m/s\`;
          if (pose.xMeters != null && pose.yMeters != null) {
            addPositionToHistory(
              pose.xMeters,
              pose.yMeters,
              pose.headingDeg,
              Date.now()
            );
            drawMap();
          }
        } else {
          $("mapStats").textContent = primitives.poseFusion?.error || 'No data';
        }

      } catch (error) {
        console.error('Failed to update status:', error);
      }
    }

    updateRecordingUi();

    // Load stored paths once at startup, then refresh every 10 seconds
    loadStoredPaths().then(() => {
      if (!recording) {
        pathNameInput.value = getNextPathName();
      }
      updateRecordingUi();
    });
    setInterval(loadStoredPaths, 10000);

    // Poll for updates
    setInterval(updateStatus, 500);
    updateStatus();
  </script>
</body>
</html>
  `;
}
