const TRAINING_PROVIDER = "cpu-baseline";
const FINAL_CONSENT_VERSION = 1;

function safeStatus(status) {
  if (!status || typeof status !== "object") return { state: "idle" };
  const safe = {
    displayName: status.displayName,
    elapsedDurationMs: status.elapsedDurationMs,
    id: status.id,
    progress: status.progress,
    provider: status.provider,
    stage: status.stage,
    state: status.state,
    targetDurationMs: status.targetDurationMs,
  };
  return Object.fromEntries(
    Object.entries(safe).filter(([, value]) => value !== undefined),
  );
}

function safeReason(error) {
  const message = String(error?.message ?? "");
  if (message.includes("CANCELED")) return "canceled";
  if (message.includes("VERIFICATION")) return "verification-failed";
  return "training-failed";
}

function finalConsent(request, now) {
  if (
    request?.confirmedOwnAuthorizedVoice !== true ||
    request?.consentVersion !== FINAL_CONSENT_VERSION
  ) {
    throw new Error("VOICE_TRAINING_FINAL_CONSENT_REQUIRED");
  }
  return { confirmedAtMs: Math.round(now()), version: FINAL_CONSENT_VERSION };
}

/**
 * Orchestrates local own-voice recording and training. Each long-running
 * normalization/training process is owned here so cancel, delete, and app quit
 * always terminate it before sensitive work is removed.
 */
export class VoiceTrainingSessionController {
  #abandonedSessionIds = [];
  #job;
  #normalization;
  #normalizingStart;
  #now;
  #onProfileVerified;
  #profiles;
  #publish;
  #runtime;
  #runtimeProvider = "unavailable";
  #starting;
  #store;

  constructor({
    now = Date.now,
    onProfileVerified = async () => {},
    profiles,
    publish = () => {},
    runtime,
    store,
  } = {}) {
    this.#now = now;
    this.#onProfileVerified = onProfileVerified;
    this.#profiles = profiles;
    this.#publish = publish;
    this.#runtime = runtime;
    this.#runtimeProvider = runtime ? TRAINING_PROVIDER : "unavailable";
    this.#store = store;
  }

  async recover() {
    const result = await this.#store.recover();
    this.#abandonedSessionIds = result.abandonedSessionIds ?? [];
    await Promise.allSettled(
      this.#abandonedSessionIds.map((id) => this.#cleanupRuntimeSession(id)),
    );
    this.#publishStatus(await this.#store.status());
    return result;
  }

  async configureRuntime(runtime) {
    this.#runtime = runtime;
    this.#runtimeProvider = runtime ? TRAINING_PROVIDER : "unavailable";
    if (runtime?.cleanupSession && this.#abandonedSessionIds.length > 0) {
      await Promise.allSettled(
        this.#abandonedSessionIds.map((id) => this.#cleanupRuntimeSession(id)),
      );
      this.#abandonedSessionIds = [];
    }
    return this.status();
  }

  async status() {
    return this.#withRuntime(await this.#store.status());
  }

  async startRecording(request) {
    if (typeof this.#runtime?.normalize !== "function") {
      throw new Error("VOICE_TRAINING_RUNTIME_UNAVAILABLE");
    }
    const status = await this.#store.start(request);
    this.#publishStatus(status);
    return this.#withRuntime(status);
  }

  async pauseRecording(id) {
    const status = await this.#store.pause(id);
    this.#publishStatus(status);
    return this.#withRuntime(status);
  }

  async resumeRecording(id) {
    const status = await this.#store.resume(id);
    this.#publishStatus(status);
    return this.#withRuntime(status);
  }

