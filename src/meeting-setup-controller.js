function manualResult({ app, endpoints, reason }) {
  return {
    app,
    meetingAppUsage: "unverified",
    microphoneName: endpoints.microphone.name,
    reason,
    speakerName: endpoints.speaker.name,
    state: "needs-manual-confirmation",
    verification: "not-verified",
  };
}

function endpointNames(endpoints) {
  const captureName = endpoints?.microphone?.name;
  const renderName = endpoints?.speaker?.name;
  if (
    typeof captureName !== "string" ||
    captureName.length === 0 ||
    typeof renderName !== "string" ||
    renderName.length === 0
  ) {
    throw new Error(
      "Meeting quick setup requires microphone and speaker names",
    );
  }
  return { captureName, renderName };
}

export class MeetingSetupController {
  #adapter;
  #platform;
  #store;

  constructor({ adapter, platform = process.platform, store }) {
    this.#adapter = adapter;
    this.#platform = platform;
    this.#store = store;
  }

  async apply({ app, endpoints, restoreOnStop = true }) {
    if (this.#platform !== "win32") {
      return manualResult({ app, endpoints, reason: "windows-only" });
    }

    const detected = await this.#adapter.detect(app);
    if (!detected.supported) {
      return manualResult({ app, endpoints, reason: "adapter-unsupported" });
    }
    if (!detected.installed) {
      return manualResult({ app, endpoints, reason: "app-not-installed" });
    }
    if (!detected.running) {
      return manualResult({ app, endpoints, reason: "app-not-running" });
    }

    let desired;
    try {
      desired = await this.#adapter.resolve(endpointNames(endpoints));
    } catch {
      return manualResult({
        app,
        endpoints,
        reason: "native-endpoint-not-found",
      });
    }

    const snapshot = await this.#adapter.snapshot();
    if (restoreOnStop) await this.#store.save({ app, snapshot });
    else await this.#store.clear();
    try {
      await this.#adapter.apply(desired);
      const current = await this.#adapter.current();
      if (
        current.captureId !== desired.captureId ||
        current.renderId !== desired.renderId
      ) {
        const restored = await this.#restoreAfterFailure(snapshot);
        return manualResult({
          app,
          endpoints,
          reason: restored.restored ? "verification-failed" : "restore-failed",
        });
      }
    } catch {
      const restored = await this.#restoreAfterFailure(snapshot);
      return manualResult({
        app,
        endpoints,
        reason: restored.restored ? "apply-failed" : "restore-failed",
      });
    }

    return {
      app,
      meetingAppUsage: "unverified",
      microphoneName: endpoints.microphone.name,
      speakerName: endpoints.speaker.name,
      state: "windows-defaults-updated",
      verification: "communication-defaults-updated",
    };
  }

  async #restoreAfterFailure(snapshot) {
    try {
      await this.#adapter.restore(snapshot);
      await this.#store.clear();
      return { restored: true };
    } catch {
      // Keep the snapshot so the next app start can retry the restore.
      return { restored: false, reason: "restore-failed" };
    }
  }

  async restore() {
    if (this.#platform !== "win32") return { restored: false };
    const saved = await this.#store.load();
    if (!saved?.snapshot) return { restored: false };
    try {
      await this.#adapter.restore(saved.snapshot);
      await this.#store.clear();
      return { restored: true };
    } catch {
      return { restored: false, reason: "restore-failed" };
    }
  }

  async restorePending() {
    if (this.#platform !== "win32") return { restored: false };
    return this.restore();
  }

  async openManualSettings(app) {
    await this.#adapter.openSettings(app);
    return { app, opened: true };
  }
}
