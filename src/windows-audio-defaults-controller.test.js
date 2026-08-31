import assert from "node:assert/strict";
import test from "node:test";

import { MeetingSetupController } from "./meeting-setup-controller.js";
import {
  GLOBAL_AUDIO_TARGETS,
  WindowsAudioDefaultsController,
  buildModeAudioTarget,
} from "./windows-audio-defaults-controller.js";

const original = {
  capture: {
    consoleId: "physical-mic-console",
    multimediaId: "physical-mic-media",
    communicationsId: "physical-mic-comms",
  },
  render: {
    consoleId: "physical-speaker-console",
    multimediaId: "physical-speaker-media",
    communicationsId: "physical-speaker-comms",
  },
};
const resolved = { captureId: "voicemeeter-b2", renderId: "voicemeeter-input" };

function memoryStore(value) {
  return {
    value,
    async clear() {
      this.value = undefined;
    },
    async load() {
      return this.value;
    },
    async save(next) {
      this.value = structuredClone(next);
    },
  };
}

function fixture({ checkpoint, current = original, overrides = {} } = {}) {
  const calls = [];
  let roles = structuredClone(current);
  const store = memoryStore(checkpoint);
  const adapter = {
    async resolve(names) {
      calls.push({ resolve: names });
      return resolved;
    },
    async snapshotAllRoles() {
      calls.push("snapshot");
      return structuredClone(roles);
    },
    async currentAllRoles() {
      calls.push("current");
      return structuredClone(roles);
    },
    async restoreAllRoles(next) {
      calls.push({ setRoles: next });
      roles = structuredClone(next);
    },
    ...overrides,
  };
  return {
    adapter,
    calls,
    current: () => roles,
    setCurrent: (next) => {
      roles = structuredClone(next);
    },
    controller: new WindowsAudioDefaultsController({
      adapter,
      platform: "win32",
      store,
    }),
    store,
  };
}

test("builds isolated mode targets without changing unrelated Windows roles", () => {
  assert.deepEqual(
    buildModeAudioTarget({ mode: "meeting", original, resolved }),
    {
      capture: { ...original.capture, communicationsId: resolved.captureId },
      render: { ...original.render, communicationsId: resolved.renderId },
    },
  );
  assert.deepEqual(
    buildModeAudioTarget({ mode: "media", original, resolved }),
    {
      capture: original.capture,
      render: {
        ...original.render,
        consoleId: resolved.renderId,
        multimediaId: resolved.renderId,
      },
    },
  );
  assert.deepEqual(
    buildModeAudioTarget({ mode: "microphone", original, resolved }),
    {
      capture: { ...original.capture, communicationsId: resolved.captureId },
      render: original.render,
    },
  );
});

test("app startup prepares a snapshot but leaves Windows roles untouched", async () => {
  const { calls, controller, current, store } = fixture();
  assert.deepEqual(await controller.prepare(), { state: "prepared" });
  assert.deepEqual(calls, [{ resolve: GLOBAL_AUDIO_TARGETS }, "snapshot"]);
  assert.deepEqual(current(), original);
  assert.equal(store.value, undefined);
});

test("preserves a user device change made after app startup", async () => {
  const { controller, current, setCurrent } = fixture();
  await controller.prepare();
  const changed = {
    ...original,
    render: { ...original.render, consoleId: "new-user-speaker" },
  };
  setCurrent(changed);
  await controller.applyMode("meeting");
  assert.equal(current().render.consoleId, "new-user-speaker");
  await controller.restore();
  assert.deepEqual(current(), changed);
});

test("canceling while only prepared leaves the next mode start usable", async () => {
  const { controller, current } = fixture();
  await controller.prepare();
  assert.deepEqual(await controller.restore(), { restored: false });
  assert.deepEqual(await controller.applyMode("meeting"), {
    mode: "meeting",
    state: "active",
  });
  assert.equal(current().capture.communicationsId, resolved.captureId);
});

