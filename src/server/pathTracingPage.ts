/**
 * Path Tracing Web UI
 *
 * Allows users to:
 * - Record paths by manually driving/dragging the mower
 * - List and manage stored paths
 * - Drive recorded paths (path following)
 */

export function renderPathTracingPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>Path Tracing - Mower Control</title>
    <style>
      :root {
        --primary: #2563eb;
        --primary-hover: #1d4ed8;
        --success: #10b981;
        --success-hover: #059669;
        --danger: #ef4444;
        --danger-hover: #dc2626;
        --warning: #f59e0b;
        --bg: #ffffff;
        --bg-secondary: #f9fafb;
        --bg-tertiary: #f3f4f6;
        --text: #111827;
        --text-secondary: #6b7280;
        --text-muted: #9ca3af;
        --border: #e5e7eb;
        --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
        --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        --recording: #dc2626;
      }

      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        background: var(--bg-secondary);
        color: var(--text);
        line-height: 1.6;
      }

      .header {
        background: var(--bg);
        border-bottom: 1px solid var(--border);
        padding: 1.5rem;
        box-shadow: var(--shadow-sm);
      }

      .header-content {
        max-width: 1200px;
        margin: 0 auto;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      h1 {
        font-size: 1.875rem;
        font-weight: 700;
        color: var(--text);
      }

      .back-link {
        color: var(--primary);
        text-decoration: none;
        font-weight: 500;
        font-size: 0.875rem;
      }

      .back-link:hover {
        color: var(--primary-hover);
        text-decoration: underline;
      }

      .container {
        max-width: 1200px;
        margin: 0 auto;
        padding: 2rem 1.5rem;
      }

      .section {
        background: var(--bg);
        border-radius: 0.75rem;
        padding: 1.5rem;
        margin-bottom: 1.5rem;
        box-shadow: var(--shadow-sm);
        border: 1px solid var(--border);
      }

      .section-title {
        font-size: 1.25rem;
        font-weight: 600;
        margin-bottom: 1rem;
        color: var(--text);
      }

      .section-description {
        color: var(--text-secondary);
        font-size: 0.875rem;
        margin-bottom: 1.5rem;
      }

      .controls {
        display: flex;
        gap: 1rem;
        margin-bottom: 1.5rem;
        flex-wrap: wrap;
        align-items: center;
      }

      .input-group {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        flex: 1;
        min-width: 200px;
      }

      label {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--text-secondary);
      }

      input[type="text"] {
        padding: 0.625rem 0.875rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        font-size: 0.875rem;
        font-family: inherit;
        background: var(--bg);
        color: var(--text);
      }

      input[type="text"]:focus {
        outline: none;
        border-color: var(--primary);
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
        background: var(--primary);
        color: white;
      }

      .button-primary:hover:not(:disabled) {
        background: var(--primary-hover);
      }

      .button-success {
        background: var(--success);
        color: white;
      }

      .button-success:hover:not(:disabled) {
        background: var(--success-hover);
      }

      .button-danger {
        background: var(--danger);
        color: white;
      }

      .button-danger:hover:not(:disabled) {
        background: var(--danger-hover);
      }

      .button-secondary {
        background: var(--bg-tertiary);
        color: var(--text);
        border: 1px solid var(--border);
      }

      .button-secondary:hover:not(:disabled) {
        background: var(--border);
      }

      .recording-indicator {
        display: none;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem 1rem;
        background: rgba(220, 38, 38, 0.1);
        border: 1px solid var(--recording);
        border-radius: 0.5rem;
        color: var(--recording);
        font-weight: 600;
        font-size: 0.875rem;
      }

      .recording-indicator.active {
        display: flex;
      }

      .recording-dot {
        width: 0.75rem;
        height: 0.75rem;
        background: var(--recording);
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
        border: 1px solid var(--border);
        font-size: 0.875rem;
      }

      .status-row {
        display: flex;
        justify-content: space-between;
        padding: 0.5rem 0;
      }

      .status-row:not(:last-child) {
        border-bottom: 1px solid var(--border);
      }

      .status-label {
        color: var(--text-secondary);
        font-weight: 500;
      }

      .status-value {
        color: var(--text);
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
        padding: 1rem;
        background: var(--bg-tertiary);
        border-radius: 0.5rem;
        border: 1px solid var(--border);
      }

      .path-info {
        flex: 1;
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
      }

      .button-small {
        padding: 0.5rem 1rem;
        font-size: 0.75rem;
      }

      .empty-state {
        text-align: center;
        padding: 3rem 1rem;
        color: var(--text-muted);
      }

      .empty-state-icon {
        font-size: 3rem;
        margin-bottom: 1rem;
      }

      .instructions {
        background: rgba(37, 99, 235, 0.05);
        border: 1px solid rgba(37, 99, 235, 0.2);
        border-radius: 0.5rem;
        padding: 1rem;
        margin-bottom: 1.5rem;
      }

      .instructions-title {
        font-weight: 600;
        margin-bottom: 0.5rem;
        color: var(--primary);
      }

      .instructions-list {
        list-style-position: inside;
        color: var(--text-secondary);
        font-size: 0.875rem;
      }

      .instructions-list li {
        margin-bottom: 0.25rem;
      }

      @media (max-width: 768px) {
        .controls {
          flex-direction: column;
          align-items: stretch;
        }

        .path-item {
          flex-direction: column;
          align-items: stretch;
          gap: 1rem;
        }

        .path-actions {
          justify-content: stretch;
        }

        .path-actions .button-small {
          flex: 1;
        }
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="header-content">
        <h1>🗺️ Path Tracing</h1>
        <a href="/" class="back-link">← Back to Dashboard</a>
      </div>
    </div>

    <div class="container">
      <!-- Recording Section -->
      <div class="section">
        <h2 class="section-title">Record New Path</h2>
        <p class="section-description">
          Record a path by manually driving or dragging the mower. Position samples are captured every 10cm of movement.
        </p>

        <div class="instructions">
          <div class="instructions-title">📝 How to Record:</div>
          <ol class="instructions-list">
            <li>Enter a name for your path (e.g., "Obstacle 1" or "Garden Border")</li>
            <li>Click "Start Recording" - position logging begins</li>
            <li>Manually drive or drag the mower along the desired path</li>
            <li>Click "Stop & Save" when complete</li>
          </ol>
        </div>

        <div class="controls">
          <div class="input-group">
            <label for="pathName">Path Name</label>
            <input type="text" id="pathName" placeholder="e.g., Obstacle 1" />
          </div>

          <button id="startRecordingBtn" class="button button-success">
            <span>⏺</span> Start Recording
          </button>

          <button id="stopRecordingBtn" class="button button-danger" disabled>
            <span>⏹</span> Stop & Save
          </button>

          <button id="cancelRecordingBtn" class="button button-secondary" disabled>
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

      <!-- Stored Paths Section -->
      <div class="section">
        <h2 class="section-title">Stored Paths</h2>
        <p class="section-description">
          Manage and execute recorded paths. Drive a path to follow it autonomously.
        </p>

        <div id="pathsList" class="paths-list">
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <div>No paths recorded yet</div>
          </div>
        </div>
      </div>
    </div>

    <script>
      const API_BASE = '';

      // State
      let recording = false;
      let currentPathName = '';
      let pointCount = 0;
      let paths = [];

      // Elements
      const pathNameInput = document.getElementById('pathName');
      const startRecordingBtn = document.getElementById('startRecordingBtn');
      const stopRecordingBtn = document.getElementById('stopRecordingBtn');
      const cancelRecordingBtn = document.getElementById('cancelRecordingBtn');
      const recordingIndicator = document.getElementById('recordingIndicator');
      const recordingStatusEl = document.getElementById('recordingStatus');
      const pointCountEl = document.getElementById('pointCount');
      const currentPathNameEl = document.getElementById('currentPathName');
      const pathsListEl = document.getElementById('pathsList');

      // Auto-increment path naming
      function getNextPathName() {
        const obstaclePattern = /^Obstacle (\\d+)$/;
        let maxNum = 0;

        paths.forEach(path => {
          const match = path.name.match(obstaclePattern);
          if (match) {
            maxNum = Math.max(maxNum, parseInt(match[1]));
          }
        });

        return \`Obstacle \${maxNum + 1}\`;
      }

      // Start recording
      startRecordingBtn.addEventListener('click', async () => {
        const pathName = pathNameInput.value.trim() || getNextPathName();

        try {
          const response = await fetch(\`\${API_BASE}/api/path/record/start\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pathName })
          });

          if (!response.ok) throw new Error('Failed to start recording');

          recording = true;
          currentPathName = pathName;
          pointCount = 0;

          updateUI();
          startStatusPolling();
        } catch (error) {
          alert('Failed to start recording: ' + error.message);
        }
      });

      // Stop and save
      stopRecordingBtn.addEventListener('click', async () => {
        try {
          const response = await fetch(\`\${API_BASE}/api/path/record/stop\`, {
            method: 'POST'
          });

          if (!response.ok) throw new Error('Failed to stop recording');

          const result = await response.json();

          recording = false;
          currentPathName = '';
          pointCount = 0;
          pathNameInput.value = '';

          updateUI();
          stopStatusPolling();
          await loadPaths();

          alert(\`Path saved: \${result.name}\\n\${result.pointCount} points recorded\`);
        } catch (error) {
          alert('Failed to save path: ' + error.message);
        }
      });

      // Cancel recording
      cancelRecordingBtn.addEventListener('click', async () => {
        try {
          const response = await fetch(\`\${API_BASE}/api/path/record/cancel\`, {
            method: 'POST'
          });

          if (!response.ok) throw new Error('Failed to cancel recording');

          recording = false;
          currentPathName = '';
          pointCount = 0;

          updateUI();
          stopStatusPolling();
        } catch (error) {
          alert('Failed to cancel recording: ' + error.message);
        }
      });

      // Update UI based on state
      function updateUI() {
        startRecordingBtn.disabled = recording;
        stopRecordingBtn.disabled = !recording;
        cancelRecordingBtn.disabled = !recording;
        pathNameInput.disabled = recording;

        if (recording) {
          recordingIndicator.classList.add('active');
          recordingStatusEl.textContent = 'Recording';
          recordingStatusEl.style.color = 'var(--recording)';
          currentPathNameEl.textContent = currentPathName;
        } else {
          recordingIndicator.classList.remove('active');
          recordingStatusEl.textContent = 'Ready';
          recordingStatusEl.style.color = 'var(--success)';
          currentPathNameEl.textContent = '—';
        }

        pointCountEl.textContent = pointCount;
      }

      // Status polling during recording
      let statusPollInterval = null;

      function startStatusPolling() {
        statusPollInterval = setInterval(async () => {
          try {
            const response = await fetch(\`\${API_BASE}/api/path/record/status\`);
            if (response.ok) {
              const status = await response.json();
              pointCount = status.pointCount;
              updateUI();
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

      // Load paths list
      async function loadPaths() {
        try {
          const response = await fetch(\`\${API_BASE}/api/path/list\`);
          if (!response.ok) throw new Error('Failed to load paths');

          paths = await response.json();
          renderPaths();
        } catch (error) {
          console.error('Failed to load paths:', error);
        }
      }

      // Render paths list
      function renderPaths() {
        if (paths.length === 0) {
          pathsListEl.innerHTML = \`
            <div class="empty-state">
              <div class="empty-state-icon">📭</div>
              <div>No paths recorded yet</div>
            </div>
          \`;
          return;
        }

        pathsListEl.innerHTML = paths.map(path => \`
          <div class="path-item">
            <div class="path-info">
              <div class="path-name">\${path.name}</div>
              <div class="path-meta">
                \${path.pointCount} points • \${path.totalDistance.toFixed(1)}m total distance
                • Created \${new Date(path.createdAt).toLocaleString()}
              </div>
            </div>
            <div class="path-actions">
              <button class="button button-primary button-small" onclick="drivePath('\${path.name}')">
                <span>▶️</span> Drive
              </button>
              <button class="button button-danger button-small" onclick="deletePath('\${path.name}')">
                <span>🗑️</span> Delete
              </button>
            </div>
          </div>
        \`).join('');
      }

      // Drive path
      window.drivePath = async function(pathName) {
        if (!confirm(\`Start autonomous driving of path "\${pathName}"?\\n\\nPress STOP button to abort at any time.\`)) {
          return;
        }

        try {
          const response = await fetch(\`\${API_BASE}/api/path/drive\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pathName })
          });

          if (!response.ok) throw new Error('Failed to start path following');

          alert(\`Path following started: \${pathName}\\n\\nMonitor progress on the dashboard.\`);
        } catch (error) {
          alert('Failed to drive path: ' + error.message);
        }
      };

      // Delete path
      window.deletePath = async function(pathName) {
        if (!confirm(\`Delete path "\${pathName}"?\\n\\nThis cannot be undone.\`)) {
          return;
        }

        try {
          const response = await fetch(\`\${API_BASE}/api/path/delete\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pathName })
          });

          if (!response.ok) throw new Error('Failed to delete path');

          await loadPaths();
        } catch (error) {
          alert('Failed to delete path: ' + error.message);
        }
      };

      // Initialize
      updateUI();
      loadPaths();

      // Set default path name
      pathNameInput.value = getNextPathName();
    </script>
  </body>
</html>`;
}
