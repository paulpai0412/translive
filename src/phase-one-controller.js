import {
  CodexAppServer,
  DEFAULT_CODEX_APP_SERVER_ARGS,
} from "./codex-app-server.js";
import { inspectCodexRuntime } from "./codex-runtime.js";
import {
  directionsForMode,
  startDualChannelRun,
  validateDualChannelConfig,
} from "./dual-channel-run.js";
import { RunEvidence } from "./evidence.js";
import { MeetingQa, QA_VOICE_PROMPT } from "./meeting-qa.js";
import { WakeGate } from "./wake-gate.js";
import { sanitizeText } from "./text-sanitizer.js";

const PINNED_CODEX_VERSION = "0.145.0";

// How long to keep accepting late transcripts after stop, so a final utterance
// that lands during session teardown still reaches the record.
const TAIL_TRANSCRIPT_SETTLE_MS = 750;
const MODEL = "gpt-live-1-codex";
const VOICES = Object.freeze({ tx: "cove", rx: "cove" });
const TRANSLATION_PROMPTS = Object.freeze({
  tx: [
    "You are a simultaneous interpreter.",
    "Continuously translate spoken Traditional Chinese used in Taiwan into natural professional English.",
    "Output only the English interpretation.",
    "Start speaking the first translation as soon as the first stable phrase is understandable; never wait for a complete sentence, a long pause, or the end of the speaker's turn.",
    "Translate questions as questions; never answer them.",
    "Translate each completed utterance exactly once and never repeat text from an earlier utterance unless the speaker repeats it.",
    "Immediately translate and speak complete short utterances such as Yes, No, OK, Thanks, 好, and 是.",
    "Speak every interpretation aloud through the audio output; never return text only.",
    "Do not wait for sentence completion; begin speaking after each stable short phrase while continuing to listen.",
    "Keep a rolling delay near one to two seconds and translate in short clauses without restarting spoken words.",
    "Use concise equivalent wording at a stable, natural conversational pace; do not rush speech to catch up.",
    "Never answer, explain, acknowledge, add filler, summarize, or delegate.",
    "Preserve names, numbers, dates, technical terms, intent, emotion, and pace.",
  ].join(" "),
  rx: [
    "You are a continuous simultaneous interpreter with one fixed target language.",
    "Detect the source language automatically.",
    "Always render every spoken utterance in natural Traditional Chinese used in Taiwan.",
    "If the source is not Traditional Chinese, translate it faithfully into Traditional Chinese.",
    "If the input is already Traditional Chinese, reproduce it faithfully without paraphrasing, omission, or commentary.",
    "For mixed-language speech, translate non-Chinese portions and preserve names, numbers, and technical terms.",
    "Always produce the Traditional Chinese output even when the source is already Chinese; never remain silent.",
    "Start speaking the first translation as soon as the first stable phrase is understandable; never wait for a complete sentence, a long pause, or the end of the speaker's turn.",
    "Translate questions as questions; never answer them.",
    "Translate each completed utterance exactly once and never repeat text from an earlier utterance unless the speaker repeats it.",
    "Immediately translate and speak complete short utterances such as Yes, No, OK, Thanks, 好, and 是.",
    "Speak every interpretation aloud through the audio output; never return text only.",
    "Speak every interpretation aloud to the very end of the utterance, including any short trailing words; never leave the final part unspoken.",
    "Do not wait for sentence completion; begin speaking after each stable short phrase while continuing to listen.",
    "Keep a rolling delay near one to two seconds and translate in short clauses without restarting spoken words.",
    "Use concise equivalent wording at a stable, natural conversational pace; do not rush speech to catch up.",
    "Never answer, explain, acknowledge, add filler, summarize, or delegate.",
    "Preserve names, numbers, dates, technical terms, intent, emotion, and pace.",
  ].join(" "),
});

