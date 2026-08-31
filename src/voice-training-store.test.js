import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { VOICE_TRAINING_POLICY } from "./voice-training-policy.js";
import { VoiceTrainingStore } from "./voice-training-store.js";

function recording() {
  return { bytes: new Uint8Array([1, 2, 3, 4]) };
}

function inspection() {
  return {
    channels: 1,
    codec: "opus",
    decodedBytes: 43_200_000,
    durationMs: VOICE_TRAINING_POLICY.minimumDurationMs,
    rmsDb: -18,
    sampleRate: 48_000,
    silenceRatio: 0.2,
  };
}

const finalConsent = {
  confirmedAtMs: 1_700_000_000_001,
  version: 1,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "translive-voice-training-"));
  let next = 0;
  return {
    directory,
    store: new VoiceTrainingStore({
      directory,
      newId: () => `vt_session_${++next}`,
      now: () => 1_700_000_000_000,
    }),
  };
}

test("owns one profile-scoped local recording through ready-to-train", async () => {
  const { directory, store } = await fixture();

  assert.deepEqual(await store.status(), { state: "idle" });
  const started = await store.start({
    confirmedOwnAuthorizedVoice: true,
    displayName: "我的本人音色",
    microphoneLabel: "USB Microphone",
  });
  assert.deepEqual(
    started,
    {
      displayName: "我的本人音色",
      elapsedDurationMs: 0,
      id: "vt_session_1",
      progress: 0,
      state: "recording",
      targetDurationMs: VOICE_TRAINING_POLICY.targetDurationMs,
    },
  );
  await assert.rejects(
    store.start({
      confirmedOwnAuthorizedVoice: true,
      displayName: "另一個",
      microphoneLabel: "USB Microphone",
    }),
    /VOICE_TRAINING_ACTIVE_SESSION/,
  );

  assert.equal((await store.pause(started.id)).state, "paused");
  assert.equal((await store.resume(started.id)).state, "recording");
  const privatePaths = await store.acceptRecording(started.id, recording());
  assert.equal(privatePaths.status.state, "inspecting");
  assert.equal(
    await readFile(privatePaths.inputPath).then((bytes) => bytes.byteLength),
    4,
  );
  await writeFile(privatePaths.normalizedPath, Buffer.from("wav"));
  const ready = await store.commitNormalized(started.id, inspection());
  assert.deepEqual(
    {
      elapsedDurationMs: ready.elapsedDurationMs,
      progress: ready.progress,
      state: ready.state,
    },
    {
      elapsedDurationMs: VOICE_TRAINING_POLICY.minimumDurationMs,
      progress: 0,
      state: "ready-to-train",
    },
  );
  await assert.rejects(access(privatePaths.inputPath));
  assert.equal(
    await readFile(join(directory, started.id, "session.json"), "utf8").then(
      (content) => JSON.parse(content).state,
    ),
    "ready-to-train",
  );
});

test("serializes train progress and atomically cancels or deletes sensitive work", async () => {
  const { directory, store } = await fixture();
  const session = await store.start({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  const paths = await store.acceptRecording(session.id, recording());
  await writeFile(paths.normalizedPath, Buffer.from("wav"));
  await store.commitNormalized(session.id, inspection());

  assert.equal(
    (await store.beginTraining(session.id, "cpu-baseline", finalConsent)).state,
    "training",
  );
  const training = await store.updateTraining(session.id, {
    progress: 42,
    provider: "cpu-baseline",
    stage: "features",
  });
  assert.deepEqual(
    {
      progress: training.progress,
      provider: training.provider,
      stage: training.stage,
      state: training.state,
    },
    {
      progress: 42,
      provider: "cpu-baseline",
      stage: "features",
      state: "training",
    },
  );
  await writeFile(join(directory, session.id, "output.pth"), Buffer.from("model"));
  assert.equal((await store.cancel(session.id)).state, "canceled");
  await assert.rejects(access(join(directory, session.id, "normalized.wav")));
  await assert.rejects(access(join(directory, session.id, "output.pth")));
  assert.equal((await store.status()).state, "canceled");

  const second = await store.start({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人二",
    microphoneLabel: "USB Microphone",
  });
  await store.delete(second.id);
  await assert.rejects(access(join(directory, second.id)));
  assert.deepEqual(await store.status(), { state: "idle" });
});

test("removes terminal verified session work after explicit deletion", async () => {
  const { directory, store } = await fixture();
  const session = await store.start({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  const paths = await store.acceptRecording(session.id, recording());
  await writeFile(paths.normalizedPath, Buffer.from("wav"));
  await store.commitNormalized(session.id, inspection());
  const work = await store.paths(session.id);
  await store.beginTraining(session.id, "cpu-baseline", finalConsent);
  await writeFile(work.outputPath, Buffer.from("model"));
  assert.equal((await store.completeVerified(session.id)).state, "verified");
  await assert.rejects(access(work.outputPath));

  await store.delete(session.id);

  await assert.rejects(access(join(directory, session.id)));
  assert.deepEqual(await store.status(), { state: "idle" });
});

test("recovers abandoned nonterminal recordings and rejects reparse-point training roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "translive-voice-training-recover-"));
  const directory = join(root, "training");
  const store = new VoiceTrainingStore({
    directory,
    newId: () => "vt_recover",
    now: () => 1_700_000_000_000,
  });
  const session = await store.start({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  const staged = await store.acceptRecording(session.id, recording());
  assert.equal(staged.status.state, "inspecting");

  const recovered = new VoiceTrainingStore({ directory });
  assert.deepEqual(await recovered.recover(), {
    abandonedSessionIds: [session.id],
    recovered: true,
  });
  await assert.rejects(access(join(directory, session.id, "recording.webm.staging")));
  assert.deepEqual(await recovered.status(), { state: "idle" });

  const outside = await mkdtemp(join(tmpdir(), "translive-voice-training-outside-"));
  const linked = join(root, "linked-training");
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, linked, "dir");
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("Windows symlink privilege unavailable");
    throw error;
  }
  const unsafe = new VoiceTrainingStore({ directory: linked });
  await assert.rejects(
    unsafe.start({
      confirmedOwnAuthorizedVoice: true,
      displayName: "本人",
      microphoneLabel: "USB Microphone",
    }),
    /VOICE_TRAINING_STORAGE_UNSAFE/,
  );
});

test("fails closed on missing consent, traversal, malformed state transition, and recording limits", async () => {
  const { store } = await fixture();
  await assert.rejects(
    store.start({ displayName: "本人", microphoneLabel: "USB Microphone" }),
    /VOICE_TRAINING_CONSENT_REQUIRED/,
  );
  await assert.rejects(store.pause("../other"), /VOICE_TRAINING_INVALID_ID/);
  const session = await store.start({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  await assert.rejects(
    store.commitNormalized(session.id, inspection()),
    /VOICE_TRAINING_STATE/,
  );
  await assert.rejects(
    store.acceptRecording(
      session.id,
      { bytes: new Uint8Array(VOICE_TRAINING_POLICY.maxRecordingBytes + 1) },
    ),
    /VOICE_TRAINING_RECORDING_BYTES_INVALID/,
  );
  assert.equal((await store.status()).state, "recording");
});
