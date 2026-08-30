import { VoiceConversionProtocolValidator } from "../src/voice-conversion-protocol.js";

/** Test-only deterministic sidecar fixture. It copies frames; it never loads or converts a voice model. */
export class FakeVoiceConversionSidecar {
  #direction;
  #stopped = false;
  #validator = new VoiceConversionProtocolValidator();
  calls = [];

  constructor({ direction }) {
    this.#direction = direction;
  }

  async warm({ profileId, provider }) {
    this.calls.push({ action: "warm", profileId, provider });
    return { ready: true };
  }

  async health() {
    this.calls.push({ action: "health" });
    return { ready: !this.#stopped };
  }

  async frame(message) {
    if (this.#stopped) throw new Error("FAKE_VOICE_SIDECAR_STOPPED");
    const frame = this.#validator.validate(message);
    if (frame.direction !== this.#direction) {
      throw new Error("FAKE_VOICE_SIDECAR_DIRECTION_MISMATCH");
    }
    this.calls.push({ action: "frame", seq: frame.seq });
    return { ...frame, payload: Buffer.from(frame.payload) };
  }

  async stop() {
    this.calls.push({ action: "stop" });
    this.#stopped = true;
    return { stopped: true };
  }
}
