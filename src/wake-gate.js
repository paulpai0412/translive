const DEFAULT_PHRASE = "translive";

const COMMAND_PATTERNS = Object.freeze([
  { command: "speak-conclusions", pattern: /^(口播結論|播報結論|播結論|read (the )?(conclusions?|summary))$/i },
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhrase(value) {
  const phrase = String(value ?? "").trim();
  return phrase.length > 0 && phrase.length <= 40 ? phrase : DEFAULT_PHRASE;
}

function phrasePattern(phrase) {
  // Separator after the phrase is optional so Chinese wake words like
  // 小泥小泥 work without a comma: 「小泥小泥預算多少」.
  return new RegExp(`^(?:hey |ok )?${escapeRegExp(phrase)}[，,\\s]*(.+)$`, "is");
}

// Text-level wake gate. This is a cost/false-trigger gate, not a security
// boundary: only final transcripts from the local microphone ("me") can
// trigger, and the controller suspends the gate while an answer is pending
// or playing so the assistant can never re-trigger on its own voice.
export class WakeGate {
  #armed;
  #pattern;
  #phrase;
  #suspended = false;

  constructor({ armed = false, phrase } = {}) {
    this.#armed = Boolean(armed);
    this.setPhrase(phrase);
  }

  setArmed(armed) {
    this.#armed = Boolean(armed);
  }

  setPhrase(phrase) {
    this.#phrase = normalizePhrase(phrase ?? this.#phrase);
    this.#pattern = phrasePattern(this.#phrase);
  }

  suspend() {
    this.#suspended = true;
  }

  resume() {
    this.#suspended = false;
  }

  onFinalTranscript({ source, text } = {}) {
    if (!this.#armed || this.#suspended || source !== "me") return null;
    const match = this.#pattern.exec(String(text ?? "").trim());
    if (!match) return null;
    const question = match[1].replace(/^[，,\s]+/, "").trim();
    if (question.length === 0) return null;
    for (const { command, pattern } of COMMAND_PATTERNS) {
      if (pattern.test(question)) return { type: "command", command };
    }
    return { type: "question", question };
  }
}