test("Meeting changes only Communications and stop restores every original role", async () => {
  const { controller, current, store } = fixture();
  await controller.prepare();
  assert.deepEqual(await controller.applyMode("meeting"), {
    mode: "meeting",
    state: "active",
  });
  assert.deepEqual(current(), {
    capture: { ...original.capture, communicationsId: resolved.captureId },
    render: { ...original.render, communicationsId: resolved.renderId },
  });
  assert.equal(store.value.mode, "meeting");
  assert.deepEqual(await controller.restore(), { restored: true });
  assert.deepEqual(current(), original);
  assert.equal(store.value, undefined);
});

test("Media does not route microphone or Communications into the browser path", async () => {
  const { controller, current } = fixture();
  await controller.applyMode("media");
  assert.deepEqual(current().capture, original.capture);
  assert.equal(current().render.consoleId, resolved.renderId);
  assert.equal(current().render.multimediaId, resolved.renderId);
  assert.equal(
    current().render.communicationsId,
    original.render.communicationsId,
  );
});

test("Microphone changes only Communications capture", async () => {
  const { controller, current } = fixture();
  await controller.applyMode("microphone");
  assert.equal(current().capture.communicationsId, resolved.captureId);
  assert.equal(current().capture.consoleId, original.capture.consoleId);
  assert.deepEqual(current().render, original.render);
});

test("recovers an interrupted mode target before preparing a new run", async () => {
  const target = buildModeAudioTarget({ mode: "meeting", original, resolved });
  const checkpoint = {
    mode: "meeting",
    phase: "active",
    snapshot: original,
    target,
  };
  const { controller, current, store } = fixture({
    checkpoint,
    current: target,
  });
  assert.deepEqual(await controller.prepare(), { state: "prepared" });
  assert.deepEqual(current(), original);
  assert.equal(store.value, undefined);
});

test("does not overwrite Windows roles changed outside TransLive", async () => {
  const target = buildModeAudioTarget({ mode: "meeting", original, resolved });
  const changed = {
    ...target,
    render: { ...target.render, consoleId: "user-changed-speaker" },
  };
  const checkpoint = {
    mode: "meeting",
    phase: "active",
    snapshot: original,
    target,
  };
  const { controller, current, store } = fixture({
    checkpoint,
    current: changed,
  });
  assert.deepEqual(await controller.prepare(), { state: "recovery-needed" });
  assert.deepEqual(current(), changed);
  assert.ok(store.value);
});

test("Meeting quick setup restores to mode target before mode restore returns physical roles", async () => {
  const { adapter, controller, current } = fixture();
  const meetingStore = memoryStore();
  adapter.detect = async () => ({
    installed: true,
    running: true,
    supported: true,
  });
  adapter.snapshot = async () => ({
    captureId: current().capture.communicationsId,
    renderId: current().render.communicationsId,
  });
  adapter.current = adapter.snapshot;
  adapter.apply = async ({ captureId, renderId }) => {
    const roles = current();
    await adapter.restoreAllRoles({
      capture: { ...roles.capture, communicationsId: captureId },
      render: { ...roles.render, communicationsId: renderId },
    });
  };
  adapter.restore = adapter.apply;
  const meeting = new MeetingSetupController({
    adapter,
    platform: "win32",
    store: meetingStore,
  });

  await controller.applyMode("meeting");
  const modeTarget = structuredClone(current());
  await meeting.apply({
    app: "teams",
    endpoints: {
      microphone: { name: "Voicemeeter Out B2" },
      speaker: { name: "Voicemeeter Input" },
    },
  });
  await meeting.restore();
  assert.deepEqual(current(), modeTarget);
  await controller.restore();
  assert.deepEqual(current(), original);
});

test("serializes restore behind in-flight mode application", async () => {
  let release;
  const waiting = new Promise((resolve) => (release = resolve));
  const { adapter, controller, current, store } = fixture();
  const setRoles = adapter.restoreAllRoles;
  adapter.restoreAllRoles = async (roles) => {
    if (roles.capture.communicationsId === resolved.captureId) await waiting;
    return setRoles(roles);
  };
  const applying = controller.applyMode("meeting");
  await new Promise((resolve) => setImmediate(resolve));
  const restoring = controller.restore();
  release();
  await applying;
  assert.deepEqual(await restoring, { restored: true });
  assert.deepEqual(current(), original);
  assert.equal(store.value, undefined);
});
