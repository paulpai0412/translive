import assert from "node:assert/strict";
import test from "node:test";

import { MeetingSetupController } from "./meeting-setup-controller.js";
import {
  GLOBAL_AUDIO_TARGETS,
  WindowsAudioDefaultsController,
} from "./windows-audio-defaults-controller.js";

const physicalSnapshot = {
  capture: {
    consoleId: "physical-capture-console",
    multimediaId: "physical-capture-multimedia",
    communicationsId: "physical-capture-communications",
  },
  render: {
    consoleId: "physical-render-console",
    multimediaId: "physical-render-multimedia",
    communicationsId: "physical-render-communications",
  },
};

const virtualTarget = {
  captureId: "voicemeeter-b2",
  renderId: "voicemeeter-input",
};

const virtualSnapshot = {
  capture: {
    consoleId: virtualTarget.captureId,
    multimediaId: virtualTarget.captureId,
    communicationsId: virtualTarget.captureId,
  },
  render: {
    consoleId: virtualTarget.renderId,
    multimediaId: virtualTarget.renderId,
    communicationsId: virtualTarget.renderId,
  },
};

const activeCheckpoint = {
  phase: "active",
  snapshot: physicalSnapshot,
  target: virtualTarget,
};

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function memoryStore(value, { clearError } = {}) {
  const calls = [];
  return {
    calls,
    value,
    async clear() {
      calls.push("clear");
      if (clearError) throw clearError;
      this.value = undefined;
    },
    async load() {
      calls.push("load");
      return this.value;
    },
    async save(next) {
      calls.push({ save: next });
      this.value = next;
    },
  };
}

function fixture({
  globalStoreValue,
  initialCurrent = physicalSnapshot,
  storeOptions,
  overrides = {},
} = {}) {
  const calls = [];
  const store = memoryStore(globalStoreValue, storeOptions);
  let current = initialCurrent;
  const adapter = {
    async resolve(names) {
      calls.push({ resolve: names });
      return virtualTarget;
    },
    async snapshotAllRoles() {
      calls.push("snapshot-all-roles");
      return current;
    },
    async currentAllRoles() {
      calls.push("current-all-roles");
      return current;
    },
    async applyAllRoles(endpoints) {
      calls.push({ applyAllRoles: endpoints });
      current = virtualSnapshot;
    },
    async restoreAllRoles(snapshot) {
      calls.push({ restoreAllRoles: snapshot });
      current = snapshot;
    },
    ...overrides,
  };
  return {
    adapter,
    calls,
    current: () => current,
    setCurrent: (next) => {
      current = next;
    },
    store,
  };
}

function controllerFor({ adapter, store }) {
  return new WindowsAudioDefaultsController({
    adapter,
    platform: "win32",
    store,
  });
}

test("records original roles, virtual target, and active phase before global routing", async () => {
  const { adapter, calls, store } = fixture();
  const controller = controllerFor({ adapter, store });

  assert.deepEqual(await controller.start(), { state: "active" });
  assert.deepEqual(controller.status(), { state: "active" });
  assert.deepEqual(calls, [
    { resolve: GLOBAL_AUDIO_TARGETS },
    "snapshot-all-roles",
    { applyAllRoles: virtualTarget },
    "current-all-roles",
  ]);
  assert.deepEqual(store.value, activeCheckpoint);
});

test("serializes exit restoration behind an in-flight global routing start", async () => {
  const applyStarted = deferred();
  const releaseApply = deferred();
  const { adapter, current, setCurrent, store } = fixture();
  adapter.applyAllRoles = async () => {
    applyStarted.resolve();
    await releaseApply.promise;
    setCurrent(virtualSnapshot);
  };
  const controller = controllerFor({ adapter, store });

  const starting = controller.start();
  await applyStarted.promise;
  const restoring = controller.restore();
  releaseApply.resolve();

  assert.deepEqual(await starting, { state: "active" });
  assert.deepEqual(await restoring, { restored: true });
  assert.deepEqual(current(), physicalSnapshot);
  assert.equal(store.value, undefined);
});

test("clears a completed prior restore without replaying original defaults", async () => {
  const { adapter, calls, store } = fixture({
    globalStoreValue: activeCheckpoint,
  });
  const controller = controllerFor({ adapter, store });

  assert.deepEqual(await controller.start(), { state: "active" });
  assert.equal(
    calls.some((call) => call.restoreAllRoles),
    false,
  );
  assert.deepEqual(store.value, activeCheckpoint);
});

test("leaves a user-changed or partial stale checkpoint untouched", async () => {
  const userChanged = {
    ...physicalSnapshot,
    render: { ...physicalSnapshot.render, consoleId: "user-render-console" },
  };
  const { adapter, calls, current, store } = fixture({
    globalStoreValue: activeCheckpoint,
    initialCurrent: userChanged,
  });
  const controller = controllerFor({ adapter, store });

  assert.deepEqual(await controller.start(), { state: "recovery-needed" });
  assert.deepEqual(current(), userChanged);
  assert.deepEqual(calls, ["current-all-roles"]);
  assert.deepEqual(store.value, activeCheckpoint);
});

