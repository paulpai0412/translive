import assert from "node:assert/strict";
import test from "node:test";

import { TranslationLifecycle } from "./translation-lifecycle.js";

test("tray mute waits for local renderer mute before updating the main session", async () => {
  const calls = [];
  const lifecycle = new TranslationLifecycle({
    controller: {
      status: () => ({ tx: "live", rx: "live" }),
      async setMuted(direction, muted) {
        calls.push(`main:mute:${direction}:${muted}`);
        return { status: { tx: muted ? "muted" : "live", rx: "live" } };
      },
    },
    rendererControls: {
      async request(control) {
        calls.push(
          `renderer:${control.action}:${control.direction}:${control.muted}`,
        );
      },
    },
    restoreMeetingDevices: async () => ({ restored: true }),
  });

  await lifecycle.setMuted("tx", true);

  assert.deepEqual(calls, ["renderer:mute:tx:true", "main:mute:tx:true"]);
});

test("tray stop tears down renderer peers, main session, and meeting devices in order", async () => {
  const calls = [];
  const lifecycle = new TranslationLifecycle({
    controller: {
      status: () => ({ tx: "live", rx: "live" }),
      async stop(reason) {
        calls.push(`main:stop:${reason}`);
        return { status: { tx: "stopped", rx: "stopped" } };
      },
    },
    rendererControls: {
      async request(control) {
        calls.push(`renderer:${control.action}`);
      },
    },
    restoreMeetingDevices: async () => {
      calls.push("devices:restore");
      return { restored: true };
    },
  });

  const result = await lifecycle.stop("tray-stop");

  assert.deepEqual(calls, [
    "renderer:stop",
    "main:stop:tray-stop",
    "devices:restore",
  ]);
  assert.deepEqual(result.meetingRestore, { restored: true });
});

test("still stops main translation and restores devices when a renderer is already destroyed", async () => {
  const calls = [];
  const lifecycle = new TranslationLifecycle({
    controller: {
      status: () => ({ tx: "live", rx: "disabled" }),
      async stop(reason) {
        calls.push(`main:stop:${reason}`);
        return { status: { tx: "stopped", rx: "disabled" } };
      },
    },
    rendererControls: {
      async request() {
        throw new Error("renderer unavailable");
      },
    },
    restoreMeetingDevices: async () => {
      calls.push("devices:restore");
      return { restored: true };
    },
  });

  await lifecycle.stop("tray-stop");

  assert.deepEqual(calls, ["main:stop:tray-stop", "devices:restore"]);
});

test("live logout cancels pending OAuth before tearing down translation and invalidating ChatGPT", async () => {
  const calls = [];
  const lifecycle = new TranslationLifecycle({
    controller: {
      status: () => ({ tx: "disabled", rx: "live" }),
      async stop(reason) {
        calls.push(`main:stop:${reason}`);
        return { status: { tx: "disabled", rx: "stopped" } };
      },
    },
    rendererControls: {
      async request(control) {
        calls.push(`renderer:${control.action}`);
      },
    },
    restoreMeetingDevices: async () => {
      calls.push("devices:restore");
      return { restored: true };
    },
  });
  const account = {
    async cancelLogin() {
      calls.push("account:cancel-login");
    },
    async logout() {
      calls.push("account:logout");
      return { state: "logged-out" };
    },
  };

  const result = await lifecycle.logout(account);

  assert.deepEqual(calls, [
    "account:cancel-login",
    "renderer:logout",
    "main:stop:account-logout",
    "devices:restore",
    "account:logout",
  ]);
  assert.deepEqual(result, { state: "logged-out", cleanupWarning: false });
});

test("logout invalidates ChatGPT and emits a safe cleanup warning after persistence and device failures", async () => {
  const calls = [];
  const events = [];
  const lifecycle = new TranslationLifecycle({
    controller: {
      status: () => ({ tx: "live", rx: "disabled" }),
      async stop(reason) {
        calls.push(`main:stop:${reason}`);
        throw new Error("private transcript persistence path");
      },
    },
    publish: (event) => events.push(event),
    rendererControls: {
      async request(control) {
        calls.push(`renderer:${control.action}`);
      },
    },
    restoreMeetingDevices: async () => {
      calls.push("devices:restore");
      throw new Error("private device path");
    },
  });
  const account = {
    async cancelLogin() {
      calls.push("account:cancel-login");
    },
    async logout() {
      calls.push("account:logout");
      return { state: "logged-out" };
    },
  };

  const result = await lifecycle.logout(account);

  assert.deepEqual(calls, [
    "account:cancel-login",
    "renderer:logout",
    "main:stop:account-logout",
    "devices:restore",
    "account:logout",
  ]);
  assert.deepEqual(result, { state: "logged-out", cleanupWarning: true });
  assert.deepEqual(events, [
    {
      type: "cleanup",
      state: "warning",
      message: "已登出，但部分本機清理未完成。請開啟診斷確認。",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(events),
    /private transcript|private device/,
  );
});
