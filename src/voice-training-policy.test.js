import assert from "node:assert/strict";
import test from "node:test";

import {
  VOICE_TRAINING_POLICY,
  validateVoiceTrainingInspection,
  validateVoiceTrainingRecording,
} from "./voice-training-policy.js";

function recording(overrides = {}) {
  return {
    bytes: new Uint8Array([1, 2, 3, 4]),
    durationMs: VOICE_TRAINING_POLICY.minimumDurationMs,
    level: {
      clippedFrames: 0,
      peak: 0.7,
      sampledFrames: 100,
      silentFrames: 20,
    },
    mimeType: "audio/webm;codecs=opus",
    ...overrides,
  };
}

test("uses a versioned ten-minute own-voice training policy", () => {
  assert.deepEqual(
    {
      id: VOICE_TRAINING_POLICY.id,
      minimumDurationMs: VOICE_TRAINING_POLICY.minimumDurationMs,
      targetDurationMs: VOICE_TRAINING_POLICY.targetDurationMs,
      version: VOICE_TRAINING_POLICY.version,
    },
    {
      id: "own-voice-rvc-training",
      minimumDurationMs: 9 * 60_000,
      targetDurationMs: 10 * 60_000,
      version: 1,
    },
  );
});

test("stages only bounded recording bytes and never trusts renderer MIME, duration, or level claims", () => {
  const result = validateVoiceTrainingRecording(recording());

  assert.deepEqual(result, { bytes: new Uint8Array([1, 2, 3, 4]) });
  assert.throws(
    () =>
      validateVoiceTrainingRecording(
        recording({ bytes: new Uint8Array(VOICE_TRAINING_POLICY.maxRecordingBytes + 1) }),
      ),
    /VOICE_TRAINING_RECORDING_BYTES_INVALID/,
  );

  assert.throws(
    () =>
      validateVoiceTrainingInspection({
        channels: 1,
        codec: "pcm_s16le",
        decodedBytes: 43_200_000,
        durationMs: VOICE_TRAINING_POLICY.minimumDurationMs,
        rmsDb: -18,
        sampleRate: 40_000,
        silenceRatio: 0.2,
      }),
    /VOICE_TRAINING_RECORDING_CODEC_INVALID/,
  );
});

test("accepts only fixed-tool inspected WebM Opus quality and duration", () => {
  const result = validateVoiceTrainingInspection({
    channels: 1,
    codec: "opus",
    decodedBytes: 43_200_000,
    durationMs: VOICE_TRAINING_POLICY.minimumDurationMs,
    rmsDb: -18,
    sampleRate: 48_000,
    silenceRatio: 0.2,
  });

  assert.deepEqual(result, {
    channels: 1,
    codec: "opus",
    decodedBytes: 43_200_000,
    durationMs: VOICE_TRAINING_POLICY.minimumDurationMs,
    rmsDb: -18,
    sampleRate: 48_000,
    silenceRatio: 0.2,
  });
  for (const invalid of [
    { ...result, channels: 0 },
    { ...result, decodedBytes: VOICE_TRAINING_POLICY.inspection.maxDecodedBytes + 1 },
    { ...result, codec: "aac" },
    { ...result, durationMs: VOICE_TRAINING_POLICY.minimumDurationMs - 1 },
    { ...result, rmsDb: -100 },
    { ...result, silenceRatio: 0.99 },
  ]) {
    assert.throws(
      () => validateVoiceTrainingInspection(invalid),
      /VOICE_TRAINING_RECORDING_/,
    );
  }
});
