import { channelStateLabel, modeLabel } from "./view-state.js";

function activeDirections(status) {
  return ["tx", "rx"].filter((direction) => status?.[direction] !== "disabled");
}

function localizedRunState(appState) {
  return (
    {
      blocked: "無法連線",
      degraded: "部分中斷",
      live: "翻譯中",
      ready: "待命",
      stopped: "已停止",
    }[appState] ?? "待命"
  );
}

export class TrayController {
  #app;
  #appState = "ready";
  #controller;
  #iconPath;
  #Menu;
  #mode = "meeting";
  #nativeImage;
  #preferences;
  #publish;
  #status = { tx: "stopped", rx: "stopped" };
  #supported;
  #Tray;
  #tray;
  #window;

  constructor({
    app,
    controller,
    iconPath,
    Menu,
    nativeImage,
    platform = process.platform,
    preferences = {
      load: async () => ({ closeBehavior: "tray", closeNoticeShown: false }),
      save: async () => {},
    },
    publish = () => {},
    Tray,
    window,
  }) {
    this.#app = app;
    this.#controller = controller;
    this.#iconPath = iconPath;
    this.#Menu = Menu;
    this.#nativeImage = nativeImage;
    this.#preferences = preferences;
    this.#publish = publish;
    this.#supported = platform === "win32";
    this.#Tray = Tray;
    this.#window = window;
  }

  async initialize({ appState, mode, status }) {
    this.update({ appState, mode, status });
    if (!this.#supported) {
      return { supported: false, closeBehavior: "exit" };
    }

    const stored = await this.#preferences.load();
    this.#preferences.value = {
      closeBehavior: stored?.closeBehavior === "exit" ? "exit" : "tray",
      closeNoticeShown: Boolean(stored?.closeNoticeShown),
    };
    const image = this.#nativeImage.createFromPath(this.#iconPath);
    this.#tray = new this.#Tray(
      image?.isEmpty?.() ? this.#nativeImage.createEmpty() : image,
    );
    this.#tray.on("click", () => this.toggleWindow());
    this.#render();
    return {
      supported: true,
      closeBehavior: this.#preferences.value.closeBehavior,
    };
  }

  setWindow(window) {
    this.#window = window;
  }

  update({ appState, mode, status }) {
    if (appState) this.#appState = appState;
    if (mode) this.#mode = mode;
    if (status) this.#status = { ...status };
    this.#render();
  }

  status() {
    return {
      closeBehavior: this.#supported
        ? this.#preferences.value?.closeBehavior ?? "tray"
        : "exit",
      supported: this.#supported,
    };
  }

  shouldHideOnClose() {
    return this.#supported && this.#preferences.value?.closeBehavior !== "exit";
  }

  async setCloseBehavior(closeBehavior) {
    if (!this.#supported) return { supported: false, closeBehavior: "exit" };
    const value = closeBehavior === "exit" ? "exit" : "tray";
    this.#preferences.value = {
      ...this.#preferences.value,
      closeBehavior: value,
    };
    await this.#preferences.save(this.#preferences.value);
    return { supported: true, closeBehavior: value };
  }

  async handleWindowClose() {
    if (
      !this.shouldHideOnClose() ||
      !this.#window ||
      this.#window.isDestroyed()
    ) {
      return { prevented: false, notice: false };
    }

    this.#window.hide();
    const notice = !this.#preferences.value.closeNoticeShown;
    if (notice) {
      this.#preferences.value.closeNoticeShown = true;
      try {
        await this.#preferences.save(this.#preferences.value);
      } catch {
        // The window is already hidden; do not interrupt live translation.
      }
    }
    this.#publish({ type: "tray", action: "hidden", notice });
    return { prevented: true, notice };
  }

  showWindow() {
    if (!this.#window || this.#window.isDestroyed()) return;
    this.#window.show();
    this.#window.focus();
  }

  toggleWindow() {
    if (!this.#window || this.#window.isDestroyed()) return;
    if (this.#window.isVisible()) this.#window.hide();
    else this.showWindow();
  }

  async dispose() {
    this.#tray?.destroy();
  }

  #render() {
    if (!this.#tray) return;
    const mode = modeLabel(this.#mode);
    const state = localizedRunState(this.#appState);
    this.#tray.setToolTip(`TransLive · ${mode} · ${state}`);
    this.#tray.setContextMenu(this.#Menu.buildFromTemplate(this.#menuTemplate()));
  }

  #menuTemplate() {
    const active = ["live", "degraded"].includes(this.#appState);
    const template = [
      { label: `TransLive · ${modeLabel(this.#mode)} · ${localizedRunState(this.#appState)}`, enabled: false },
      { type: "separator" },
      { label: "顯示 TransLive", click: () => this.showWindow() },
    ];
    for (const direction of activeDirections(this.#status)) {
      const status = this.#status[direction];
      if (!["live", "muted"].includes(status)) continue;
      const label = direction === "tx" ? "TX" : "RX";
      template.push({
        label: `${label} ${status === "muted" ? "取消靜音" : "靜音"}`,
        click: () => this.#toggleMute(direction, status !== "muted"),
      });
    }
    if (active) {
      template.push({
        label: "停止翻譯",
        click: () => this.#stop(),
      });
    }
    template.push(
      { label: "開啟診斷", click: () => this.#publish({ type: "tray", action: "diagnostics" }) },
      { type: "separator" },
      {
        label: "完全結束",
        click: () => this.#app.quit(),
      },
    );
    return template;
  }

  async #toggleMute(direction, muted) {
    await this.#controller.setMuted(direction, muted);
    this.#status = this.#controller.status();
    this.#publish({ type: "tray", action: "mute", direction, muted });
    this.#render();
  }

  async #stop() {
    await this.#controller.stop("tray-stop");
    this.#status = this.#controller.status();
    this.#appState = "stopped";
    this.#publish({ type: "tray", action: "stopped" });
    this.#render();
  }
}
