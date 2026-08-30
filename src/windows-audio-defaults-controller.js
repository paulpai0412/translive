const ROLE_FIELDS = ["consoleId", "multimediaId", "communicationsId"];

export const GLOBAL_AUDIO_TARGETS = Object.freeze({
  captureName: "Voicemeeter Out B2 (VB-Audio Voicemeeter VAIO)",
  renderName: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)",
});

function allRolesMatch(snapshot, { captureId, renderId }) {
  return ROLE_FIELDS.every(
    (field) =>
      snapshot?.capture?.[field] === captureId &&
      snapshot?.render?.[field] === renderId,
  );
}

function snapshotsMatch(left, right) {
  return ROLE_FIELDS.every(
    (field) =>
      left?.capture?.[field] === right?.capture?.[field] &&
      left?.render?.[field] === right?.render?.[field],
  );
}

export class WindowsAudioDefaultsController {
  #adapter;
  #operation = Promise.resolve();
  #platform;
  #state = "unknown";
  #store;

  constructor({ adapter, platform = process.platform, store }) {
    this.#adapter = adapter;
    this.#platform = platform;
    this.#store = store;
  }

  status() {
    return { state: this.#state };
  }

  start() {
    return this.#enqueue(() => this.#start());
  }

  restore() {
    return this.#enqueue(() => this.#restore());
  }

  async #start() {
    if (this.#platform !== "win32") return this.#setState("unsupported");
    if (this.#state === "active") return this.status();

    const recovered = await this.#recoverPending();
    if (recovered) return this.#setState(recovered);

    let target;
    try {
      target = await this.#adapter.resolve(GLOBAL_AUDIO_TARGETS);
    } catch {
      return this.#setState("target-unavailable");
    }

    let checkpoint;
    try {
      checkpoint = {
        phase: "applying",
        snapshot: await this.#adapter.snapshotAllRoles(),
        target,
      };
      await this.#store.save(checkpoint);
    } catch {
      return this.#setState("snapshot-failed");
    }

    try {
      await this.#adapter.applyAllRoles(target);
      const current = await this.#adapter.currentAllRoles();
      if (!allRolesMatch(current, target)) throw new Error("verify failed");
      await this.#store.save({ ...checkpoint, phase: "active" });
    } catch {
      const restored = await this.#restoreCheckpoint(checkpoint);
      if (restored.reason) return this.#setState(restored.reason);
      return this.#setState("apply-failed");
    }

    return this.#setState("active");
  }

  async #restore() {
    if (this.#platform !== "win32") return { restored: false };
    const checkpoint = await this.#store.load();
    if (!checkpoint) return { restored: false };
    if (checkpoint.invalid) {
      this.#setState("recovery-needed");
      return { restored: false, reason: "recovery-needed" };
    }

    const result = await this.#reconcileCheckpoint(checkpoint);
    if (result.reason) this.#setState(result.reason);
    else this.#setState("restored");
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
      return { restored: false, reason: "recovery-needed" };
    }

    if (allRolesMatch(current, checkpoint.target)) {
      return this.#restoreCheckpoint(checkpoint);
    }
    if (snapshotsMatch(current, checkpoint.snapshot)) {
      return this.#clearCheckpoint();
    }
    return { restored: false, reason: "recovery-needed" };
  }

  async #restoreCheckpoint(checkpoint) {
    try {
      await this.#adapter.restoreAllRoles(checkpoint.snapshot);
    } catch {
      return { restored: false, reason: "restore-failed" };
    }
    return this.#clearCheckpoint();
  }

  async #clearCheckpoint() {
    try {
      await this.#store.clear();
      return { restored: true };
    } catch {
      return { restored: true, reason: "checkpoint-clear-failed" };
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
