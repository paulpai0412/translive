import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { VOICE_TRAINING_POLICY } from "./voice-training-policy.js";
import { VoiceTrainingSessionController } from "./voice-training-session-controller.js";
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

const finalConsentRequest = {
  confirmedOwnAuthorizedVoice: true,
  consentVersion: 1,
};

async function fixture({ runtimeAvailable = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "translive-voice-training-controller-"));
  const training = join(root, "training");
  const events = [];
  let next = 0;
  const store = new VoiceTrainingStore({
    directory: training,
    newId: () => `vt_local_${++next}`,
    now: () => 1_710_000_000_000,
  });
  const calls = [];
  let job;
  const runtime = runtimeAvailable
    ? {
        normalize({ inputPath, outputPath }) {
          calls.push({ normalize: { inputPath, outputPath } });
          let canceled = false;
          return {
            cancel() {
              canceled = true;
            },
            completed: (async () => {
              if (canceled) throw new Error("VOICE_TRAINING_RUNTIME_CANCELED");
              await writeFile(outputPath, Buffer.from("wav"));
              return inspection();
            })(),
          };
        },
        startTraining(request) {
          calls.push({ train: request });
          let resolve;
          let reject;
          const completed = new Promise((onResolve, onReject) => {
            resolve = onResolve;
            reject = onReject;
          });
          job = {
            cancel() {
              reject(new Error("VOICE_TRAINING_RUNTIME_CANCELED"));
            },
            completed,
            resolve,
          };
          return job;
        },
        async cleanupSession(id) {
          calls.push({ cleanup: { id } });
        },
        async verifyOutput({ modelPath }) {
          calls.push({ verify: { modelPath } });
          return {
            configLength: 18,
            schema: "rvc-checkpoint-v2",
            tensorCount: 12,
          };
        },
      }
    : undefined;
  const promoted = [];
  const profiles = {
    async promoteVerifiedTraining(request) {
      promoted.push(request);
      return {
        consentVersion: 1,
        displayName: "本人音色",
        id: "vp_verified",
        state: "verified",
      };
    },
  };
  const controller = new VoiceTrainingSessionController({
    now: () => 1_710_000_000_123,
    profiles,
    publish: (event) => events.push(event),
    runtime,
    store,
  });
  return { calls, controller, events, getJob: () => job, promoted };
}

test("records locally, normalizes with the fixed runtime, then promotes only verified trainer output", async () => {
  const { calls, controller, events, getJob, promoted } = await fixture();
  const started = await controller.startRecording({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人音色",
    microphoneLabel: "USB Microphone",
  });
  assert.equal(started.state, "recording");
  assert.equal((await controller.pauseRecording(started.id)).state, "paused");
  assert.equal((await controller.resumeRecording(started.id)).state, "recording");
  const ready = await controller.stopRecording({ id: started.id, recording: recording() });
  assert.equal(ready.state, "ready-to-train");
  assert.equal(calls.length, 1);
  assert.equal(
    await controller.startTraining({ id: started.id, ...finalConsentRequest }),
    undefined,
  );
  assert.equal((await controller.status()).state, "training");
  const job = getJob();
  job.resolve({ modelPath: calls[1].train.outputPath });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await controller.status()).state, "verified");
  assert.deepEqual(promoted, [
    {
      confirmedOwnAuthorizedVoice: true,
      displayName: "本人音色",
      finalConsent: { confirmedAtMs: 1_710_000_000_123, version: 1 },
      modelSourcePath: calls[1].train.outputPath,
      verification: {
        configLength: 18,
        schema: "rvc-checkpoint-v2",
        tensorCount: 12,
      },
    },
  ]);
  assert.equal(calls.filter((call) => call.verify).length, 1);
  assert.equal(events.at(-1).status.state, "verified");
  assert.doesNotMatch(JSON.stringify(events), /normalized\.wav|recording\.webm|output\.pth/);
});