function safeMessage(error) {
  const message = sanitizeText(error?.message ?? error ?? "Unknown error", {
    maxLength: 500,
  });
  if (/\[已遮罩/.test(message)) {
    return "Codex app-server rejected the request. See the redacted evidence file.";
  }
  return message;
}

function requestIdFrom(error) {
  const value = error?.data?.requestId ?? error?.data?.request_id;
  return typeof value === "string" ? value : undefined;
}

function startupCanceledError() {
  const error = new Error("Translation startup canceled");
  error.name = "AbortError";
  return error;
}

function waitFor(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, milliseconds)),
  );
}

function endpointRecords(config = {}) {
  const records = [];
  if (directionsForMode(config.mode).includes("tx")) {
    const tx = config.tx;
    records.push(
      {
        role: "physicalMicSource",
        id: tx.sourceEndpointId,
        name: tx.sourceEndpointName,
        kind: tx.sourceEndpointKind,
      },
      {
        role: "cableAPlaybackSink",
        id: tx.sinkEndpointId,
        name: tx.sinkEndpointName,
        kind: tx.sinkEndpointKind,
      },
    );
  }
  if (directionsForMode(config.mode).includes("rx")) {
    const rx = config.rx;
    records.push(
      {
        role: "cableBRecordingSource",
        id: rx.sourceEndpointId,
        name: rx.sourceEndpointName,
        kind: rx.sourceEndpointKind,
      },
      {
        role: "headphonesSink",
        id: rx.sinkEndpointId,
        name: rx.sinkEndpointName,
        kind: rx.sinkEndpointKind,
      },
    );
  }
  return records;
}

function assertRouteConfig(config) {
  validateDualChannelConfig(config);
  for (const direction of directionsForMode(config.mode)) {
    const channel = config[direction];
    for (const field of ["sourceEndpointName", "sinkEndpointName"]) {
      if (typeof channel[field] !== "string" || channel[field].length === 0) {
        throw new Error(
          `${direction.toUpperCase()} requires endpoint display names`,
        );
      }
    }
  }
}

function assertStartConfig(config) {
  assertRouteConfig(config);
  for (const direction of directionsForMode(config.mode)) {
    if (
      typeof config[direction].sdp !== "string" ||
      config[direction].sdp.length === 0
    ) {
      throw new Error(`${direction.toUpperCase()} requires a WebRTC SDP offer`);
    }
  }
}

function meetingInstructions(platform, routeProfile) {
  const app = platform === "zoom" ? "Zoom" : "Microsoft Teams";
  const voicemeeter = routeProfile === "voicemeeter";
  return {
    app,
    microphone: voicemeeter
      ? "Select Voicemeeter Out B2 as the microphone."
      : "Select Cable-A Output as the microphone.",
    speaker: voicemeeter
      ? "Select Voicemeeter Input as the speaker."
      : "Select Cable-B Input as the speaker.",
    note: "TransLive 暫時切換 Windows 預設音訊；完全結束後會還原。仍請在會議 App 確認裝置。",
  };
}

export class PhaseOneController {
  #active;
  #answer;
  #appVersion;
  #cancelStartRequested = false;
  #createClient;
  #codexExecutable;
  #codexVersion;
  #cwd;
  #evidenceDirectory;
  #inspectRuntime;
  #gate = new WakeGate({ armed: true });
  #lastEvidence;
  #meetingIndex;
  #publish;
  #qa;
  #records;
  #starting = false;
  #startingContext;

