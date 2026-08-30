import {
  mkdir,
  readFile as defaultReadFile,
  rm,
  writeFile as defaultWriteFile,
} from "node:fs/promises";
import { join } from "node:path";

export class JsonFileStore {
  #directory;
  #fileName;
  #invalidResult;
  #normalize;
  #readFile;
  #rm;
  #validationMessage;
  #writeFile;

  constructor({
    directory,
    fileName,
    invalidResult,
    normalize,
    readFile = defaultReadFile,
    rm: remove = rm,
    validationMessage,
    writeFile = defaultWriteFile,
  }) {
    this.#directory = directory;
    this.#fileName = fileName;
    this.#invalidResult = invalidResult;
    this.#normalize = normalize;
    this.#readFile = readFile;
    this.#rm = remove;
    this.#validationMessage = validationMessage;
    this.#writeFile = writeFile;
  }

  async load() {
    try {
      return (
        this.#normalize(
          JSON.parse(await this.#readFile(this.#path(), "utf8")),
        ) ?? this.#invalidResult
      );
    } catch (error) {
      return error?.code === "ENOENT" ? undefined : this.#invalidResult;
    }
  }

  async save(value) {
    const normalized = this.#normalize(value);
    if (!normalized) throw new Error(this.#validationMessage);
    await mkdir(this.#directory, { recursive: true });
    await this.#writeFile(
      this.#path(),
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8",
    );
    return normalized;
  }

  async clear() {
    await this.#rm(this.#path(), { force: true });
  }

  #path() {
    return join(this.#directory, this.#fileName);
  }
}
