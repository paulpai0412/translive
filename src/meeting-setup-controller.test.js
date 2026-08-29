import assert from "node:assert/strict";
import test from "node:test";

import { MeetingSetupController } from "./meeting-setup-controller.js";

function fixture(overrides = {}) {
  const calls = [];
  const store = {
    value: undefined,
    async clear() {
      calls.push("clear");
      this.value = undefined;
    },
    async load() {
      calls.push("load");
      return this.value;
    },
    async save(value) {
      calls.push({ save: value });
      this.value = value;
    },
  };
  const adapter = {
    async detect(app) {
      calls.push({ detect: app });
      return { installed: true, running: true, supported: true };
    },
    async resolve(names) {
      calls.push({ resolve: names });
      return {
        captureId: "native-virtual-mic",
        renderId: "native-virtual-speaker",
      };
    },
    async snapshot() {
      calls.push("snapshot");
      return { captureId: "previous-mic", renderId: "previous-speaker" };
    },
    async apply(endpoints) {
      calls.push({ apply: endpoints });
    },
    async current() {
      calls.push("current");
      return {
        captureId: "native-virtual-mic",
        renderId: "native-virtual-speaker",
      };
    },
    async restore(snapshot) {
      calls.push({ restore: snapshot });
    },
    async openSettings(app) {
      calls.push({ openSettings: app });
    },
    ...overrides,
  };
  return { adapter, calls, store };
}

const endpoints = {
  microphone: { id: "virtual-mic", name: "Voicemeeter Out B2" },
  speaker: { id: "virtual-speaker", name: "Voicemeeter Input" },
};

test("resolves browser display names to native IDs before changing Windows defaults", async () => {
  const { adapter, calls, store } = fixture({
    async resolve(names) {
      calls.push({ resolve: names });
      return {
        captureId: "native-virtual-mic",
        renderId: "native-virtual-speaker",
      };
    },
  });
  const controller = new MeetingSetupController({
    adapter,
    platform: "win32",
    store,
  });

  await controller.apply({
    app: "teams",
    endpoints: {
      microphone: {
        id: "browser-media-device-id-should-not-reach-windows",
        name: "Voicemeeter Out B2",
      },
      speaker: {
        id: "browser-render-device-id-should-not-reach-windows",
        name: "Voicemeeter Input",
      },
    },
    restoreOnStop: true,
  });

  assert.deepEqual(calls, [
    { detect: "teams" },
    {
      resolve: {
        captureName: "Voicemeeter Out B2",
        renderName: "Voicemeeter Input",
      },
    },
    "snapshot",
    {
      save: {
        app: "teams",
        snapshot: { captureId: "previous-mic", renderId: "previous-speaker" },
      },
    },
    {
      apply: {
        captureId: "native-virtual-mic",
        renderId: "native-virtual-speaker",
      },
    },
    "current",
  ]);
  assert.equal(
    JSON.stringify(calls).includes("browser-media-device-id"),
    false,
  );
  assert.equal(
    JSON.stringify(calls).includes("browser-render-device-id"),
    false,
  );
});

test("snapshots, applies, verifies, and restores Windows communication devices", async () => {
  const { adapter, calls, store } = fixture();
  const controller = new MeetingSetupController({
    adapter,
    platform: "win32",
    store,
  });

  const applied = await controller.apply({
    app: "teams",
    endpoints,
    restoreOnStop: true,
  });

  assert.deepEqual(applied, {
    app: "teams",
    meetingAppUsage: "unverified",
    microphoneName: "Voicemeeter Out B2",
    speakerName: "Voicemeeter Input",
    state: "windows-defaults-updated",
    verification: "communication-defaults-updated",
  });
  assert.deepEqual(calls, [
    { detect: "teams" },
    {
      resolve: {
        captureName: "Voicemeeter Out B2",
        renderName: "Voicemeeter Input",
      },
    },
    "snapshot",
    {
      save: {
        app: "teams",
        snapshot: { captureId: "previous-mic", renderId: "previous-speaker" },
      },
    },
    {
      apply: {
        captureId: "native-virtual-mic",
        renderId: "native-virtual-speaker",
      },
    },
    "current",
  ]);

  const restored = await controller.restore();
  assert.deepEqual(restored, { restored: true });
  assert.deepEqual(calls.at(-2), {
    restore: { captureId: "previous-mic", renderId: "previous-speaker" },
  });
  assert.equal(store.value, undefined);
});

