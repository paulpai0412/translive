import { execFile as defaultExecFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";

import { JsonFileStore } from "./json-file-store.js";

const execFile = promisify(defaultExecFile);
const ROUTE_KEYS = Object.freeze(
  [3, 4].flatMap((strip) =>
    ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3"].map(
      (bus) => `Strip[${strip}].${bus}`,
    ),
  ),
);

export const VOICEMEETER_ROUTE_TARGET = Object.freeze(
  Object.fromEntries(
    ROUTE_KEYS.map((key) => [
      key,
      key === "Strip[3].B1" || key === "Strip[4].B2" ? 1 : 0,
    ]),
  ),
);

function normalizeValues(value) {
  if (!value || typeof value !== "object") return undefined;
  const entries = [];
  for (const key of ROUTE_KEYS) {
    const item = Number(value[key]);
    if (item !== 0 && item !== 1) return undefined;
    entries.push([key, item]);
  }
  if (Object.keys(value).some((key) => !ROUTE_KEYS.includes(key))) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function normalizeCheckpoint(value) {
  if (!value || !["applying", "active"].includes(value.phase)) return undefined;
  const original = normalizeValues(value.original);
  const target = normalizeValues(value.target);
  return original && target ? { original, phase: value.phase, target } : undefined;
}

function equalValues(left, right) {
  return ROUTE_KEYS.every((key) => left?.[key] === right?.[key]);
}

export function createVoiceMeeterRoutingStore({ directory }) {
  return new JsonFileStore({
    directory,
    fileName: "voicemeeter-routing-restore.json",
    invalidResult: { invalid: true },
    normalize: normalizeCheckpoint,
    validationMessage: "Invalid VoiceMeeter routing checkpoint",
  });
}

export class VoiceMeeterRoutingAdapter {
  #platform;
  #run;
  #scriptPath;

  constructor({ platform = process.platform, run = execFile, scriptPath } = {}) {
    this.#platform = platform;
    this.#run = run;
    this.#scriptPath = scriptPath;
  }

  snapshot() {
    return this.#invoke("snapshot");
  }

  async apply() {
    await this.#invoke("apply");
  }

  async restore(values) {
    const normalized = normalizeValues(values);
    if (!normalized) throw new Error("VOICEMEETER_ROUTING_INVALID_VALUES");
    const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString(
      "base64",
    );
    await this.#invoke("restore", ["-ValuesBase64", encoded]);
  }

  async #invoke(action, extra = []) {
    if (this.#platform !== "win32") {
      throw new Error("VOICEMEETER_ROUTING_UNSUPPORTED_PLATFORM");
    }
    const { stdout } = await this.#run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.#scriptPath,
        "-Action",
        action,
        ...extra,
      ],
      { timeout: 15_000, windowsHide: true },
    );
    let result;
    try {
      result = JSON.parse(String(stdout).trim());
    } catch {
      throw new Error("VOICEMEETER_ROUTING_INVALID_RESPONSE");
    }
    if (result?.ok !== true) {
      throw new Error(result?.code || "VOICEMEETER_ROUTING_FAILED");
    }
    if (action === "snapshot") {
      const values = normalizeValues(result.values);
      if (!values) throw new Error("VOICEMEETER_ROUTING_INVALID_RESPONSE");
      return values;
    }
    return { ok: true };
  }
}

export class VoiceMeeterRoutingController {
  #adapter;
  #operation = Promise.resolve();
  #platform;
  #state = "unknown";
  #store;

  constructor({ adapter, platform = process.platform, store } = {}) {
    this.#adapter = adapter;
    this.#platform = platform;
    this.#store = store;
  }

  status() {
    return { state: this.#state };
  }

  start() {
    return this.#enqueue(() => this.#start());
  }

  restore() {
    return this.#enqueue(() => this.#restore());
  }

  async #start() {
    if (this.#platform !== "win32") return this.#setState("unsupported");
    if (this.#state === "active") return this.status();
    const pending = await this.#store.load();
    if (pending?.invalid) return this.#setState("recovery-needed");
    if (pending) {
      const recovered = await this.#reconcile(pending);
      if (!recovered.restored) return this.#setState(recovered.reason);
    }
    let original;
    try {
      original = await this.#adapter.snapshot();
      await this.#store.save({
        original,
        phase: "applying",
        target: VOICEMEETER_ROUTE_TARGET,
      });
      await this.#adapter.apply();
      const current = await this.#adapter.snapshot();
      if (!equalValues(current, VOICEMEETER_ROUTE_TARGET)) {
        throw new Error("VoiceMeeter route verification failed");
      }
      await this.#store.save({
        original,
        phase: "active",
        target: VOICEMEETER_ROUTE_TARGET,
      });
      return this.#setState("active");
    } catch {
      if (original) {
        try {
          await this.#adapter.restore(original);
          await this.#store.clear();
        } catch {
          return this.#setState("restore-failed");
        }
      }
      return this.#setState("unavailable");
    }
  }

  async #restore() {
    if (this.#platform !== "win32") return { restored: false };
    const pending = await this.#store.load();
    if (!pending) return { restored: false };
    if (pending.invalid) {
      this.#setState("recovery-needed");
      return { reason: "recovery-needed", restored: false };
    }
    const result = await this.#reconcile(pending);
    this.#setState(result.restored ? "restored" : result.reason);
    return result;
  }

  async #reconcile(checkpoint) {
    try {
      const current = await this.#adapter.snapshot();
      if (equalValues(current, checkpoint.original)) {
        await this.#store.clear();
        return { restored: true };
      }
      if (!equalValues(current, checkpoint.target)) {
        return { reason: "recovery-needed", restored: false };
      }
      await this.#adapter.restore(checkpoint.original);
      const restored = await this.#adapter.snapshot();
      if (!equalValues(restored, checkpoint.original)) {
        return { reason: "restore-failed", restored: false };
      }
      await this.#store.clear();
      return { restored: true };
    } catch {
      return { reason: "restore-failed", restored: false };
    }
  }

  #enqueue(operation) {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.catch(() => {});
    return result;
  }

  #setState(state) {
    this.#state = state;
    return this.status();
  }
}
