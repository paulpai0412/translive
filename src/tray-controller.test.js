import assert from "node:assert/strict";
import test from "node:test";

import { TrayController } from "./tray-controller.js";

function trayFixture({ status = { tx: "live", rx: "live" } } = {}) {
  const menuCalls = [];
  const tooltips = [];
  const events = new Map();
  const tray = {
    destroyed: false,
    setContextMenu: (menu) => menuCalls.push(menu),
    setToolTip: (tooltip) => tooltips.push(tooltip),
    on: (event, handler) => events.set(event, handler),
    destroy() {
      this.destroyed = true;
    },
  };
  const window = {
    shown: 0,
    hidden: 0,
    visible: true,
    isDestroyed: () => false,
    isVisible() {
      return this.visible;
    },
    show() {
      this.visible = true;
      this.shown += 1;
    },
    focus() {},
    hide() {
      this.visible = false;
      this.hidden += 1;
    },
  };
  const controller = {
    muted: [],
    stopped: 0,
    status: () => status,
    async setMuted(direction, muted) {
      this.muted.push({ direction, muted });
    },
    async stop() {
      this.stopped += 1;
    },
  };
  const preferences = {
    value: { closeBehavior: "tray", closeNoticeShown: false },
    async load() {
      return this.value;
    },
    async save(value) {
      this.value = value;
    },
  };
  const published = [];
  const fixture = {
    app: { quitCalls: 0, quit() { this.quitCalls += 1; } },
    controller,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false }),
      createEmpty: () => ({ isEmpty: () => false }),
    },
    preferences,
    publish: (event) => published.push(event),
    Tray: class {
      constructor() {
        return tray;
      }
    },
    tray,
    window,
    events,
    menuCalls,
    published,
    tooltips,
  };
  return fixture;
}

test("creates a Windows tray with mode-aware controls and localized tooltip", async () => {
  const fixture = trayFixture();
  const controller = new TrayController({
    ...fixture,
    iconPath: "mark.png",
    platform: "win32",
  });

  const result = await controller.initialize({
    appState: "live",
    mode: "meeting",
    status: { tx: "live", rx: "live" },
  });

  assert.deepEqual(result, { supported: true, closeBehavior: "tray" });
  assert.match(fixture.tooltips.at(-1), /雙向會議.*翻譯中/u);
  const labels = fixture.menuCalls.at(-1).template.map((item) => item.label);
  assert.ok(labels.includes("TX 靜音"));
  assert.ok(labels.includes("RX 靜音"));
  assert.ok(labels.includes("停止翻譯"));
  assert.ok(labels.includes("完全結束"));
});

test("hides to tray once with a notice and never stops a live translation", async () => {
  const fixture = trayFixture();
  const controller = new TrayController({
    ...fixture,
    iconPath: "mark.png",
    platform: "win32",
  });
  await controller.initialize({
    appState: "live",
    mode: "meeting",
    status: fixture.controller.status(),
  });

  const first = await controller.handleWindowClose();
  const second = await controller.handleWindowClose();

  assert.deepEqual(first, { prevented: true, notice: true });
  assert.deepEqual(second, { prevented: true, notice: false });
  assert.equal(fixture.window.hidden, 2);
  assert.equal(fixture.controller.stopped, 0);
  assert.deepEqual(fixture.published.at(-1), {
    type: "tray",
    action: "hidden",
    notice: false,
  });
});

test("still hides a live session when the first-use preference cannot be saved", async () => {
  const fixture = trayFixture();
  fixture.preferences.save = async () => {
    throw new Error("disk unavailable");
  };
  const controller = new TrayController({
    ...fixture,
    iconPath: "mark.png",
    platform: "win32",
  });
  await controller.initialize({
    appState: "live",
    mode: "meeting",
    status: fixture.controller.status(),
  });

  assert.deepEqual(await controller.handleWindowClose(), {
    prevented: true,
    notice: true,
  });
  assert.equal(fixture.controller.stopped, 0);
});

test("can rebind the tray to a recreated main window", async () => {
  const fixture = trayFixture();
  const controller = new TrayController({
    ...fixture,
    iconPath: "mark.png",
    platform: "win32",
  });
  await controller.initialize({
    appState: "ready",
    mode: "meeting",
    status: fixture.controller.status(),
  });
  const nextWindow = { ...fixture.window, shown: 0, visible: false };
  controller.setWindow(nextWindow);
  controller.showWindow();

  assert.equal(nextWindow.shown, 1);
  assert.equal(fixture.window.shown, 0);
});

test("exit preference lets Windows close the main window normally", async () => {
  const fixture = trayFixture();
  const controller = new TrayController({
    ...fixture,
    iconPath: "mark.png",
    platform: "win32",
  });
  await controller.initialize({
    appState: "ready",
    mode: "meeting",
    status: fixture.controller.status(),
  });
  await controller.setCloseBehavior("exit");

  assert.equal(controller.shouldHideOnClose(), false);
  assert.deepEqual(await controller.handleWindowClose(), {
    prevented: false,
    notice: false,
  });
  assert.equal(fixture.window.hidden, 0);
});

test("tray mute only exposes and controls active directions", async () => {
  const fixture = trayFixture({ status: { tx: "disabled", rx: "live" } });
  const controller = new TrayController({
    ...fixture,
    iconPath: "mark.png",
    platform: "win32",
  });
  await controller.initialize({
    appState: "live",
    mode: "media",
    status: fixture.controller.status(),
  });

  const menu = fixture.menuCalls.at(-1).template;
  assert.equal(menu.some((item) => item.label === "TX 靜音"), false);
  const rxMute = menu.find((item) => item.label === "RX 靜音");
  await rxMute.click();

  assert.deepEqual(fixture.controller.muted, [{ direction: "rx", muted: true }]);
});

test("non-Windows tray requests fail safely without constructing Electron tray", async () => {
  let trayConstructed = false;
  const controller = new TrayController({
    Menu: {},
    Tray: class {
      constructor() {
        trayConstructed = true;
      }
    },
    app: {},
    controller: { status: () => ({ tx: "stopped", rx: "stopped" }) },
    iconPath: "mark.png",
    platform: "linux",
  });

  assert.deepEqual(
    await controller.initialize({
      appState: "ready",
      mode: "meeting",
      status: { tx: "stopped", rx: "stopped" },
    }),
    { supported: false, closeBehavior: "exit" },
  );
  assert.deepEqual(await controller.handleWindowClose(), {
    prevented: false,
    notice: false,
  });
  assert.equal(trayConstructed, false);
});
