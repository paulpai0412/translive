import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  RVC_PINNED_TRAINER_COMMIT,
  VOICE_PROFILE_CONSENT_VERSION,
  VoiceProfileStore,
  copyNoFollow,
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
      copyArtifact: (source, destination) =>
        copyNoFollow(source, destination, {
          noFollow: 0,
          platform: "linux",
        }),
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

test("cleans abandoned profile staging and deletion tombstones on startup", async () => {
  const { profiles, store } = await fixture();
  await mkdir(profiles, { recursive: true });
  await mkdir(join(profiles, "vp_old.staging-test"));
  await mkdir(join(profiles, "vp_old.deleting-test"));

  assert.deepEqual(await store.recover(), { recovered: true });
  await assert.rejects(readFile(join(profiles, "vp_old.staging-test", "x")));
  await assert.rejects(readFile(join(profiles, "vp_old.deleting-test", "x")));
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

test("promotes only an independently verified profile from the local training root", async () => {
  const { profiles } = await fixture();
  const training = join(
    await mkdtemp(join(tmpdir(), "translive-voice-training-output-")),
    "vt_owned",
  );
  await mkdir(training);
  const model = join(training, "output.pth");
  await writeFile(model, "verified local model bytes");
  const verifierCalls = [];
  const store = new VoiceProfileStore({
    directory: profiles,
    newId: () => "vp_verified_001",
    now: () => 1_710_000_000_000,
    trainingDirectory: training.slice(0, -"/vt_owned".length),
    verifyTrainingOutput: async (request) => {
      verifierCalls.push(request);
      return {
        configLength: 18,
        schema: "rvc-checkpoint-v2",
        sha256: createHash("sha256")
          .update(await readFile(request.modelPath))
          .digest("hex"),
        tensorCount: 12,
      };
    },
  });

  const profile = await store.promoteVerifiedTraining({
    confirmedOwnAuthorizedVoice: true,
    displayName: "我訓練的音色",
    finalConsent: { confirmedAtMs: 1_710_000_000_000, version: 1 },
    modelSourcePath: model,
  });

  assert.deepEqual(profile, {
    consentVersion: VOICE_PROFILE_CONSENT_VERSION,
    displayName: "我訓練的音色",
    id: "vp_verified_001",
    state: "verified",
  });
  assert.equal(verifierCalls.length, 1);
  assert.notEqual(verifierCalls[0].modelPath, model);
  const descriptor = await store.sidecarDescriptor(profile.id);
  assert.equal(descriptor.trainer.commit, RVC_PINNED_TRAINER_COMMIT);
  assert.equal(descriptor.verification.schema, "rvc-checkpoint-v2");
  await assert.rejects(
    store.promoteVerifiedTraining({
      confirmedOwnAuthorizedVoice: true,
      displayName: "外部模型",
      finalConsent: { confirmedAtMs: 1_710_000_000_000, version: 1 },
      modelSourcePath: join(tmpdir(), "outside.pth"),
    }),
    /VOICE_PROFILE_TRAINING_ARTIFACT_REQUIRED/,
  );
});

test("promotes only the exact private staged bytes verified by the trusted runner", async () => {
  const { profiles } = await fixture();
  const trainingRoot = await mkdtemp(
    join(tmpdir(), "translive-voice-training-promotion-race-"),
  );
  const session = join(trainingRoot, "vt_owned");
  await mkdir(session);
  const model = join(session, "output.pth");
  await writeFile(model, "original verified model bytes");
  let verifierPath;
  const store = new VoiceProfileStore({
    directory: profiles,
    newId: () => "vp_staged_001",
    now: () => 1_710_000_000_000,
    trainingDirectory: trainingRoot,
    verifyTrainingOutput: async ({ modelPath }) => {
      verifierPath = modelPath;
      const bytes = await readFile(modelPath);
      await writeFile(model, "replaced after verifier began");
      return {
        configLength: 18,
        schema: "rvc-checkpoint-v2",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        tensorCount: 12,
      };
    },
  });

  const profile = await store.promoteVerifiedTraining({
    confirmedOwnAuthorizedVoice: true,
    displayName: "競態安全本人音色",
    finalConsent: { confirmedAtMs: 1_710_000_000_000, version: 1 },
    modelSourcePath: model,
  });

  assert.notEqual(verifierPath, model);
  const descriptor = await store.sidecarDescriptor(profile.id);
  assert.equal(
    await readFile(descriptor.modelPath, "utf8"),
    "original verified model bytes",
  );
  assert.equal(
    descriptor.modelHash,
    createHash("sha256").update("original verified model bytes").digest("hex"),
  );
});

test("does not accept a fully forged verified profile manifest", async () => {
  const { model, profiles, store } = await fixture();
  const profile = await store.importProfile({
    confirmedOwnAuthorizedVoice: true,
    displayName: "偽造完整設定檔",
    modelSourcePath: model,
  });
  const modelHash = createHash("sha256")
    .update(await readFile(join(profiles, profile.id, "model.pth")))
    .digest("hex");
  await writeFile(
    join(profiles, profile.id, "manifest.json"),
    JSON.stringify({
      artifacts: { model: { file: "model.pth", sha256: modelHash } },
      consent: { confirmedAtMs: 1_710_000_000_000, version: 1 },
      displayName: "偽造完整設定檔",
      id: profile.id,
      provenance: "rvc-local-trainer",
      schemaVersion: 1,
      state: "verified",
      trainer: {
        commit: RVC_PINNED_TRAINER_COMMIT,
        provenance: "rvc-local-trainer",
        weightsOnlyRequired: true,
      },
      verification: {
        configLength: 18,
        outputHash: modelHash,
        schema: "rvc-checkpoint-v2",
        tensorCount: 12,
        verifiedAtMs: 1_710_000_000_000,
      },
    }),
  );

  await assert.rejects(
    store.sidecarDescriptor(profile.id),
    /VOICE_PROFILE_(?:NOT_FOUND|UNVERIFIED)/,
  );
  assert.deepEqual(await store.listProfiles(), [
    { ...profile, state: "unverified" },
  ]);
});

test("rejects a symlinked local training artifact before staging or verification", async (t) => {
  const { profiles } = await fixture();
  const trainingRoot = await mkdtemp(
    join(tmpdir(), "translive-voice-training-link-"),
  );
  const session = join(trainingRoot, "vt_linked");
  await mkdir(session);
  const outside = join(trainingRoot, "outside.pth");
  const linked = join(session, "output.pth");
  await writeFile(outside, "outside model");
  try {
    await symlink(outside, linked);
  } catch (error) {
    if (error?.code === "EPERM")
      return t.skip("Windows symlink privilege unavailable");
    throw error;
  }
  const store = new VoiceProfileStore({
    directory: profiles,
    trainingDirectory: trainingRoot,
    verifyTrainingOutput: async () => ({
      configLength: 18,
      schema: "rvc-checkpoint-v2",
      sha256: "0".repeat(64),
      tensorCount: 12,
    }),
  });

  await assert.rejects(
    store.promoteVerifiedTraining({
      confirmedOwnAuthorizedVoice: true,
      displayName: "不可信連結",
      finalConsent: { confirmedAtMs: 1_710_000_000_000, version: 1 },
      modelSourcePath: linked,
    }),
    /VOICE_PROFILE_(?:LOCAL_ARTIFACT_UNSAFE|INVALID_LOCAL_ARTIFACT)/,
  );
});

test("refuses a source swapped to a symlink after identity inspection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "translive-voice-copy-race-"));
  const source = join(root, "source.pth");
  const outside = join(root, "outside.pth");
  const destination = join(root, "private.pth");
  await writeFile(source, "safe source bytes");
  await writeFile(outside, "swapped target bytes");
  try {
    await assert.rejects(
      copyNoFollow(source, destination, {
        openFile: async (path, flags) => {
          await rm(source);
          await symlink(outside, source);
          return open(path, flags);
        },
      }),
      /VOICE_PROFILE_(?:NOFOLLOW_UNAVAILABLE|LOCAL_ARTIFACT_UNSAFE|COPY_FAILED)/,
    );
  } catch (error) {
    if (error?.code === "EPERM")
      return t.skip("Windows symlink privilege unavailable");
    throw error;
  }
  await assert.rejects(readFile(destination));
});

test("fails closed on Windows when no final-path and file-identity nofollow adapter exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "translive-voice-copy-win-"));
  const source = join(root, "source.pth");
  await writeFile(source, "safe source bytes");
  await assert.rejects(
    copyNoFollow(source, join(root, "private.pth"), { platform: "win32" }),
    /VOICE_PROFILE_NOFOLLOW_UNAVAILABLE/,
  );
});

test("rejects a Windows final-path or file-id mismatch after opening a source handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "translive-voice-copy-identity-"));
  const source = join(root, "source.pth");
  await writeFile(source, "safe source bytes");
  await assert.rejects(
    copyNoFollow(source, join(root, "private.pth"), {
      inspectWindowsHandle: async () => ({
        fileId: "wrong-file-id",
        finalPath: source,
      }),
      noFollow: 0,
      platform: "win32",
    }),
    /VOICE_PROFILE_LOCAL_ARTIFACT_UNSAFE/,
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
