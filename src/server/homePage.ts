export function renderHomePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mower Core Server</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f6f8;
        --panel: #ffffff;
        --text: #102135;
        --muted: #557086;
        --accent: #0d6e6e;
        --border: #d9e4eb;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, sans-serif;
        background: radial-gradient(circle at top, #ffffff 0, var(--bg) 60%);
        color: var(--text);
      }
      main {
        max-width: 860px;
        margin: 1.5rem auto;
        padding: 0 1rem;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(16, 33, 53, 0.08);
        overflow: hidden;
      }
      .tabs {
        display: flex;
        border-bottom: 1px solid var(--border);
      }
      .tabs button {
        flex: 1;
        border: 0;
        background: #eef4f7;
        padding: 0.9rem;
        color: var(--muted);
        cursor: pointer;
      }
      .tabs button.active {
        background: #ffffff;
        color: var(--accent);
        font-weight: 600;
      }
      .content {
        padding: 1rem;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--text);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Mower Core Server</h1>
      <div class="panel">
        <div class="tabs">
          <button id="tab-primitives" class="active">Primitives</button>
          <button id="tab-status">Status</button>
          <button id="tab-turns">Turn Tuning</button>
        </div>
        <div class="content">
          <section id="view-primitives">
            <pre id="primitives-output">Loading...</pre>
          </section>
          <section id="view-status" hidden>
            <pre id="status-output">Loading...</pre>
          </section>
          <section id="view-turns" hidden>
            <p>Use the dedicated <a href="/turn-tuning" style="color: var(--accent); font-weight: 600;">Turn Tuning Page</a> for full turn controller interface.</p>
          </section>
        </div>
      </div>
    </main>
    <script>
      const tabs = {
        primitives: document.getElementById('tab-primitives'),
        status: document.getElementById('tab-status'),
        turns: document.getElementById('tab-turns')
      };
      const views = {
        primitives: document.getElementById('view-primitives'),
        status: document.getElementById('view-status'),
        turns: document.getElementById('view-turns')
      };

      function select(name) {
        Object.keys(tabs).forEach(key => {
          tabs[key].classList.toggle('active', key === name);
          views[key].hidden = key !== name;
        });
      }

      tabs.primitives.addEventListener('click', () => select('primitives'));
      tabs.status.addEventListener('click', () => select('status'));
      tabs.turns.addEventListener('click', () => select('turns'));

      async function refresh() {
        const [primitives, health] = await Promise.all([
          fetch('/api/primitives').then((r) => r.json()),
          fetch('/health').then((r) => r.json())
        ]);

        document.getElementById('primitives-output').textContent = JSON.stringify(primitives, null, 2);
        document.getElementById('status-output').textContent = JSON.stringify(health, null, 2);
      }

      refresh();
      setInterval(refresh, 1000);
    </script>
  </body>
</html>`;
}
