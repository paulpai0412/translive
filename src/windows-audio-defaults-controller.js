const ROLE_FIELDS = ["consoleId", "multimediaId", "communicationsId"];
const MODES = new Set(["meeting", "media", "microphone"]);

export const GLOBAL_AUDIO_TARGETS = Object.freeze({
  captureName: "Voicemeeter Out B2 (VB-Audio Voicemeeter VAIO)",
  renderName: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)",
});

function cloneSnapshot(value) {
  return {
    capture: { ...value.capture },
    render: { ...value.render },
  };
}

function snapshotsMatch(left, right) {
  return ROLE_FIELDS.every(
    (field) =>
      left?.capture?.[field] === right?.capture?.[field] &&
      left?.render?.[field] === right?.render?.[field],
  );
}

export function buildModeAudioTarget({ mode, original, resolved }) {
  if (!MODES.has(mode)) throw new Error("Unsupported audio routing mode");
  if (!original?.capture || !original?.render) {
    throw new Error("Original Windows audio roles are required");
  }
  if (!resolved?.captureId || !resolved?.renderId) {
    throw new Error("VoiceMeeter endpoint IDs are required");
  }
  const target = cloneSnapshot(original);
  if (mode === "meeting" || mode === "microphone") {
    target.capture.communicationsId = resolved.captureId;
  }
  if (mode === "meeting") {
    target.render.communicationsId = resolved.renderId;
  }
  if (mode === "media") {
    target.render.consoleId = resolved.renderId;
    target.render.multimediaId = resolved.renderId;
  }
  return target;
}

export class WindowsAudioDefaultsController {
  #adapter;
  #mode;
  #operation = Promise.resolve();
  #original;
  #platform;
  #resolved;
  #state = "unknown";
  #store;

  constructor({ adapter, platform = process.platform, store }) {
    this.#adapter = adapter;
    this.#platform = platform;
    this.#store = store;
  }

  status() {
    return this.#mode
      ? { mode: this.#mode, state: this.#state }
      : { state: this.#state };
  }

  prepare() {
    return this.#enqueue(() => this.#prepare());
  }

  // Compatibility for callers migrating from the old app-start global route.
  start() {
    return this.prepare();
  }

  applyMode(mode) {
    return this.#enqueue(() => this.#applyMode(mode));
  }

  restore() {
    return this.#enqueue(() => this.#restore());
  }

  async #prepare() {
    if (this.#platform !== "win32") return this.#setState("unsupported");
    if (this.#state === "prepared") return this.status();
    if (this.#state === "active") return this.status();

    const recovered = await this.#recoverPending();
    if (recovered) return this.#setState(recovered);
    try {
      this.#resolved = await this.#adapter.resolve(GLOBAL_AUDIO_TARGETS);
    } catch {
      this.#resolved = undefined;
      return this.#setState("target-unavailable");
    }
    try {
      this.#original = await this.#adapter.snapshotAllRoles();
    } catch {
      this.#original = undefined;
      return this.#setState("snapshot-failed");
    }
    return this.#setState("prepared");
  }

  async #applyMode(mode) {
    if (!MODES.has(mode)) return this.#setState("unsupported-mode");
    if (this.#state === "active" && this.#mode === mode) return this.status();
    if (this.#state === "active") {
      const restored = await this.#restore();
      if (restored.reason) return this.#setState(restored.reason);
    }
    if (this.#state !== "prepared") {
      const prepared = await this.#prepare();
      if (prepared.state !== "prepared") return prepared;
    }
    try {
      this.#original = await this.#adapter.snapshotAllRoles();
    } catch {
      return this.#setState("snapshot-failed");
    }
    const target = buildModeAudioTarget({
      mode,
      original: this.#original,
      resolved: this.#resolved,
    });
    const checkpoint = {
      mode,
      phase: "applying",
      snapshot: this.#original,
      target,
    };
    try {
      await this.#store.save(checkpoint);
      await this.#adapter.restoreAllRoles(target);
      const current = await this.#adapter.currentAllRoles();
      if (!snapshotsMatch(current, target)) throw new Error("verify failed");
      await this.#store.save({ ...checkpoint, phase: "active" });
      this.#mode = mode;
      return this.#setState("active");
    } catch {
      const restored = await this.#restoreCheckpoint(checkpoint);
      if (restored.reason) return this.#setState(restored.reason);
      return this.#setState("apply-failed");
    }
  }

  async #restore() {
    if (this.#platform !== "win32") return { restored: false };
    const checkpoint = await this.#store.load();
    if (!checkpoint) {
      this.#mode = undefined;
      this.#original = undefined;
      this.#resolved = undefined;
      this.#setState("restored");
      return { restored: false };
    }
    if (checkpoint.invalid) {
      this.#setState("recovery-needed");
      return { reason: "recovery-needed", restored: false };
    }
    const result = await this.#reconcileCheckpoint(checkpoint);
    if (result.reason) this.#setState(result.reason);
    else {
      this.#mode = undefined;
      this.#original = undefined;
      this.#resolved = undefined;
      this.#setState("restored");
    }
    return result;
  }

  async #recoverPending() {
    const checkpoint = await this.#store.load();
    if (!checkpoint) return undefined;
    if (checkpoint.invalid) return "recovery-needed";
    const result = await this.#reconcileCheckpoint(checkpoint);
    return result.reason;
  }

  async #reconcileCheckpoint(checkpoint) {
    let current;
    try {
      current = await this.#adapter.currentAllRoles();
    } catch {
      return { reason: "recovery-needed", restored: false };
    }
    if (snapshotsMatch(current, checkpoint.target)) {
      return this.#restoreCheckpoint(checkpoint);
    }
    if (snapshotsMatch(current, checkpoint.snapshot)) {
      return this.#clearCheckpoint();
    }
    return { reason: "recovery-needed", restored: false };
  }

  async #restoreCheckpoint(checkpoint) {
    try {
      await this.#adapter.restoreAllRoles(checkpoint.snapshot);
      const current = await this.#adapter.currentAllRoles();
      if (!snapshotsMatch(current, checkpoint.snapshot)) {
        return { reason: "restore-failed", restored: false };
      }
    } catch {
      return { reason: "restore-failed", restored: false };
    }
    return this.#clearCheckpoint();
  }

  async #clearCheckpoint() {
    try {
      await this.#store.clear();
      return { restored: true };
    } catch {
      return { reason: "checkpoint-clear-failed", restored: true };
    }
  }

  #enqueue(operation) {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.catch(() => {});
    return result;
  }

  #setState(state) {
    this.#state = state;
    return this.status();
  }
}