test("does not overwrite a user device change after OS restore succeeded but checkpoint clear failed", async () => {
  const { adapter, calls, current, setCurrent, store } = fixture({
    storeOptions: { clearError: new Error("disk full") },
  });
  const controller = controllerFor({ adapter, store });

  await controller.start();
  assert.deepEqual(await controller.restore(), {
    restored: true,
    reason: "checkpoint-clear-failed",
  });
  assert.deepEqual(current(), physicalSnapshot);
  assert.deepEqual(store.value, activeCheckpoint);

  const userChanged = {
    ...physicalSnapshot,
    capture: { ...physicalSnapshot.capture, consoleId: "user-mic-console" },
  };
  setCurrent(userChanged);
  assert.deepEqual(await controller.start(), { state: "recovery-needed" });
  assert.deepEqual(current(), userChanged);
  assert.equal(calls.filter((call) => call.restoreAllRoles).length, 1);
});

test("restores an interrupted applying checkpoint before taking a new physical snapshot", async () => {
  const { adapter, calls, store } = fixture({
    globalStoreValue: { ...activeCheckpoint, phase: "applying" },
    initialCurrent: virtualSnapshot,
  });
  const controller = controllerFor({ adapter, store });

  assert.deepEqual(await controller.start(), { state: "active" });
  assert.ok(
    calls.findIndex((call) => call.restoreAllRoles) <
      calls.findIndex((call) => call === "snapshot-all-roles"),
  );
  assert.deepEqual(
    calls.find((call) => call.restoreAllRoles),
    { restoreAllRoles: physicalSnapshot },
  );
  assert.deepEqual(store.value, activeCheckpoint);
});

test("leaves Windows unchanged when VoiceMeeter target endpoints are unavailable", async () => {
  const { adapter, calls, store } = fixture({
    overrides: {
      async resolve(names) {
        calls.push({ resolve: names });
        throw new Error("endpoint missing");
      },
    },
  });
  const controller = controllerFor({ adapter, store });

  assert.deepEqual(await controller.start(), { state: "target-unavailable" });
  assert.deepEqual(calls, [{ resolve: GLOBAL_AUDIO_TARGETS }]);
  assert.equal(store.value, undefined);
});

test("keeps the startup checkpoint when restoration fails so the next start can retry", async () => {
  const { adapter, calls, store } = fixture({
    globalStoreValue: activeCheckpoint,
    initialCurrent: virtualSnapshot,
    overrides: {
      async restoreAllRoles(snapshot) {
        calls.push({ restoreAllRoles: snapshot });
        throw new Error("policy rejected restore");
      },
    },
  });
  const controller = controllerFor({ adapter, store });

  assert.deepEqual(await controller.start(), { state: "restore-failed" });
  assert.deepEqual(store.value, activeCheckpoint);
  assert.equal(
    calls.some((call) => call === "snapshot-all-roles"),
    false,
  );
});

test("quick setup stop returns to global virtual defaults before full exit restores physical defaults", async () => {
  const globalStore = memoryStore();
  const meetingStore = memoryStore();
  let current = physicalSnapshot;
  const calls = [];
  const adapter = {
    async detect() {
      return { installed: true, running: true, supported: true };
    },
    async resolve() {
      return virtualTarget;
    },
    async snapshotAllRoles() {
      return current;
    },
    async currentAllRoles() {
      return current;
    },
    async applyAllRoles() {
      calls.push("apply-global");
      current = virtualSnapshot;
    },
    async restoreAllRoles(snapshot) {
      calls.push({ restoreGlobal: snapshot });
      current = snapshot;
    },
    async snapshot() {
      return {
        captureId: current.capture.communicationsId,
        renderId: current.render.communicationsId,
      };
    },
    async apply({ captureId, renderId }) {
      calls.push({ applyMeeting: { captureId, renderId } });
      current = {
        ...current,
        capture: { ...current.capture, communicationsId: captureId },
        render: { ...current.render, communicationsId: renderId },
      };
    },
    async current() {
      return {
        captureId: current.capture.communicationsId,
        renderId: current.render.communicationsId,
      };
    },
    async restore({ captureId, renderId }) {
      calls.push({ restoreMeeting: { captureId, renderId } });
      current = {
        ...current,
        capture: { ...current.capture, communicationsId: captureId },
        render: { ...current.render, communicationsId: renderId },
      };
    },
  };
  const global = controllerFor({ adapter, store: globalStore });
  const meeting = new MeetingSetupController({
    adapter,
    platform: "win32",
    store: meetingStore,
  });

  await global.start();
  await meeting.apply({
    app: "teams",
    endpoints: {
      microphone: { name: "Voicemeeter Out B2" },
      speaker: { name: "Voicemeeter Input" },
    },
  });
  await meeting.restore();

  assert.deepEqual(
    calls.find((call) => call.restoreMeeting),
    {
      restoreMeeting: {
        captureId: "voicemeeter-b2",
        renderId: "voicemeeter-input",
      },
    },
  );
  assert.equal(current.capture.communicationsId, "voicemeeter-b2");
  assert.equal(current.render.communicationsId, "voicemeeter-input");

  await global.restore();
  assert.deepEqual(calls.at(-1), { restoreGlobal: physicalSnapshot });
  assert.deepEqual(current, physicalSnapshot);
});
