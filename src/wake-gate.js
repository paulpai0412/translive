import { pinyin } from "pinyin-pro";

const DEFAULT_PHRASE = "translive";
const FOLLOW_UP_WINDOW_MS = 4_000;
const WAKE_PREFIXES = ["hey", "ok", "hai", "hei", "wei"];
const SEPARATORS = /^(?:\s|[，,、。：:；;!！?？.．])+/;

const COMMAND_PATTERNS = Object.freeze([
  {
    command: "speak-conclusions",
    pattern: /^(口播結論|播報結論|播結論|read (the )?(conclusions?|summary))$/i,
  },
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhrase(value) {
  const phrase = String(value ?? "").trim();
  return phrase.length > 0 && phrase.length <= 40 ? phrase : DEFAULT_PHRASE;
}

// ASR drifts homophones freely (小泥→小妮, same pinyin), so matching happens
// on pinyin-normalized text, while the question is still cut from the
// original transcript.
function normalizeChar(char) {
  if (/[a-z0-9]/i.test(char)) return char.toLowerCase();
  if (/\s/.test(char) || "，,、。：:；;!！?？.．".includes(char)) return "";
  return pinyin(char, { toneType: "none", type: "array" })[0] ?? "";
}

function scan(text) {
  let normalized = "";
  const origIndex = [];
  for (let i = 0; i < text.length; i++) {
    const piece = normalizeChar(text[i]);
    for (let j = 0; j < piece.length; j++) origIndex.push(i);
    normalized += piece;
  }
  return { normalized, origIndex };
}

// Text-level wake gate. This is a cost/false-trigger gate, not a security
// boundary: only final transcripts from the local microphone ("me") can
// trigger, and the controller suspends the gate while an answer is pending
// or playing so the assistant can never re-trigger on its own voice.
export class WakeGate {
  #armed;
  #armedUntil = 0;
  #now;
  #pattern;
  #phrase;
  #phraseNorm;
  #suspended = false;

  constructor({ armed = false, phrase, now = Date.now } = {}) {
    this.#armed = Boolean(armed);
    this.#now = now;
    this.setPhrase(phrase);
  }

  setArmed(armed) {
    this.#armed = Boolean(armed);
  }

  setPhrase(phrase) {
    this.#phrase = normalizePhrase(phrase ?? this.#phrase);
    this.#phraseNorm = scan(this.#phrase).normalized;
    this.#pattern = new RegExp(
      "^(?:" +
        WAKE_PREFIXES.map(escapeRegExp).join("|") +
        ")?" +
        escapeRegExp(this.#phraseNorm),
      "i",
    );
  }

  suspend() {
    this.#suspended = true;
    this.#armedUntil = 0;
  }

  resume() {
    this.#suspended = false;
  }

  onFinalTranscript({ source, text } = {}) {
    if (!this.#armed || this.#suspended || source !== "me") return null;
    const raw = String(text ?? "").trim();
    if (raw.length === 0) return null;

    const { normalized, origIndex } = scan(raw);
    const match = this.#pattern.exec(normalized);
    if (match) {
      const endNorm = match[0].length;
      const cutOriginal = endNorm === 0 ? 0 : (origIndex[endNorm - 1] ?? 0) + 1;
      const question = raw.slice(cutOriginal).replace(SEPARATORS, "").trim();
      if (question.length === 0) {
        // Bare wake phrase: arm a short window so the question can arrive as
        // its own utterance (ASR splits on the pause after the wake word).
        this.#armedUntil = this.#now() + FOLLOW_UP_WINDOW_MS;
        return null;
      }
      this.#armedUntil = 0;
      return this.#toTrigger(question);
    }
    // Follow-up window: the wake phrase landed alone moments ago.
    if (this.#now() < this.#armedUntil) {
      this.#armedUntil = 0;
      return this.#toTrigger(raw);
    }
    return null;
  }

  #toTrigger(question) {
    for (const { command, pattern } of COMMAND_PATTERNS) {
      if (pattern.test(question)) return { type: "command", command };
    }
    return { type: "question", question };
  }
}
