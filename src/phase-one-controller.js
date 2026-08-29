import { CodexAppServer } from "./codex-app-server.js";
import { inspectCodexRuntime } from "./codex-runtime.js";
import {
  startDualChannelRun,
  validateDualChannelConfig,
} from "./dual-channel-run.js";
import { RunEvidence } from "./evidence.js";

const PINNED_CODEX_VERSION = "0.145.0";
const MODEL = "gpt-live-1-codex";
const VOICES = Object.freeze({ tx: "marin", rx: "cove" });
const TRANSLATION_PROMPTS = Object.freeze({
  tx: [
    "You are a simultaneous interpreter.",
    "Continuously translate spoken Traditional Chinese used in Taiwan into natural professional English.",
    "Output only the English interpretation.",
    "Never answer, explain, acknowledge, add filler, summarize, or delegate.",
    "Preserve names, numbers, dates, technical terms, intent, emotion, and pace.",
  ].join(" "),
  rx: [
    "You are a simultaneous interpreter.",
    "Continuously translate spoken English into natural Traditional Chinese used in Taiwan.",
    "Output only the Traditional Chinese interpretation.",
    "Never answer, explain, acknowledge, add filler, summarize, or delegate.",
    "Preserve names, numbers, dates, technical terms, intent, emotion, and pace.",
  ].join(" "),
});

function safeMessage(error) {
  const message = String(error?.message ?? error ?? "Unknown error");
  if (
    /authorization|access_token|refresh_token|id_token|bearer|\b(?:sk|gho|ghp|ghu|ghs)[_-]|account(?:_|-)?id|\bv=0(?:\r?\n|$)/i.test(
      message,
    )
  ) {
    return "Codex app-server rejected the request. See the redacted evidence file.";
  }
  return message.slice(0, 500);
}

function requestIdFrom(error) {
  const value = error?.data?.requestId ?? error?.data?.request_id;
  return typeof value === "string" ? value : undefined;
}

function endpointRecords(config = {}) {
  const tx = config.tx ?? {};
  const rx = config.rx ?? {};
  return [
    {
      role: "physicalMicSource",
      id: tx.sourceEndpointId ?? "missing-tx-source",
      name: tx.sourceEndpointName ?? "Unknown TX source",
      kind: tx.sourceEndpointKind ?? "unknown",
    },
    {
      role: "cableAPlaybackSink",
      id: tx.sinkEndpointId ?? "missing-tx-sink",
      name: tx.sinkEndpointName ?? "Unknown Cable-A sink",
      kind: tx.sinkEndpointKind ?? "unknown",
    },
    {
      role: "cableBRecordingSource",
      id: rx.sourceEndpointId ?? "missing-rx-source",
      name: rx.sourceEndpointName ?? "Unknown Cable-B source",
      kind: rx.sourceEndpointKind ?? "unknown",
    },
    {
      role: "headphonesSink",
      id: rx.sinkEndpointId ?? "missing-rx-sink",
      name: rx.sinkEndpointName ?? "Unknown headphone sink",
      kind: rx.sinkEndpointKind ?? "unknown",
    },
  ];
}

function assertRouteConfig(config) {
  validateDualChannelConfig(config);
  for (const direction of ["tx", "rx"]) {
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
  for (const direction of ["tx", "rx"]) {
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
    note: "TransLive does not change meeting-app or Windows defaults.",
  };
}

export class PhaseOneController {
  #active;
  #appVersion;
  #codexArgs;
  #codexExecutable;
  #codexVersion;
  #cwd;
  #evidenceDirectory;
  #inspectRuntime;
  #publish;
  #starting = false;

  constructor({
    appVersion,
    codexExecutable = process.env.TRANSLIVE_CODEX_BIN || "codex",
    codexArgs = ["app-server", "--stdio"],
    codexVersion = process.env.TRANSLIVE_CODEX_VERSION || PINNED_CODEX_VERSION,
    cwd = process.cwd(),
    evidenceDirectory = process.env.TRANSLIVE_EVIDENCE_DIR ||
      ".translive-evidence",
    inspectRuntime = inspectCodexRuntime,
    publish = () => {},
  }) {
    this.#appVersion = appVersion;
    this.#codexArgs = codexArgs;
    this.#codexExecutable = codexExecutable;
    this.#codexVersion = codexVersion;
    this.#cwd = cwd;
    this.#evidenceDirectory = evidenceDirectory;
    this.#inspectRuntime = inspectRuntime;
    this.#publish = publish;
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
    let context;
    let runtime;
    try {
      assertStartConfig(config);
      runtime = await this.#runtime(true);
      this.#assertRuntime(runtime);
      const evidence = this.#evidence(config, runtime);
      const client = new CodexAppServer({
        executable: this.#codexExecutable,
        args: this.#codexArgs,
        cwd: this.#cwd,
      });
      context = {
        client,
        evidence,
        run: undefined,
        threads: new Map(),
        buffered: [],
        finalized: false,
      };
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
      const run = await startDualChannelRun(config, {
        evidence,
        onStateChange: (event) => this.#publish({ type: "state", ...event }),
        openChannel: async (channel) => this.#openChannel(context, channel),
      });
      context.run = run;
      // Install the active run before forwarding buffered SDP notifications to the renderer.
      this.#active = { context, run };
      context.buffered
        .splice(0)
        .forEach((notification) =>
          this.#receiveNotification(context, notification),
        );
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
      if (!context?.finalized) {
        if (context) {
          context.evidence.recordBlockedAttempt("controller-start", error);
          context.evidence.recordError("system", error, {
            requestId: requestIdFrom(error),
          });
          await this.#finalize(context, {
            reason: safeMessage(error),
            outcome: "blocked",
          });
        } else {
          await this.#recordBlockedAttempt(
            config,
            "controller-start",
            error,
            runtime,
          );
        }
      }
      this.#publish({ type: "blocked", message: safeMessage(error) });
      throw new Error(safeMessage(error));
    } finally {
      this.#starting = false;
    }
  }

  status() {
    return this.#active?.run.status() ?? { tx: "stopped", rx: "stopped" };
  }

  async answerApplied(direction) {
    const active = this.#requireActive();
    active.run.answerApplied(direction);
    return this.#publishChannelState(active, direction);
  }

  async stop(reason = "user-stop") {
    const active = this.#active;
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
    try {
      await evidence.write(this.#evidenceDirectory);
    } catch (writeError) {
      this.#publish({
        type: "error",
        message: `Could not write blocked evidence: ${safeMessage(writeError)}`,
      });
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
    if (
      notification.method === "thread/realtime/transcript/delta" ||
      notification.method === "thread/realtime/transcript/done"
    ) {
      this.#publish({
        type: "transcript",
        direction,
        role: notification.params.role,
        text: notification.params.delta ?? notification.params.text,
      });
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
    if (context.finalized) return;
    context.finalized = true;
    if (this.#active?.context === context) this.#active = undefined;
    let writeError;
    try {
      await context.run?.stop();
      context.evidence.finish(Date.now(), termination);
      await context.evidence.write(this.#evidenceDirectory);
    } catch (error) {
      writeError = error;
    } finally {
      await context.client.close();
    }
    if (writeError) throw writeError;
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
