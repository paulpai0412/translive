import assert from "node:assert/strict";
import test from "node:test";

import {
  assessToneRoute,
  verifyVoiceMeeterRoute,
} from "./voicemeeter-route-health.js";

const devices = {
  inputs: [
    { deviceId: "b1", label: "Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)" },
    { deviceId: "b2", label: "Voicemeeter Out B2 (VB-Audio Voicemeeter VAIO)" },
  ],
  outputs: [
    { deviceId: "vaio", label: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" },
    { deviceId: "aux", label: "Voicemeeter AUX Input (VB-Audio Voicemeeter AUX VAIO)" },
  ],
};

test("accepts a tone only when the expected bus is present and reverse-bus leakage is bounded", () => {
  assert.deepEqual(
    assessToneRoute({ expectedDb: -28, leakageDb: -72 }),
    { ok: true },
  );
  assert.deepEqual(
    assessToneRoute({ expectedDb: -80, leakageDb: -90 }),
    { ok: false, reason: "expected-bus-silent" },
  );
  assert.deepEqual(
    assessToneRoute({ expectedDb: -28, leakageDb: -34 }),
    { ok: false, reason: "reverse-bus-leakage" },
  );
});

test("Meeting probes AUX to B2 and VAIO to B1 without exposing device IDs", async () => {
  const calls = [];
  const result = await verifyVoiceMeeterRoute({
    devices,
    mode: "meeting",
    probe: async (request) => {
      calls.push(request);
      return { expectedDb: -30, leakageDb: -75 };
    },
  });
  assert.deepEqual(calls, [
    { expectedInputId: "b2", leakageInputId: "b1", sinkId: "aux" },
    { expectedInputId: "b1", leakageInputId: "b2", sinkId: "vaio" },
  ]);
  assert.deepEqual(result, { ok: true, routes: ["tx", "rx"] });
  assert.doesNotMatch(JSON.stringify(result), /b1|b2|aux|vaio/);
});

test("mode probes only the route it uses and fails closed for missing devices or leakage", async () => {
  const mediaCalls = [];
  assert.deepEqual(
    await verifyVoiceMeeterRoute({
      devices,
      mode: "media",
      probe: async (request) => {
        mediaCalls.push(request);
        return { expectedDb: -25, leakageDb: -70 };
      },
    }),
    { ok: true, routes: ["rx"] },
  );
  assert.equal(mediaCalls[0].sinkId, "vaio");

  assert.deepEqual(
    await verifyVoiceMeeterRoute({
      devices,
      mode: "microphone",
      probe: async () => ({ expectedDb: -25, leakageDb: -26 }),
    }),
    { ok: false, reason: "tx-reverse-bus-leakage" },
  );
  await assert.rejects(
    verifyVoiceMeeterRoute({ devices: { inputs: [], outputs: [] }, mode: "meeting" }),
    /VOICEMEETER_ROUTE_HEALTH_DEVICES_MISSING/,
  );
});