test("requires fresh final consent before training or verified-profile promotion", async () => {
  const { calls, controller, getJob, promoted } = await fixture();
  const session = await controller.startRecording({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  await controller.stopRecording({ id: session.id, recording: recording() });

  await assert.rejects(
    controller.startTraining({ id: session.id }),
    /VOICE_TRAINING_FINAL_CONSENT_REQUIRED/,
  );
  assert.equal((await controller.status()).state, "ready-to-train");

  await controller.startTraining({ id: session.id, ...finalConsentRequest });
  const trainingCall = calls.find((call) => call.train);
  getJob().resolve({ modelPath: trainingCall.train.outputPath });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(promoted, [
    {
      confirmedOwnAuthorizedVoice: true,
      displayName: "本人",
      finalConsent: { confirmedAtMs: 1_710_000_000_123, version: 1 },
      modelSourcePath: trainingCall.train.outputPath,
      verification: {
        configLength: 18,
        schema: "rvc-checkpoint-v2",
        tensorCount: 12,
      },
    },
  ]);
});

test("refuses to retain raw own-voice recording without a fixed runtime and cancels one active job safely", async () => {
  const unavailable = await fixture({ runtimeAvailable: false });
  await assert.rejects(
    unavailable.controller.startRecording({
      confirmedOwnAuthorizedVoice: true,
      displayName: "本人",
      microphoneLabel: "USB Microphone",
    }),
    /VOICE_TRAINING_RUNTIME_UNAVAILABLE/,
  );
  assert.equal((await unavailable.controller.status()).state, "idle");

  const available = await fixture();
  const active = await available.controller.startRecording({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  await available.controller.stopRecording({ id: active.id, recording: recording() });
  const start = available.controller.startTraining({
    id: active.id,
    ...finalConsentRequest,
  });
  assert.equal((await available.controller.cancel()).state, "canceled");
  await start;
  assert.equal((await available.controller.status()).state, "canceled");
  assert.equal(available.events.at(-1).status.state, "canceled");
});

test("dispose cancels an in-flight normalizer and deletes raw staged own-voice work", async () => {
  const root = await mkdtemp(join(tmpdir(), "translive-voice-training-normalize-cancel-"));
  const training = join(root, "training");
  const store = new VoiceTrainingStore({
    directory: training,
    newId: () => "vt_normalizing",
    now: () => 1_710_000_000_000,
  });
  let rejectNormalize;
  let signalNormalizationStarted;
  const normalizationStarted = new Promise((resolve) => {
    signalNormalizationStarted = resolve;
  });
  let cancelCalls = 0;
  const controller = new VoiceTrainingSessionController({
    profiles: { async promoteVerifiedTraining() {} },
    runtime: {
      normalize() {
        signalNormalizationStarted();
        return {
          cancel() {
            cancelCalls += 1;
            rejectNormalize(new Error("VOICE_TRAINING_RUNTIME_CANCELED"));
          },
          completed: new Promise((_, reject) => {
            rejectNormalize = reject;
          }),
        };
      },
    },
    store,
  });
  const session = await controller.startRecording({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  const stopping = controller.stopRecording({ id: session.id, recording: recording() });
  const stopped = stopping.then(
    () => undefined,
    (error) => error,
  );
  await normalizationStarted;

  await controller.dispose();
  assert.match(
    String((await stopped)?.message),
    /VOICE_TRAINING_(?:NORMALIZATION_FAILED|RUNTIME_CANCELED)/,
  );

  assert.equal(cancelCalls, 1);
  assert.equal((await controller.status()).state, "canceled");
  await assert.rejects(access(join(training, session.id, "recording.webm.staging")));
});

test("cleans fixed RVC workspace residues for abandoned sessions at startup", async () => {
  const cleaned = [];
  const controller = new VoiceTrainingSessionController({
    profiles: {},
    runtime: {
      async cleanupSession(id) {
        cleaned.push(id);
      },
    },
    store: {
      async recover() {
        return { abandonedSessionIds: ["vt_abandoned"], recovered: true };
      },
      async status() {
        return { state: "idle" };
      },
    },
  });

  assert.deepEqual(await controller.recover(), {
    abandonedSessionIds: ["vt_abandoned"],
    recovered: true,
  });
  assert.deepEqual(cleaned, ["vt_abandoned"]);
});

test("cancels a training process tree and cleans its fixed RVC workspace", async () => {
  const { calls, controller, getJob } = await fixture();
  const session = await controller.startRecording({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  await controller.stopRecording({ id: session.id, recording: recording() });
  await controller.startTraining({ id: session.id, ...finalConsentRequest });

  await controller.cancel();

  assert.deepEqual(calls.filter((call) => call.cleanup), [
    { cleanup: { id: session.id } },
  ]);
  await assert.rejects(getJob().completed, /VOICE_TRAINING_RUNTIME_CANCELED/);
});

test("settles a failed recording handoff before disposal", async () => {
  const events = [];
  const store = {
    async acceptRecording() {
      throw new Error("EACCES");
    },
    async cancel() {
      return { id: "vt_eacces", state: "canceled" };
    },
    async start() {
      return { id: "vt_eacces", state: "recording" };
    },
    async status() {
      return { id: "vt_eacces", state: "recording" };
    },
  };
  const controller = new VoiceTrainingSessionController({
    profiles: {},
    publish: (event) => events.push(event),
    runtime: { normalize() {} },
    store,
  });
  const session = await controller.startRecording({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  const failed = controller.stopRecording({ id: session.id, recording: recording() });
  await assert.rejects(failed, /EACCES/);
  await Promise.race([
    controller.dispose(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("dispose hung")), 100)),
  ]);
  assert.equal(events.at(-1).status.state, "canceled");
});

test("cancels an active local recording before any audio upload", async () => {
  const { controller, events } = await fixture();
  const session = await controller.startRecording({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });

  const canceled = await controller.cancel();

  assert.equal(canceled.state, "canceled");
  assert.equal((await controller.status()).state, "canceled");
  assert.doesNotMatch(JSON.stringify(events), /bytes|audio\/webm|recording\.webm/i);
  await controller.delete(session.id);
});

test("rejects unconsented, mismatched, and duplicate recording sessions without exposing audio", async () => {
  const { controller, events } = await fixture();
  await assert.rejects(
    controller.startRecording({
      confirmedOwnAuthorizedVoice: false,
      displayName: "本人",
      microphoneLabel: "USB Microphone",
    }),
    /VOICE_TRAINING_CONSENT_REQUIRED/,
  );
  const session = await controller.startRecording({
    confirmedOwnAuthorizedVoice: true,
    displayName: "本人",
    microphoneLabel: "USB Microphone",
  });
  await assert.rejects(
    controller.stopRecording({ id: "vt_other", recording: recording() }),
    /VOICE_TRAINING_NOT_FOUND/,
  );
  await assert.rejects(
    controller.startRecording({
      confirmedOwnAuthorizedVoice: true,
      displayName: "第二個",
      microphoneLabel: "USB Microphone",
    }),
    /VOICE_TRAINING_ACTIVE_SESSION/,
  );
  assert.doesNotMatch(JSON.stringify(events), /bytes|audio\/webm|recording\.webm/i);
  await controller.delete(session.id);
});
