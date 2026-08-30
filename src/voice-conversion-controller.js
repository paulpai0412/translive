import { RVC_PINNED_TRAINER_COMMIT } from "./voice-profile-store.js";

const DIRECTIONS = new Set(["tx", "rx"]);

function safeProfile(profile) {
  return profile
    ? { displayName: profile.displayName, id: profile.id }
    : undefined;
}

function safeProfiles(profiles) {
  return profiles.map((profile) => ({
    consentVersion: profile.consentVersion,
    displayName: profile.displayName,
    id: profile.id,
    state: profile.state,
  }));
}

/**
 * Product state for an opt-in local voice conversion feature. Production is
 * intentionally constructed without a sidecar factory until an actual pinned
 * RVC runtime passes P0; test-only adapters may exercise lifecycle behavior.
 */
export class VoiceConversionController {
  #capability = { hardware: {}, provider: "unavailable", state: "unavailable" };
  #capabilityProbe;
  #descriptor;
  #enabled = false;
  #profile;
  #profiles = [];
  #profileStore;
  #reason;
  #sidecarFactory;
  #sidecars = new Map();
  #state = "checking";

  constructor({ capabilityProbe, profiles, sidecarFactory } = {}) {
    this.#capabilityProbe = capabilityProbe;
    this.#profileStore = profiles;
    this.#sidecarFactory = sidecarFactory;
  }

