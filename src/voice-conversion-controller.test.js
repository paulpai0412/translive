import assert from "node:assert/strict";
import test from "node:test";

import { VoiceConversionController } from "./voice-conversion-controller.js";
import { RVC_PINNED_TRAINER_COMMIT } from "./voice-profile-store.js";

function profileStore({ state = "verified" } = {}) {
  const deleted = [];
  const profiles = [
    {
      consentVersion: 1,
      displayName: "本人音色",
      id: "vp_owned_voice",
      state,
    },
  ];
  return {
    deleted,
    async deleteProfile(id) {
      const index = profiles.findIndex((profile) => profile.id === id);
      if (index < 0) throw new Error("VOICE_PROFILE_NOT_FOUND");
      deleted.push(id);
      profiles.splice(index, 1);
      return { deleted: true };
    },
    async importProfile(request) {
      if (request.confirmedOwnAuthorizedVoice !== true) {
        throw new Error("VOICE_PROFILE_CONSENT_REQUIRED");
      }
      return profiles[0];
    },
    async listProfiles() {
      return profiles;
    },
    async sidecarDescriptor(id) {
      if (id !== profiles[0].id) throw new Error("VOICE_PROFILE_NOT_FOUND");
      return {
        id,
        modelPath: "C:\\private\\model.pth",
        trainer: {
          commit: RVC_PINNED_TRAINER_COMMIT,
          provenance: "rvc-local-trainer",
          weightsOnlyRequired: true,
        },
      };
    },
  };
}

const available = {
  hardware: { gpuName: "Intel Arc B390" },
  provider: "directml-candidate",
  state: "available",
};

test("defaults RVC off and returns only safe capability/profile status to the renderer", async () => {
  const controller = new VoiceConversionController({
    capabilityProbe: { probe: async () => available },
    profiles: profileStore(),
  });

  assert.deepEqual(await controller.initialize(), {
    enabled: false,
    profile: undefined,
    profiles: [
      {
        consentVersion: 1,
        displayName: "本人音色",
        id: "vp_owned_voice",
        state: "verified",
      },
    ],
    provider: "directml-candidate",
    state: "off",
  });
  assert.doesNotMatch(
    JSON.stringify(controller.status()),
    /private|model\.pth|hash|path/i,
  );
});

test("initialization treats independent probe and profile-store failures as raw-only unavailable", async () => {
  for (const [capabilityProbe, profiles, reason, profileCount] of [
    [
      { probe: async () => Promise.reject(new Error("probe failed")) },
      profileStore(),
      "capability-unavailable",
      1,
    ],
    [
      {
        probe: () => {
          throw new Error("sync probe failed");
        },
      },
      profileStore(),
      "capability-unavailable",
      1,
    ],
    [
      { probe: async () => available },
      { listProfiles: async () => Promise.reject(new Error("store denied")) },
      "profile-store-unavailable",
      0,
    ],
    [
      { probe: async () => available },
      {
        listProfiles: () => {
          throw new Error("sync store denied");
        },
      },
      "profile-store-unavailable",
      0,
    ],
  ]) {
    const controller = new VoiceConversionController({
      capabilityProbe,
      profiles,
    });

    const status = await controller.initialize();

    assert.equal(status.enabled, false);
    assert.equal(status.state, "unavailable");
    assert.equal(status.reason, reason);
    assert.equal(status.profiles.length, profileCount);
  }
});

test("refuses an unverified picker profile before asking for a sidecar descriptor", async () => {
  let descriptorRequested = false;
  const profiles = profileStore({ state: "unverified" });
  const controller = new VoiceConversionController({
    capabilityProbe: { probe: async () => available },
    profiles: {
      ...profiles,
      async sidecarDescriptor(id) {
        descriptorRequested = true;
        return profiles.sidecarDescriptor(id);
      },
    },
    sidecarFactory: async () => {
      throw new Error("must not create sidecar");
    },
  });
  await controller.initialize();

  const status = await controller.setEnabled({
    enabled: true,
    profileId: "vp_owned_voice",
  });

  assert.equal(status.enabled, false);
  assert.equal(status.reason, "profile-unverified");
  assert.equal(status.state, "unavailable");
  assert.equal(descriptorRequested, false);
});

