export const VOICE_TRAINING_POLICY = Object.freeze({
  id: "own-voice-rvc-training",
  inspection: Object.freeze({
    acceptedCodec: "opus",
    maxDecodedBytes: 256 * 1024 * 1024,
    maximumChannels: 2,
    minimumChannels: 1,
    minimumRmsDb: -60,
    minimumSampleRate: 8_000,
  }),
  maxClippedRatio: 0.05,
  maxRecordingBytes: 64 * 1024 * 1024,
  maxSilenceRatio: 0.8,
  maximumDurationMs: 15 * 60_000,
  minimumDurationMs: 9 * 60_000,
  normalization: Object.freeze({
    channels: 1,
    sampleFormat: "pcm_s16le",
    sampleRate: 40_000,
  }),
  recordingMimeType: "audio/webm;codecs=opus",
  targetDurationMs: 10 * 60_000,
  version: 1,
});

function fail(code) {
  throw new Error(`VOICE_TRAINING_RECORDING_${code}`);
}

function boundedInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function boundedDecimal(value, code) {
  if (!Number.isFinite(value)) fail(code);
  return value;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  fail("BYTES_REQUIRED");
}

/**
 * The renderer can establish only a byte-size bound. MIME, duration and signal
 * quality are discovered later by fixed local ffprobe/ffmpeg commands.
 */
export function validateVoiceTrainingRecording(
  value,
  policy = VOICE_TRAINING_POLICY,
) {
  const bytes = toBytes(value?.bytes);
  if (bytes.byteLength === 0 || bytes.byteLength > policy.maxRecordingBytes) {
    fail("BYTES_INVALID");
  }
  return { bytes };
}

/**
 * Accepts only an independently inspected local WebM/Opus receipt. This
 * receipt is produced by the fixed runtime, never by renderer metadata.
 */
export function validateVoiceTrainingInspection(
  value,
  policy = VOICE_TRAINING_POLICY,
) {
  const channels = boundedInteger(value?.channels, "CHANNELS_INVALID");
  const decodedBytes = boundedInteger(value?.decodedBytes, "DECODED_BYTES_INVALID");
  if (decodedBytes === 0 || decodedBytes > policy.inspection.maxDecodedBytes) {
    fail("DECODED_BYTES_INVALID");
  }
  if (
    channels < policy.inspection.minimumChannels ||
    channels > policy.inspection.maximumChannels
  ) {
    fail("CHANNELS_INVALID");
  }
  if (
    String(value?.codec ?? "").toLowerCase() !== policy.inspection.acceptedCodec
  ) {
    fail("CODEC_INVALID");
  }
  const durationMs = boundedInteger(value?.durationMs, "DURATION_INVALID");
  if (
    durationMs < policy.minimumDurationMs ||
    durationMs > policy.maximumDurationMs
  ) {
    fail("DURATION_INVALID");
  }
  const sampleRate = boundedInteger(value?.sampleRate, "SAMPLE_RATE_INVALID");
  if (sampleRate < policy.inspection.minimumSampleRate) {
    fail("SAMPLE_RATE_INVALID");
  }
  const rmsDb = boundedDecimal(value?.rmsDb, "RMS_INVALID");
  if (rmsDb < policy.inspection.minimumRmsDb || rmsDb > 0) {
    fail("RMS_INVALID");
  }
  const silenceRatio = boundedDecimal(value?.silenceRatio, "SILENCE_INVALID");
  if (silenceRatio < 0 || silenceRatio > policy.maxSilenceRatio) {
    fail("SILENCE_EXCESSIVE");
  }
  return {
    channels,
    codec: policy.inspection.acceptedCodec,
    decodedBytes,
    durationMs,
    rmsDb,
    sampleRate,
    silenceRatio,
  };
}
