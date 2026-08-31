import assert from "node:assert/strict";
import test from "node:test";

import {
  VOICEMEETER_ROUTE_TARGET,
  VoiceMeeterRoutingAdapter,
  VoiceMeeterRoutingController,
} from "./voicemeeter-routing.js";

const original = Object.fromEntries(
  Object.keys(VOICEMEETER_ROUTE_TARGET).map((key, index) => [key, index % 2]),
);

function memoryStore(value) {
  return {
    value,
    async clear() { this.value = undefined; },
    async load() { return this.value; },
    async save(next) { this.value = structuredClone(next); },
  };
}

test("snapshots and applies the isolated VAIO-B1 AUX-B2 route once", async () => {
  const calls = [];
  let current = original;
  const adapter = {
    async snapshot() { calls.push("snapshot"); return structuredClone(current); },
    async apply() { calls.push("apply"); current = structuredClone(VOICEMEETER_ROUTE_TARGET); },
    async restore(values) { calls.push({ restore: values }); current = structuredClone(values); },
  };
  const store = memoryStore();
  const controller = new VoiceMeeterRoutingController({ adapter, platform: "win32", store });

  assert.deepEqual(await controller.start(), { state: "active" });
  assert.deepEqual(calls, ["snapshot", "apply", "snapshot"]);
  assert.equal(store.value.phase, "active");
  assert.deepEqual(store.value.original, original);
  assert.deepEqual(await controller.start(), { state: "active" });
  assert.equal(calls.filter((call) => call === "apply").length, 1);
});

test("full exit restores the original VoiceMeeter bus state", async () => {
  let current = original;
  const store = memoryStore();
  const adapter = {
    async snapshot() { return structuredClone(current); },
    async apply() { current = structuredClone(VOICEMEETER_ROUTE_TARGET); },
    async restore(values) { current = structuredClone(values); },
  };
  const controller = new VoiceMeeterRoutingController({ adapter, platform: "win32", store });
  await controller.start();

  assert.deepEqual(await controller.restore(), { restored: true });
  assert.deepEqual(current, original);
  assert.equal(store.value, undefined);
});

test("recovers an interrupted active route before taking a new snapshot", async () => {
  let current = structuredClone(VOICEMEETER_ROUTE_TARGET);
  const calls = [];
  const store = memoryStore({
    phase: "active",
    original,
    target: VOICEMEETER_ROUTE_TARGET,
  });
  const adapter = {
    async snapshot() { calls.push("snapshot"); return structuredClone(current); },
    async apply() { calls.push("apply"); current = structuredClone(VOICEMEETER_ROUTE_TARGET); },
    async restore(values) { calls.push("restore"); current = structuredClone(values); },
  };
  const controller = new VoiceMeeterRoutingController({ adapter, platform: "win32", store });

  assert.deepEqual(await controller.start(), { state: "active" });
  assert.deepEqual(calls, [
    "snapshot",
    "restore",
    "snapshot",
    "snapshot",
    "apply",
    "snapshot",
  ]);
  assert.deepEqual(store.value.original, original);
});

test("leaves a user-changed stale route untouched and asks for recovery", async () => {
  const changed = { ...original, "Strip[3].A1": 1 };
  let applied = false;
  const store = memoryStore({ phase: "active", original, target: VOICEMEETER_ROUTE_TARGET });
  const controller = new VoiceMeeterRoutingController({
    platform: "win32",
    store,
    adapter: {
      async snapshot() { return changed; },
      async apply() { applied = true; },
      async restore() { applied = true; },
    },
  });

  assert.deepEqual(await controller.start(), { state: "recovery-needed" });
  assert.equal(applied, false);
  assert.ok(store.value);
});

test("adapter uses one fixed PowerShell script and base64 restore data", async () => {
  const calls = [];
  const adapter = new VoiceMeeterRoutingAdapter({
    platform: "win32",
    scriptPath: "C:\\app\\windows-voicemeeter-routing.ps1",
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ ok: true, values: original }) };
    },
  });

  assert.deepEqual(await adapter.snapshot(), original);
  await adapter.apply();
  await adapter.restore(original);
  assert.equal(calls.every((call) => call.command === "powershell.exe"), true);
  assert.equal(calls.every((call) => call.options.windowsHide === true), true);
  assert.equal(calls[2].args.includes("-ValuesBase64"), true);
  assert.doesNotMatch(calls[2].args.join(" "), /Strip\[3\]/);
});
