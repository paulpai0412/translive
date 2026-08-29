import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_ERROR_LENGTH = 500;
const GATES = Object.freeze({
  ttfaP50Ms: 1_500,
  ttfaP95Ms: 2_500,
  lagP95Ms: 4_000,
});

function safeTime(value) {
  return Number.isFinite(value) ? Math.round(value) : Date.now();
}

function hashEndpointId(id) {
  return createHash("sha256").update(String(id)).digest("hex").slice(0, 16);
}

function redactMessage(value) {
  const message = String(value ?? "Unknown error")
    .replace(
      /["']?(?:authorization|access_token|refresh_token|id_token|api[_-]?key|session[_-]?token|client_secret|sdp)["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s,;"']+/gi,
      (match) => {
        const key =
          match.match(
            /authorization|access_token|refresh_token|id_token|api[_-]?key|session[_-]?token|client_secret|sdp/i,
          )?.[0] ?? "credential";
        return `${key}: [redacted]`;
      },
    )
    .replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk(?:-proj)?-[A-Za-z0-9_-]+|(?:gho|ghp|ghu|ghs)_[A-Za-z0-9_-]+)/gi,
      "[redacted]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted-jwt]",
    )
    .replace(
      /\baccount(?:[ _-])?id\s*[:=]\s*["']?[^\s,;"']+/gi,
      "accountId: [redacted]",
    );

  if (/\bv=0(?:\r?\n|$)|a=candidate:|\bm=audio\b/i.test(message)) {
    return "[redacted protocol payload]";
  }
  return message.slice(0, MAX_ERROR_LENGTH);
}

function safeIdentifier(value) {
  const identifier = String(value ?? "");
  return /^[A-Za-z0-9._:-]{1,200}$/.test(identifier) ? identifier : undefined;
}

function numericStats(stats) {
  return Object.fromEntries(
    Object.entries(stats ?? {}).filter(([, value]) => Number.isFinite(value)),
  );
}

function percentile(samples, percent) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percent) - 1)
  ];
}

