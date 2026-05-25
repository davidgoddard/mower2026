export function getAppDialogStyles(): string {
  return `
    .app-dialog-backdrop {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      background: rgba(248, 250, 252, 0.58);
      backdrop-filter: blur(3px);
      z-index: 2000;
    }

    .app-dialog-backdrop.visible {
      display: flex;
    }

    .app-dialog-panel {
      width: min(92vw, 32rem);
      border-radius: 1rem;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      box-shadow: 0 30px 80px rgba(15, 23, 42, 0.18);
      overflow: hidden;
    }

    .app-dialog-header {
      padding: 1rem 1.25rem 0.5rem;
      border-bottom: 1px solid var(--border-color);
    }

    .app-dialog-title {
      font-size: 1rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .app-dialog-body {
      padding: 1rem 1.25rem;
      color: var(--text-primary);
      white-space: pre-wrap;
      line-height: 1.6;
    }

    .app-dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      padding: 0 1.25rem 1.25rem;
    }

    .app-dialog-button {
      min-width: 5.5rem;
      padding: 0.7rem 1rem;
      border: none;
      border-radius: 0.7rem;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
      box-shadow: var(--shadow-sm);
    }

    .app-dialog-button:hover {
      transform: translateY(-1px);
      box-shadow: var(--shadow-md);
    }

    .app-dialog-button.primary {
      background: var(--primary-color);
      color: white;
    }

    .app-dialog-button.primary:hover {
      background: var(--primary-hover);
    }

    .app-dialog-button.secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }

    .app-dialog-button.secondary:hover {
      background: var(--border-color);
    }
  `;
}

export function getAppDialogHtml(): string {
  return `
    <div id="appDialogBackdrop" class="app-dialog-backdrop" aria-hidden="true">
      <div class="app-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle">
        <div class="app-dialog-header">
          <div id="appDialogTitle" class="app-dialog-title">Notice</div>
        </div>
        <div id="appDialogMessage" class="app-dialog-body"></div>
        <div class="app-dialog-actions">
          <button id="appDialogCancel" type="button" class="app-dialog-button secondary" style="display: none;">Cancel</button>
          <button id="appDialogOk" type="button" class="app-dialog-button primary">OK</button>
        </div>
      </div>
    </div>
  `;
}

export function getAppDialogScript(): string {
  return `
    (() => {
      const backdrop = document.getElementById("appDialogBackdrop");
      const titleEl = document.getElementById("appDialogTitle");
      const messageEl = document.getElementById("appDialogMessage");
      const okButton = document.getElementById("appDialogOk");
      const cancelButton = document.getElementById("appDialogCancel");

      if (!backdrop || !titleEl || !messageEl || !okButton || !cancelButton) {
        return;
      }

      let activeMode = "alert";
      let activeResolve = null;

      function closeDialog(value) {
        backdrop.classList.remove("visible");
        backdrop.setAttribute("aria-hidden", "true");
        document.removeEventListener("keydown", handleKeyDown);
        const resolve = activeResolve;
        activeResolve = null;
        if (resolve) {
          resolve(value);
        }
      }

      function handleKeyDown(event) {
        if (!backdrop.classList.contains("visible")) {
          return;
        }
        if (event.key === "Escape") {
          closeDialog(activeMode === "confirm" ? false : undefined);
        }
      }

      function openDialog(title, message, mode) {
        activeMode = mode;
        titleEl.textContent = title;
        messageEl.textContent = message;
        cancelButton.style.display = mode === "confirm" ? "inline-flex" : "none";
        backdrop.classList.add("visible");
        backdrop.setAttribute("aria-hidden", "false");
        okButton.focus();
        document.addEventListener("keydown", handleKeyDown);

        return new Promise((resolve) => {
          activeResolve = resolve;
        });
      }

      okButton.addEventListener("click", () => {
        closeDialog(activeMode === "confirm" ? true : undefined);
      });

      cancelButton.addEventListener("click", () => {
        closeDialog(false);
      });

      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) {
          closeDialog(activeMode === "confirm" ? false : undefined);
        }
      });

      window.appAlert = (message, title = "Notice") => openDialog(title, String(message), "alert");
      window.appConfirm = (message, title = "Confirm") => openDialog(title, String(message), "confirm");
      window.alert = (message) => {
        void window.appAlert(message);
      };
    })();
  `;
}