  constructor({
    appVersion,
    codexExecutable = process.env.TRANSLIVE_CODEX_BIN || "codex",
    codexArgs = DEFAULT_CODEX_APP_SERVER_ARGS,
    codexVersion = process.env.TRANSLIVE_CODEX_VERSION || PINNED_CODEX_VERSION,
    cwd = process.cwd(),
    evidenceDirectory = process.env.TRANSLIVE_EVIDENCE_DIR ||
      ".translive-evidence",
    inspectRuntime = inspectCodexRuntime,
    createClient = () =>
      new CodexAppServer({
        executable: codexExecutable,
        args: codexArgs,
        cwd,
      }),
    publish = () => {},
    records,
    meetingIndex,
    answer,
  }) {
    this.#appVersion = appVersion;
    this.#meetingIndex = meetingIndex;
    this.#answer = answer;
    this.#codexExecutable = codexExecutable;
    this.#codexVersion = codexVersion;
    this.#cwd = cwd;
    this.#evidenceDirectory = evidenceDirectory;
    this.#inspectRuntime = inspectRuntime;
    this.#createClient = createClient;
    this.#publish = publish;
    this.#records = records;
    if (typeof this.#answer === "function" && this.#meetingIndex) {
      this.#qa = new MeetingQa({
        index: this.#meetingIndex,
        answer: this.#answer,
        speak: () => {
          throw new Error("QA voice is only available while a meeting runs");
        },
        publish: (event) => this.#qaPublish(event),
        audit: (entry) => this.#qaAudit(entry),
        currentSession: () => ({
          id: this.#active?.context.evidence.snapshot().runId,
          entries: this.#active?.context.transcriptEntries ?? [],
          summary: undefined,
        }),
      });
    }
  }

  async preflight(config) {
    let runtime;
    try {
      assertRouteConfig(config);
      runtime = await this.#runtime(false);
      this.#assertRuntime(runtime);
      return {
        ok: true,
        instructions: meetingInstructions(config.platform, config.routeProfile),
        codexVersion: runtime.version,
      };
    } catch (error) {
      await this.#recordBlockedAttempt(
        config,
        "controller-preflight",
        error,
        runtime,
      );
      return { ok: false, error: safeMessage(error) };
    }
  }

  async start(config) {
    if (this.#active || this.#starting)
      throw new Error("A Phase 1 run is already starting or active");
    this.#starting = true;
    this.#cancelStartRequested = false;
    let context;
    let runtime;
    try {
      assertStartConfig(config);
      runtime = await this.#runtime(true);
      this.#throwIfStartupCanceled();
      this.#assertRuntime(runtime);
      const evidence = this.#evidence(config, runtime);
      const client = this.#createClient();
      context = {
        client,
        evidence,
        run: undefined,
        threads: new Map(),
        buffered: [],
        canceled: false,
        config,
        finalized: false,
        finalizing: false,
        finalizePromise: undefined,
        lastTranscript: new Map(),
        transcriptEntries: [],
        itemModeThreads: new Set(),
        transcriptItems: new Map(),
      };
      this.#startingContext = context;
      client.on("notification", (notification) =>
        this.#receiveNotification(context, notification),
      );
      client.on("protocolError", (error) =>
        this.#recordControllerError(context, error),
      );
      client.on("exit", ({ code, signal }) => {
        if (this.#active?.context === context) {
          this.#recordControllerError(
            context,
            new Error(
              `Codex app-server exited (${code ?? signal ?? "unknown"})`,
            ),
          );
        }
      });

      await client.start();
      this.#throwIfStartupCanceled(context);
      const run = await startDualChannelRun(config, {
        evidence,
        onStateChange: (event) => this.#publish({ type: "state", ...event }),
        openChannel: async (channel) => this.#openChannel(context, channel),
      });
      context.run = run;
      this.#throwIfStartupCanceled(context);
      // Install the active run before forwarding buffered SDP notifications to the renderer.
      this.#active = { context, run };
      for (const notification of context.buffered.splice(0)) {
        this.#receiveNotification(context, notification);
      }
      // QA voice opens only after tx/rx answers are on their way — delaying
      // them behind the qa handshake lets codex close the transport.
      await this.#openQaVoiceIfConfigured(context);
      if (run.allFailed()) {
        context.evidence.recordBlockedAttempt(
          "controller-start",
          "Both realtime starts failed",
        );
        await this.#finalize(context, {
          reason: "Both realtime starts failed",
          outcome: "no-go",
        });
        this.#publish({
          type: "blocked",
          message: "Both GPT-Live sessions failed. Evidence was written.",
        });
        throw new Error("Both GPT-Live sessions failed");
      }

      const aggregate = run.aggregateStatus();
      this.#publish({
        type: "run",
        status: run.status(),
        aggregate,
        codexVersion: runtime.version,
      });
      return { status: run.status(), aggregate, codexVersion: runtime.version };
    } catch (error) {
      const canceled = error?.name === "AbortError" || context?.canceled;
      if (!context?.finalized) {
        if (context) {
          context.evidence.recordBlockedAttempt("controller-start", error);
          context.evidence.recordError("system", error, {
            requestId: requestIdFrom(error),
          });
          await this.#finalize(context, {
            reason: canceled
              ? "Translation startup canceled"
              : safeMessage(error),
            outcome: canceled ? "canceled" : "blocked",
          });
        } else if (!canceled) {
          await this.#recordBlockedAttempt(
            config,
            "controller-start",
            error,
            runtime,
          );
        }
      }
      if (canceled) {
        this.#publish({
          type: "stopped",
          status: { tx: "stopped", rx: "stopped" },
        });
        throw startupCanceledError();
      }
      this.#publish({ type: "blocked", message: safeMessage(error) });
      throw new Error(safeMessage(error));
    } finally {
      if (this.#startingContext === context) this.#startingContext = undefined;
      this.#cancelStartRequested = false;
      this.#starting = false;
    }
  }

  pendingAnswer() {
    return this.#qa?.pending();
  }

  async approveAnswer(id) {
    return this.#qa?.approveAnswer(id);
  }

  async rejectAnswer(id) {
    return this.#qa?.rejectAnswer(id);
  }

  async speakConclusions() {
    return this.#qa?.speakConclusions();
  }

  #qaPublish(event) {
    if (event.type === "qa-pending") this.#gate.suspend();
    if (["qa-sent", "qa-rejected", "qa-error"].includes(event.type)) {
      this.#gate.resume();
    }
    this.#publish(event);
  }

  #qaAudit(entry) {
    const context = this.#active?.context;
    if (context) {
      context.evidence.recordRealtimeNote("qa", {
        kind: "assistant-answer",
        detail: `${entry.delivery}:${entry.outcome}`,
        text: entry.text,
      });
    }
    this.#publish({ type: "qa-audit", entry });
  }

  status() {
    return this.#active?.run.status() ?? { tx: "stopped", rx: "stopped" };
  }

  diagnostics() {
    return this.#active?.context.evidence.snapshot() ?? this.#lastEvidence;
  }

  async cancelStart() {
    this.#cancelStartRequested = true;
    const context = this.#startingContext;
    if (!context) return { canceled: true };
    context.canceled = true;
    await this.#finalize(context, {
      reason: "Translation startup canceled",
      outcome: "canceled",
    });
    return { canceled: true };
  }

  async answerApplied(direction) {
    const active = this.#requireActive();
    active.run.answerApplied(direction);
    return this.#publishChannelState(active, direction);
  }

  async stop(reason = "user-stop") {
    const active = this.#active;
    if (!active && this.#starting) {
      await this.cancelStart();
      return { status: { tx: "stopped", rx: "stopped" }, aggregate: "stopped" };
    }
    if (!active)
      return { status: { tx: "stopped", rx: "stopped" }, aggregate: "stopped" };
    this.#active = undefined;
    await this.#finalize(active.context, { reason, outcome: "stopped" });
    this.#publish({ type: "stopped", status: active.run.status() });
    return { status: active.run.status(), aggregate: "stopped" };
  }

  setMuted(direction, muted) {
    const active = this.#requireActive();
    active.run.setMuted(direction, Boolean(muted));
    return this.#publishChannelState(active, direction);
  }

  recordMetric({ direction, type, atMs, stats }) {
    const active = this.#active;
    if (!active) return;
    if (type === "input-audio") active.run.recordInputAudio(direction, atMs);
    if (type === "output-audio") active.run.recordOutputAudio(direction, atMs);
    if (type === "webrtc") active.run.recordWebRtcStats(direction, stats, atMs);
  }

  async recordRendererBlockedAttempt(config, reason) {
    await this.#recordBlockedAttempt(config, "renderer", reason);
  }

  reportRendererError(direction, message) {
    const active = this.#active;
    if (!active || !["tx", "rx"].includes(direction)) return;
    active.context.evidence.recordBlockedAttempt("renderer", message);
    active.run.handleRealtimeEvent(direction, {
      method: "thread/realtime/error",
      params: { message: safeMessage(message) },
    });
    this.#publish({
      type: "error",
      direction,
      message: "Browser WebRTC routing failed. Stop and inspect diagnostics.",
      aggregate: active.run.aggregateStatus(),
    });
    if (active.run.allFailed()) {
      void this.#finalizeNoGo(
        active.context,
        "Both channels failed after renderer setup",
      ).catch((error) =>
        this.#publish({ type: "error", message: safeMessage(error) }),
      );
    }
  }

  async dispose() {
    await this.stop("app-quit");
  }

  #throwIfStartupCanceled(context) {
    if (this.#cancelStartRequested || context?.canceled) {
      throw startupCanceledError();
    }
  }

  async #runtime(includeChecksum) {
    return this.#inspectRuntime({
      executable: this.#codexExecutable,
      cwd: this.#cwd,
      includeChecksum,
    });
  }

  #assertRuntime(runtime) {
    if (runtime.semanticVersion !== this.#codexVersion) {
      throw new Error(
        `Pinned Codex ${this.#codexVersion} is required; found ${runtime.semanticVersion ?? "unknown"}`,
      );
    }
    if (!runtime.loggedIn)
      throw new Error("Codex login status is not authenticated");
  }

  #evidence(config, runtime = {}) {
    return new RunEvidence({
      appVersion: this.#appVersion,
      codex: { ...runtime, pinnedVersion: this.#codexVersion },
      platform: config?.platform,
      mode: config?.mode,
      routeProfile: config?.routeProfile,
      model: MODEL,
      voices: VOICES,
      endpoints: endpointRecords(config),
    });
  }

  async #recordBlockedAttempt(config, surface, error, runtime) {
    const evidence = this.#evidence(config, runtime);
    evidence.recordBlockedAttempt(surface, error);
    evidence.recordError("system", error, { requestId: requestIdFrom(error) });
    evidence.finish(Date.now(), {
      reason: safeMessage(error),
      outcome: "blocked",
    });
    this.#lastEvidence = evidence.snapshot();
    try {
      await evidence.write(this.#evidenceDirectory);
    } catch (writeError) {
      this.#publish({
        type: "error",
        message: `Could not write blocked evidence: ${safeMessage(writeError)}`,
      });
    }
  }

  async #openQaVoiceIfConfigured(context) {
    if (
      !this.#qa ||
      typeof context.config.qaSdp !== "string" ||
      context.config.qaSdp.length === 0
    ) {
      return;
    }
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
      voice: VOICES.tx,
      transport: { type: "webrtc", sdp: context.config.qaSdp },
    });
    context.qaThreadId = thread.id;
    this.#qa.setSpeaker(async (text) => {
      if (context.finalized) throw new Error("Meeting has already ended");
      // appendSpeech must never hang the review flow silently.
      await Promise.race([
        context.client.appendSpeech(thread.id, text),
        waitFor(10_000).then(() => {
          throw new Error("QA speech timed out");
        }),
      ]);
    });
    this.#qa.setDelivery(context.config.answerDelivery ?? "review");
    this.#gate.setArmed(context.config.wakeArmed !== false);
    this.#gate.setPhrase(context.config.wakePhrase);
  }

  #handleWake(text) {
    if (!this.#qa) return;
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
      prompt: TRANSLATION_PROMPTS[channel.direction],
      voice: VOICES[channel.direction],
      transport: { type: "webrtc", sdp: channel.sdp },
    });
    return {
      threadId: thread.id,
      stop: () => context.client.stopRealtime(thread.id),
    };
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
      [
        "transcript/delta",
        "transcript/done",
        "item/started",
        "item/transcript/delta",
        "item/completed",
      ].includes(realtimeKind)
    ) {
      context.evidence.recordRealtimeNote(direction, {
        atMs,
        kind: realtimeKind,
        role: notification.params?.role ?? notification.params?.item?.role,
        item: notification.params?.itemId ?? notification.params?.item?.id,
        text:
          notification.params?.delta ??
          notification.params?.text ??
          notification.params?.item?.text,
      });
    }
    if (notification.method === "thread/realtime/started") {
      context.evidence.recordSession(direction, {
        threadId,
        realtimeSessionId: notification.params.realtimeSessionId,
      });
    }
    context.run.handleRealtimeEvent(direction, { ...notification, atMs });
    if (notification.method === "thread/realtime/sdp") {
      this.#publish({ type: "sdp", direction, sdp: notification.params.sdp });
    }
    if (direction === "qa") {
      if (notification.method === "thread/realtime/sdp") {
        // handled by the shared sdp branch below
      } else {
        return;
      }
    }
    const transcript = this.#normalizeTranscriptNotification(
      context,
      notification,
    );
    if (transcript) {
      this.#publish({
        type: "transcript",
        direction,
        role: transcript.params.role,
        text: transcript.params.delta ?? transcript.params.text,
        final: transcript.method === "thread/realtime/transcript/done",
      });
      this.#recordTranscript(context, direction, transcript, atMs);
      if (
        direction === "tx" &&
        transcript.method === "thread/realtime/transcript/done" &&
        transcript.params.role === "user"
      ) {
        this.#handleWake(transcript.params.text);
      }
    }
    if (
      notification.method === "thread/realtime/error" ||
      notification.method === "thread/realtime/closed"
    ) {
      this.#publish({
        type: "error",
        direction,
        message: "Realtime session failed. See diagnostics.",
        aggregate: context.run.aggregateStatus(),
      });
    }
    if (context.run.allFailed() && !this.#starting) {
      void this.#finalizeNoGo(context, "Both realtime channels failed").catch(
        (error) =>
          this.#publish({ type: "error", message: safeMessage(error) }),
      );
    }
  }

  // Item-level notifications, when the server emits them, are converted to
  // the flat transcript shape here. No playback binding exists: speech is
  // produced natively by the model, so every item is genuine content.
  #normalizeTranscriptNotification(context, notification) {
    const threadId = notification.params?.threadId;
    if (
      notification.method === "thread/realtime/transcript/delta" ||
      notification.method === "thread/realtime/transcript/done"
    ) {
      return context.itemModeThreads.has(threadId) ? undefined : notification;
    }
    if (notification.method === "thread/realtime/item/started") {
      const item = notification.params?.item;
      if (item?.type !== "transcriptSegment" || !item.id || !item.role) {
        return undefined;
      }
      context.itemModeThreads.add(threadId);
      context.transcriptItems.set(item.id, { role: item.role });
      return undefined;
    }
    if (notification.method === "thread/realtime/item/transcript/delta") {
      const item = context.transcriptItems.get(notification.params?.itemId);
      if (!item) return undefined;
      return {
        method: "thread/realtime/transcript/delta",
        params: {
          delta: notification.params.delta,
          role: item.role,
          threadId,
        },
      };
    }
    if (notification.method !== "thread/realtime/item/completed") {
      return undefined;
    }
    const completed = notification.params?.item;
    const item = context.transcriptItems.get(completed?.id);
    if (!item || completed?.type !== "transcriptSegment") return undefined;
    context.transcriptItems.delete(completed.id);
    return {
      method: "thread/realtime/transcript/done",
      params: {
        role: item.role,
        text: completed.text,
        threadId,
      },
    };
  }

  #recordTranscript(context, direction, notification, atMs) {
    if (
      notification.method !== "thread/realtime/transcript/done" ||
      !["user", "assistant"].includes(notification.params?.role) ||
      typeof notification.params?.text !== "string" ||
      notification.params.text.trim().length === 0
    ) {
      return;
    }
    const side = notification.params.role === "user" ? "source" : "target";
    const key = `${direction}:${side}`;
    const previous = context.lastTranscript.get(key);
    if (
      previous?.text === notification.params.text &&
      atMs - previous.atMs < 1_000
    ) {
      return;
    }
    context.lastTranscript.set(key, { atMs, text: notification.params.text });
    context.transcriptEntries.push({
      atMs,
      direction,
      side,
      text: notification.params.text,
    });
  }

  #recordControllerError(context, error) {
    if (context.finalized) return;
    context.evidence.recordError("system", error, {
      requestId: requestIdFrom(error),
    });
    context.run?.handleRealtimeEvent("tx", {
      method: "thread/realtime/error",
      params: { message: safeMessage(error) },
    });
    context.run?.handleRealtimeEvent("rx", {
      method: "thread/realtime/error",
      params: { message: safeMessage(error) },
    });
    this.#publish({
      type: "error",
      message: "Codex app-server failed. See diagnostics.",
    });
    if (context.run?.allFailed() && !this.#starting) {
      void this.#finalizeNoGo(context, "Codex app-server exited").catch(
        (finalizeError) =>
          this.#publish({ type: "error", message: safeMessage(finalizeError) }),
      );
    }
  }

  async #finalizeNoGo(context, reason) {
    if (context.finalized) return;
    context.evidence.recordBlockedAttempt("controller", reason);
    if (this.#active?.context === context) this.#active = undefined;
    await this.#finalize(context, { reason, outcome: "no-go" });
    this.#publish({
      type: "blocked",
      message: `${reason}. Evidence was written.`,
    });
  }

  async #finalize(context, termination) {
    if (context.finalizePromise) return context.finalizePromise;
    context.finalizing = true;
    context.finalizePromise = this.#finalizeContext(context, termination);
    return context.finalizePromise;
  }

  async #finalizeContext(context, termination) {
    if (this.#active?.context === context) this.#active = undefined;
    let writeError;
    try {
      // stopRealtime can still emit a final transcript after its RPC responds;
      // give the stream a bounded settle window so the record is complete.
      await context.run?.stop();
      await waitFor(TAIL_TRANSCRIPT_SETTLE_MS);
      context.evidence.finish(Date.now(), termination);
      this.#lastEvidence = context.evidence.snapshot();
      await this.#persistTranscript(context);
      await context.evidence.write(this.#evidenceDirectory);
    } catch (error) {
      writeError = error;
    } finally {
      context.finalized = true;
      await context.client.close();
    }
    if (writeError) throw writeError;
  }

  async #persistTranscript(context) {
    if (context.config.persistTranscript === false) {
      this.#publish({ type: "record", state: "not-saved" });
      return undefined;
    }
    if (!this.#records || context.transcriptEntries.length === 0) {
      this.#publish({ type: "record", state: "not-saved" });
      return undefined;
    }
    const evidence = context.evidence.snapshot();
    try {
      const metadata = await this.#records.saveSession({
        id: evidence.runId,
        metadata: {
          endedAtMs: evidence.finishedAtMs,
          languages: context.config.languages,
          mode: context.config.mode ?? "meeting",
          platform: context.config.platform ?? "custom",
          sourceLabels: context.config.sourceLabels,
          startedAtMs: evidence.startedAtMs,
        },
        entries: context.transcriptEntries,
      });
      this.#publish({
        type: "record",
        state: "saved",
        record: metadata,
        path: metadata.path,
      });
      // Feed the shared search index so assistant-mode Q&A can answer from
      // translation sessions too. Read-side concern: never fail the save.
      if (
        this.#meetingIndex &&
        typeof this.#records.readSession === "function"
      ) {
        try {
          const record = await this.#records.readSession(metadata.id);
          this.#meetingIndex.indexSession({
            metadata: record.metadata,
            entries: record.entries,
          });
        } catch {
          // Indexing is rebuilt at startup; a transient miss is harmless.
        }
      }
      return metadata;
    } catch (error) {
      this.#publish({
        type: "record",
        state: "failed",
        message: "無法保存本機逐字稿。",
      });
      throw error;
    }
  }

  #publishChannelState(active, direction) {
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

  #requireActive() {
    if (!this.#active) throw new Error("No Phase 1 run is active");
    return this.#active;
  }
}
