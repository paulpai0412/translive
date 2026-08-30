import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  RVC_PINNED_TRAINER_COMMIT,
  VOICE_PROFILE_CONSENT_VERSION,
  VoiceProfileStore,
} from "./voice-profile-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "translive-voice-profile-"));
  const source = join(root, "source");
  const profiles = join(root, "profiles");
  await mkdir(source);
  const model = join(source, "owned-model.pth");
  const index = join(source, "owned-model.index");
  await writeFile(model, "owned local RVC model bytes");
  await writeFile(index, "owned local RVC index bytes");
  return {
    index,
    model,
    profiles,
    store: new VoiceProfileStore({
      directory: profiles,
      now: () => 1_710_000_000_000,
      newId: () => "vp_own_voice_001",
    }),
  };
}

test("keeps picker-imported RVC artifacts unverified and unavailable to a sidecar", async () => {
  const { index, model, profiles, store } = await fixture();

  const profile = await store.importProfile({
    confirmedOwnAuthorizedVoice: true,
    displayName: "我的正式音色",
    indexSourcePath: index,
    modelSourcePath: model,
  });

  assert.deepEqual(profile, {
    consentVersion: VOICE_PROFILE_CONSENT_VERSION,
    displayName: "我的正式音色",
    id: "vp_own_voice_001",
    state: "unverified",
  });
  assert.deepEqual(await store.listProfiles(), [profile]);
  const publicJson = JSON.stringify(await store.listProfiles());
  assert.doesNotMatch(publicJson, /source|\.pth|\.index|hash|model|embedding/i);
  await assert.rejects(
    store.sidecarDescriptor(profile.id),
    /VOICE_PROFILE_UNVERIFIED/,
  );

  const manifest = await readFile(
    join(profiles, profile.id, "manifest.json"),
    "utf8",
  );
  assert.doesNotMatch(
    manifest,
    /rvc-local-trainer|81eed5e8|weightsOnlyRequired/,
  );
  assert.equal(
    await readFile(join(profiles, profile.id, "model.pth"), "utf8"),
    "owned local RVC model bytes",
  );
});

test("rejects unconsented, network, device, executable, and traversal profile inputs without revealing paths", async () => {
  const { model, store } = await fixture();
  const attempts = [
    {
      confirmedOwnAuthorizedVoice: false,
      displayName: "未同意",
      modelSourcePath: model,
    },
    {
      confirmedOwnAuthorizedVoice: true,
      displayName: "遠端",
      modelSourcePath: "https://example.test/voice.pth",
    },
    {
      confirmedOwnAuthorizedVoice: true,
      displayName: "網路",
      modelSourcePath: "//server/share/voice.pth",
    },
    {
      confirmedOwnAuthorizedVoice: true,
      displayName: "裝置",
      modelSourcePath: "\\\\.\\PIPE\\voice.pth",
    },
    {
      confirmedOwnAuthorizedVoice: true,
      displayName: "執行檔",
      modelSourcePath: "C:\\temp\\voice.exe",
    },
    {
      confirmedOwnAuthorizedVoice: true,
      displayName: "穿越",
      modelSourcePath: "../voice.pth",
    },
  ];

  for (const request of attempts) {
    await assert.rejects(store.importProfile(request), (error) => {
      assert.match(error.message, /^VOICE_PROFILE_/);
      assert.doesNotMatch(error.message, /example|temp|voice\.pth|\.exe|\.\./i);
      return true;
    });
  }
  for (const modelSourcePath of [
    "//server/share/voice.pth",
    "\\\\server\\share\\voice.pth",
    "\\\\.\\PIPE\\voice.pth",
  ]) {
    await assert.rejects(
      store.importProfile({
        confirmedOwnAuthorizedVoice: true,
        displayName: "不可信來源",
        modelSourcePath,
      }),
      /VOICE_PROFILE_INVALID_LOCAL_ARTIFACT/,
    );
  }
  assert.deepEqual(await store.listProfiles(), []);
});

test("uses an atomic profile deletion boundary and does not retain consent or model artifacts", async () => {
  const { model, store } = await fixture();
  const profile = await store.importProfile({
    confirmedOwnAuthorizedVoice: true,
    displayName: "刪除測試",
    modelSourcePath: model,
  });

  assert.deepEqual(await store.deleteProfile(profile.id), { deleted: true });
  assert.deepEqual(await store.listProfiles(), []);
  await assert.rejects(
    store.sidecarDescriptor(profile.id),
    /VOICE_PROFILE_NOT_FOUND/,
  );
});

test("fails closed before reading a tampered picker import", async () => {
  const { model, profiles, store } = await fixture();
  const profile = await store.importProfile({
    confirmedOwnAuthorizedVoice: true,
    displayName: "篡改檢查",
    modelSourcePath: model,
  });
  await writeFile(join(profiles, profile.id, "model.pth"), "tampered bytes");

  await assert.rejects(store.sidecarDescriptor(profile.id), (error) => {
    assert.equal(error.message, "VOICE_PROFILE_UNVERIFIED");
    assert.doesNotMatch(error.message, /profiles|model\.pth/i);
    return true;
  });
  assert.deepEqual(await store.listProfiles(), [profile]);
});

test("downgrades a legacy picker import to unverified so it remains revocable", async () => {
  const { model, profiles, store } = await fixture();
  const profile = await store.importProfile({
    confirmedOwnAuthorizedVoice: true,
    displayName: "舊版匯入",
    modelSourcePath: model,
  });
  const manifestPath = join(profiles, profile.id, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.provenance;
  delete manifest.state;
  manifest.trainer = {
    commit: RVC_PINNED_TRAINER_COMMIT,
    provenance: "rvc-local-trainer",
    weightsOnlyRequired: true,
  };
  await writeFile(manifestPath, JSON.stringify(manifest));

  assert.deepEqual(await store.listProfiles(), [
    { ...profile, state: "unverified" },
  ]);
  await assert.rejects(
    store.sidecarDescriptor(profile.id),
    /VOICE_PROFILE_UNVERIFIED/,
  );
  assert.deepEqual(await store.deleteProfile(profile.id), { deleted: true });
});

test("does not accept a locally forged verified manifest as trainer provenance", async () => {
  const { model, profiles, store } = await fixture();
  const profile = await store.importProfile({
    confirmedOwnAuthorizedVoice: true,
    displayName: "偽造驗證",
    modelSourcePath: model,
  });
  const manifestPath = join(profiles, profile.id, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.state = "verified";
  manifest.trainer = {
    commit: RVC_PINNED_TRAINER_COMMIT,
    provenance: "rvc-local-trainer",
    weightsOnlyRequired: true,
  };
  await writeFile(manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    store.sidecarDescriptor(profile.id),
    /VOICE_PROFILE_(?:NOT_FOUND|UNVERIFIED)/,
  );
});

test("does not let a picker request forge pinned trainer provenance", async () => {
  const { model, store } = await fixture();
  const profile = await store.importProfile({
    confirmedOwnAuthorizedVoice: true,
    displayName: "安全載入",
    modelSourcePath: model,
    trainer: {
      commit: RVC_PINNED_TRAINER_COMMIT,
      provenance: "rvc-local-trainer",
      weightsOnlyRequired: true,
    },
  });

  assert.equal(profile.state, "unverified");
  await assert.rejects(
    store.sidecarDescriptor(profile.id),
    /VOICE_PROFILE_UNVERIFIED/,
  );
});