function summary(samples) {
  return {
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
}

function gate(check, passedWhen) {
  if (check.valueMs === null) return { ...check, status: "insufficient" };
  return { ...check, status: passedWhen(check.valueMs) ? "pass" : "fail" };
}

function allSamples(timing, metric) {
  return Object.values(timing).flatMap((channel) => channel[metric] ?? []);
}

export class RunEvidence {
  #data;

  constructor({
    appVersion,
    codex,
    endpoints,
    platform = "unknown",
    mode = "meeting",
    routeProfile = "unknown",
    model = "gpt-live-1-codex",
    voices = {},
    runId = randomUUID(),
    startedAtMs = Date.now(),
  }) {
    const codexData = {
      executable: String(codex?.executable ?? "codex"),
      version: String(codex?.version ?? "unknown"),
      pinnedVersion: String(codex?.pinnedVersion ?? "unknown"),
    };
    if (codex?.checksum) codexData.checksum = String(codex.checksum);
    this.#data = {
      schemaVersion: 2,
      runId,
      startedAtMs: safeTime(startedAtMs),
      finishedAtMs: null,
      app: { version: String(appVersion ?? "unknown") },
      route: {
        platform: String(platform),
        mode: String(mode),
        routeProfile: String(routeProfile),
        model: String(model),
        voices: structuredClone(voices),
      },
      codex: codexData,
      endpoints: (endpoints ?? []).map(({ role, id, name, kind }) => ({
        role: String(role),
        name: String(name),
        kind: String(kind),
        idHash: hashEndpointId(id),
      })),
      sessions: { tx: {}, rx: {} },
      blockedAttempts: [],
      stateTransitions: [],
      transcriptTimestamps: [],
      timing: {
        tx: { ttfaMs: [], activityGapMs: [], rttMs: [] },
        rx: { ttfaMs: [], activityGapMs: [], rttMs: [] },
      },
      metrics: { tx: {}, rx: {} },
      errors: [],
      termination: { reason: null, outcome: "running" },
      gate: { result: "insufficient", checks: {} },
    };
  }

  recordBlockedAttempt(surface, reason, atMs = Date.now()) {
    this.#data.blockedAttempts.push({
      atMs: safeTime(atMs),
      surface: String(surface),
      reason: redactMessage(reason),
    });
  }

  recordState(direction, state, atMs = Date.now(), detail) {
    const transition = { atMs: safeTime(atMs), direction, state };
    if (detail) transition.detail = redactMessage(detail);
    this.#data.stateTransitions.push(transition);
  }

  recordSession(direction, { threadId, realtimeSessionId } = {}) {
    const session = this.#data.sessions[direction];
    const safeThreadId = safeIdentifier(threadId);
    const safeRealtimeSessionId = safeIdentifier(realtimeSessionId);
    if (safeThreadId) session.threadId = safeThreadId;
    if (safeRealtimeSessionId)
      session.realtimeSessionId = safeRealtimeSessionId;
  }

  recordInputAudio(direction, atMs = Date.now()) {
    const timing = this.#data.timing[direction];
    timing.firstInputAudioAtMs ??= safeTime(atMs);
    timing.lastInputAudioAtMs = safeTime(atMs);
  }

  recordOutputAudio(direction, atMs = Date.now()) {
    const timing = this.#data.timing[direction];
    const timestamp = safeTime(atMs);
    timing.firstOutputAudioAtMs ??= timestamp;
    if (
      timing.firstInputAudioAtMs !== undefined &&
      timing.ttfaMs.length === 0
    ) {
      timing.ttfaMs.push(Math.max(0, timestamp - timing.firstInputAudioAtMs));
    }
    if (timing.lastInputAudioAtMs !== undefined) {
      // This is only the gap between observed input/output activity, not semantic interpretation lag.
      timing.activityGapMs.push(
        Math.max(0, timestamp - timing.lastInputAudioAtMs),
      );
    }
  }

  recordWebRtcStats(direction, stats, atMs = Date.now()) {
    const sample = numericStats(stats);
    if (Number.isFinite(sample.rttMs))
      this.#data.timing[direction].rttMs.push(sample.rttMs);
    if (Object.keys(sample).length > 0) {
      const timing = this.#data.timing[direction];
      timing.webrtc ??= [];
      timing.webrtc.push({ atMs: safeTime(atMs), ...sample });
    }
  }

  recordTranscriptTimestamp(direction, role, atMs = Date.now()) {
    this.#data.transcriptTimestamps.push({
      atMs: safeTime(atMs),
      direction,
      role: String(role ?? "unknown"),
    });
  }

  recordError(direction, error, { requestId, atMs = Date.now() } = {}) {
    const entry = {
      atMs: safeTime(atMs),
      direction,
      message: redactMessage(error?.message ?? error),
    };
    const safeRequestId = safeIdentifier(
      requestId ?? error?.data?.requestId ?? error?.data?.request_id,
    );
    if (safeRequestId) entry.requestId = safeRequestId;
    this.#data.errors.push(entry);
  }

  setTermination(reason, outcome = "stopped") {
    this.#data.termination = { reason: redactMessage(reason), outcome };
  }

  finish(atMs = Date.now(), termination) {
    if (termination)
      this.setTermination(termination.reason, termination.outcome);
    this.#data.finishedAtMs ??= safeTime(atMs);
    this.#data.metrics = Object.fromEntries(
      Object.entries(this.#data.timing).map(([direction, timing]) => [
        direction,
        {
          ttfa: summary(timing.ttfaMs),
          activityGap: summary(timing.activityGapMs),
          rtt: summary(timing.rttMs),
        },
      ]),
    );
    this.#data.gate = this.#evaluateGate();
  }

  snapshot() {
    return structuredClone(this.#data);
  }

  async write(directory) {
    this.finish();
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${this.#data.runId}.json`);
    await writeFile(
      file,
      `${JSON.stringify(this.snapshot(), null, 2)}\n`,
      "utf8",
    );
    return file;
  }

  #evaluateGate() {
    const ttfa = summary(allSamples(this.#data.timing, "ttfaMs"));
    const checks = {
      ttfaP50: gate(
        { valueMs: ttfa.p50Ms, limitMs: GATES.ttfaP50Ms },
        (value) => value <= GATES.ttfaP50Ms,
      ),
      ttfaP95: gate(
        { valueMs: ttfa.p95Ms, limitMs: GATES.ttfaP95Ms },
        (value) => value <= GATES.ttfaP95Ms,
      ),
      interpretationLag: {
        valueMs: null,
        limitMs: GATES.lagP95Ms,
        status: "insufficient",
        reason: "Requires externally aligned source and translated audio",
      },
    };
    const statuses = Object.values(checks).map((check) => check.status);
    const bothDirectionsMeasured = ["tx", "rx"].every(
      (direction) =>
        this.#data.timing[direction].ttfaMs.length > 0 &&
        this.#data.timing[direction].activityGapMs.length > 0,
    );
    const failedChannel = this.#data.stateTransitions.some(
      (transition) => transition.state === "failed",
    );
    const forcedFailure =
      ["blocked", "no-go", "failed"].includes(this.#data.termination.outcome) ||
      failedChannel;
    let result = "pass";
    if (forcedFailure || statuses.includes("fail")) result = "fail";
    else if (!bothDirectionsMeasured || statuses.includes("insufficient"))
      result = "insufficient";
    return { result, checks };
  }
}
