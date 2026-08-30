import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";

export const VOICE_PROFILE_CONSENT_VERSION = 1;
export const RVC_PINNED_TRAINER_COMMIT =
  "81eed5e8f68b6bed1789f682fe78cdd324495afc";

const ID_PATTERN = /^vp_[A-Za-z0-9_-]{1,96}$/;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_MODEL_BYTES = 4 * 1024 * 1024 * 1024;
const PROFILE_MANIFEST_VERSION = 1;
const PICKER_IMPORT_PROVENANCE = "picker-import";

function fail(code) {
  throw new Error(`VOICE_PROFILE_${code}`);
}

function isWindowsAbsolute(path) {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function localSourcePath(value, extension, missingCode) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(missingCode);
  }
  const path = value.trim();
  const networkOrDevicePath = /^(?:[\\/]{2})/.test(path);
  if (
    path.includes("\0") ||
    networkOrDevicePath ||
    path.split(/[\\/]/).includes("..") ||
    (!isAbsolute(path) && !isWindowsAbsolute(path)) ||
    (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !isWindowsAbsolute(path)) ||
    extname(path).toLowerCase() !== extension
  ) {
    fail("INVALID_LOCAL_ARTIFACT");
  }
  return path;
}

function boundedDisplayName(value) {
  if (typeof value !== "string") fail("INVALID_DISPLAY_NAME");
  const name = value.replace(/[\r\n\t]/g, " ").trim();
  if (!name || name.length > MAX_DISPLAY_NAME_LENGTH) {
    fail("INVALID_DISPLAY_NAME");
  }
  return name;
}

function profileId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("INVALID_ID");
  }
  return value;
}

function manifestFrom(value) {
  if (value?.schemaVersion !== PROFILE_MANIFEST_VERSION) return undefined;
  if (
    value?.consent?.version !== VOICE_PROFILE_CONSENT_VERSION ||
    !Number.isSafeInteger(value?.consent?.confirmedAtMs) ||
    value.consent.confirmedAtMs <= 0
  ) {
    return undefined;
  }
  try {
    const model = value?.artifacts?.model;
    const index = value?.artifacts?.index;
    if (model?.file !== "model.pth") fail("INVALID_MANIFEST");
    let normalizedIndex;
    if (index) {
      if (index.file !== "model.index") fail("INVALID_MANIFEST");
      normalizedIndex = {
        file: index.file,
        sha256: sha256(index.sha256),
      };
    }
    const normalized = {
      artifacts: {
        index: normalizedIndex,
        model: {
          file: model.file,
          sha256: sha256(model.sha256),
        },
      },
      consent: {
        confirmedAtMs: value.consent.confirmedAtMs,
        version: value.consent.version,
      },
      displayName: boundedDisplayName(value.displayName),
      id: profileId(value.id),
      schemaVersion: PROFILE_MANIFEST_VERSION,
    };
    const pickerImport =
      value?.state === "unverified" &&
      value?.provenance === PICKER_IMPORT_PROVENANCE;
    const legacyPickerImport =
      value?.state === undefined &&
      value?.trainer?.commit === RVC_PINNED_TRAINER_COMMIT &&
      value.trainer.provenance === "rvc-local-trainer" &&
      value.trainer.weightsOnlyRequired === true;
    if (pickerImport || legacyPickerImport) {
      return {
        ...normalized,
        provenance: PICKER_IMPORT_PROVENANCE,
        state: "unverified",
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    fail("INVALID_MANIFEST");
  }
  return value.toLowerCase();
}

function publicProfile(manifest) {
  return {
    consentVersion: manifest.consent.version,
    displayName: manifest.displayName,
    id: manifest.id,
    state: manifest.state,
  };
}

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertImportableFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_MODEL_BYTES) {
      fail("INVALID_LOCAL_ARTIFACT");
    }
  } catch (error) {
    if (String(error?.message ?? "").startsWith("VOICE_PROFILE_")) throw error;
    fail("LOCAL_ARTIFACT_UNAVAILABLE");
  }
}

/**
 * Owns sensitive, user-scope RVC artifacts. Renderer APIs receive only the
 * reduced profile view; model paths and hashes are reserved for a future
 * weights-only local sidecar and are never loaded by JavaScript.
 */
export class VoiceProfileStore {
  #directory;
  #newId;
  #now;
  #queue = Promise.resolve();

  constructor({
    directory,
    newId = () => `vp_${randomUUID().replaceAll("-", "")}`,
    now = Date.now,
  } = {}) {
    this.#directory = directory;
    this.#newId = newId;
    this.#now = now;
  }

  importProfile(request = {}) {
    return this.#serialize(() => this.#importProfile(request));
  }

