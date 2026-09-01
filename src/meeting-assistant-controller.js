import {
  CodexAppServer,
  DEFAULT_CODEX_APP_SERVER_ARGS,
} from "./codex-app-server.js";
import { inspectCodexRuntime } from "./codex-runtime.js";
import {
  startDualChannelRun,
  validateAssistantConfig,
} from "./dual-channel-run.js";
import { RunEvidence } from "./evidence.js";
import { MeetingQa } from "./meeting-qa.js";
import { formatSummaryMarkdown } from "./summary-service.js";
import { sanitizeText } from "./text-sanitizer.js";
import { WakeGate } from "./wake-gate.js";

const PINNED_CODEX_VERSION = "0.145.0";
const TAIL_TRANSCRIPT_SETTLE_MS = 750;
const MODEL = "gpt-live-1-codex";
const VOICE = "cove";

// Assistant mode never translates: both channels transcribe verbatim and only
// role=user (real input speech) is recorded. The model must SPEAK the
// transcript aloud — on this transport input transcripts only arrive
// alongside model output turns (probed 2026-09-01: a silent transcription
// prompt yields zero transcript events). The echo audio is never routed.
const TRANSCRIBE_PROMPTS = Object.freeze({
  tx: [
    "You are a verbatim transcription machine for the local speaker.",
    "Repeat every utterance aloud exactly as heard, in its original language, through the audio output.",
    "Never return text only; never remain silent.",
    "Never translate, never answer questions, never add commentary or filler.",
  ].join(" "),
  rx: [
    "You are a verbatim transcription machine for meeting audio.",
    "Repeat every utterance aloud exactly as heard, in its original language, through the audio output.",
    "Never return text only; never remain silent.",
    "Never translate, never answer questions, never add commentary or filler.",
  ].join(" "),
});

const QA_VOICE_PROMPT = [
  "You are a voice output channel.",
  "Speak only the standalone text handed to you, naturally and exactly once.",
  "Never improvise, never answer questions, never translate.",
].join(" ");

function safeMessage(error) {
  return sanitizeText(error?.message ?? error ?? "Unknown error", {
    maxLength: 500,
  });
}

function waitFor(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, milliseconds)),
  );
}

// Meeting assistant mode: record + transcribe both directions (no
// translation), auto-summary on stop, FTS5 indexing, and wake-word Q&A.
// Records, summaries, and the index are the same stores translation mode
// uses — one system, two session configs.
export class MeetingAssistantController {
  #active;
  #answer;
  #appVersion;
  #createClient;
  #codexExecutable;
  #codexVersion;
  #cwd;
  #evidenceDirectory;
  #gate = new WakeGate({ armed: true });
  #inspectRuntime;
  #meetingIndex;
  #publish;
  #qa;
  #records;
  #starting = false;
  #summaryService;

