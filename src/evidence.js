import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sanitizeText } from "./text-sanitizer.js";

const MAX_ERROR_LENGTH = 500;
const GATES = Object.freeze({
  ttfaP50Ms: 1_500,
  ttfaP95Ms: 2_500,
  lagP95Ms: 4_000,
});
const PACING_NUMERIC_FIELDS = Object.freeze([
  "backlogMs",
  "coalescedSegments",
  "dispatchedSegments",
  "fastStartSegments",
  "lagWarningCount",
  "maxBacklogMs",
  "outstandingSegments",
  "scheduledSegments",
  "steadySegments",
  "targetBacklogMs",
  "waitCount",
]);

function safeTime(value) {
  return Number.isFinite(value) ? Math.round(value) : Date.now();
}

function hashEndpointId(id) {
  return createHash("sha256").update(String(id)).digest("hex").slice(0, 16);
}

function redactMessage(value) {
  return sanitizeText(value ?? "Unknown error", {
    maxLength: MAX_ERROR_LENGTH,
  });
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

function pacingMetrics(metrics) {
  const safe = Object.fromEntries(
    PACING_NUMERIC_FIELDS.filter((field) =>
      Number.isFinite(metrics?.[field]),
    ).map((field) => [field, Math.round(metrics[field])]),
  );
  if (/^[a-z-]{1,100}$/.test(metrics?.policyId ?? "")) {
    safe.policyId = metrics.policyId;
  }
  if (Number.isInteger(metrics?.policyVersion)) {
    safe.policyVersion = metrics.policyVersion;
  }
  return safe;
}

export function textFingerprint(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text ?? "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const MAX_REALTIME_NOTES = 200;

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
      realtimeNotes: { tx: [], rx: [] },
      blockedAttempts: [],
      stateTransitions: [],
      transcriptTimestamps: [],
      timing: {
        tx: { ttfaMs: [], activityGapMs: [], rttMs: [] },
        rx: { ttfaMs: [], activityGapMs: [], rttMs: [] },
      },
      metrics: { tx: {}, rx: {} },
      pacing: { tx: {}, rx: {} },
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
    // tx/rx buckets always exist; extra channels (e.g. the assistant-mode qa
    // voice) get one lazily so evidence capture never breaks a run.
    const session = (this.#data.sessions[direction] ??= {});
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

  // Content-free diagnostics ring for the realtime event stream: text is
  // reduced to a length and a short fingerprint so loops can be traced
  // without transcripts entering evidence.
  recordRealtimeNote(direction, { atMs, kind, role, item, detail, text } = {}) {
    const notes = (this.#data.realtimeNotes[direction] ??= []);
    const note = { atMs: safeTime(atMs), kind: String(kind ?? "unknown") };
    if (role) note.role = String(role);
    if (item) note.item = String(item);
    if (detail) note.detail = String(detail);
    if (text != null) {
      note.textLength = String(text).length;
      note.fp = textFingerprint(text);
    }
    notes.push(note);
    if (notes.length > MAX_REALTIME_NOTES) {
      notes.splice(0, notes.length - MAX_REALTIME_NOTES);
    }
  }

  recordPacing(direction, metrics) {
    if (!(direction in this.#data.pacing)) return;
    this.#data.pacing[direction] = pacingMetrics(metrics);
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
