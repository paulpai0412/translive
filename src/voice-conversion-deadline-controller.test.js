import assert from "node:assert/strict";
import test from "node:test";

import { VoiceConversionDeadlineController } from "./voice-conversion-deadline-controller.js";

function frame(seq, timestampUs = seq * 20_000) {
  return {
    direction: "rx",
    frameBytes: 960,
    sampleRate: 48_000,
    seq,
    streamId: "vc_rx_deadline",
    timestampUs,
  };
}

const policy = {
  frameDurationMs: 20,
  maxOutstandingFrames: 2,
  maxQueueAgeMs: 60,
  minGateSamples: 2,
};

test("uses raw GPT blocks while a sidecar is not ready and never buffers them", () => {
  const controller = new VoiceConversionDeadlineController({
    direction: "rx",
    policy,
  });

  assert.deepEqual(
    controller.submit(frame(0), { atMs: 0, sidecarReady: false }),
    {
      output: "raw",
      reason: "not-ready",
      seq: 0,
    },
  );
  assert.deepEqual(controller.status(), {
    direction: "rx",
    outstandingFrames: 0,
    state: "raw-fallback",
  });
});

test("keeps converted and raw decisions mutually exclusive under an outstanding-frame bound", () => {
  const controller = new VoiceConversionDeadlineController({
    direction: "rx",
    policy,
  });

  assert.deepEqual(
    controller.submit(frame(0), { atMs: 0, sidecarReady: true }),
    {
      output: "convert",
      seq: 0,
    },
  );
  assert.deepEqual(
    controller.submit(frame(1), { atMs: 20, sidecarReady: true }),
    {
      output: "convert",
      seq: 1,
    },
  );
  assert.deepEqual(
    controller.submit(frame(2), { atMs: 40, sidecarReady: true }),
    {
      output: "raw",
      reason: "overflow",
      seq: 2,
    },
  );
  assert.deepEqual(controller.complete({ seq: 0, atMs: 10 }), {
    output: "raw",
    reason: "fallback-latched",
    seq: 0,
  });
  assert.deepEqual(
    controller.submit(frame(3, 50_000), { atMs: 50, sidecarReady: true }),
    {
      output: "raw",
      reason: "fallback-latched",
      seq: 3,
    },
  );
  controller.resetAfterWarm();
  assert.deepEqual(
    controller.submit(frame(3, 50_000), { atMs: 50, sidecarReady: true }),
    {
      output: "convert",
      seq: 3,
    },
  );
});

test("switches at a frame boundary to raw fallback on deadline or queue-age misses", () => {
  const deadline = new VoiceConversionDeadlineController({
    direction: "rx",
    policy,
  });
  deadline.submit(frame(0), { atMs: 0, sidecarReady: true });

  assert.deepEqual(deadline.complete({ seq: 0, atMs: 20 }), {
    inferenceMs: 20,
    output: "raw",
    reason: "deadline-miss",
    seq: 0,
  });
  assert.deepEqual(deadline.gate(), {
    p95InferenceMs: 20,
    state: "failed",
  });

  const queueAge = new VoiceConversionDeadlineController({
    direction: "rx",
    policy,
  });
  assert.deepEqual(
    queueAge.submit(frame(1, 0), { atMs: 61, sidecarReady: true }),
    {
      output: "raw",
      reason: "queue-age",
      seq: 1,
    },
  );
  assert.deepEqual(
    queueAge.submit(frame(2, 40_000), { atMs: 40, sidecarReady: true }),
    {
      output: "raw",
      reason: "fallback-latched",
      seq: 2,
    },
  );
});

test("latches raw fallback, flushes outstanding conversion work, and resumes only after a re-warm", () => {
  const controller = new VoiceConversionDeadlineController({
    direction: "rx",
    policy,
  });
  controller.submit(frame(0), { atMs: 0, sidecarReady: true });
  controller.submit(frame(1), { atMs: 20, sidecarReady: true });

  assert.deepEqual(controller.complete({ seq: 0, atMs: 20 }), {
    inferenceMs: 20,
    output: "raw",
    reason: "deadline-miss",
    seq: 0,
  });
  assert.deepEqual(controller.complete({ seq: 1, atMs: 25 }), {
    output: "raw",
    reason: "fallback-latched",
    seq: 1,
  });
  assert.deepEqual(
    controller.submit(frame(2, 40_000), { atMs: 40, sidecarReady: true }),
    {
      output: "raw",
      reason: "fallback-latched",
      seq: 2,
    },
  );
  assert.deepEqual(controller.status(), {
    direction: "rx",
    outstandingFrames: 0,
    state: "raw-fallback",
  });

  assert.deepEqual(controller.resetAfterWarm(), {
    direction: "rx",
    outstandingFrames: 0,
    state: "ready",
  });
  assert.deepEqual(
    controller.submit(frame(2, 40_000), { atMs: 40, sidecarReady: true }),
    { output: "convert", seq: 2 },
  );
});

test("flushes only its own direction when a device is removed", () => {
  const rx = new VoiceConversionDeadlineController({ direction: "rx", policy });
  const tx = new VoiceConversionDeadlineController({ direction: "tx", policy });
  rx.submit(frame(0), { atMs: 0, sidecarReady: true });
  tx.submit(
    { ...frame(0), direction: "tx", streamId: "vc_tx_deadline" },
    { atMs: 0, sidecarReady: true },
  );

  assert.deepEqual(rx.deviceRemoved(), [
    { output: "raw", reason: "device-removed", seq: 0 },
  ]);
  assert.deepEqual(tx.complete({ seq: 0, atMs: 10 }), {
    inferenceMs: 10,
    output: "converted",
    seq: 0,
  });
  assert.deepEqual(rx.status(), {
    direction: "rx",
    outstandingFrames: 0,
    state: "raw-fallback",
  });
});

test("reports an honest p95 gate only after enough bounded samples", () => {
  const controller = new VoiceConversionDeadlineController({
    direction: "rx",
    policy,
  });
  assert.deepEqual(controller.gate(), { state: "insufficient" });
  for (const [seq, inferenceMs] of [
    [0, 10],
    [1, 15],
  ]) {
    controller.submit(frame(seq), { atMs: seq * 30, sidecarReady: true });
    controller.complete({ seq, atMs: seq * 30 + inferenceMs });
  }
  assert.deepEqual(controller.gate(), {
    p95InferenceMs: 15,
    state: "passed",
  });
});