test("refuses enable safely when the runtime sidecar has not passed its gate", async () => {
  const controller = new VoiceConversionController({
    capabilityProbe: { probe: async () => available },
    profiles: profileStore(),
  });
  await controller.initialize();

  assert.deepEqual(
    await controller.setEnabled({
      enabled: true,
      profileId: "vp_owned_voice",
    }),
    {
      enabled: false,
      profile: { displayName: "本人音色", id: "vp_owned_voice" },
      profiles: [
        {
          consentVersion: 1,
          displayName: "本人音色",
          id: "vp_owned_voice",
          state: "verified",
        },
      ],
      provider: "directml-candidate",
      reason: "runtime-unavailable",
      state: "unavailable",
    },
  );
});

test("allows a test-only local sidecar to reach ready, converting, and raw fallback without exposing its descriptor", async () => {
  const calls = [];
  const controller = new VoiceConversionController({
    capabilityProbe: { probe: async () => available },
    profiles: profileStore(),
    sidecarFactory: async ({ direction }) => ({
      async health() {
        calls.push(`${direction}:health`);
        return { ready: true };
      },
      async stop() {
        calls.push(`${direction}:stop`);
      },
      async warm({ profileId, provider }) {
        calls.push(`${direction}:warm:${profileId}:${provider}`);
        return { ready: true };
      },
    }),
  });
  await controller.initialize();

  const ready = await controller.setEnabled({
    enabled: true,
    profileId: "vp_owned_voice",
  });
  assert.equal(ready.state, "ready");
  assert.equal(ready.enabled, true);
  assert.equal(ready.profile.displayName, "本人音色");
  assert.doesNotMatch(JSON.stringify(ready), /private|model\.pth/);

  assert.equal((await controller.startDirection("rx")).state, "converting");
  assert.equal((await controller.startDirection("tx")).state, "converting");
  assert.equal(
    controller.rawFallback("rx", "deadline-miss").state,
    "raw-fallback",
  );
  assert.deepEqual(calls, [
    "rx:warm:vp_owned_voice:directml-candidate",
    "rx:health",
    "tx:warm:vp_owned_voice:directml-candidate",
    "tx:health",
  ]);
  assert.equal((await controller.setEnabled({ enabled: false })).state, "off");
  assert.deepEqual(calls.slice(-2).sort(), ["rx:stop", "tx:stop"]);
});

test("deleting a selected profile stops local sidecars and revokes the safe selection", async () => {
  const calls = [];
  const profiles = profileStore();
  const controller = new VoiceConversionController({
    capabilityProbe: { probe: async () => available },
    profiles,
    sidecarFactory: async () => ({
      async health() {
        return { ready: true };
      },
      async stop() {
        calls.push("stop");
      },
      async warm() {
        return { ready: true };
      },
    }),
  });
  await controller.initialize();
  await controller.setEnabled({ enabled: true, profileId: "vp_owned_voice" });
  await controller.startDirection("rx");

  const status = await controller.deleteProfile("vp_owned_voice");

  assert.deepEqual(profiles.deleted, ["vp_owned_voice"]);
  assert.deepEqual(calls, ["stop"]);
  assert.deepEqual(status, {
    enabled: false,
    profile: undefined,
    profiles: [],
    provider: "directml-candidate",
    state: "off",
  });
});

test("stops an unhealthy test sidecar before returning raw-only unavailable state", async () => {
  const calls = [];
  const controller = new VoiceConversionController({
    capabilityProbe: { probe: async () => available },
    profiles: profileStore(),
    sidecarFactory: async () => ({
      async health() {
        calls.push("health");
        return { ready: false };
      },
      async stop() {
        calls.push("stop");
      },
      async warm() {
        calls.push("warm");
        return { ready: true };
      },
    }),
  });
  await controller.initialize();
  await controller.setEnabled({ enabled: true, profileId: "vp_owned_voice" });

  const status = await controller.startDirection("rx");
  assert.equal(status.enabled, false);
  assert.equal(status.reason, "runtime-unavailable");
  assert.equal(status.state, "unavailable");
  assert.deepEqual(calls, ["warm", "health", "stop"]);
});

