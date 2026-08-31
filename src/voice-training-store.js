import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { assertPrivateLocalDirectory } from "./private-local-storage.js";
import {
  VOICE_TRAINING_POLICY,
  validateVoiceTrainingInspection,
  validateVoiceTrainingRecording,
} from "./voice-training-policy.js";

const ID_PATTERN = /^vt_[A-Za-z0-9_-]{1,96}$/;
const NAME_LIMIT = 80;
const MICROPHONE_LABEL_LIMIT = 160;
const NON_TERMINAL_STATES = new Set([
  "recording",
  "paused",
  "inspecting",
  "normalizing",
  "ready-to-train",
  "training",
]);
const TERMINAL_STATES = new Set(["verified", "failed", "canceled"]);

function fail(code) {
  throw new Error(`VOICE_TRAINING_${code}`);
}

function id(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("INVALID_ID");
  }
  return value;
}

function boundedText(value, maximum, code) {
  if (typeof value !== "string") fail(code);
  const text = value.replace(/[\r\n\t]/g, " ").trim();
  if (!text || Array.from(text).length > maximum) fail(code);
  return text;
}

function integer(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function isReparsePoint(info) {
  return (
    info?.isSymbolicLink?.() === true ||
    info?.isReparsePoint === true ||
    (Number.isSafeInteger(info?.mode) && (info.mode & 0o170000) === 0o120000)
  );
}

async function assertDirectory(path, code = "STORAGE_UNSAFE") {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || isReparsePoint(info)) fail(code);
    return info;
  } catch (error) {
    if (String(error?.message ?? "").startsWith("VOICE_TRAINING_")) {
      throw error;
    }
    fail(code);
  }
}

async function assertRegularFile(path, code = "STORAGE_UNSAFE") {
  try {
    const info = await lstat(path);
    if (!info.isFile() || isReparsePoint(info)) fail(code);
    return info;
  } catch (error) {
    if (String(error?.message ?? "").startsWith("VOICE_TRAINING_")) {
      throw error;
    }
    fail(code);
  }
}

function finalConsent(value) {
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value?.confirmedAtMs) ||
    value.confirmedAtMs <= 0
  ) {
    fail("FINAL_CONSENT_REQUIRED");
  }
  return { confirmedAtMs: value.confirmedAtMs, version: value.version };
}

function safeSession(session) {
  if (session?.state === "idle") return { state: "idle" };
  const safe = {
    displayName: session.displayName,
    elapsedDurationMs: session.elapsedDurationMs ?? 0,
    id: session.id,
    progress: session.progress ?? 0,
    provider: session.provider,
    stage: session.stage,
    state: session.state,
    targetDurationMs: session.targetDurationMs,
  };
  return Object.fromEntries(
    Object.entries(safe).filter(([, value]) => value !== undefined),
  );
}

function normalizeSession(value, policy) {
  if (!value || typeof value !== "object") return undefined;
  try {
    const state = String(value.state ?? "");
    if (![...NON_TERMINAL_STATES, ...TERMINAL_STATES].includes(state)) {
      return undefined;
    }
    const normalized = {
      createdAtMs: integer(value.createdAtMs, "INVALID_SESSION"),
      displayName: boundedText(value.displayName, NAME_LIMIT, "INVALID_SESSION"),
      elapsedDurationMs: integer(value.elapsedDurationMs ?? 0, "INVALID_SESSION"),
      id: id(value.id),
      microphoneLabel: boundedText(
        value.microphoneLabel,
        MICROPHONE_LABEL_LIMIT,
        "INVALID_SESSION",
      ),
      progress: integer(value.progress ?? 0, "INVALID_SESSION"),
      state,
      targetDurationMs: integer(value.targetDurationMs, "INVALID_SESSION"),
    };
    if (normalized.targetDurationMs !== policy.targetDurationMs) return undefined;
    if (normalized.progress > 100) return undefined;
    if (typeof value.provider === "string") {
      normalized.provider = boundedText(value.provider, 64, "INVALID_SESSION");
    }
    if (typeof value.stage === "string") {
      normalized.stage = boundedText(value.stage, 64, "INVALID_SESSION");
    }
    if (value.finalConsent) normalized.finalConsent = finalConsent(value.finalConsent);
    if (value.inspection) {
      normalized.inspection = validateVoiceTrainingInspection(
        value.inspection,
        policy,
      );
      normalized.elapsedDurationMs = normalized.inspection.durationMs;
    }
    return normalized;
  } catch {
    return undefined;
  }
}