test("restores and clears the snapshot when Windows refuses to apply endpoints", async () => {
  const { adapter, calls, store } = fixture({
    async apply() {
      calls.push("apply-failed");
      throw new Error("policy unavailable");
    },
  });
  const controller = new MeetingSetupController({
    adapter,
    platform: "win32",
    store,
  });

  const result = await controller.apply({
    app: "teams",
    endpoints,
    restoreOnStop: true,
  });

  assert.equal(result.state, "needs-manual-confirmation");
  assert.equal(result.reason, "apply-failed");
  assert.ok(calls.some((call) => call.restore));
  assert.equal(store.value, undefined);
});

test("surfaces a restore failure and keeps the snapshot for the next Windows start", async () => {
  const { adapter, calls, store } = fixture({
    async restore(snapshot) {
      calls.push({ restore: snapshot });
      throw new Error("Windows policy rejected restore");
    },
  });
  store.value = {
    app: "teams",
    snapshot: { captureId: "previous-mic", renderId: "previous-speaker" },
  };
  const controller = new MeetingSetupController({
    adapter,
    platform: "win32",
    store,
  });

  const result = await controller.restore();

  assert.deepEqual(result, { restored: false, reason: "restore-failed" });
  assert.deepEqual(store.value, {
    app: "teams",
    snapshot: { captureId: "previous-mic", renderId: "previous-speaker" },
  });
  assert.ok(calls.some((call) => call.restore));
});

test("does not retain a stale restore snapshot when the user opts out of restore", async () => {
  const { adapter, calls, store } = fixture();
  store.value = {
    app: "teams",
    snapshot: { captureId: "older-mic", renderId: "older-speaker" },
  };
  const controller = new MeetingSetupController({
    adapter,
    platform: "win32",
    store,
  });

  await controller.apply({ app: "zoom", endpoints, restoreOnStop: false });

  assert.equal(store.value, undefined);
  assert.ok(calls.includes("clear"));
});

test("restores immediately and falls back to manual setup when verification fails", async () => {
  const { adapter, calls, store } = fixture({
    async current() {
      return { captureId: "wrong-mic", renderId: "wrong-speaker" };
    },
  });
  const controller = new MeetingSetupController({
    adapter,
    platform: "win32",
    store,
  });

  const result = await controller.apply({
    app: "zoom",
    endpoints,
    restoreOnStop: true,
  });

  assert.deepEqual(result, {
    app: "zoom",
    meetingAppUsage: "unverified",
    microphoneName: "Voicemeeter Out B2",
    reason: "verification-failed",
    speakerName: "Voicemeeter Input",
    state: "needs-manual-confirmation",
    verification: "not-verified",
  });
  assert.ok(calls.some((call) => call.restore));
  assert.equal(store.value, undefined);
});

test("does not change devices outside Windows and opens a manual fallback safely", async () => {
  const { adapter, calls, store } = fixture();
  const controller = new MeetingSetupController({
    adapter,
    platform: "linux",
    store,
  });

  const result = await controller.apply({
    app: "teams",
    endpoints,
    restoreOnStop: true,
  });
  assert.deepEqual(result, {
    app: "teams",
    meetingAppUsage: "unverified",
    microphoneName: "Voicemeeter Out B2",
    reason: "windows-only",
    speakerName: "Voicemeeter Input",
    state: "needs-manual-confirmation",
    verification: "not-verified",
  });
  assert.deepEqual(calls, []);

  await controller.openManualSettings("teams");
  assert.deepEqual(calls, [{ openSettings: "teams" }]);
  assert.deepEqual(await controller.restore(), { restored: false });
  assert.deepEqual(calls, [{ openSettings: "teams" }]);
});

test("requires manual confirmation when the selected meeting app is not running", async () => {
  const { adapter, calls, store } = fixture({
    async detect(app) {
      calls.push({ detect: app });
      return { installed: true, running: false, supported: true };
    },
  });
  const controller = new MeetingSetupController({
    adapter,
    platform: "win32",
    store,
  });

  const result = await controller.apply({
    app: "teams",
    endpoints,
    restoreOnStop: true,
  });
  assert.equal(result.state, "needs-manual-confirmation");
  assert.equal(result.meetingAppUsage, "unverified");
  assert.equal(result.verification, "not-verified");
  assert.equal(result.reason, "app-not-running");
  assert.deepEqual(calls, [{ detect: "teams" }]);
});