test("contains sidecar factory, warm, health, frame, and stop failures in raw-only status", async () => {
  const failureCases = [
    {
      expectedReason: "runtime-unavailable",
      name: "factory",
      sidecarFactory: async () => {
        throw new Error("factory failure");
      },
      start: true,
    },
    {
      expectedReason: "runtime-unavailable",
      name: "warm",
      sidecarFactory: async () => ({
        async health() {
          return { ready: true };
        },
        async stop() {},
        async warm() {
          throw new Error("warm failure");
        },
      }),
      start: true,
    },
    {
      expectedReason: "runtime-unavailable",
      name: "health",
      sidecarFactory: async () => ({
        async health() {
          throw new Error("health failure");
        },
        async stop() {},
        async warm() {
          return { ready: true };
        },
      }),
      start: true,
    },
    {
      expectedReason: "sidecar-failure",
      name: "frame",
      sidecarFactory: async () => ({
        async frame() {
          throw new Error("frame failure");
        },
        async health() {
          return { ready: true };
        },
        async stop() {},
        async warm() {
          return { ready: true };
        },
      }),
      start: false,
    },
    {
      expectedReason: "sidecar-failure",
      name: "malformed-frame",
      sidecarFactory: async () => ({
        async frame() {
          return undefined;
        },
        async health() {
          return { ready: true };
        },
        async stop() {},
        async warm() {
          return { ready: true };
        },
      }),
      start: false,
    },
  ];
  for (const failureCase of failureCases) {
    const controller = new VoiceConversionController({
      capabilityProbe: { probe: async () => available },
      profiles: profileStore(),
      sidecarFactory: failureCase.sidecarFactory,
    });
    await controller.initialize();
    await controller.setEnabled({ enabled: true, profileId: "vp_owned_voice" });

    const result = failureCase.start
      ? await controller.startDirection("rx")
      : await (async () => {
          await controller.startDirection("rx");
          return controller.convertFrame("rx", { seq: 0 });
        })();

    assert.equal(
      result.enabled ?? result.status?.enabled,
      false,
      failureCase.name,
    );
    assert.equal(
      result.reason ?? result.status?.reason,
      failureCase.expectedReason,
      failureCase.name,
    );
    assert.equal(
      result.state ?? result.status?.state,
      "unavailable",
      failureCase.name,
    );
  }

  const stopController = new VoiceConversionController({
    capabilityProbe: { probe: async () => available },
    profiles: profileStore(),
    sidecarFactory: async () => ({
      async health() {
        return { ready: true };
      },
      async stop() {
        throw new Error("stop failure");
      },
      async warm() {
        return { ready: true };
      },
    }),
  });
  await stopController.initialize();
  await stopController.setEnabled({
    enabled: true,
    profileId: "vp_owned_voice",
  });
  await stopController.startDirection("rx");
  const stopped = await stopController.setEnabled({ enabled: false });
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.reason, "sidecar-stop-failed");
  assert.equal(stopped.state, "unavailable");
});

test("stops existing sidecars before an invalid re-enable and on app disposal", async () => {
  const calls = [];
  const controller = new VoiceConversionController({
    capabilityProbe: { probe: async () => available },
    profiles: profileStore(),
    sidecarFactory: async () => ({
      async health() {
        return { ready: true };
      },
      async stop() {
        calls.push("stop");
      },
      async warm() {
        return { ready: true };
      },
    }),
  });
  await controller.initialize();
  await controller.setEnabled({ enabled: true, profileId: "vp_owned_voice" });
  await controller.startDirection("rx");

  const invalid = await controller.setEnabled({
    enabled: true,
    profileId: "missing-profile",
  });
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.reason, "profile-required");
  assert.deepEqual(calls, ["stop"]);

  await controller.setEnabled({ enabled: true, profileId: "vp_owned_voice" });
  await controller.startDirection("rx");
  await controller.dispose();
  assert.deepEqual(calls, ["stop", "stop"]);
  assert.equal(controller.status().enabled, false);
});

test("rejects an unavailable capability and unconsented import request without turning conversion on", async () => {
  const controller = new VoiceConversionController({
    capabilityProbe: {
      probe: async () => ({
        hardware: {},
        provider: "unavailable",
        state: "unavailable",
      }),
    },
    profiles: profileStore(),
  });
  await controller.initialize();

  assert.equal((await controller.setEnabled({ enabled: true })).enabled, false);
  await assert.rejects(
    controller.importProfile({ confirmedOwnAuthorizedVoice: false }),
    /VOICE_PROFILE_CONSENT_REQUIRED/,
  );
});