/**
 * Keeps sensitive own-voice training work in a private local directory.
 * Every nonterminal session is destructive-recovery-only: a restart never
 * resumes or silently retains raw own-voice audio.
 */
export class VoiceTrainingStore {
  #active;
  #directory;
  #ensureStorage;
  #last = { state: "idle" };
  #newId;
  #now;
  #policy;
  #queue = Promise.resolve();

  constructor({
    directory,
    ensureStorage = async () => {},
    newId = () => `vt_${randomUUID().replaceAll("-", "")}`,
    now = Date.now,
    policy = VOICE_TRAINING_POLICY,
  } = {}) {
    this.#directory = directory;
    this.#ensureStorage = ensureStorage;
    this.#newId = newId;
    this.#now = now;
    this.#policy = policy;
  }

  recover() {
    return this.#serialize(() => this.#recover());
  }

  start(request = {}) {
    return this.#serialize(() => this.#start(request));
  }

  pause(sessionId) {
    return this.#serialize(() => this.#setRecordingState(sessionId, "paused"));
  }

  resume(sessionId) {
    return this.#serialize(() => this.#setRecordingState(sessionId, "recording"));
  }

  acceptRecording(sessionId, payload) {
    return this.#serialize(() => this.#stageRecording(sessionId, payload));
  }

  commitNormalized(sessionId, inspection) {
    return this.#serialize(() => this.#commitNormalized(sessionId, inspection));
  }

