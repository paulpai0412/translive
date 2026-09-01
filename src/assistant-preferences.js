import { mkdir, readFile as defaultReadFile, writeFile as defaultWriteFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULTS = Object.freeze({
  answerDelivery: "review",
  wakeArmed: true,
});

function normalize(value) {
  return {
    answerDelivery: value?.answerDelivery === "auto" ? "auto" : "review",
    wakeArmed: value?.wakeArmed !== false,
  };
}

// Meeting assistant settings. "review" (default) holds every generated answer
// until the user sends it; "auto" speaks answers into the meeting immediately.
export class AssistantPreferences {
  #directory;
  #readFile;
  #writeFile;

  constructor({
    directory,
    readFile = defaultReadFile,
    writeFile = defaultWriteFile,
  }) {
    this.#directory = directory;
    this.#readFile = readFile;
    this.#writeFile = writeFile;
  }

  async load() {
    try {
      return normalize(JSON.parse(await this.#readFile(this.#path(), "utf8")));
    } catch {
      return { ...DEFAULTS };
    }
  }

  async save(value) {
    const preferences = normalize(value);
    await mkdir(this.#directory, { recursive: true });
    await this.#writeFile(
      this.#path(),
      `${JSON.stringify(preferences, null, 2)}\n`,
      "utf8",
    );
    return preferences;
  }

  #path() {
    return join(this.#directory, "assistant-preferences.json");
  }
}