  constructor({
    appVersion,
    answer,
    codexExecutable = process.env.TRANSLIVE_CODEX_BIN || "codex",
    codexArgs = DEFAULT_CODEX_APP_SERVER_ARGS,
    codexVersion = process.env.TRANSLIVE_CODEX_VERSION || PINNED_CODEX_VERSION,
    cwd = process.cwd(),
    evidenceDirectory = process.env.TRANSLIVE_EVIDENCE_DIR ||
      ".translive-evidence",
    inspectRuntime = inspectCodexRuntime,
    createClient = () =>
      new CodexAppServer({ executable: codexExecutable, args: codexArgs, cwd }),
    meetingIndex,
    publish = () => {},
    records,
    summaryService,
  }) {
    if (typeof answer !== "function") {
      throw new Error("MeetingAssistantController requires an answer function");
    }
    this.#appVersion = appVersion;
    this.#answer = answer;
    this.#codexExecutable = codexExecutable;
    this.#codexVersion = codexVersion;
    this.#cwd = cwd;
    this.#evidenceDirectory = evidenceDirectory;
    this.#inspectRuntime = inspectRuntime;
    this.#createClient = createClient;
    this.#meetingIndex = meetingIndex;
    this.#publish = publish;
    this.#records = records;
    this.#summaryService = summaryService;
    this.#qa = new MeetingQa({
      index: meetingIndex,
      answer: this.#answer,
      speak: () => {
        throw new Error("QA voice is only available while a meeting runs");
      },
      publish: (event) => this.#qaPublish(event),
      audit: (entry) => this.#qaAudit(entry),
      currentSession: () => this.#currentSession(),
    });
  }

  async start(config) {
    if (this.#active || this.#starting) {
      throw new Error("A meeting assistant run is already starting or active");
    }
    this.#starting = true;
    let context;
    try {
      this.#assertConfig(config);
      const runtime = await this.#inspectRuntime({
        executable: this.#codexExecutable,
        cwd: this.#cwd,
        includeChecksum: true,
      });
      if (runtime.semanticVersion !== this.#codexVersion) {
        throw new Error(
          `Pinned Codex ${this.#codexVersion} is required; found ${runtime.semanticVersion ?? "unknown"}`,
        );
      }
      if (!runtime.loggedIn) {
        throw new Error("Codex login status is not authenticated");
      }
      const evidence = new RunEvidence({
        appVersion: this.#appVersion,
        codex: { ...runtime, pinnedVersion: this.#codexVersion },
        platform: config.platform,
        mode: "meeting-assistant",
        routeProfile: config.routeProfile,
        model: MODEL,
      });
      const client = this.#createClient();
      context = {
        audit: [],
        buffered: [],
        canceled: false,
        client,
        config,
        evidence,
        finalized: false,
        finalizePromise: undefined,
        lastTranscript: new Map(),
        qaThreadId: undefined,
        run: undefined,
        summary: undefined,
        threads: new Map(),
        transcriptEntries: [],
        transcriptItems: new Map(),
      };
      client.on("notification", (notification) =>
        this.#receiveNotification(context, notification),
      );
      client.on("protocolError", (error) =>
        this.#publish({ type: "error", message: safeMessage(error) }),
      );
      await client.start();
      const run = await startDualChannelRun(config, {
        evidence,
        onStateChange: (event) => this.#publish({ type: "state", ...event }),
        openChannel: async (channel) => this.#openChannel(context, channel),
        validate: validateAssistantConfig,
      });
      context.run = run;
      if (typeof config.qaSdp === "string" && config.qaSdp.length > 0) {
        context.qaThreadId = await this.#openQaVoice(context, config.qaSdp);
      }
      this.#wireQaVoice(context);
      this.#qa.setDelivery(config.answerDelivery ?? "review");
      this.#gate.setArmed(config.wakeArmed !== false);
      this.#gate.setPhrase(config.wakePhrase);
      this.#active = context;
      for (const notification of context.buffered.splice(0)) {
        this.#receiveNotification(context, notification);
      }
      this.#publish({
        type: "run",
        status: run.status(),
        aggregate: run.aggregateStatus(),
      });
      return { status: run.status(), aggregate: run.aggregateStatus() };
    } catch (error) {
      if (context && !context.finalized) {
        context.evidence.recordBlockedAttempt("assistant-start", error);
        await this.#finalize(context, {
          reason: safeMessage(error),
          outcome: "blocked",
        });
      }
      this.#publish({ type: "blocked", message: safeMessage(error) });
      throw new Error(safeMessage(error));
    } finally {
      this.#starting = false;
    }
  }

  pendingAnswer() {
    return this.#qa.pending();
  }

  isActive() {
    return this.#active !== undefined;
  }

  async answerApplied(direction) {
    const active = this.#active;
    if (!active) throw new Error("No meeting assistant run is active");
    active.run.answerApplied(direction);
    const status = active.run.status();
    const aggregate = active.run.aggregateStatus();
    this.#publish({
      type: "state",
      direction,
      state: status[direction],
      aggregate,
    });
    return { status, aggregate };
  }

  async approveAnswer(id) {
    const result = await this.#qa.approveAnswer(id);
    return result;
  }

  async rejectAnswer(id) {
    return this.#qa.rejectAnswer(id);
  }

  async speakConclusions() {
    return this.#qa.speakConclusions();
  }

  setWakeArmed(armed) {
    this.#gate.setArmed(armed);
    return { armed: Boolean(armed) };
  }

  async stop(reason = "user-stop") {
    const context = this.#active;
    if (!context) {
      return { status: { tx: "stopped", rx: "stopped" }, aggregate: "stopped" };
    }
    this.#active = undefined;
    await this.#finalize(context, { reason, outcome: "stopped" });
    this.#publish({
      type: "stopped",
      status: { tx: "stopped", rx: "stopped" },
    });
    return { status: { tx: "stopped", rx: "stopped" }, aggregate: "stopped" };
  }

  recordMetric({ direction, type, atMs, stats }) {
    const active = this.#active;
    if (!active || !["tx", "rx"].includes(direction)) return;
    if (type === "input-audio") active.run.recordInputAudio(direction, atMs);
    if (type === "output-audio") active.run.recordOutputAudio(direction, atMs);
    if (type === "webrtc") active.run.recordWebRtcStats(direction, stats, atMs);
  }

  async dispose() {
    await this.stop("app-quit");
  }

  #assertConfig(config) {
    validateAssistantConfig(config);
    for (const direction of ["tx", "rx"]) {
      if (
        typeof config?.[direction]?.sdp !== "string" ||
        config[direction].sdp.length === 0
      ) {
        throw new Error(
          `${direction.toUpperCase()} requires a WebRTC SDP offer`,
        );
      }
    }
  }

  async #openChannel(context, channel) {
    const thread = await context.client.startEphemeralThread();
    context.threads.set(thread.id, channel.direction);
    context.evidence.recordSession(channel.direction, { threadId: thread.id });
    await context.client.startRealtime({
      threadId: thread.id,
      model: MODEL,
      version: "v3",
      outputModality: "audio",
      includeStartupContext: false,
      clientManagedHandoffs: true,
      delegationAckFiller: false,
      prompt: TRANSCRIBE_PROMPTS[channel.direction],
      voice: VOICE,
      transport: { type: "webrtc", sdp: channel.sdp },
    });
    return {
      threadId: thread.id,
      stop: () => context.client.stopRealtime(thread.id),
    };
  }

  async #openQaVoice(context, sdp) {
    const thread = await context.client.startEphemeralThread();
    context.threads.set(thread.id, "qa");
    context.evidence.recordSession("qa", { threadId: thread.id });
    await context.client.startRealtime({
      threadId: thread.id,
      model: MODEL,
      version: "v3",
      outputModality: "audio",
      includeStartupContext: false,
      clientManagedHandoffs: true,
      delegationAckFiller: false,
      prompt: QA_VOICE_PROMPT,
      voice: VOICE,
      transport: { type: "webrtc", sdp },
    });
    return thread.id;
  }

  #wireQaVoice(context) {
    if (!context.qaThreadId) return;
    const threadId = context.qaThreadId;
    this.#qa.setSpeaker(async (text) => {
      if (context.finalized) throw new Error("Meeting has already ended");
      // appendSpeech must never hang the review flow silently.
      await Promise.race([
        context.client.appendSpeech(threadId, text),
        waitFor(10_000).then(() => {
          throw new Error("QA speech timed out");
        }),
      ]);
    });
  }

  #currentSession() {
    const context = this.#active;
    return {
      id: context?.evidence.snapshot().runId,
      entries: context?.transcriptEntries ?? [],
      summary: context?.summary,
    };
  }

  #qaPublish(event) {
    if (event.type === "qa-pending") this.#gate.suspend();
    if (["qa-sent", "qa-rejected", "qa-error"].includes(event.type)) {
      this.#gate.resume();
    }
    this.#publish(event);
  }

  #qaAudit(entry) {
    const context = this.#active;
    if (context) {
      context.audit.push(entry);
      context.evidence.recordRealtimeNote("qa", {
        kind: "assistant-answer",
        detail: `${entry.delivery}:${entry.outcome}`,
        text: entry.text,
      });
    }
    this.#publish({ type: "qa-audit", entry });
  }

  #receiveNotification(context, notification) {
    const threadId = notification.params?.threadId;
    const direction = context.threads.get(threadId);
    if (!direction || context.finalized) return;
    if (!context.run) {
      context.buffered.push(notification);
      return;
    }
    const atMs = Date.now();
    const realtimeKind = String(notification.method ?? "").startsWith(
      "thread/realtime/",
    )
      ? notification.method.slice("thread/realtime/".length)
      : undefined;
    if (
      ["transcript/delta", "transcript/done", "started", "error", "closed"].includes(
        realtimeKind,
      )
    ) {
      context.evidence.recordRealtimeNote(direction, {
        atMs,
        kind: realtimeKind,
        role: notification.params?.role,
        text: notification.params?.delta ?? notification.params?.text,
      });
    }
    if (direction !== "qa") {
      context.run.handleRealtimeEvent(direction, { ...notification, atMs });
    }
    if (notification.method === "thread/realtime/sdp") {
      this.#publish({ type: "sdp", direction, sdp: notification.params.sdp });
    }
    if (notification.method === "thread/realtime/transcript/done") {
      const { role, text } = notification.params ?? {};
      // The assistant-role echo of a transcribe-only session is the model
      // repeating the input — never show or record it.
      if (role === "user") {
        this.#publish({
          type: "transcript",
          direction,
          role,
          text,
          final: true,
        });
        this.#recordTranscript(context, direction, role, text, atMs);
        if (direction === "tx") this.#handleWake(context, text);
      }
    }
  }

  #handleWake(context, text) {
    const trigger = this.#gate.onFinalTranscript({ source: "me", text });
    if (!trigger) return;
    const task =
      trigger.type === "command" && trigger.command === "speak-conclusions"
        ? this.#qa.speakConclusions()
        : this.#qa.ask(trigger.question);
    task.catch((error) =>
      this.#publish({ type: "qa-error", message: safeMessage(error) }),
    );
  }

  #recordTranscript(context, direction, role, text, atMs) {
    // Only real input speech becomes a record; the assistant-role echo of a
    // transcribe-only session is the model repeating the input, not content.
    if (
      role !== "user" ||
      typeof text !== "string" ||
      text.trim().length === 0
    ) {
      return;
    }
    const previous = context.lastTranscript.get(direction);
    if (previous?.text === text && atMs - previous.atMs < 1_000) return;
    context.lastTranscript.set(direction, { atMs, text });
    context.transcriptEntries.push({ atMs, direction, side: "source", text });
  }

  async #finalize(context, termination) {
    if (context.finalizePromise) return context.finalizePromise;
    context.finalizePromise = this.#finalizeContext(context, termination);
    return context.finalizePromise;
  }

  async #finalizeContext(context, termination) {
    if (this.#active === context) this.#active = undefined;
    try {
      await context.run?.stop();
      await waitFor(TAIL_TRANSCRIPT_SETTLE_MS);
      context.evidence.finish(Date.now(), termination);
      const record = await this.#persistTranscript(context);
      if (record && context.config.autoSummary !== false) {
        await this.#summarize(context, record);
      }
      await context.evidence.write(this.#evidenceDirectory);
    } finally {
      context.finalized = true;
      await context.client.close();
    }
  }

  async #persistTranscript(context) {
    if (!this.#records || context.transcriptEntries.length === 0) {
      this.#publish({ type: "record", state: "not-saved" });
      return undefined;
    }
    const snapshot = context.evidence.snapshot();
    const metadata = await this.#records.saveSession({
      id: snapshot.runId,
      metadata: {
        endedAtMs: snapshot.finishedAtMs,
        mode: "meeting-assistant",
        platform: context.config.platform ?? "custom",
        sourceLabels: { tx: "我", rx: "會議" },
        startedAtMs: snapshot.startedAtMs,
      },
      entries: context.transcriptEntries,
    });
    this.#publish({ type: "record", state: "saved", record: metadata });
    return metadata;
  }

  // One summary system for both modes: same service, same store, same index.
  async #summarize(context, record) {
    if (!this.#summaryService) return;
    try {
      const saved = await this.#records.readSession(record.id);
      const sessions = [{ metadata: saved.metadata, entries: saved.entries }];
      const structured = await this.#summaryService.generate({
        kind: "session",
        sessions,
      });
      const sourceSessions = [
        {
          id: record.id,
          timestamps: saved.entries.map((entry) => entry.offsetMs),
        },
      ];
      const markdown = formatSummaryMarkdown({
        kind: "session",
        modelOutput: structured,
        sourceSessions,
      });
      await this.#records.saveSessionSummary(record.id, {
        generatedAtMs: Date.now(),
        markdown,
        sourceSessions,
        structured,
      });
      context.summary = structured;
      this.#meetingIndex?.indexSession({
        metadata: saved.metadata,
        entries: saved.entries,
        summary: structured,
      });
      this.#publish({ type: "summary", state: "saved", sessionId: record.id });
    } catch (error) {
      this.#publish({
        type: "summary",
        state: "failed",
        message: safeMessage(error),
      });
    }
  }
}
