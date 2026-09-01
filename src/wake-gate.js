const WAKE_PATTERN = /^(?:hey |ok )?translive[，,\s]+(.+)$/is;

const COMMAND_PATTERNS = Object.freeze([
  { command: "speak-conclusions", pattern: /^(口播結論|播報結論|播結論|read (the )?(conclusions?|summary))$/i },
]);

// Text-level wake gate. This is a cost/false-trigger gate, not a security
// boundary: only final transcripts from the local microphone ("me") can
// trigger, and the controller suspends the gate while an answer is pending
// or playing so the assistant can never re-trigger on its own voice.
export class WakeGate {
  #armed;
  #suspended = false;

  constructor({ armed = false } = {}) {
    this.#armed = Boolean(armed);
  }

  setArmed(armed) {
    this.#armed = Boolean(armed);
  }

  suspend() {
    this.#suspended = true;
  }

  resume() {
    this.#suspended = false;
  }

  onFinalTranscript({ source, text } = {}) {
    if (!this.#armed || this.#suspended || source !== "me") return null;
    const match = WAKE_PATTERN.exec(String(text ?? "").trim());
    if (!match) return null;
    const question = match[1].trim();
    if (question.length === 0) return null;
    for (const { command, pattern } of COMMAND_PATTERNS) {
      if (pattern.test(question)) return { type: "command", command };
    }
    return { type: "question", question };
  }
}
