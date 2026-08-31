export class DirectionalAudioOutput {
  #audio;
  #context;
  #createAudioContext;
  #createAudioElement;
  #gain;
  #muted = false;
  #sinkId;
  #source;
  #stream;

  constructor({
    createAudioContext = () => new AudioContext(),
    createAudioElement = () => {
      const audio = document.createElement("audio");
      audio.hidden = true;
      audio.playsInline = true;
      document.body.append(audio);
      return audio;
    },
    sinkId,
  } = {}) {
    if (typeof sinkId !== "string" || !sinkId) {
      throw new Error("AUDIO_OUTPUT_SINK_REQUIRED");
    }
    this.#createAudioContext = createAudioContext;
    this.#createAudioElement = createAudioElement;
    this.#sinkId = sinkId;
  }

  async prepare() {
    if (this.#context) return;
    const context = this.#createAudioContext();
    try {
      if (typeof context?.setSinkId !== "function") {
        throw new Error("AUDIO_OUTPUT_SINK_UNSUPPORTED");
      }
      await context.setSinkId(this.#sinkId);
      if (context.sinkId !== this.#sinkId) {
        throw new Error("AUDIO_OUTPUT_SINK_MISMATCH");
      }
      const gain = context.createGain();
      gain.gain.value = this.#muted ? 0 : 1;
      this.#context = context;
      this.#gain = gain;
    } catch (error) {
      await context?.close?.().catch(() => {});
      throw error;
    }
  }

  async attach(stream) {
    if (!this.#context || !this.#gain) {
      throw new Error("AUDIO_OUTPUT_NOT_PREPARED");
    }
    if (this.#source) throw new Error("AUDIO_OUTPUT_ALREADY_ATTACHED");
    const source = this.#context.createMediaStreamSource(stream);
    source.connect(this.#gain);
    this.#gain.connect(this.#context.destination);
    const audio = this.#createAudioElement();
    audio.muted = true;
    audio.srcObject = stream;
    this.#audio = audio;
    await audio.play();
    await this.#context.resume();
    this.#source = source;
    this.#stream = stream;
  }

  setMuted(muted) {
    this.#muted = Boolean(muted);
    if (this.#gain) this.#gain.gain.value = this.#muted ? 0 : 1;
  }

  async close() {
    const context = this.#context;
    if (!context) return;
    this.#context = undefined;
    this.#audio?.pause();
    if (this.#audio) {
      this.#audio.srcObject = null;
      this.#audio.remove();
    }
    try {
      this.#source?.disconnect();
    } catch {}
    try {
      this.#gain?.disconnect();
    } catch {}
    for (const track of this.#stream?.getAudioTracks?.() ?? []) track.stop();
    this.#audio = undefined;
    this.#source = undefined;
    this.#gain = undefined;
    this.#stream = undefined;
    await context.close();
  }
}