  async stopRecording({ id, recording } = {}) {
    if (this.#normalizingStart || this.#normalization) {
      throw new Error("VOICE_TRAINING_RUNTIME_UNAVAILABLE");
    }
    let resolveJob;
    const active = {
      canceled: false,
      id,
      job: undefined,
      jobReady: new Promise((resolve) => {
        resolveJob = resolve;
      }),
      resolveJob,
    };
    this.#normalization = active;
    const start = this.#beginNormalization(active, recording);
    this.#normalizingStart = start;
    try {
      return await start;
    } finally {
      if (this.#normalizingStart === start) this.#normalizingStart = undefined;
    }
  }

  async #beginNormalization(active, recording) {
    const { id } = active;
    let recordingAccepted = false;
    const settleJob = (job) => {
      if (active.jobSettled) return;
      active.jobSettled = true;
      active.resolveJob(job);
    };
    try {
      const paths = await this.#store.acceptRecording(id, recording);
      recordingAccepted = true;
      if (active.canceled) throw new Error("VOICE_TRAINING_RUNTIME_CANCELED");
      this.#publishStatus(paths.status);
      if (typeof this.#runtime?.normalize !== "function") {
        throw new Error("VOICE_TRAINING_RUNTIME_UNAVAILABLE");
      }
      const job = this.#runtime.normalize({
        inputPath: paths.inputPath,
        outputPath: paths.normalizedPath,
      });
      if (!job?.completed || typeof job.cancel !== "function") {
        throw new Error("VOICE_TRAINING_RUNTIME_UNAVAILABLE");
      }
      active.job = job;
      settleJob(job);
      job.completed.catch(() => {});
      const inspection = await job.completed;
      if (active.canceled || this.#normalization !== active) {
        throw new Error("VOICE_TRAINING_RUNTIME_CANCELED");
      }
      const status = await this.#store.commitNormalized(id, inspection);
      this.#normalization = undefined;
      this.#publishStatus(status);
      return this.#withRuntime(status);
    } catch (error) {
      settleJob(undefined);
      if (this.#normalization === active) this.#normalization = undefined;
      if (active.canceled) {
        const canceled = await this.#cancelSession(id);
        this.#publishStatus(canceled);
        throw error;
      }
      if (!recordingAccepted) throw error;
      let terminal;
      try {
        terminal = await this.#store.fail(id, "normalization-failed");
      } catch {
        terminal = await this.#cancelSession(id);
      }
      this.#publishStatus(terminal);
      throw new Error("VOICE_TRAINING_NORMALIZATION_FAILED");
    } finally {
      settleJob(undefined);
    }
  }

  async startTraining(request = {}) {
    if (
      this.#job ||
      this.#normalization ||
      this.#starting ||
      typeof this.#runtime?.startTraining !== "function"
    ) {
      throw new Error("VOICE_TRAINING_RUNTIME_UNAVAILABLE");
    }
    const consent = finalConsent(request, this.#now);
    const start = this.#beginTraining(request.id, consent);
    this.#starting = start;
    try {
      return await start;
    } finally {
      if (this.#starting === start) this.#starting = undefined;
    }
  }

  async #beginTraining(id, consent) {
    const paths = await this.#store.paths(id);
    const status = await this.#store.beginTraining(id, TRAINING_PROVIDER, consent);
    this.#publishStatus(status);
    let job;
    try {
      job = this.#runtime.startTraining({
        inputPath: paths.normalizedPath,
        onProgress: (update) => void this.#recordProgress(id, update),
        outputPath: paths.outputPath,
        provider: TRAINING_PROVIDER,
        sessionId: id,
      });
      if (!job?.completed || typeof job.cancel !== "function") {
        throw new Error("VOICE_TRAINING_RUNTIME_UNAVAILABLE");
      }
    } catch {
      const failed = await this.#store.fail(id, "runtime-unavailable");
      this.#publishStatus(failed);
      throw new Error("VOICE_TRAINING_RUNTIME_UNAVAILABLE");
    }
    const active = { canceled: false, consent, id, job, paths };
    this.#job = active;
    void this.#completeTraining(active);
  }

  async cancel() {
    if (this.#starting) await this.#starting.catch(() => {});
    const normalization = this.#normalization;
    if (normalization) {
      normalization.canceled = true;
      const job = normalization.job ?? (await normalization.jobReady);
      if (job) {
        await Promise.resolve(job.cancel());
        await job.completed.catch(() => {});
      }
      await this.#normalizingStart?.catch(() => {});
      await this.#cleanupRuntimeSession(normalization.id);
      if (this.#normalization === normalization) this.#normalization = undefined;
      const current = await this.#store.status();
      const status =
        current?.id === normalization.id &&
        ["recording", "paused", "inspecting", "normalizing"].includes(
          current.state,
        )
          ? await this.#store.cancel(normalization.id)
          : current;
      this.#publishStatus(status);
      return this.#withRuntime(status);
    }
    const active = this.#job;
    if (active) {
      active.canceled = true;
      await Promise.resolve(active.job.cancel());
      await active.job.completed.catch(() => {});
      await this.#cleanupRuntimeSession(active.id);
      if (this.#job === active) this.#job = undefined;
      const status = await this.#store.cancel(active.id);
      this.#publishStatus(status);
      return this.#withRuntime(status);
    }
    const current = await this.#store.status();
    if (
      current?.id &&
      ["recording", "paused", "inspecting", "normalizing", "ready-to-train"].includes(
        current.state,
      )
    ) {
      const status = await this.#store.cancel(current.id);
      this.#publishStatus(status);
      return this.#withRuntime(status);
    }
    return this.#withRuntime(current);
  }

  async delete(id) {
    if (this.#normalization?.id === id || this.#job?.id === id) {
      await this.cancel();
    }
    const result = await this.#store.delete(id);
    this.#publishStatus(await this.#store.status());
    return result;
  }

  async dispose() {
    await this.cancel();
  }

  async #cleanupRuntimeSession(id) {
    await this.#runtime?.cleanupSession?.(id).catch?.(() => {});
  }

  async #cancelSession(id) {
    try {
      return await this.#store.cancel(id);
    } catch {
      return { id, state: "canceled" };
    }
  }

  async #recordProgress(id, update) {
    const active = this.#job;
    if (!active || active.id !== id || active.canceled) return;
    try {
      const status = await this.#store.updateTraining(id, {
        progress: update.progress,
        provider: TRAINING_PROVIDER,
        stage: update.stage,
      });
      if (this.#job === active && !active.canceled) this.#publishStatus(status);
    } catch {
      // The completion path owns terminal failure/cancel states.
    }
  }

  async #completeTraining(active) {
    try {
      const result = await active.job.completed;
      if (active.canceled || this.#job !== active) return;
      if (typeof this.#runtime?.verifyOutput !== "function") {
        throw new Error("VOICE_TRAINING_RUNTIME_VERIFICATION");
      }
      const verification = await this.#runtime.verifyOutput({
        modelPath: result.modelPath,
      });
      const session = await this.#store.status();
      await this.#profiles.promoteVerifiedTraining({
        confirmedOwnAuthorizedVoice: true,
        displayName: session.displayName,
        finalConsent: active.consent,
        modelSourcePath: active.paths.outputPath,
        verification,
      });
      const status = await this.#store.completeVerified(active.id);
      await this.#cleanupRuntimeSession(active.id);
      if (this.#job === active) this.#job = undefined;
      this.#publishStatus(status);
      void this.#onProfileVerified().catch(() => {});
    } catch (error) {
      if (active.canceled || this.#job !== active) return;
      this.#job = undefined;
      await this.#cleanupRuntimeSession(active.id);
      try {
        const status = await this.#store.fail(active.id, safeReason(error));
        this.#publishStatus(status);
      } catch {
        this.#publishStatus({ state: "failed" });
      }
    }
  }

  #withRuntime(status) {
    return {
      ...safeStatus(status),
      runtime: {
        available: Boolean(this.#runtime?.normalize && this.#runtime?.startTraining),
        provider: this.#runtimeProvider,
      },
    };
  }

  #publishStatus(status) {
    this.#publish({ type: "voice-training", status: this.#withRuntime(status) });
  }
}
