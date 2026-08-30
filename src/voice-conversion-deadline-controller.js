const DIRECTIONS = new Set(["tx", "rx"]);

export const VOICE_CONVERSION_DEADLINE_POLICY = Object.freeze({
  frameDurationMs: 20,
  maxInferenceSamples: 256,
  maxOutstandingFrames: 3,
  maxQueueAgeMs: 120,
  minGateSamples: 20,
});

function assertDirection(value) {
  if (!DIRECTIONS.has(value))
    throw new Error("VOICE_CONVERSION_INVALID_DIRECTION");
  return value;
}

function normalizedPolicy(value = {}) {
  const policy = { ...VOICE_CONVERSION_DEADLINE_POLICY, ...value };
  for (const field of [
    "frameDurationMs",
    "maxInferenceSamples",
    "maxOutstandingFrames",
    "maxQueueAgeMs",
    "minGateSamples",
  ]) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] <= 0) {
      throw new Error("VOICE_CONVERSION_INVALID_DEADLINE_POLICY");
    }
  }
  return policy;
}

function validFrame(frame, direction) {
  if (
    frame?.direction !== direction ||
    !Number.isSafeInteger(frame?.seq) ||
    frame.seq < 0 ||
    !Number.isSafeInteger(frame?.timestampUs) ||
    frame.timestampUs < 0
  ) {
    throw new Error("VOICE_CONVERSION_INVALID_FRAME");
  }
  return frame;
}

function percentile95(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

/**
 * Bounded per-direction decision controller. It never performs conversion or
 * buffers raw audio: callers receive a mutually exclusive output decision for
 * each complete block and perform raw fallback at that same block boundary.
 */
export class VoiceConversionDeadlineController {
  #deadlineMisses = 0;
  #direction;
  #inferenceMs = [];
  #outstanding = new Map();
  #policy;
  #rawFallbackLatched = false;
  #state = "off";

  constructor({ direction, policy } = {}) {
    this.#direction = assertDirection(direction);
    this.#policy = normalizedPolicy(policy);
  }

  submit(frame, { atMs, sidecarReady } = {}) {
    const checked = validFrame(frame, this.#direction);
    const now = Number(atMs);
    if (!Number.isFinite(now)) throw new Error("VOICE_CONVERSION_INVALID_TIME");
    if (this.#rawFallbackLatched) {
      return { output: "raw", reason: "fallback-latched", seq: checked.seq };
    }
    if (sidecarReady !== true) {
      this.#state = "raw-fallback";
      return { output: "raw", reason: "not-ready", seq: checked.seq };
    }
    const queueAgeMs = Math.max(0, now - checked.timestampUs / 1_000);
    if (queueAgeMs > this.#policy.maxQueueAgeMs) {
      this.#latchRawFallback();
      return { output: "raw", reason: "queue-age", seq: checked.seq };
    }
    if (
      this.#outstanding.size >= this.#policy.maxOutstandingFrames ||
      this.#outstanding.has(checked.seq)
    ) {
      this.#latchRawFallback();
      return { output: "raw", reason: "overflow", seq: checked.seq };
    }
    this.#outstanding.set(checked.seq, { admittedAtMs: now, frame: checked });
    this.#state = "converting";
    return { output: "convert", seq: checked.seq };
  }

  complete({ seq, atMs } = {}) {
    if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isFinite(atMs)) {
      throw new Error("VOICE_CONVERSION_INVALID_COMPLETION");
    }
    if (this.#rawFallbackLatched) {
      return { output: "raw", reason: "fallback-latched", seq };
    }
    const outstanding = this.#outstanding.get(seq);
    if (!outstanding) {
      return { output: "raw", reason: "stale-completion", seq };
    }
    this.#outstanding.delete(seq);
    const inferenceMs = Math.max(
      0,
      Math.round(atMs - outstanding.admittedAtMs),
    );
    this.#rememberInference(inferenceMs);
    if (inferenceMs >= this.#policy.frameDurationMs) {
      this.#deadlineMisses += 1;
      this.#latchRawFallback();
      return { inferenceMs, output: "raw", reason: "deadline-miss", seq };
    }
    this.#state = "converting";
    return { inferenceMs, output: "converted", seq };
  }

  deviceRemoved() {
    const decisions = [...this.#outstanding.keys()].map((seq) => ({
      output: "raw",
      reason: "device-removed",
      seq,
    }));
    this.#latchRawFallback();
    return decisions;
  }

  resetAfterWarm() {
    this.#rawFallbackLatched = false;
    this.#state = "ready";
    return this.status();
  }

  gate() {
    if (this.#inferenceMs.length === 0) return { state: "insufficient" };
    const p95InferenceMs = percentile95(this.#inferenceMs);
    if (this.#deadlineMisses > 0) {
      return { p95InferenceMs, state: "failed" };
    }
    if (this.#inferenceMs.length < this.#policy.minGateSamples) {
      return { state: "insufficient" };
    }
    return {
      p95InferenceMs,
      state:
        p95InferenceMs < this.#policy.frameDurationMs ? "passed" : "failed",
    };
  }

  status() {
    return {
      direction: this.#direction,
      outstandingFrames: this.#outstanding.size,
      state: this.#state,
    };
  }

  #latchRawFallback() {
    this.#rawFallbackLatched = true;
    this.#outstanding.clear();
    this.#state = "raw-fallback";
  }

  #rememberInference(value) {
    this.#inferenceMs.push(value);
    if (this.#inferenceMs.length > this.#policy.maxInferenceSamples) {
      this.#inferenceMs.splice(
        0,
        this.#inferenceMs.length - this.#policy.maxInferenceSamples,
      );
    }
  }
}
