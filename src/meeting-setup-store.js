import { mkdir, readFile as defaultReadFile, rm, writeFile as defaultWriteFile } from "node:fs/promises";
import { join } from "node:path";

function normalize(value) {
  if (
    !["teams", "zoom"].includes(value?.app) ||
    typeof value?.snapshot?.captureId !== "string" ||
    typeof value?.snapshot?.renderId !== "string"
  ) {
    return undefined;
  }
  return {
    app: value.app,
    snapshot: {
      captureId: value.snapshot.captureId,
      renderId: value.snapshot.renderId,
    },
  };
}

export class MeetingSetupStore {
  #directory;
  #readFile;
  #rm;
  #writeFile;

  constructor({
    directory,
    readFile = defaultReadFile,
    rm: remove = rm,
    writeFile = defaultWriteFile,
  }) {
    this.#directory = directory;
    this.#readFile = readFile;
    this.#rm = remove;
    this.#writeFile = writeFile;
  }

  async load() {
    try {
      return normalize(JSON.parse(await this.#readFile(this.#path(), "utf8")));
    } catch {
      return undefined;
    }
  }

  async save(value) {
    const snapshot = normalize(value);
    if (!snapshot) throw new Error("Invalid meeting device restore snapshot");
    await mkdir(this.#directory, { recursive: true });
    await this.#writeFile(
      this.#path(),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
    return snapshot;
  }

  async clear() {
    await this.#rm(this.#path(), { force: true });
  }

  #path() {
    return join(this.#directory, "meeting-device-restore.json");
  }
}
