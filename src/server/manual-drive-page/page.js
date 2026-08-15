    const $ = (id) => document.getElementById(id);
    const { fetchJson, postJson, stopAll } = window.operatorPage;

    function format(value, decimals = 2) {
      return Number(value).toFixed(decimals);
    }

    function jsString(value) {
      return JSON.stringify(String(value));
    }

    function htmlAttribute(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function normalizeAxisHeading(headingDeg) {
      const normalized = ((Number(headingDeg) % 180) + 180) % 180;
      return Number.isFinite(normalized) ? normalized : 0;
    }

    function describeHeading(headingDeg) {
      const normalized = normalizeAxisHeading(headingDeg);
      if (normalized >= 112.5 && normalized < 157.5) {
        return 'NW-SE';
      }
      if (normalized >= 67.5 && normalized < 112.5) {
        return 'N-S';
      }
      if (normalized >= 22.5 && normalized < 67.5) {
        return 'NE-SW';
      }
      return 'E-W';
    }

    const MOWING_HEADING_STORAGE_KEY = 'manualDrivePage.mowingHeadingDeg';
    const STRIP_SPACING_STORAGE_KEY = 'manualDrivePage.stripSpacingCm';
    const MOWING_PRESET_STORAGE_KEY = 'manualDrivePage.mowingPresetId';
    const MOWING_PROGRESS_STORAGE_KEY = 'manualDrivePage.mowingProgress';
    const MOWING_PLAN_PREVIEW_STORAGE_KEY = 'manualDrivePage.mowingPlanPreview.v1';
    const DEFAULT_STRIP_SPACING_CM = 30;
    function loadStoredMowingHeading() {
      try {
        return window.localStorage.getItem(MOWING_HEADING_STORAGE_KEY);
      } catch (_error) {
        return null;
      }
    }

    function storeMowingHeading(headingDeg) {
      try {
        window.localStorage.setItem(MOWING_HEADING_STORAGE_KEY, String(Math.round(normalizeAxisHeading(headingDeg))));
      } catch (_error) {
        // Ignore storage failures; the page still works without persistence.
      }
    }

    function loadStoredStripSpacingCm() {
      try {
        const value = Number(window.localStorage.getItem(STRIP_SPACING_STORAGE_KEY));
        return Number.isFinite(value) && value >= 10 && value <= 40 ? value : null;
      } catch (_error) {
        return null;
      }
    }

    function storeStripSpacingCm(value) {
      const spacingCm = Number(value);
      if (!Number.isFinite(spacingCm) || spacingCm < 10 || spacingCm > 40) {
        return;
      }
      try {
        window.localStorage.setItem(STRIP_SPACING_STORAGE_KEY, String(spacingCm));
      } catch (_error) {
        // Ignore storage failures; the page still works without persistence.
      }
    }

    function loadStoredMowingPresetId() {
      try {
        return window.localStorage.getItem(MOWING_PRESET_STORAGE_KEY) || '';
      } catch (_error) {
        return '';
      }
    }

    function storeMowingPresetId(presetId) {
      try {
        if (presetId) {
          window.localStorage.setItem(MOWING_PRESET_STORAGE_KEY, presetId);
        } else {
          window.localStorage.removeItem(MOWING_PRESET_STORAGE_KEY);
        }
      } catch (_error) {
        // Ignore storage failures; the page still works without persistence.
      }
    }

    function isStoredMowingPlanPreview(value) {
      return typeof value === 'object'
        && value !== null
        && typeof value.areaName === 'string'
        && value.areaName.length > 0
        && Number.isFinite(value.headingDeg)
        && Number.isFinite(value.stripSpacingMeters)
        && Array.isArray(value.strips)
        && Array.isArray(value.connectors)
        && Array.isArray(value.rawAreaPoints);
    }

    function loadStoredMowingPlanPreview() {
      try {
        const value = JSON.parse(window.localStorage.getItem(MOWING_PLAN_PREVIEW_STORAGE_KEY) || 'null');
        if (isStoredMowingPlanPreview(value)) {
          return value;
        }
        window.localStorage.removeItem(MOWING_PLAN_PREVIEW_STORAGE_KEY);
      } catch (_error) {
        // Ignore invalid or unavailable storage and wait for a fresh preview.
      }
      return null;
    }

    function storeMowingPlanPreview(preview) {
      if (!isStoredMowingPlanPreview(preview)) {
        return;
      }
      try {
        window.localStorage.setItem(MOWING_PLAN_PREVIEW_STORAGE_KEY, JSON.stringify(preview));
      } catch (_error) {
        // The live preview remains usable if browser storage is unavailable or full.
      }
    }

    function clearStoredMowingPlanPreview() {
      try {
        window.localStorage.removeItem(MOWING_PLAN_PREVIEW_STORAGE_KEY);
      } catch (_error) {
        // Ignore storage failures.
      }
    }

    function updateHeadingLabel() {
      const heading = normalizeAxisHeading(mowingHeadingInput.value);
      mowingHeadingValue.textContent = `${Math.round(heading)}° ${describeHeading(heading)}`;
    }

    function setMowingHeading(headingDeg) {
      const heading = Math.round(normalizeAxisHeading(headingDeg));
      mowingHeadingInput.value = String(heading);
      storeMowingHeading(heading);
      updateHeadingLabel();
      markMowingPlanPreviewStale();
    }

    function getStoredAreaPerimeterByName(areaName) {
      return storedAreaPerimeters.find((path) => path.name === areaName) ?? null;
    }

    function applyAreaMowingDefaults(areaName) {
      const area = getStoredAreaPerimeterByName(areaName);
      const defaults = area?.mowingDefaults;
      if (!defaults) {
        return false;
      }

      if (Number.isFinite(defaults.headingDeg)) {
        mowingHeadingInput.value = String(Math.round(normalizeAxisHeading(defaults.headingDeg)));
        storeMowingHeading(mowingHeadingInput.value);
        updateHeadingLabel();
      }
      if (Number.isFinite(defaults.stripSpacingMeters) && defaults.stripSpacingMeters > 0) {
        const storedSpacingCm = loadStoredStripSpacingCm();
        stripSpacingInput.value = String(
          storedSpacingCm ?? Math.round(defaults.stripSpacingMeters * 100),
        );
      }
      return true;
    }

    // Position history tracking
    const positionHistory = [];
    const MAP_MIN_VIEW_RANGE_METERS = 5;
    const MAP_STATIONARY_POINT_SPACING_METERS = 0.03;
    const MAP_HISTORY_DISCONTINUITY_DISTANCE_METERS = 2.0;
    const MOWING_PROGRESS_STORE_INTERVAL_MS = 2000;
    let lastMowingProgressStoreAt = 0;
    const canvas = $("mapCanvas");
    const ctx = canvas.getContext("2d");

    // Path recording / management state
    let recording = false;
    let currentPathName = '';
    let pointCount = 0;
    let storedPaths = [];
    let areaRecording = false;
    let currentAreaPerimeterName = '';
    let areaPointCount = 0;
    let storedAreaPerimeters = [];
    let mowingPresets = [];
    let mowingPlanPreview = loadStoredMowingPlanPreview();
    let selectedMowingPlanArea = mowingPlanPreview?.areaName ?? '';
    let mowingPlanPreviewError = '';
    let mowingPlanEditing = false;
    let committedMowingPlanFields = null;
    let mowingPlanEditSnapshot = null;
    let mapTransform = null;
    let headingDragStart = null;
    let pageStatePollTimer = null;
    let pageStatePollInFlight = false;
    let pageStatePollFailureCount = 0;
    let listRefreshTimer = null;
    let listRefreshInFlight = false;
    let lastListRefreshAt = 0;
    let listsLoadedOnce = false;
    let pathRecordingStatusInFlight = false;
    let areaRecordingStatusInFlight = false;
    let mowingStatusInFlight = false;
    let mowingActionInFlight = false;
    let perimeterEdit = null;

    const PRIMITIVES_POLL_MS = 1000;
    const LIST_REFRESH_MS = 30000;
    const FAILURE_BACKOFF_MS = 5000;

    function loadStoredMowingProgress() {
      try {
        const stored = JSON.parse(window.localStorage.getItem(MOWING_PROGRESS_STORAGE_KEY) || '[]');
        if (!Array.isArray(stored)) {
          return;
        }
        for (const point of stored) {
          if (
            Number.isFinite(point?.x)
            && Number.isFinite(point?.y)
            && Number.isFinite(point?.heading)
            && Number.isFinite(point?.timestamp)
          ) {
            positionHistory.push({
              x: point.x,
              y: point.y,
              heading: point.heading,
              timestamp: point.timestamp,
              breakBefore: point.breakBefore === true,
            });
          }
        }
      } catch (_error) {
        // Ignore invalid or unavailable storage and begin with an empty trail.
      }
    }

    async function loadMowerMowingProgress() {
      try {
        const data = await fetchJson('/api/mowing/progress');
        if (!Array.isArray(data.points)) {
          return;
        }
        const mowerPoints = data.points.filter((point) => (
          Number.isFinite(point?.x)
          && Number.isFinite(point?.y)
          && Number.isFinite(point?.heading)
          && Number.isFinite(point?.timestamp)
        ));
        positionHistory.length = 0;
        for (let index = 0; index < mowerPoints.length; index++) {
          const point = mowerPoints[index];
          const previous = mowerPoints[index - 1];
          positionHistory.push({
            x: point.x,
            y: point.y,
            heading: point.heading,
            timestamp: point.timestamp,
            breakBefore: Boolean(previous) && Math.hypot(point.x - previous.x, point.y - previous.y) > MAP_HISTORY_DISCONTINUITY_DISTANCE_METERS,
          });
        }
        storeMowingProgress(true);
        drawMap();
      } catch (error) {
        console.error('Failed to load mower mowing progress:', error);
      }
    }

    async function loadFrozenMowingPlanPreview() {
      try {
        const data = await fetchJson('/api/mowing/plan');
        if (!isStoredMowingPlanPreview(data?.preview)) {
          return;
        }
        mowingPlanPreview = data.preview;
        selectedMowingPlanArea = data.preview.areaName;
        storeMowingPlanPreview(data.preview);
      } catch (error) {
        console.error('Failed to load frozen mowing plan:', error);
      }
    }

    function storeMowingProgress(force = false) {
      const now = Date.now();
      if (!force && now - lastMowingProgressStoreAt < MOWING_PROGRESS_STORE_INTERVAL_MS) {
        return;
      }
      try {
        window.localStorage.setItem(MOWING_PROGRESS_STORAGE_KEY, JSON.stringify(positionHistory));
        lastMowingProgressStoreAt = now;
      } catch (_error) {
        // Keep drawing live progress if browser storage is unavailable or full.
      }
    }

    function clearMowingProgress() {
      positionHistory.length = 0;
      storeMowingProgress(true);
      drawMap();
    }

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
    const areaPerimeterNameInput = $("areaPerimeterName");
    const startAreaRecordingBtn = $("startAreaRecordingBtn");
    const stopAreaRecordingBtn = $("stopAreaRecordingBtn");
    const cancelAreaRecordingBtn = $("cancelAreaRecordingBtn");
    const areaRecordingIndicator = $("areaRecordingIndicator");
    const areaRecordingStatusEl = $("areaRecordingStatus");
    const areaPointCountEl = $("areaPointCount");
    const currentAreaPerimeterNameEl = $("currentAreaPerimeterName");
    const areaPerimetersListEl = $("areaPerimetersList");
    const mowingPlanAreaSelect = $("mowingPlanArea");
    const mowingPresetSelect = $("mowingPreset");
    const mowingPlanStatusEl = $("mowingPlanStatus");
    const mowingHeadingInput = $("mowingHeadingDeg");
    const mowingHeadingValue = $("mowingHeadingValue");
    const stripSpacingInput = $("stripSpacingCm");
    const previewMowingPlanBtn = $("previewMowingPlanBtn");
    const cancelMowingPlanEditBtn = $("cancelMowingPlanEditBtn");
    const resumeMowingBtn = $("resumeMowingBtn");
    const perimeterEditorBackdrop = $("perimeterEditorBackdrop");
    const perimeterEditorCanvas = $("perimeterEditorCanvas");
    const perimeterEditorContext = perimeterEditorCanvas.getContext("2d");
    const perimeterEditorHelp = $("perimeterEditorHelp");
    const perimeterEditorStatus = $("perimeterEditorStatus");
    const savePerimeterEditBtn = $("savePerimeterEdit");
    const undoPerimeterEditBtn = $("undoPerimeterEdit");

    function addPositionToHistory(x, y, heading, timestamp) {
      const previous = positionHistory[positionHistory.length - 1];
      if (previous) {
        const movementMeters = Math.hypot(x - previous.x, y - previous.y);
        if (movementMeters < MAP_STATIONARY_POINT_SPACING_METERS) {
          positionHistory[positionHistory.length - 1] = {
            x,
            y,
            heading,
            timestamp,
            breakBefore: previous.breakBefore === true,
          };
          storeMowingProgress();
          return;
        }
        positionHistory.push({
          x,
          y,
          heading,
          timestamp,
          breakBefore: movementMeters > MAP_HISTORY_DISCONTINUITY_DISTANCE_METERS,
        });
        storeMowingProgress();
        return;
      }

      positionHistory.push({ x, y, heading, timestamp });
      storeMowingProgress();
    }

    function drawMap() {
      if (positionHistory.length === 0 && storedPaths.length === 0 && storedAreaPerimeters.length === 0) {
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

      for (const path of storedAreaPerimeters) {
        for (const point of path.points) {
          minX = Math.min(minX, point.xMeters);
          maxX = Math.max(maxX, point.xMeters);
          minY = Math.min(minY, point.yMeters);
          maxY = Math.max(maxY, point.yMeters);
        }
      }

      // Keep stationary GNSS jitter from zooming the map into centimetres.
      const rawRangeX = maxX - minX;
      const rawRangeY = maxY - minY;
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const viewRangeX = Math.max(rawRangeX, MAP_MIN_VIEW_RANGE_METERS);
      const viewRangeY = Math.max(rawRangeY, MAP_MIN_VIEW_RANGE_METERS);
      minX = centerX - (viewRangeX / 2);
      maxX = centerX + (viewRangeX / 2);
      minY = centerY - (viewRangeY / 2);
      maxY = centerY + (viewRangeY / 2);

      // Add padding to bounds
      const rangeX = maxX - minX;
      const rangeY = maxY - minY;
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
      mapTransform = {
        minX,
        minY,
        scale,
        padding,
        width,
        height,
        toCanvasX,
        toCanvasY,
        toWorldX: (x) => minX + ((x - padding) / scale),
        toWorldY: (y) => minY + ((height - padding - y) / scale),
      };

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

      const selectedAreaName = mowingPlanPreview?.areaName || selectedMowingPlanArea;
      const perimeterColors = {
        selected: 'rgba(37, 99, 235, 0.92)',
        background: 'rgba(148, 163, 184, 0.22)',
        backgroundText: 'rgba(100, 116, 139, 0.5)',
      };

      storedAreaPerimeters.forEach((path) => {
        const isSelected = path.name === selectedAreaName;
        const previewOwnsSelectedOutline = isSelected && mowingPlanPreview && Array.isArray(mowingPlanPreview.rawAreaPoints);
        if (previewOwnsSelectedOutline) {
          return;
        }
        const color = isSelected ? perimeterColors.selected : perimeterColors.background;
        ctx.strokeStyle = color;
        ctx.lineWidth = isSelected ? 5 : 3;

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
        if (path.points.length > 2) {
          ctx.closePath();
        }
        ctx.stroke();

        if (path.points.length > 0) {
          const startPoint = path.points[0];
          const sx = toCanvasX(startPoint.xMeters);
          const sy = toCanvasY(startPoint.yMeters);

          ctx.fillStyle = isSelected ? color : perimeterColors.backgroundText;
          ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.45)';
          ctx.lineWidth = isSelected ? 3 : 2;
          ctx.font = isSelected ? 'bold 14px sans-serif' : '12px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.strokeText(path.name, sx, sy + 10);
          ctx.fillText(path.name, sx, sy + 10);
        }
      });

      drawMowingPlanPreview(toCanvasX, toCanvasY);

      if (positionHistory.length > 0) {
        // Draw the complete mowing-progress trail until a fresh mowing run clears it.
        ctx.lineWidth = 3;

        for (let i = 1; i < positionHistory.length; i++) {
          const prev = positionHistory[i - 1];
          const curr = positionHistory[i];
          if (curr.breakBefore) {
            continue;
          }

          ctx.strokeStyle = 'rgba(37, 99, 235, 0.6)';
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
        const distance = Math.max(rawRangeX, rawRangeY);
        const stripText = mowingPlanPreview ? buildPreviewStatsSuffix() : '';
        $("mapStats").textContent = `${positionHistory.length} points | movement: ${format(distance, 2)}m | view: ${format(Math.max(rangeX, rangeY), 2)}m | scale: ${format(1/scale, 3)}m/px | current: (${format(current.x, 2)}, ${format(current.y, 2)})${stripText}`;
      } else {
        const storedCount = storedPaths.length + storedAreaPerimeters.length;
        const stripText = mowingPlanPreview ? buildPreviewStatsSuffix() : '';
        $("mapStats").textContent = `${storedCount} stored perimeter${storedCount === 1 ? '' : 's'} | scale: ${format(1/scale, 3)}m/px${stripText}`;
      }
    }

    function drawMowingPlanPreview(toCanvasX, toCanvasY) {
      if (!mowingPlanPreview || !Array.isArray(mowingPlanPreview.strips)) {
        return;
      }

      ctx.save();
      drawPreviewAreaGeometry(toCanvasX, toCanvasY);
      const regionColours = [
        'rgba(59, 130, 246, 0.16)', 'rgba(16, 185, 129, 0.16)',
        'rgba(245, 158, 11, 0.16)', 'rgba(168, 85, 247, 0.16)',
        'rgba(236, 72, 153, 0.16)', 'rgba(6, 182, 212, 0.16)'
      ];
      const regionsById = new Map((mowingPlanPreview.regions ?? []).map((region) => [region.id, region]));
      mowingPlanPreview.strips.forEach((strip) => {
        const region = regionsById.get(strip.regionId);
        if (!region) return;
        ctx.strokeStyle = regionColours[region.orderIndex % regionColours.length];
        ctx.lineWidth = Math.max(8, mowingPlanPreview.stripSpacingMeters * 0.8 / Math.max(0.001, 1 / Math.abs(toCanvasX(1) - toCanvasX(0))));
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(toCanvasX(strip.start.xMeters), toCanvasY(strip.start.yMeters));
        ctx.lineTo(toCanvasX(strip.end.xMeters), toCanvasY(strip.end.yMeters));
        ctx.stroke();
      });
      (mowingPlanPreview.regions ?? []).forEach((region) => {
        if (!region.entryPoint) return;
        const x = toCanvasX(region.entryPoint.xMeters);
        const y = toCanvasY(region.entryPoint.yMeters);
        ctx.fillStyle = 'rgba(17, 24, 39, 0.88)';
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(region.orderIndex + 1), x, y);
      });
      ctx.strokeStyle = 'rgba(17, 24, 39, 0.32)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 6]);

      mowingPlanPreview.strips.forEach((strip) => {
        const traversalStart = strip.traversalReversed ? strip.end : strip.start;
        const traversalEnd = strip.traversalReversed ? strip.start : strip.end;
        const startX = toCanvasX(traversalStart.xMeters);
        const startY = toCanvasY(traversalStart.yMeters);
        const endX = toCanvasX(traversalEnd.xMeters);
        const endY = toCanvasY(traversalEnd.yMeters);
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      });

      ctx.strokeStyle = 'rgba(220, 38, 38, 0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 5]);
      (mowingPlanPreview.connectors ?? []).forEach((connector) => {
        if (!Array.isArray(connector) || connector.length < 2) {
          return;
        }

        ctx.beginPath();
        connector.forEach((point, pointIndex) => {
          const x = toCanvasX(point.xMeters);
          const y = toCanvasY(point.yMeters);
          if (pointIndex === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();
      });

      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(17, 24, 39, 0.9)';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(
        `${mowingPlanPreview.stripCount} strips in ${(mowingPlanPreview.regions ?? []).length || 1} regions @ ${Math.round(mowingPlanPreview.stripSpacingMeters * 100)}cm`,
        72,
        72,
      );
      if (mowingPlanPreview.areaGeometryStats) {
        ctx.fillText(
          `area pts raw/smooth/reduced: ${mowingPlanPreview.areaGeometryStats.rawPointCount}/${mowingPlanPreview.areaGeometryStats.smoothedPointCount}/${mowingPlanPreview.areaGeometryStats.reducedPointCount}`,
          72,
          92,
        );
        ctx.fillText(
          'boundary overlay: raw blue | smoothed green | reduced orange',
          72,
          112,
        );
      }
      if (mowingPlanPreview.planPerformance) {
        ctx.fillText(
          `plan ms prep/strip/seq/conn: ${mowingPlanPreview.planPerformance.prepareMs}/${mowingPlanPreview.planPerformance.stripBuildMs}/${mowingPlanPreview.planPerformance.sequenceMs}/${mowingPlanPreview.planPerformance.connectorBuildMs}`,
          72,
          132,
        );
      }
      ctx.restore();
    }

    function drawPreviewAreaGeometry(toCanvasX, toCanvasY) {
      drawPreviewPolyline(mowingPlanPreview.rawAreaPoints, toCanvasX, toCanvasY, {
        strokeStyle: 'rgba(30, 64, 175, 0.95)',
        lineWidth: 2,
        lineDash: [],
      });
      drawPreviewPolyline(mowingPlanPreview.smoothedAreaPoints, toCanvasX, toCanvasY, {
        strokeStyle: 'rgba(5, 150, 105, 0.95)',
        lineWidth: 2,
        lineDash: [],
      });
      drawPreviewPolyline(mowingPlanPreview.reducedAreaPoints, toCanvasX, toCanvasY, {
        strokeStyle: 'rgba(221, 107, 32, 0.88)',
        lineWidth: 3,
        lineDash: [5, 4],
      });
    }

    function drawPreviewPolyline(points, toCanvasX, toCanvasY, style) {
      if (!Array.isArray(points) || points.length < 2) {
        return;
      }
      ctx.save();
      ctx.strokeStyle = style.strokeStyle;
      ctx.lineWidth = style.lineWidth;
      ctx.setLineDash(style.lineDash);
      ctx.beginPath();
      points.forEach((point, pointIndex) => {
        const x = toCanvasX(point.xMeters);
        const y = toCanvasY(point.yMeters);
        if (pointIndex === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      if (points.length > 2) {
        ctx.closePath();
      }
      ctx.stroke();
      ctx.restore();
    }

    function buildPreviewStatsSuffix() {
      const parts = [`strips: ${mowingPlanPreview.stripCount}`];
      if (mowingPlanPreview.areaGeometryStats) {
        parts.push(`area pts ${mowingPlanPreview.areaGeometryStats.rawPointCount}/${mowingPlanPreview.areaGeometryStats.smoothedPointCount}/${mowingPlanPreview.areaGeometryStats.reducedPointCount}`);
      }
      if (mowingPlanPreview.areaGeometryTiming) {
        parts.push(`smooth ${mowingPlanPreview.areaGeometryTiming.smoothingMs}ms`);
        parts.push(`reduce ${mowingPlanPreview.areaGeometryTiming.reductionMs}ms`);
        parts.push(`area ${mowingPlanPreview.areaGeometryTiming.totalMs}ms`);
      }
      if (mowingPlanPreview.planPerformance) {
        parts.push(`prep ${mowingPlanPreview.planPerformance.prepareMs}ms`);
        parts.push(`strip ${mowingPlanPreview.planPerformance.stripBuildMs}ms`);
        parts.push(`seq ${mowingPlanPreview.planPerformance.sequenceMs}ms`);
        parts.push(`conn ${mowingPlanPreview.planPerformance.connectorBuildMs}ms`);
      }
      return ` | ${parts.join(' | ')}`;
    }

    function hasDrawablePathPoints(path) {
      return Array.isArray(path?.points)
        && path.points.length > 0
        && path.points.every((point) =>
          Number.isFinite(point?.xMeters) && Number.isFinite(point?.yMeters)
        );
    }

    // Track which path names have already produced a "skipped" warning so the
    // 10s poll doesn't spam DevTools every cycle with the same diagnostic.
    const skippedPathWarnings = new Set();
    function warnSkippedPath(name, message, detail) {
      if (skippedPathWarnings.has(name)) {
        return;
      }
      skippedPathWarnings.add(name);
      console.warn(message, detail);
    }

    function sanitizeStoredPathCollection(paths, warningLabel) {
      return (Array.isArray(paths) ? paths : []).filter((pathInfo, index) => {
        const pathName = pathInfo?.name;
        if (typeof pathName !== 'string' || pathName.length === 0) {
          warnSkippedPath(`__missing_name__:${warningLabel}:${index}`, `Skipping ${warningLabel} with missing name:`, pathInfo);
          return false;
        }
        if (!hasDrawablePathPoints(pathInfo)) {
          warnSkippedPath(pathName, `Skipping ${warningLabel} with invalid points:`, pathInfo);
          return false;
        }
        return true;
      });
    }

    async function loadStoredPaths() {
      try {
        const data = await fetchJson('/api/paths?includePoints=1');
        storedPaths = sanitizeStoredPathCollection(data?.paths, 'stored path');
        renderPaths();
        drawMap();
      } catch (error) {
        console.error('Failed to load stored paths:', error);
      }
    }

    async function loadStoredAreaPerimeters() {
      try {
        const data = await fetchJson('/api/area-perimeters?includePoints=1');
        storedAreaPerimeters = sanitizeStoredPathCollection(data?.paths, 'stored area perimeter');
        renderAreaPerimeters();
        renderMowingPlanAreaOptions();
        drawMap();
      } catch (error) {
        console.error('Failed to load stored area perimeters:', error);
      }
    }

    async function loadMowingPresets() {
      try {
        const data = await fetchJson('/api/mowing-records');
        mowingPresets = Array.isArray(data.presets) ? data.presets : [];
        mowingPresetSelect.innerHTML = '<option value="">Custom settings</option>' + mowingPresets.map((preset) =>
          `<option value="${htmlAttribute(preset.id)}">${htmlAttribute(preset.name)} — ${htmlAttribute(preset.areaName)}</option>`
        ).join('');
        const storedPresetId = loadStoredMowingPresetId();
        if (mowingPresets.some((preset) => preset.id === storedPresetId)) {
          mowingPresetSelect.value = storedPresetId;
        } else if (storedPresetId) {
          storeMowingPresetId('');
        }
      } catch (error) {
        console.error('Failed to load mowing presets:', error);
      }
    }

    function applyMowingPreset(preset) {
      if (!preset) {
        return false;
      }
      mowingPresetSelect.value = preset.id;
      mowingPlanAreaSelect.value = preset.areaName;
      selectedMowingPlanArea = preset.areaName;
      mowingHeadingInput.value = String(Math.round(normalizeAxisHeading(preset.headingDeg)));
      stripSpacingInput.value = String(Math.round(Number(preset.stripWidthMeters) * 100));
      storeMowingHeading(mowingHeadingInput.value);
      storeStripSpacingCm(stripSpacingInput.value);
      updateHeadingLabel();
      return true;
    }

    function restoreStoredMowingPreset() {
      const storedPresetId = loadStoredMowingPresetId();
      if (!storedPresetId) {
        return;
      }
      const preset = mowingPresets.find((entry) => entry.id === storedPresetId);
      if (!applyMowingPreset(preset)) {
        storeMowingPresetId('');
      }
    }

    function renderMowingPlanAreaOptions() {
      if (mowingPlanEditing) {
        return;
      }
      const previousSelection = selectedMowingPlanArea || mowingPlanAreaSelect.value;
      mowingPlanAreaSelect.innerHTML = storedAreaPerimeters.map((path) => {
        const selected = path.name === previousSelection ? ' selected' : '';
        return `<option value="${htmlAttribute(path.name)}"${selected}>${htmlAttribute(path.name)}</option>`;
      }).join('');

      if (storedAreaPerimeters.length === 0) {
        mowingPlanAreaSelect.innerHTML = '<option value="">No mowing areas</option>';
        mowingPlanPreview = null;
        selectedMowingPlanArea = '';
        mowingPlanStatusEl.textContent = 'No mowing areas available.';
        return;
      }

      selectedMowingPlanArea = mowingPlanAreaSelect.value || storedAreaPerimeters[0].name;
      mowingPlanAreaSelect.value = selectedMowingPlanArea;
      if (mowingPlanPreview?.areaName === selectedMowingPlanArea) {
        restoreStoredMowingPlanPreview();
        return;
      }
      applyAreaMowingDefaults(selectedMowingPlanArea);
      if (mowingPlanPreviewError) {
        mowingPlanStatusEl.textContent = mowingPlanPreviewError;
      } else {
        mowingPlanStatusEl.textContent = `Selected area: ${selectedMowingPlanArea}. Click Preview to inspect the plan.`;
      }
    }

    function markMowingPlanPreviewStale() {
      mowingPlanPreview = null;
      mowingPlanPreviewError = '';
      const areaName = mowingPlanAreaSelect.value;
      if (!areaName) {
        mowingPlanStatusEl.textContent = 'Choose a mowing area and a valid strip spacing to preview strips.';
        drawMap();
        return;
      }
      mowingPlanStatusEl.textContent = `Selected area: ${areaName}. Click Preview to inspect the plan.`;
      drawMap();
    }

    function readMowingPlanFields() {
      return {
        areaName: mowingPlanAreaSelect.value,
        presetId: mowingPresetSelect.value,
        headingDeg: mowingHeadingInput.value,
        stripSpacingCm: stripSpacingInput.value,
        preview: mowingPlanPreview,
      };
    }

    function commitMowingPlanFields() {
      mowingPlanEditing = false;
      mowingPlanEditSnapshot = null;
      committedMowingPlanFields = readMowingPlanFields();
      cancelMowingPlanEditBtn.hidden = true;
    }

    function beginMowingPlanEdit() {
      if (mowingPlanEditing) {
        return;
      }
      mowingPlanEditSnapshot = committedMowingPlanFields ?? readMowingPlanFields();
      mowingPlanEditing = true;
      cancelMowingPlanEditBtn.hidden = false;
    }

    async function cancelMowingPlanEdit() {
      const snapshot = mowingPlanEditSnapshot ?? committedMowingPlanFields;
      mowingPlanEditing = false;
      cancelMowingPlanEditBtn.hidden = true;
      await Promise.all([
        loadStoredAreaPerimeters(),
        loadMowingPresets(),
      ]);
      if (snapshot) {
        selectedMowingPlanArea = snapshot.areaName;
        mowingPlanAreaSelect.value = snapshot.areaName;
        mowingPresetSelect.value = snapshot.presetId;
        mowingHeadingInput.value = snapshot.headingDeg;
        stripSpacingInput.value = snapshot.stripSpacingCm;
        mowingPlanPreview = snapshot.preview;
        storeMowingPresetId(snapshot.presetId);
        storeMowingHeading(snapshot.headingDeg);
        storeStripSpacingCm(snapshot.stripSpacingCm);
        updateHeadingLabel();
      }
      if (!restoreStoredMowingPlanPreview()) {
        mowingPlanPreview = snapshot?.preview ?? null;
        if (mowingPlanPreview) {
          drawMap();
        } else {
          markMowingPlanPreviewStale();
        }
      }
      commitMowingPlanFields();
    }

    function restoreStoredMowingPlanPreview() {
      const preview = mowingPlanPreview ?? loadStoredMowingPlanPreview();
      if (!preview) {
        return false;
      }
      if (!storedAreaPerimeters.some((area) => area.name === preview.areaName)) {
        mowingPlanPreview = null;
        clearStoredMowingPlanPreview();
        return false;
      }

      mowingPlanPreview = preview;
      mowingPlanPreviewError = '';
      selectedMowingPlanArea = preview.areaName;
      mowingPlanAreaSelect.value = preview.areaName;
      mowingHeadingInput.value = String(Math.round(normalizeAxisHeading(preview.headingDeg)));
      stripSpacingInput.value = String(Math.round(preview.stripSpacingMeters * 100));
      storeMowingHeading(mowingHeadingInput.value);
      storeStripSpacingCm(stripSpacingInput.value);
      updateHeadingLabel();
      mowingPlanStatusEl.textContent = `${preview.stripCount ?? preview.strips.length} strips restored for ${preview.areaName}. This is the last generated plan; it has not been recalculated from the mower's current position.`;
      drawMap();
      return true;
    }

    async function requestMowingPlanPreview() {
      const areaName = mowingPlanAreaSelect.value;
      const headingDeg = normalizeAxisHeading(mowingHeadingInput.value);
      const stripSpacingMeters = Number(stripSpacingInput.value) / 100;

      if (!areaName || !Number.isFinite(stripSpacingMeters) || stripSpacingMeters <= 0) {
        mowingPlanPreview = null;
        mowingPlanStatusEl.textContent = 'Choose a mowing area and a valid strip spacing to preview strips.';
        drawMap();
        return;
      }

      selectedMowingPlanArea = areaName;
      mowingPlanStatusEl.textContent = `Generating preview for ${areaName}...`;
      const previewAbortController = new AbortController();
      const previewTimeout = setTimeout(() => previewAbortController.abort(), 30000);
      try {
        const result = await postJson('/api/mowing-plan/preview', {
          areaName,
          headingDeg,
          stripSpacingMeters,
        }, {
          signal: previewAbortController.signal,
        });

        mowingPlanPreview = result;
        storeMowingPlanPreview(result);
        mowingPlanPreviewError = '';
        const stats = result.areaGeometryStats;
        const timing = result.areaGeometryTiming;
        const planPerformance = result.planPerformance;
        const areaDetail = stats
          ? ` raw/smoothed/reduced ${stats.rawPointCount}/${stats.smoothedPointCount}/${stats.reducedPointCount}`
          : '';
        const timingDetail = timing
          ? ` | smooth ${timing.smoothingMs}ms | reduce ${timing.reductionMs}ms`
          : '';
        const planDetail = planPerformance
          ? ` | prep ${planPerformance.prepareMs}ms | strips ${planPerformance.stripBuildMs}ms | sequence ${planPerformance.sequenceMs}ms | connectors ${planPerformance.connectorBuildMs}ms`
          : '';
        mowingPlanStatusEl.textContent = `${result.stripCount} strips ready for ${areaName}.${areaDetail}${timingDetail}${planDetail}`;
        commitMowingPlanFields();
        drawMap();
      } catch (error) {
        mowingPlanPreview = null;
        const message = error?.name === 'AbortError'
          ? 'planning exceeded 30 seconds'
          : error.message;
        mowingPlanPreviewError = `Preview failed for ${areaName}: ${message}`;
        mowingPlanStatusEl.textContent = mowingPlanPreviewError;
        drawMap();
        console.error('Failed to preview mowing plan:', error);
      } finally {
        clearTimeout(previewTimeout);
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

      return `Obstacle ${maxNum + 1}`;
    }

    function getNextAreaPerimeterName() {
      const areaPattern = /^Mowing Area (\d+)$/;
      let maxNum = 0;

      storedAreaPerimeters.forEach((path) => {
        const match = path.name?.match(areaPattern);
        if (match) {
          maxNum = Math.max(maxNum, parseInt(match[1], 10));
        }
      });

      return `Mowing Area ${maxNum + 1}`;
    }

    function updateRecordingUi() {
      startRecordingBtn.disabled = recording;
      stopRecordingBtn.disabled = !recording;
      cancelRecordingBtn.disabled = !recording;
      pathNameInput.disabled = recording;
      startAreaRecordingBtn.disabled = recording || areaRecording;

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

    function updateAreaRecordingUi() {
      startAreaRecordingBtn.disabled = recording || areaRecording;
      stopAreaRecordingBtn.disabled = !areaRecording;
      cancelAreaRecordingBtn.disabled = !areaRecording;
      areaPerimeterNameInput.disabled = areaRecording;
      startRecordingBtn.disabled = recording || areaRecording;

      if (areaRecording) {
        areaRecordingIndicator.classList.add('active');
        areaRecordingStatusEl.textContent = 'Recording';
        areaRecordingStatusEl.style.color = 'var(--danger-color)';
        currentAreaPerimeterNameEl.textContent = currentAreaPerimeterName;
      } else {
        areaRecordingIndicator.classList.remove('active');
        areaRecordingStatusEl.textContent = 'Ready';
        areaRecordingStatusEl.style.color = 'var(--success-color)';
        currentAreaPerimeterNameEl.textContent = '—';
      }

      areaPointCountEl.textContent = String(areaPointCount);
    }

    function renderPaths() {
      if (storedPaths.length === 0) {
        pathsListEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <div>No paths recorded yet</div>
          </div>
        `;
        return;
      }

      pathsListEl.innerHTML = storedPaths.map((path) => {
        const pointTotal = path.points?.length ?? path.pointCount ?? 0;
        const totalDistance = path.metadata?.totalDistance ?? 0;
        const createdAt = path.createdAt ? new Date(path.createdAt).toLocaleString() : 'Unknown';

        return `
          <div class="path-item">
            <div class="path-info">
              <div class="path-name">${path.name}</div>
              <div class="path-meta">
                ${pointTotal} points • ${totalDistance.toFixed(1)}m total distance
                • Created ${createdAt}
              </div>
            </div>
            <div class="path-actions">
              <button class="button button-primary button-small" type="button" onclick="drivePath(${htmlAttribute(jsString(path.name))})">
                <span>▶️</span> Drive
              </button>
              <button class="button button-success button-small" type="button" onclick="verifyPath(${htmlAttribute(jsString(path.name))})">
                <span>✓</span> Verify
              </button>
              <button class="button button-danger button-small" type="button" onclick="deletePath(${htmlAttribute(jsString(path.name))})">
                <span>🗑️</span> Delete
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    function renderAreaPerimeters() {
      if (storedAreaPerimeters.length === 0) {
        areaPerimetersListEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <div>No mowing area perimeters recorded yet</div>
          </div>
        `;
        return;
      }

      areaPerimetersListEl.innerHTML = storedAreaPerimeters.map((path) => {
        const pointTotal = path.points?.length ?? path.pointCount ?? 0;
        const totalDistance = path.metadata?.totalDistance ?? 0;
        const createdAt = path.createdAt ? new Date(path.createdAt).toLocaleString() : 'Unknown';

        return `
          <div class="path-item">
            <div class="path-info">
              <div class="path-name">${path.name}</div>
              <div class="path-meta">
                ${pointTotal} points • ${totalDistance.toFixed(1)}m perimeter
                • Created ${createdAt}
              </div>
            </div>
            <div class="path-actions">
              <button class="button button-secondary button-small" type="button" onclick="editAreaPerimeter(${htmlAttribute(jsString(path.name))})">
                <span>✏️</span> Edit
              </button>
              <button class="button button-primary button-small" type="button" onclick="driveAreaPerimeter(${htmlAttribute(jsString(path.name))})">
                <span>▶️</span> Drive
              </button>
              <button class="button button-success button-small" type="button" onclick="verifyAreaPerimeter(${htmlAttribute(jsString(path.name))})">
                <span>✓</span> Verify
              </button>
              <button class="button button-danger button-small" type="button" onclick="deleteAreaPerimeter(${htmlAttribute(jsString(path.name))})">
                <span>🗑️</span> Delete
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    function copyPerimeterPoints(points) {
      return points.map((point) => ({ xMeters: Number(point.xMeters), yMeters: Number(point.yMeters), capturedAt: Number(point.capturedAt) || Date.now() }));
    }

    function setPerimeterEditorTool(mode) {
      if (!perimeterEdit) return;
      perimeterEdit.mode = mode;
      perimeterEdit.anchors = [];
      perimeterEdit.controlIndex = null;
      perimeterEditorHelp.textContent = mode === 'straighten'
        ? 'Click the two fixed endpoints of the wobbly section. The shorter perimeter section between them will become a straight line.'
        : 'Click two fixed endpoints, then click where the replacement corner should be. Drag the red point to fine-tune it.';
      perimeterEditorStatus.textContent = 'Choose the first fixed anchor.';
      drawPerimeterEditor();
    }

    function perimeterEditorTransform() {
      const points = [...perimeterEdit.original, ...perimeterEdit.points];
      const xs = points.map((point) => point.xMeters);
      const ys = points.map((point) => point.yMeters);
      const padding = 42;
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const scale = Math.min((perimeterEditorCanvas.width - padding * 2) / Math.max(maxX - minX, .5), (perimeterEditorCanvas.height - padding * 2) / Math.max(maxY - minY, .5));
      return {
        toCanvas: (point) => ({ x: perimeterEditorCanvas.width / 2 + (point.xMeters - (minX + maxX) / 2) * scale, y: perimeterEditorCanvas.height / 2 - (point.yMeters - (minY + maxY) / 2) * scale }),
        toWorld: (point) => ({ xMeters: (point.x - perimeterEditorCanvas.width / 2) / scale + (minX + maxX) / 2, yMeters: -(point.y - perimeterEditorCanvas.height / 2) / scale + (minY + maxY) / 2 }),
      };
    }

    function drawPerimeterLine(points, color, width, dashed = false) {
      if (points.length < 2) return;
      const transform = perimeterEditorTransform();
      perimeterEditorContext.beginPath();
      points.forEach((point, index) => {
        const canvasPoint = transform.toCanvas(point);
        index ? perimeterEditorContext.lineTo(canvasPoint.x, canvasPoint.y) : perimeterEditorContext.moveTo(canvasPoint.x, canvasPoint.y);
      });
      const first = transform.toCanvas(points[0]);
      perimeterEditorContext.lineTo(first.x, first.y);
      perimeterEditorContext.setLineDash(dashed ? [9, 7] : []);
      perimeterEditorContext.strokeStyle = color;
      perimeterEditorContext.lineWidth = width;
      perimeterEditorContext.stroke();
      perimeterEditorContext.setLineDash([]);
    }

    function drawPerimeterEditor() {
      if (!perimeterEdit) return;
      perimeterEditorContext.clearRect(0, 0, perimeterEditorCanvas.width, perimeterEditorCanvas.height);
      perimeterEditorContext.fillStyle = '#f8fafc';
      perimeterEditorContext.fillRect(0, 0, perimeterEditorCanvas.width, perimeterEditorCanvas.height);
      drawPerimeterLine(perimeterEdit.original, '#94a3b8', 3, true);
      drawPerimeterLine(perimeterEdit.points, '#059669', 4);
      const transform = perimeterEditorTransform();
      perimeterEdit.anchors.forEach((index) => {
        const point = transform.toCanvas(perimeterEdit.points[index]);
        perimeterEditorContext.beginPath(); perimeterEditorContext.arc(point.x, point.y, 8, 0, Math.PI * 2);
        perimeterEditorContext.fillStyle = '#f59e0b'; perimeterEditorContext.fill();
      });
      if (perimeterEdit.controlIndex !== null) {
        const point = transform.toCanvas(perimeterEdit.points[perimeterEdit.controlIndex]);
        perimeterEditorContext.beginPath(); perimeterEditorContext.arc(point.x, point.y, 10, 0, Math.PI * 2);
        perimeterEditorContext.fillStyle = '#dc2626'; perimeterEditorContext.fill();
      }
    }

    function editorCanvasPoint(event) {
      const bounds = perimeterEditorCanvas.getBoundingClientRect();
      return { x: (event.clientX - bounds.left) * perimeterEditorCanvas.width / bounds.width, y: (event.clientY - bounds.top) * perimeterEditorCanvas.height / bounds.height };
    }

    function nearestPerimeterPointIndex(canvasPoint) {
      const transform = perimeterEditorTransform();
      let nearest = 0, nearestDistance = Infinity;
      perimeterEdit.points.forEach((point, index) => {
        const candidate = transform.toCanvas(point);
        const distance = Math.hypot(candidate.x - canvasPoint.x, candidate.y - canvasPoint.y);
        if (distance < nearestDistance) { nearest = index; nearestDistance = distance; }
      });
      return nearest;
    }

    function replaceShorterPerimeterSection(firstIndex, secondIndex, middlePoint = null) {
      const points = perimeterEdit.points;
      const count = points.length;
      const forwardLength = (secondIndex - firstIndex + count) % count;
      let start = firstIndex, end = secondIndex;
      if (forwardLength > count / 2) { start = secondIndex; end = firstIndex; }
      const rotated = Array.from({ length: count }, (_, offset) => points[(start + offset) % count]);
      const endOffset = (end - start + count) % count;
      const replacement = [rotated[0]];
      if (middlePoint) replacement.push({ ...middlePoint, capturedAt: Math.round((rotated[0].capturedAt + rotated[endOffset].capturedAt) / 2) });
      replacement.push(rotated[endOffset]);
      perimeterEdit.undo.push(copyPerimeterPoints(points));
      perimeterEdit.points = replacement.concat(rotated.slice(endOffset + 1));
      perimeterEdit.anchors = middlePoint ? [0, 2] : [0, 1];
      perimeterEdit.controlIndex = middlePoint ? 1 : null;
      perimeterEdit.dirty = true;
      undoPerimeterEditBtn.disabled = false;
      savePerimeterEditBtn.disabled = false;
      perimeterEditorStatus.textContent = middlePoint ? 'Corner replaced. Drag the red point to adjust it, or save when ready.' : 'Section straightened. Choose Straighten section again to make another correction, or save.';
      drawPerimeterEditor();
    }

    perimeterEditorCanvas.addEventListener('pointerdown', (event) => {
      if (!perimeterEdit) return;
      const canvasPoint = editorCanvasPoint(event);
      if (perimeterEdit.controlIndex !== null) {
        const control = perimeterEditorTransform().toCanvas(perimeterEdit.points[perimeterEdit.controlIndex]);
        if (Math.hypot(control.x - canvasPoint.x, control.y - canvasPoint.y) <= 24) {
          perimeterEdit.dragging = true;
          perimeterEdit.dragTransform = perimeterEditorTransform();
          perimeterEditorCanvas.setPointerCapture(event.pointerId);
          return;
        }
      }
      if (perimeterEdit.anchors.length < 2) {
        const index = nearestPerimeterPointIndex(canvasPoint);
        if (!perimeterEdit.anchors.includes(index)) perimeterEdit.anchors.push(index);
        if (perimeterEdit.anchors.length === 1) perimeterEditorStatus.textContent = 'Choose the second fixed anchor.';
        if (perimeterEdit.anchors.length === 2 && perimeterEdit.mode === 'straighten') replaceShorterPerimeterSection(perimeterEdit.anchors[0], perimeterEdit.anchors[1]);
        else if (perimeterEdit.anchors.length === 2) perimeterEditorStatus.textContent = 'Click the desired position of the replacement corner.';
        drawPerimeterEditor();
        return;
      }
      if (perimeterEdit.mode === 'reshape' && perimeterEdit.controlIndex === null) {
        const worldPoint = perimeterEditorTransform().toWorld(canvasPoint);
        replaceShorterPerimeterSection(perimeterEdit.anchors[0], perimeterEdit.anchors[1], worldPoint);
      }
    });

    perimeterEditorCanvas.addEventListener('pointermove', (event) => {
      if (!perimeterEdit?.dragging || perimeterEdit.controlIndex === null) return;
      const worldPoint = perimeterEdit.dragTransform.toWorld(editorCanvasPoint(event));
      Object.assign(perimeterEdit.points[perimeterEdit.controlIndex], worldPoint);
      perimeterEdit.dirty = true;
      savePerimeterEditBtn.disabled = false;
      drawPerimeterEditor();
    });
    perimeterEditorCanvas.addEventListener('pointerup', () => { if (perimeterEdit) { perimeterEdit.dragging = false; perimeterEdit.dragTransform = null; } });

    window.editAreaPerimeter = function(pathName) {
      const path = getStoredAreaPerimeterByName(pathName);
      if (!path?.points?.length) { alert('This perimeter has no editable points.'); return; }
      perimeterEdit = { name: path.name, original: copyPerimeterPoints(path.points), points: copyPerimeterPoints(path.points), mode: 'straighten', anchors: [], controlIndex: null, dragging: false, dragTransform: null, dirty: false, undo: [] };
      $('perimeterEditorSubtitle').textContent = path.name;
      perimeterEditorBackdrop.classList.add('visible');
      perimeterEditorBackdrop.setAttribute('aria-hidden', 'false');
      savePerimeterEditBtn.disabled = true;
      undoPerimeterEditBtn.disabled = true;
      setPerimeterEditorTool('straighten');
    };

    async function closePerimeterEditor() {
      if (perimeterEdit?.dirty && !await window.appConfirm('Discard the unsaved perimeter corrections?', 'Close perimeter editor')) return;
      perimeterEditorBackdrop.classList.remove('visible');
      perimeterEditorBackdrop.setAttribute('aria-hidden', 'true');
      perimeterEdit = null;
    }

    $('closePerimeterEditor').addEventListener('click', () => { void closePerimeterEditor(); });
    $('straightenPerimeterSection').addEventListener('click', () => setPerimeterEditorTool('straighten'));
    $('reshapePerimeterSection').addEventListener('click', () => setPerimeterEditorTool('reshape'));
    $('resetPerimeterEdit').addEventListener('click', () => {
      if (!perimeterEdit) return;
      perimeterEdit.points = copyPerimeterPoints(perimeterEdit.original); perimeterEdit.undo = []; perimeterEdit.dirty = false; savePerimeterEditBtn.disabled = true; undoPerimeterEditBtn.disabled = true; setPerimeterEditorTool(perimeterEdit.mode);
    });
    undoPerimeterEditBtn.addEventListener('click', () => {
      if (!perimeterEdit?.undo.length) return;
      perimeterEdit.points = perimeterEdit.undo.pop(); perimeterEdit.anchors = []; perimeterEdit.controlIndex = null; perimeterEdit.dirty = true; undoPerimeterEditBtn.disabled = perimeterEdit.undo.length === 0; savePerimeterEditBtn.disabled = false; perimeterEditorStatus.textContent = 'Last edit undone.'; drawPerimeterEditor();
    });
    savePerimeterEditBtn.addEventListener('click', async () => {
      if (!perimeterEdit) return;
      savePerimeterEditBtn.disabled = true; perimeterEditorStatus.textContent = 'Saving corrected perimeter…';
      try {
        await postJson('/api/area-perimeter/update', { pathName: perimeterEdit.name, points: perimeterEdit.points });
        perimeterEdit.original = copyPerimeterPoints(perimeterEdit.points);
        perimeterEdit.undo = [];
        perimeterEdit.dirty = false;
        perimeterEdit.anchors = [];
        perimeterEdit.controlIndex = null;
        undoPerimeterEditBtn.disabled = true;
        await loadStoredAreaPerimeters();
        markMowingPlanPreviewStale();
        perimeterEditorStatus.textContent = 'Corrected mowing area perimeter saved. Close when finished, or make another correction.';
        drawPerimeterEditor();
      } catch (error) { savePerimeterEditBtn.disabled = false; perimeterEditorStatus.textContent = 'Save failed: ' + error.message; }
    });

    function schedulePageStatePoll(delayMs = PRIMITIVES_POLL_MS) {
      if (pageStatePollTimer !== null) {
        window.clearTimeout(pageStatePollTimer);
      }
      pageStatePollTimer = window.setTimeout(runPageStatePoll, delayMs);
    }

    function stopPageStatePoll() {
      if (pageStatePollTimer !== null) {
        window.clearTimeout(pageStatePollTimer);
        pageStatePollTimer = null;
      }
    }

    function scheduleListRefresh(delayMs = LIST_REFRESH_MS) {
      if (listRefreshTimer !== null) {
        window.clearTimeout(listRefreshTimer);
      }
      listRefreshTimer = window.setTimeout(runListRefresh, delayMs);
    }

    function stopListRefresh() {
      if (listRefreshTimer !== null) {
        window.clearTimeout(listRefreshTimer);
        listRefreshTimer = null;
      }
    }

    async function refreshPathRecordingStatus() {
      if (!recording || pathRecordingStatusInFlight) {
        return;
      }
      pathRecordingStatusInFlight = true;
      try {
        const status = await fetchJson('/api/path/record/status');
        pointCount = status.pointCount ?? 0;
        updateRecordingUi();
      } catch (error) {
        console.error('Failed to fetch recording status:', error);
      } finally {
        pathRecordingStatusInFlight = false;
      }
    }

    async function refreshAreaRecordingStatus() {
      if (!areaRecording || areaRecordingStatusInFlight) {
        return;
      }
      areaRecordingStatusInFlight = true;
      try {
        const status = await fetchJson('/api/area-perimeter/record/status');
        areaPointCount = status.pointCount ?? 0;
        updateAreaRecordingUi();
      } catch (error) {
        console.error('Failed to fetch area perimeter recording status:', error);
      } finally {
        areaRecordingStatusInFlight = false;
      }
    }

    const startMowingBtn = $("startMowingBtn");
    const startMowingNoPerimeterBtn = $("startMowingNoPerimeterBtn");
    const stopMowingBtn = $("stopMowingBtn");
    const mowingStatusBar = $("mowingStatusBar");
    const mowingStatusText = $("mowingStatusText");
    const rechargeDriveToText = $("rechargeDriveToText");
    const rechargeChargingText = $("rechargeChargingText");
    const rechargeStatusText = $("rechargeStatusText");
    let rechargeConfiguration = null;

    function formatRechargePoint(point) {
      return point ? `${Number(point.xMeters).toFixed(2)}, ${Number(point.yMeters).toFixed(2)} m` : 'Not set';
    }

    async function loadRechargeStatus() {
      const status = await fetchJson('/api/recharge/status');
      rechargeConfiguration = status.configuration;
      rechargeDriveToText.textContent = formatRechargePoint(status.configuration.driveToPosition);
      rechargeChargingText.textContent = formatRechargePoint(status.configuration.chargingPosition);
      rechargeStatusText.textContent = status.waitingForCharge
        ? 'Charging — press Carry On Mowing when ready.'
        : `${status.batteryRemainingPercent == null ? 'Battery estimate unavailable' : Number(status.batteryRemainingPercent).toFixed(1) + '% battery remaining'}${status.rechargeDue ? ' — recharge due' : ''}. Automatic recharge uses monitored motor power only.`;
    }

    async function captureRechargePoint(point) {
      await postJson('/api/recharge/capture', { point });
      await loadRechargeStatus();
    }
    $("captureRechargeDriveToBtn").addEventListener('click', () => captureRechargePoint('driveTo').catch((error) => alert(error.message)));
    $("captureRechargeChargingBtn").addEventListener('click', () => captureRechargePoint('charging').catch((error) => alert(error.message)));
    $("rechargeNowBtn").addEventListener('click', () => postJson('/api/recharge/request', {}).then(loadRechargeStatus).catch((error) => alert(error.message)));

    const MOWING_PHASE_LABELS = {
      idle: 'Idle',
      approaching_area_perimeter: 'Approaching area perimeter',
      approaching_strip: 'Approaching strip',
      tracing_boundary: 'Tracing boundary',
      mowing_strip: 'Mowing strip',
      following_connector: 'Following connector',
      travelling_to_charger: 'Travelling to charger',
      docking: 'Reversing onto charger',
      waiting_for_charge: 'Waiting for charge',
      undocking: 'Driving clear of charger',
      returning_to_mow: 'Returning to interrupted point',
      complete: 'Complete',
      stopped: 'Stopped',
      error: 'Error',
    };

    function updateMowingStatusUi(status) {
      const active = status.phase !== 'idle';
      mowingStatusBar.classList.toggle('active', active);
      mowingStatusBar.classList.toggle('error', status.phase === 'error');
      mowingStatusBar.classList.toggle('complete', status.phase === 'complete' || status.phase === 'stopped');

      const phaseLabel = MOWING_PHASE_LABELS[status.phase] ?? status.phase;
      const stripInfo = status.totalStrips > 0
        ? ` — strip ${status.currentStripIndex + 1}/${status.totalStrips}`
        : '';
      const errorInfo = status.error ? ` (${status.error})` : '';
      mowingStatusText.textContent = `${phaseLabel}${stripInfo}${errorInfo}`;

      const isRunning = status.phase !== 'idle' && status.phase !== 'complete' && status.phase !== 'stopped' && status.phase !== 'error';
      startMowingBtn.style.display = isRunning ? 'none' : '';
      startMowingNoPerimeterBtn.style.display = isRunning ? 'none' : '';
      startMowingBtn.disabled = mowingActionInFlight;
      startMowingNoPerimeterBtn.disabled = mowingActionInFlight;
      const canResume = status.phase === 'waiting_for_charge' || (!isRunning && Boolean(status.resumeAvailable));
      resumeMowingBtn.style.display = canResume ? '' : 'none';
      resumeMowingBtn.disabled = !canResume || mowingActionInFlight;
      stopMowingBtn.style.display = '';
    }

    async function pollMowingStatus() {
      if (mowingStatusInFlight) {
        return;
      }
      mowingStatusInFlight = true;
      try {
        const status = await fetchJson('/api/mowing/status');
        updateMowingStatusUi(status);
      } catch (error) {
        console.error('Failed to poll mowing status:', error);
      } finally {
        mowingStatusInFlight = false;
      }
    }

    async function runListRefresh() {
      if (document.hidden || listRefreshInFlight) {
        scheduleListRefresh();
        return;
      }
      listRefreshInFlight = true;
      try {
        await Promise.all([
          loadStoredPaths(),
          loadStoredAreaPerimeters(),
        ]);
        listsLoadedOnce = true;
        lastListRefreshAt = Date.now();
      } catch (_error) {
        // Individual list loaders already log their failures.
      } finally {
        listRefreshInFlight = false;
        scheduleListRefresh();
      }
    }

    async function ensureListsLoaded() {
      if (listsLoadedOnce || listRefreshInFlight) {
        return;
      }
      await runListRefresh();
    }

    async function runPageStatePoll() {
      if (document.hidden) {
        schedulePageStatePoll(PRIMITIVES_POLL_MS);
        return;
      }
      if (pageStatePollInFlight) {
        schedulePageStatePoll(PRIMITIVES_POLL_MS);
        return;
      }
      pageStatePollInFlight = true;
      try {
        await updateStatus();
        await Promise.all([
          refreshPathRecordingStatus(),
          refreshAreaRecordingStatus(),
          pollMowingStatus(),
          loadRechargeStatus(),
        ]);
        pageStatePollFailureCount = 0;
        if (!listsLoadedOnce || Date.now() - lastListRefreshAt >= LIST_REFRESH_MS) {
          await ensureListsLoaded();
        }
        schedulePageStatePoll(PRIMITIVES_POLL_MS);
      } catch (_error) {
        pageStatePollFailureCount += 1;
        schedulePageStatePoll(Math.min(FAILURE_BACKOFF_MS * pageStatePollFailureCount, 30000));
      } finally {
        pageStatePollInFlight = false;
      }
    }

    async function startMowing(skipInitialBoundaryTrace) {
      if (mowingActionInFlight) {
        return;
      }
      const areaName = mowingPlanAreaSelect.value;
      if (!areaName) {
        alert('Please select a mowing area first.');
        return;
      }
      if (recording || areaRecording) {
        alert('Stop recording before starting mowing.');
        return;
      }

      const headingDeg = normalizeAxisHeading(mowingHeadingInput.value);
      const stripSpacingMeters = Number(stripSpacingInput.value) / 100;

      mowingActionInFlight = true;
      startMowingBtn.disabled = true;
      startMowingNoPerimeterBtn.disabled = true;
      resumeMowingBtn.disabled = true;
      try {
        const result = await postJson('/api/mowing/start', {
          areaName,
          headingDeg,
          stripSpacingMeters,
          skipInitialBoundaryTrace: Boolean(skipInitialBoundaryTrace),
        });

        clearMowingProgress();
        commitMowingPlanFields();
        updateMowingStatusUi({ phase: 'approaching_area_perimeter', currentStripIndex: 0, totalStrips: result.stripCount, tracedBoundaryCount: 0 });
        schedulePageStatePoll(0);
      } catch (error) {
        alert('Failed to start mowing: ' + error.message);
      } finally {
        mowingActionInFlight = false;
        startMowingBtn.disabled = false;
        startMowingNoPerimeterBtn.disabled = false;
        resumeMowingBtn.disabled = resumeMowingBtn.style.display === 'none';
        schedulePageStatePoll(0);
      }
    }

    startMowingBtn.addEventListener('click', async () => {
      await startMowing(false);
    });

    startMowingNoPerimeterBtn.addEventListener('click', async () => {
      await startMowing(true);
    });

    resumeMowingBtn.addEventListener('click', async () => {
      if (mowingActionInFlight) {
        return;
      }
      mowingActionInFlight = true;
      startMowingBtn.disabled = true;
      startMowingNoPerimeterBtn.disabled = true;
      resumeMowingBtn.disabled = true;
      try {
        const result = await postJson('/api/mowing/resume', {});

        updateMowingStatusUi({
          phase: 'approaching_strip',
          currentStripIndex: result.currentStripIndex ?? 0,
          totalStrips: result.stripCount ?? 0,
          tracedBoundaryCount: 0,
          resumeAvailable: false,
        });
        schedulePageStatePoll(0);
      } catch (error) {
        alert('Failed to resume mowing: ' + error.message);
      } finally {
        mowingActionInFlight = false;
        startMowingBtn.disabled = false;
        startMowingNoPerimeterBtn.disabled = false;
        resumeMowingBtn.disabled = resumeMowingBtn.style.display === 'none';
        schedulePageStatePoll(0);
      }
    });

    stopMowingBtn.addEventListener('click', async () => {
      try {
        await stopAll();
      } catch (error) {
        alert('Failed to stop mowing: ' + error.message);
      }
    });

    startRecordingBtn.addEventListener('click', async () => {
      const pathName = pathNameInput.value.trim() || getNextPathName();

      try {
        await postJson('/api/path/record/start', { pathName });

        recording = true;
        currentPathName = pathName;
        pointCount = 0;
        updateRecordingUi();
        schedulePageStatePoll(0);
      } catch (error) {
        alert('Failed to start recording: ' + error.message);
      }
    });

    stopRecordingBtn.addEventListener('click', async () => {
      try {
        const result = await postJson('/api/path/record/stop', {});
        recording = false;
        currentPathName = '';
        pointCount = 0;
        pathNameInput.value = '';
        updateRecordingUi();
        await loadStoredPaths();
        lastListRefreshAt = Date.now();
        listsLoadedOnce = true;
        pathNameInput.value = getNextPathName();

        const savedPointCount = result.pointCount ?? result.metadata?.pointCount ?? 0;
        alert(`Path saved: ${result.name}\n${savedPointCount} points recorded`);
      } catch (error) {
        alert('Failed to save path: ' + error.message);
      }
    });

    cancelRecordingBtn.addEventListener('click', async () => {
      try {
        await postJson('/api/path/record/cancel', {});

        recording = false;
        currentPathName = '';
        pointCount = 0;
        updateRecordingUi();
      } catch (error) {
        alert('Failed to cancel recording: ' + error.message);
      }
    });

    startAreaRecordingBtn.addEventListener('click', async () => {
      const pathName = areaPerimeterNameInput.value.trim() || getNextAreaPerimeterName();

      try {
        await postJson('/api/area-perimeter/record/start', { pathName });

        areaRecording = true;
        currentAreaPerimeterName = pathName;
        areaPointCount = 0;
        updateRecordingUi();
        updateAreaRecordingUi();
        schedulePageStatePoll(0);
      } catch (error) {
        alert('Failed to start area perimeter recording: ' + error.message);
      }
    });

    stopAreaRecordingBtn.addEventListener('click', async () => {
      try {
        const result = await postJson('/api/area-perimeter/record/stop', {
          headingDeg: normalizeAxisHeading(mowingHeadingInput.value),
          stripSpacingMeters: Number(stripSpacingInput.value) / 100,
        });
        areaRecording = false;
        currentAreaPerimeterName = '';
        areaPointCount = 0;
        areaPerimeterNameInput.value = '';
        updateRecordingUi();
        updateAreaRecordingUi();
        await loadStoredAreaPerimeters();
        lastListRefreshAt = Date.now();
        listsLoadedOnce = true;
        areaPerimeterNameInput.value = getNextAreaPerimeterName();
        selectedMowingPlanArea = result.name;
        mowingPlanAreaSelect.value = result.name;
        applyAreaMowingDefaults(result.name);
        markMowingPlanPreviewStale();

        const savedPointCount = result.pointCount ?? result.metadata?.pointCount ?? 0;
        alert(`Area perimeter saved: ${result.name}\n${savedPointCount} points recorded`);
      } catch (error) {
        alert('Failed to save area perimeter: ' + error.message);
      }
    });

    cancelAreaRecordingBtn.addEventListener('click', async () => {
      try {
        await postJson('/api/area-perimeter/record/cancel', {});

        areaRecording = false;
        currentAreaPerimeterName = '';
        areaPointCount = 0;
        updateRecordingUi();
        updateAreaRecordingUi();
      } catch (error) {
        alert('Failed to cancel area perimeter recording: ' + error.message);
      }
    });

    mowingPlanAreaSelect.addEventListener('change', () => {
      beginMowingPlanEdit();
      mowingPresetSelect.value = '';
      storeMowingPresetId('');
      selectedMowingPlanArea = mowingPlanAreaSelect.value;
      applyAreaMowingDefaults(selectedMowingPlanArea);
      markMowingPlanPreviewStale();
    });

    mowingPresetSelect.addEventListener('change', () => {
      beginMowingPlanEdit();
      const preset = mowingPresets.find((entry) => entry.id === mowingPresetSelect.value);
      storeMowingPresetId(preset?.id || '');
      if (!applyMowingPreset(preset)) return;
      markMowingPlanPreviewStale();
    });

    mowingHeadingInput.addEventListener('input', () => {
      beginMowingPlanEdit();
      mowingPresetSelect.value = '';
      storeMowingPresetId('');
      storeMowingHeading(mowingHeadingInput.value);
      updateHeadingLabel();
      markMowingPlanPreviewStale();
    });

    stripSpacingInput.addEventListener('input', () => {
      beginMowingPlanEdit();
      mowingPresetSelect.value = '';
      storeMowingPresetId('');
      storeStripSpacingCm(stripSpacingInput.value);
      markMowingPlanPreviewStale();
    });

    previewMowingPlanBtn.addEventListener('click', () => {
      requestMowingPlanPreview();
    });

    cancelMowingPlanEditBtn.addEventListener('click', () => {
      cancelMowingPlanEdit().catch((error) => {
        console.error('Failed to cancel mowing plan changes:', error);
      });
    });

    canvas.addEventListener('mousedown', (event) => {
      if (!mapTransform) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (event.clientX - rect.left) * scaleX;
      const canvasY = (event.clientY - rect.top) * scaleY;
      headingDragStart = {
        x: mapTransform.toWorldX(canvasX),
        y: mapTransform.toWorldY(canvasY),
      };
    });

    canvas.addEventListener('mouseup', (event) => {
      if (!mapTransform || !headingDragStart) {
        headingDragStart = null;
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (event.clientX - rect.left) * scaleX;
      const canvasY = (event.clientY - rect.top) * scaleY;
      const worldX = mapTransform.toWorldX(canvasX);
      const worldY = mapTransform.toWorldY(canvasY);
      const dx = worldX - headingDragStart.x;
      const dy = worldY - headingDragStart.y;
      headingDragStart = null;

      if (Math.hypot(dx, dy) < 0.05) {
        return;
      }

      beginMowingPlanEdit();
      setMowingHeading((Math.atan2(dy, dx) * 180) / Math.PI);
    });

    window.drivePath = async function(pathName) {
      if (recording || areaRecording) {
        alert('Stop recording before starting a path drive.');
        return;
      }

      await runPathAction(pathName, '/api/path/drive', 'drive', 'Path drive complete');
    };

    window.verifyPath = async function(pathName) {
      if (recording || areaRecording) {
        alert('Stop recording before starting a path verification run.');
        return;
      }

      await runPathAction(pathName, '/api/path/verify', 'verify', 'Path verification complete');
    };

    window.driveAreaPerimeter = async function(pathName) {
      if (recording || areaRecording) {
        alert('Stop recording before starting an area perimeter drive.');
        return;
      }

      await runPathAction(pathName, '/api/area-perimeter/drive', 'drive area perimeter', 'Area perimeter drive complete');
    };

    window.verifyAreaPerimeter = async function(pathName) {
      if (recording || areaRecording) {
        alert('Stop recording before starting an area perimeter verification run.');
        return;
      }

      await runPathAction(pathName, '/api/area-perimeter/verify', 'verify area perimeter', 'Area perimeter verification complete');
    };

    async function runPathAction(pathName, endpoint, actionName, successLabel) {
      try {
        const result = await postJson(endpoint, { pathName });

        const failureDetail = result.error || result.failedSegment?.errorMessage || result.reason || 'unknown';
        const reason = result.completed ? '' : `\nReason: ${failureDetail}`;
        alert(`${successLabel}: ${pathName}${reason}`);
      } catch (error) {
        alert(`Failed to ${actionName} path: ${error.message}`);
      }
    }

    window.stopPathOperation = async function() {
      try {
        await stopAll();

        alert('Path stop requested.');
      } catch (error) {
        alert('Failed to stop path operation: ' + error.message);
      }
    };

    window.deletePath = async function(pathName) {
      try {
        await postJson('/api/path/delete', { pathName });

        await loadStoredPaths();
        lastListRefreshAt = Date.now();
        listsLoadedOnce = true;
        pathNameInput.value = getNextPathName();
      } catch (error) {
        alert('Failed to delete path: ' + error.message);
      }
    };

    window.deleteAreaPerimeter = async function(pathName) {
      try {
        await postJson('/api/area-perimeter/delete', { pathName });

        await loadStoredAreaPerimeters();
        lastListRefreshAt = Date.now();
        listsLoadedOnce = true;
        areaPerimeterNameInput.value = getNextAreaPerimeterName();
        markMowingPlanPreviewStale();
      } catch (error) {
        alert('Failed to delete area perimeter: ' + error.message);
      }
    };

    async function updateStatus() {
      try {
        const data = await fetchJson('/api/primitives');
        const primitives = data.primitives;
        const imu = primitives.imu || {};
        const gnss = primitives.gnss || {};
        const poseFusion = primitives.poseFusion || {};
        const imuWidget = $("mini-imu-widget");
        const gnssWidget = $("mini-gnss-widget");
        const motorOdoWidget = $("mini-motor-odometry-widget");

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

        if (primitives.poseFusion && primitives.poseFusion.status === 'ok') {
          const pose = primitives.poseFusion;
          $("mapStats").textContent = `Pose: ${format(pose.headingDeg, 1)}° | quality: ${pose.quality}`;
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
        throw error;
      }
    }

    stripSpacingInput.value = String(loadStoredStripSpacingCm() ?? DEFAULT_STRIP_SPACING_CM);
    loadStoredMowingProgress();
    const storedMowingHeading = loadStoredMowingHeading();
    if (storedMowingHeading !== null) {
      mowingHeadingInput.value = String(Math.round(normalizeAxisHeading(storedMowingHeading)));
    }

    updateRecordingUi();
    updateAreaRecordingUi();
    updateHeadingLabel();

    window.addEventListener('pagehide', () => {
      storeMowingProgress(true);
    });

    Promise.allSettled([
      loadMowerMowingProgress(),
      loadFrozenMowingPlanPreview(),
      loadStoredPaths(),
      loadStoredAreaPerimeters(),
      loadMowingPresets(),
      pollMowingStatus(),
    ]).then(() => {
      restoreStoredMowingPreset();
      listsLoadedOnce = true;
      lastListRefreshAt = Date.now();
      if (!recording) {
        pathNameInput.value = getNextPathName();
      }
      if (!areaRecording) {
        areaPerimeterNameInput.value = getNextAreaPerimeterName();
      }
      updateRecordingUi();
      updateAreaRecordingUi();
      if (!restoreStoredMowingPlanPreview()) {
        markMowingPlanPreviewStale();
      }
      commitMowingPlanFields();
      scheduleListRefresh();
      schedulePageStatePoll(0);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPageStatePoll();
        stopListRefresh();
        return;
      }
      schedulePageStatePoll(0);
      scheduleListRefresh(0);
    });