  async initialize() {
    this.#state = "checking";
    this.#reason = undefined;
    const [capabilityResult, profilesResult] = await Promise.allSettled([
      Promise.resolve().then(
        () => this.#capabilityProbe?.probe?.() ?? this.#capability,
      ),
      Promise.resolve().then(() => this.#profileStore?.listProfiles?.() ?? []),
    ]);
    const capability =
      capabilityResult.status === "fulfilled" && capabilityResult.value?.state
        ? capabilityResult.value
        : { hardware: {}, provider: "unavailable", state: "unavailable" };
    const profiles =
      profilesResult.status === "fulfilled" &&
      Array.isArray(profilesResult.value)
        ? profilesResult.value
        : [];
    this.#capability = capability;
    this.#profiles = safeProfiles(profiles);
    this.#enabled = false;
    this.#profile = undefined;
    this.#descriptor = undefined;
    if (capabilityResult.status !== "fulfilled") {
      this.#reason = "capability-unavailable";
      this.#state = "unavailable";
    } else if (profilesResult.status !== "fulfilled") {
      this.#reason = "profile-store-unavailable";
      this.#state = "unavailable";
    } else {
      this.#state =
        this.#capability.state === "available" ? "off" : "unavailable";
      if (this.#state === "unavailable") {
        this.#reason = "capability-unavailable";
      }
    }
    return this.status();
  }

  status() {
    const status = {
      enabled: this.#enabled,
      profile: safeProfile(this.#profile),
      profiles: safeProfiles(this.#profiles),
      provider: this.#capability.provider,
      state: this.#state,
    };
    if (this.#state === "unavailable" && this.#reason) {
      status.reason = this.#reason;
    }
    return status;
  }

  async importProfile(request) {
    const profile = await this.#profileStore.importProfile(request);
    this.#profiles = safeProfiles(await this.#profileStore.listProfiles());
    this.#profile = this.#profiles.find((item) => item.id === profile.id);
    return safeProfile(this.#profile);
  }

  async deleteProfile(id) {
    const stopFailed = await this.#stopSidecars();
    this.#enabled = false;
    this.#reason = undefined;
    if (this.#profile?.id === id) this.#profile = undefined;
    await this.#profileStore.deleteProfile(id);
    this.#profiles = safeProfiles(await this.#profileStore.listProfiles());
    if (!this.#profiles.some((profile) => profile.id === this.#profile?.id)) {
      this.#profile = undefined;
    }
    if (stopFailed) return this.#unavailable("sidecar-stop-failed");
    this.#state =
      this.#capability.state === "available" ? "off" : "unavailable";
    return this.status();
  }

  async setEnabled({ enabled, profileId } = {}) {
    const stopFailed = await this.#stopSidecars();
    this.#enabled = false;
    this.#reason = undefined;
    if (stopFailed) return this.#unavailable("sidecar-stop-failed");
    if (enabled !== true) {
      this.#state =
        this.#capability.state === "available" ? "off" : "unavailable";
      return this.status();
    }

    const selectedId =
      typeof profileId === "string" ? profileId : this.#profile?.id;
    const selected = this.#profiles.find(
      (profile) => profile.id === selectedId,
    );
    this.#profile = selected;
    if (!selected) return this.#unavailable("profile-required");
    if (selected.state !== "verified") {
      return this.#unavailable("profile-unverified");
    }
    if (this.#capability.state !== "available") {
      return this.#unavailable("capability-unavailable");
    }
    if (!this.#sidecarFactory) return this.#unavailable("runtime-unavailable");
    try {
      this.#descriptor = await this.#profileStore.sidecarDescriptor(
        selected.id,
      );
    } catch (error) {
      return this.#unavailable(
        error?.message === "VOICE_PROFILE_UNVERIFIED"
          ? "profile-unverified"
          : "profile-unavailable",
      );
    }
    if (
      this.#descriptor?.trainer?.commit !== RVC_PINNED_TRAINER_COMMIT ||
      this.#descriptor?.trainer?.provenance !== "rvc-local-trainer" ||
      this.#descriptor?.trainer?.weightsOnlyRequired !== true
    ) {
      return this.#unavailable("unsafe-model");
    }
    this.#enabled = true;
    this.#reason = undefined;
    this.#state = "ready";
    return this.status();
  }

  async startDirection(direction) {
    if (!DIRECTIONS.has(direction)) {
      throw new Error("VOICE_CONVERSION_INVALID_DIRECTION");
    }
    if (!this.#enabled || !this.#profile || !this.#descriptor) {
      return this.#failClosed("not-enabled");
    }
    try {
      let sidecar = this.#sidecars.get(direction);
      if (!sidecar) {
        sidecar = await this.#sidecarFactory({ direction });
        this.#sidecars.set(direction, sidecar);
      }
      const warm = await sidecar.warm({
        descriptor: this.#descriptor,
        profileId: this.#profile.id,
        provider: this.#capability.provider,
      });
      const health = await sidecar.health();
      if (warm?.ready !== true || health?.ready !== true) {
        return this.#failClosed("runtime-unavailable");
      }
      this.#state = "converting";
      return this.status();
    } catch {
      return this.#failClosed("runtime-unavailable");
    }
  }

  async convertFrame(direction, frame) {
    if (!DIRECTIONS.has(direction)) {
      throw new Error("VOICE_CONVERSION_INVALID_DIRECTION");
    }
    const sidecar = this.#sidecars.get(direction);
    if (!this.#enabled || !sidecar) {
      return { output: "raw", reason: "not-ready", status: this.status() };
    }
    try {
      const converted = await sidecar.frame(frame);
      if (!converted || typeof converted !== "object") {
        throw new Error("VOICE_CONVERSION_INVALID_SIDECAR_FRAME");
      }
      return { output: "converted", frame: converted };
    } catch {
      return {
        output: "raw",
        reason: "sidecar-failure",
        status: await this.#failClosed("sidecar-failure"),
      };
    }
  }

  async dispose() {
    await this.#failClosed("disposed");
  }

  rawFallback(direction, reason = "deadline-miss") {
    if (!DIRECTIONS.has(direction))
      throw new Error("VOICE_CONVERSION_INVALID_DIRECTION");
    if (!this.#enabled) return this.status();
    this.#state = "raw-fallback";
    this.#reason = reason;
    return this.status();
  }

  async #stopSidecars() {
    const results = await Promise.allSettled(
      [...this.#sidecars.values()].map((sidecar) =>
        Promise.resolve().then(() => {
          if (typeof sidecar?.stop !== "function") {
            throw new Error("VOICE_CONVERSION_SIDECAR_STOP_REQUIRED");
          }
          return sidecar.stop();
        }),
      ),
    );
    this.#sidecars.clear();
    this.#descriptor = undefined;
    return results.some((result) => result.status === "rejected");
  }

  async #failClosed(reason) {
    const stopFailed = await this.#stopSidecars();
    return this.#unavailable(stopFailed ? "sidecar-stop-failed" : reason);
  }

  #unavailable(reason) {
    this.#descriptor = undefined;
    this.#enabled = false;
    this.#reason = reason;
    this.#state = "unavailable";
    return this.status();
  }
}
