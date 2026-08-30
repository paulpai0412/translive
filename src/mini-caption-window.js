export const MINI_CAPTION_LIMITS = Object.freeze({
  bottomInset: 28,
  height: 190,
  modeCharacters: 48,
  primaryCharacters: 900,
  secondaryCharacters: 600,
  statusCharacters: 64,
  width: 460,
});

function boundedText(value, limit) {
  return Array.from(String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " "))
    .slice(0, limit)
    .join("")
    .trim();
}

export function normalizeMiniCaptionSnapshot(value) {
  return {
    mode: boundedText(value?.mode, MINI_CAPTION_LIMITS.modeCharacters),
    primary: boundedText(value?.primary, MINI_CAPTION_LIMITS.primaryCharacters),
    secondary: boundedText(
      value?.secondary,
      MINI_CAPTION_LIMITS.secondaryCharacters,
    ),
    status: boundedText(value?.status, MINI_CAPTION_LIMITS.statusCharacters),
  };
}

function bottomCenterPosition(workArea) {
  const area = workArea ?? {};
  const width = Number(area.width) || MINI_CAPTION_LIMITS.width;
  const height = Number(area.height) || MINI_CAPTION_LIMITS.height;
  const x = Number(area.x) || 0;
  const y = Number(area.y) || 0;
  return {
    x: x + Math.floor((width - MINI_CAPTION_LIMITS.width) / 2),
    y:
      y + height - MINI_CAPTION_LIMITS.height - MINI_CAPTION_LIMITS.bottomInset,
  };
}

/**
 * Owns the non-modal caption surface. It deliberately accepts only a bounded
 * status/caption snapshot and has no access to app diagnostics or credentials.
 */
export class MiniCaptionWindowController {
  #createWindow;
  #disposing = false;
  #getMainWindow;
  #getWorkArea;
  #latestSnapshot;
  #pagePath;
  #ready = false;
  #showRequested = false;
  #window;

  constructor({ createWindow, getMainWindow, getWorkArea, pagePath }) {
    this.#createWindow = createWindow;
    this.#getMainWindow = getMainWindow;
    this.#getWorkArea = getWorkArea;
    this.#pagePath = pagePath;
  }

  show(snapshot) {
    this.#showRequested = true;
    this.#ensureWindow();
    this.update(snapshot);
    this.#showIfReady();
    return { shown: true };
  }

  update(snapshot) {
    this.#latestSnapshot = normalizeMiniCaptionSnapshot(snapshot);
    const window = this.#window;
    if (!window || window.isDestroyed() || !this.#ready) {
      return { delivered: false };
    }
    window.webContents.send("translive:mini-caption", this.#latestSnapshot);
    return { delivered: true };
  }

  hideAndFocusMain() {
    const window = this.#window;
    if (window && !window.isDestroyed()) window.hide();
    const main = this.#getMainWindow?.();
    if (!main || main.isDestroyed()) return { hidden: Boolean(window) };
    main.show();
    main.focus();
    return { hidden: true };
  }

  dispose() {
    const window = this.#window;
    this.#disposing = true;
    this.#ready = false;
    this.#showRequested = false;
    this.#window = undefined;
    if (window && !window.isDestroyed()) window.destroy?.();
    this.#disposing = false;
  }

  #showIfReady() {
    const window = this.#window;
    if (
      !this.#ready ||
      !this.#showRequested ||
      !window ||
      window.isDestroyed()
    ) {
      return;
    }
    if (typeof window.showInactive === "function") window.showInactive();
    else window.show();
  }

  #ensureWindow() {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const position = bottomCenterPosition(this.#getWorkArea?.());
    const window = this.#createWindow({
      alwaysOnTop: true,
      frame: false,
      height: MINI_CAPTION_LIMITS.height,
      modal: false,
      movable: true,
      resizable: true,
      show: false,
      skipTaskbar: true,
      width: MINI_CAPTION_LIMITS.width,
      x: position.x,
      y: position.y,
    });
    window.loadFile(this.#pagePath);
    window.once("ready-to-show", () => {
      if (this.#window !== window) return;
      this.#ready = true;
      if (this.#latestSnapshot) {
        window.webContents.send("translive:mini-caption", this.#latestSnapshot);
      }
      this.#showIfReady();
    });
    window.on("close", (event) => {
      if (this.#disposing) return;
      event.preventDefault();
      this.hideAndFocusMain();
    });
    window.on("closed", () => {
      if (this.#window === window) {
        this.#ready = false;
        this.#window = undefined;
      }
    });
    this.#window = window;
    return window;
  }
}