  listProfiles() {
    return this.#serialize(async () => {
      let entries;
      try {
        entries = await readdir(this.#directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        fail("STORE_UNAVAILABLE");
      }
      const profiles = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
        const manifest = await this.#readManifest(entry.name);
        if (manifest) profiles.push(publicProfile(manifest));
      }
      return profiles.sort((left, right) =>
        left.displayName.localeCompare(right.displayName, "zh-Hant"),
      );
    });
  }

  sidecarDescriptor(id) {
    return this.#serialize(async () => {
      const manifest = await this.#requiredManifest(id);
      if (manifest.state !== "verified") fail("UNVERIFIED");
      const folder = this.#profilePath(manifest.id);
      await this.#assertArtifactHashes(manifest, folder);
      return {
        id: manifest.id,
        indexHash: manifest.artifacts.index?.sha256,
        indexPath: manifest.artifacts.index
          ? join(folder, manifest.artifacts.index.file)
          : undefined,
        modelHash: manifest.artifacts.model.sha256,
        modelPath: join(folder, manifest.artifacts.model.file),
        trainer: { ...manifest.trainer },
      };
    });
  }

  deleteProfile(id) {
    return this.#serialize(async () => {
      const safeId = profileId(id);
      const source = this.#profilePath(safeId);
      try {
        await stat(source);
      } catch {
        fail("NOT_FOUND");
      }
      const deleted = `${source}.deleting-${randomUUID()}`;
      try {
        await rename(source, deleted);
        await rm(deleted, { force: true, recursive: true });
      } catch {
        fail("DELETE_FAILED");
      }
      return { deleted: true };
    });
  }

  async #importProfile(request) {
    if (request?.confirmedOwnAuthorizedVoice !== true) {
      fail("CONSENT_REQUIRED");
    }
    const displayName = boundedDisplayName(request?.displayName);
    const modelSourcePath = localSourcePath(
      request?.modelSourcePath,
      ".pth",
      "MODEL_REQUIRED",
    );
    const indexSourcePath =
      request?.indexSourcePath === undefined || request?.indexSourcePath === ""
        ? undefined
        : localSourcePath(request.indexSourcePath, ".index", "INVALID_INDEX");
    await assertImportableFile(modelSourcePath);
    if (indexSourcePath) await assertImportableFile(indexSourcePath);

    const id = profileId(this.#newId());
    const destination = this.#profilePath(id);
    const staging = `${destination}.staging-${randomUUID()}`;
    try {
      await mkdir(this.#directory, { recursive: true });
      await mkdir(staging);
      const modelFile = join(staging, "model.pth");
      await copyFile(modelSourcePath, modelFile);
      const indexFile = indexSourcePath
        ? join(staging, "model.index")
        : undefined;
      if (indexSourcePath) await copyFile(indexSourcePath, indexFile);
      // A picker proves only storage consent. It cannot prove that a
      // pickle-like .pth is safe or came from the pinned trainer. A future
      // independent weights-only verifier must create a verified manifest.
      const manifest = {
        artifacts: {
          index: indexFile
            ? { file: "model.index", sha256: await fileHash(indexFile) }
            : undefined,
          model: { file: "model.pth", sha256: await fileHash(modelFile) },
        },
        consent: {
          confirmedAtMs: Math.round(this.#now()),
          version: VOICE_PROFILE_CONSENT_VERSION,
        },
        displayName,
        id,
        provenance: PICKER_IMPORT_PROVENANCE,
        schemaVersion: PROFILE_MANIFEST_VERSION,
        state: "unverified",
      };
      await writeFile(
        join(staging, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(staging, destination);
      return publicProfile(manifestFrom(manifest));
    } catch (error) {
      await rm(staging, { force: true, recursive: true }).catch(() => {});
      if (String(error?.message ?? "").startsWith("VOICE_PROFILE_"))
        throw error;
      fail("IMPORT_FAILED");
    }
  }

  async #requiredManifest(id) {
    const manifest = await this.#readManifest(profileId(id));
    if (!manifest) fail("NOT_FOUND");
    return manifest;
  }

  async #readManifest(id) {
    try {
      return manifestFrom(
        JSON.parse(
          await readFile(join(this.#profilePath(id), "manifest.json"), "utf8"),
        ),
      );
    } catch {
      return undefined;
    }
  }

  async #assertArtifactHashes(manifest, folder) {
    const artifacts = [
      manifest.artifacts.model,
      manifest.artifacts.index,
    ].filter(Boolean);
    try {
      for (const artifact of artifacts) {
        if ((await fileHash(join(folder, artifact.file))) !== artifact.sha256) {
          fail("ARTIFACT_TAMPERED");
        }
      }
    } catch (error) {
      if (String(error?.message ?? "") === "VOICE_PROFILE_ARTIFACT_TAMPERED") {
        throw error;
      }
      fail("ARTIFACT_TAMPERED");
    }
  }

  #profilePath(id) {
    return join(this.#directory, profileId(id));
  }

  #serialize(operation) {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => {});
    return result;
  }
}