  paths(sessionId) {
    return this.#serialize(async () => {
      const session = this.#requireActive(sessionId);
      const folder = this.#sessionPath(session.id);
      await assertDirectory(folder);
      return {
        inputPath: this.#stagedInputPath(session.id),
        normalizedPath: this.#stagedNormalizedPath(session.id),
        outputPath: this.#outputPath(session.id),
      };
    });
  }

  beginTraining(sessionId, provider, consent) {
    return this.#serialize(() => this.#beginTraining(sessionId, provider, consent));
  }

  updateTraining(sessionId, update = {}) {
    return this.#serialize(() => this.#updateTraining(sessionId, update));
  }

  completeVerified(sessionId) {
    return this.#serialize(() => this.#complete(sessionId, "verified"));
  }

  fail(sessionId, reason = "training-failed") {
    return this.#serialize(() => this.#complete(sessionId, "failed", reason));
  }

  cancel(sessionId) {
    return this.#serialize(() => this.#cancel(sessionId));
  }

  delete(sessionId) {
    return this.#serialize(() => this.#delete(sessionId));
  }

  status() {
    return this.#serialize(async () => safeSession(this.#active ?? this.#last));
  }

  async #ensureRoot() {
    try {
      await this.#ensureStorage();
      await assertPrivateLocalDirectory({ directory: this.#directory });
      await assertDirectory(this.#directory);
    } catch {
      fail("STORAGE_UNSAFE");
    }
  }

  async #recover() {
    await this.#ensureRoot();
    let recovered = false;
    const abandonedSessionIds = [];
    for (const entry of await readdir(this.#directory, { withFileTypes: true })) {
      const path = join(this.#directory, entry.name);
      if (
        entry.name.includes(".staging-") ||
        entry.name.includes(".deleting-")
      ) {
        await rm(path, { force: true, recursive: true });
        recovered = true;
        continue;
      }
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        await assertDirectory(path);
        const raw = JSON.parse(
          await readFile(join(path, "session.json"), "utf8"),
        );
        const session = normalizeSession(raw, this.#policy);
        if (!session || NON_TERMINAL_STATES.has(session.state)) {
          abandonedSessionIds.push(entry.name);
          await this.#removeAtomically(entry.name);
          recovered = true;
        }
      } catch {
        abandonedSessionIds.push(entry.name);
        await rm(path, { force: true, recursive: true });
        recovered = true;
      }
    }
    this.#active = undefined;
    this.#last = { state: "idle" };
    return { abandonedSessionIds, recovered };
  }

  async #start(request) {
    await this.#ensureRoot();
    if (this.#active && NON_TERMINAL_STATES.has(this.#active.state)) {
      fail("ACTIVE_SESSION");
    }
    if (request.confirmedOwnAuthorizedVoice !== true) fail("CONSENT_REQUIRED");
    const session = {
      createdAtMs: Math.round(this.#now()),
      displayName: boundedText(request.displayName, NAME_LIMIT, "INVALID_NAME"),
      elapsedDurationMs: 0,
      id: id(this.#newId()),
      microphoneLabel: boundedText(
        request.microphoneLabel,
        MICROPHONE_LABEL_LIMIT,
        "INVALID_MICROPHONE",
      ),
      progress: 0,
      state: "recording",
      targetDurationMs: this.#policy.targetDurationMs,
    };
    await mkdir(this.#sessionPath(session.id), { recursive: false, mode: 0o700 });
    await assertDirectory(this.#sessionPath(session.id));
    await this.#writeSession(session);
    this.#active = session;
    this.#last = { state: "idle" };
    return safeSession(session);
  }

  async #setRecordingState(sessionId, next) {
    const session = this.#requireActive(sessionId);
    if (
      (next === "paused" && session.state !== "recording") ||
      (next === "recording" && session.state !== "paused")
    ) {
      fail("STATE");
    }
    session.state = next;
    await this.#writeSession(session);
    return safeSession(session);
  }

  async #stageRecording(sessionId, payload) {
    const session = this.#requireActive(sessionId);
    if (!["recording", "paused"].includes(session.state)) fail("STATE");
    const recording = validateVoiceTrainingRecording(payload, this.#policy);
    session.state = "inspecting";
    await this.#writeBytesAtomically(
      this.#stagedInputPath(session.id),
      recording.bytes,
    );
    await this.#writeSession(session);
    return {
      inputPath: this.#stagedInputPath(session.id),
      normalizedPath: this.#stagedNormalizedPath(session.id),
      status: safeSession(session),
    };
  }

  async #commitNormalized(sessionId, inspection) {
    const session = this.#requireActive(sessionId);
    if (!['inspecting', 'normalizing'].includes(session.state)) fail("STATE");
    const validated = validateVoiceTrainingInspection(inspection, this.#policy);
    const stagedNormalized = this.#stagedNormalizedPath(session.id);
    await assertRegularFile(stagedNormalized, "NORMALIZATION");
    await rm(this.#stagedInputPath(session.id), { force: true });
    await rename(stagedNormalized, this.#normalizedPath(session.id));
    session.inspection = validated;
    session.elapsedDurationMs = validated.durationMs;
    session.state = "ready-to-train";
    await this.#writeSession(session);
    return safeSession(session);
  }

  async #beginTraining(sessionId, provider, consent) {
    const session = this.#requireActive(sessionId);
    if (session.state !== "ready-to-train") fail("STATE");
    session.finalConsent = finalConsent(consent);
    session.provider = boundedText(provider, 64, "INVALID_PROVIDER");
    session.progress = 0;
    session.stage = "queued";
    session.state = "training";
    await this.#writeSession(session);
    return safeSession(session);
  }

  async #updateTraining(sessionId, update) {
    const session = this.#requireActive(sessionId);
    if (session.state !== "training") fail("STATE");
    const progress = integer(update.progress, "INVALID_PROGRESS");
    if (progress > 100 || progress < session.progress) fail("INVALID_PROGRESS");
    session.progress = progress;
    if (update.provider !== undefined) {
      session.provider = boundedText(update.provider, 64, "INVALID_PROVIDER");
    }
    if (update.stage !== undefined) {
      session.stage = boundedText(update.stage, 64, "INVALID_STAGE");
    }
    await this.#writeSession(session);
    return safeSession(session);
  }

  async #complete(sessionId, state, reason) {
    const session = this.#requireActive(sessionId);
    if (
      (state === "verified" && session.state !== "training") ||
      (state === "failed" && !NON_TERMINAL_STATES.has(session.state))
    ) {
      fail("STATE");
    }
    session.state = state;
    session.progress = state === "verified" ? 100 : session.progress;
    if (reason) session.reason = boundedText(reason, 64, "INVALID_REASON");
    await rm(this.#stagedInputPath(session.id), { force: true });
    await rm(this.#stagedNormalizedPath(session.id), { force: true });
    await rm(this.#normalizedPath(session.id), { force: true });
    await rm(this.#outputPath(session.id), { force: true });
    await this.#writeSession(session);
    this.#last = session;
    this.#active = undefined;
    return safeSession(session);
  }

  async #cancel(sessionId) {
    const session = this.#requireActive(sessionId);
    const canceled = { ...session, state: "canceled" };
    await this.#removeAtomically(session.id);
    this.#active = undefined;
    this.#last = canceled;
    return safeSession(canceled);
  }

  async #delete(sessionId) {
    const safeId = id(sessionId);
    if (this.#active?.id === safeId) {
      await this.#cancel(safeId);
      this.#last = { state: "idle" };
    } else if (this.#last?.id === safeId) {
      if (this.#last.state !== "canceled") await this.#removeAtomically(safeId);
      this.#last = { state: "idle" };
    } else {
      await this.#removeAtomically(safeId);
    }
    return { deleted: true };
  }

  #requireActive(sessionId) {
    const safeId = id(sessionId);
    if (!this.#active || this.#active.id !== safeId) fail("NOT_FOUND");
    return this.#active;
  }

  async #writeSession(session) {
    const normalized = normalizeSession(session, this.#policy);
    if (!normalized) fail("INVALID_SESSION");
    await this.#writeBytesAtomically(
      this.#sessionManifestPath(session.id),
      Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8"),
    );
  }

  async #writeBytesAtomically(path, bytes) {
    const temporary = `${path}.staging-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async #removeAtomically(sessionId) {
    const source = this.#sessionPath(sessionId);
    const deleted = `${source}.deleting-${randomUUID()}`;
    try {
      await assertDirectory(source);
      await rename(source, deleted);
    } catch (error) {
      if (error?.code === "ENOENT") fail("NOT_FOUND");
      if (String(error?.message ?? "").startsWith("VOICE_TRAINING_")) throw error;
      fail("DELETE_FAILED");
    }
    try {
      await rm(deleted, { force: true, recursive: true });
    } catch {
      fail("DELETE_FAILED");
    }
  }

  #sessionPath(sessionId) {
    return join(this.#directory, id(sessionId));
  }

  #sessionManifestPath(sessionId) {
    return join(this.#sessionPath(sessionId), "session.json");
  }

  #stagedInputPath(sessionId) {
    return join(this.#sessionPath(sessionId), "recording.webm.staging");
  }

  #stagedNormalizedPath(sessionId) {
    return join(this.#sessionPath(sessionId), "normalized.wav.staging");
  }

  #normalizedPath(sessionId) {
    return join(this.#sessionPath(sessionId), "normalized.wav");
  }

  #outputPath(sessionId) {
    return join(this.#sessionPath(sessionId), "output.pth");
  }

  #serialize(operation) {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => {});
    return result;
  }
}
