import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { assertPrivateLocalDirectory } from "./private-local-storage.js";

export const VOICE_PROFILE_CONSENT_VERSION = 1;
export const RVC_PINNED_TRAINER_COMMIT =
  "81eed5e8f68b6bed1789f682fe78cdd324495afc";

const ID_PATTERN = /^vp_[A-Za-z0-9_-]{1,96}$/;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_MODEL_BYTES = 4 * 1024 * 1024 * 1024;
const PROFILE_MANIFEST_VERSION = 1;
const PICKER_IMPORT_PROVENANCE = "picker-import";
const VERIFIED_PROVENANCE = "rvc-local-trainer";
const VERIFIED_SCHEMA = "rvc-checkpoint-v2";
const ATTESTATION_FILE = ".profile-attestation.key";
const ATTESTATION_ALGORITHM = "hmac-sha256";

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

function finalConsentFrom(value) {
  if (
    value?.version !== VOICE_PROFILE_CONSENT_VERSION ||
    !Number.isSafeInteger(value?.confirmedAtMs) ||
    value.confirmedAtMs <= 0
  ) {
    fail("FINAL_CONSENT_REQUIRED");
  }
  return {
    confirmedAtMs: value.confirmedAtMs,
    version: value.version,
  };
}

function verificationFrom(value) {
  if (
    value?.schema !== VERIFIED_SCHEMA ||
    !Number.isSafeInteger(value?.tensorCount) ||
    value.tensorCount < 1 ||
    !Number.isSafeInteger(value?.configLength) ||
    value.configLength < 8 ||
    !Number.isSafeInteger(value?.verifiedAtMs) ||
    value.verifiedAtMs <= 0
  ) {
    return undefined;
  }
  try {
    return {
      configLength: value.configLength,
      outputHash: sha256(value.outputHash),
      schema: value.schema,
      tensorCount: value.tensorCount,
      verifiedAtMs: value.verifiedAtMs,
    };
  } catch {
    return undefined;
  }
}

function isInside(root, candidate) {
  if (!root) return false;
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  );
}

function isReparsePoint(info) {
  return (
    info?.isSymbolicLink?.() === true ||
    info?.isReparsePoint === true ||
    (Number.isSafeInteger(info?.mode) && (info.mode & 0o170000) === 0o120000)
  );
}

async function assertNoReparse(path, { directory = false } = {}) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    fail("LOCAL_ARTIFACT_UNAVAILABLE");
  }
  if (
    isReparsePoint(info) ||
    (directory ? !info.isDirectory() : !info.isFile())
  ) {
    fail("LOCAL_ARTIFACT_UNSAFE");
  }
  return info;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function attestationPayload(manifest) {
  const { attestation: _attestation, ...payload } = manifest;
  return canonicalJson(payload);
}

function attestationFrom(value) {
  if (
    value?.algorithm !== ATTESTATION_ALGORITHM ||
    typeof value?.value !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.value)
  ) {
    return undefined;
  }
  return { algorithm: ATTESTATION_ALGORITHM, value: value.value.toLowerCase() };
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
      value.trainer.provenance === VERIFIED_PROVENANCE &&
      value.trainer.weightsOnlyRequired === true;
    if (pickerImport || legacyPickerImport) {
      return {
        ...normalized,
        provenance: PICKER_IMPORT_PROVENANCE,
        state: "unverified",
      };
    }
    const verification = verificationFrom(value?.verification);
    if (
      value?.state === "verified" &&
      value?.provenance === VERIFIED_PROVENANCE &&
      value?.trainer?.commit === RVC_PINNED_TRAINER_COMMIT &&
      value.trainer.weightsOnlyRequired === true &&
      verification &&
      verification.outputHash === normalized.artifacts.model.sha256
    ) {
      return {
        ...normalized,
        provenance: VERIFIED_PROVENANCE,
        state: "verified",
        trainer: {
          commit: RVC_PINNED_TRAINER_COMMIT,
          provenance: VERIFIED_PROVENANCE,
          weightsOnlyRequired: true,
        },
        verification,
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
    const info = await assertNoReparse(path);
    if (info.size <= 0 || info.size > MAX_MODEL_BYTES) {
      fail("INVALID_LOCAL_ARTIFACT");
    }
  } catch (error) {
    if (String(error?.message ?? "").startsWith("VOICE_PROFILE_")) throw error;
    fail("LOCAL_ARTIFACT_UNAVAILABLE");
  }
}

function sameFileIdentity(left, right) {
  return (
    left?.dev === right?.dev &&
    left?.ino === right?.ino &&
    left?.size === right?.size
  );
}

/**
 * Copies from one already-pinned, regular source handle into an exclusive
 * private staging file. On Windows Node lacks an O_NOFOLLOW implementation,
 * so callers must supply a native final-path/file-id adapter or fail closed.
 */
async function moveRegularFileNoFollow(source, destination) {
  await assertImportableFile(source);
  try {
    await rename(source, destination);
    await assertNoReparse(destination);
    return fileHash(destination);
  } catch (error) {
    if (String(error?.message ?? "").startsWith("VOICE_PROFILE_")) throw error;
    fail("COPY_FAILED");
  }
}

export async function copyNoFollow(
  source,
  destination,
  {
    inspectWindowsHandle,
    lstatFile = lstat,
    noFollow = constants.O_NOFOLLOW,
    openFile = open,
    platform = process.platform,
  } = {},
) {
  const supportsNoFollow = Number.isSafeInteger(noFollow);
  if (!supportsNoFollow) fail("NOFOLLOW_UNAVAILABLE");
  if (platform === "win32" && typeof inspectWindowsHandle !== "function") {
    // Node's Windows binding currently exposes no O_NOFOLLOW. Do not turn an
    // arbitrary picker path into a trusted artifact without a native handle
    // inspector that validates final path and volume/file identity.
    fail("NOFOLLOW_UNAVAILABLE");
  }
  let before;
  try {
    before = await lstatFile(source);
    if (
      isReparsePoint(before) ||
      !before.isFile() ||
      before.size <= 0 ||
      before.size > MAX_MODEL_BYTES
    ) {
      fail("LOCAL_ARTIFACT_UNSAFE");
    }
  } catch (error) {
    if (String(error?.message ?? "").startsWith("VOICE_PROFILE_")) throw error;
    fail("LOCAL_ARTIFACT_UNAVAILABLE");
  }

  let handle;
  try {
    handle = await openFile(
      source,
      constants.O_RDONLY | (supportsNoFollow ? noFollow : 0),
    );
    const opened = await handle.stat();
    const after = await lstatFile(source);
    if (
      isReparsePoint(after) ||
      !opened.isFile() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(after, opened) ||
      opened.size <= 0 ||
      opened.size > MAX_MODEL_BYTES
    ) {
      fail("LOCAL_ARTIFACT_UNSAFE");
    }
    if (platform === "win32") {
      // A Windows native adapter must return the handle's final path and
      // volume/file identity. The before/open/after checks reject replacement
      // races; the final-path check rejects an opened reparse target.
      if (
        !Number.isSafeInteger(opened.dev) ||
        !Number.isSafeInteger(opened.ino)
      ) {
        fail("NOFOLLOW_UNAVAILABLE");
      }
      const expectedFinalPath = await realpath(source);
      const identity = await inspectWindowsHandle({ handle, source });
      if (
        !identity ||
        identity.fileId !== `${opened.dev}:${opened.ino}` ||
        identity.finalPath !== expectedFinalPath ||
        isReparsePoint(await lstatFile(source))
      ) {
        fail("LOCAL_ARTIFACT_UNSAFE");
      }
    }
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    const digest = createHash("sha256");
    const input = createReadStream(undefined, {
      autoClose: false,
      fd: handle.fd,
    });
    input.on("data", (chunk) => digest.update(chunk));
    await pipeline(input, output);
    const stagedHash = await fileHash(destination);
    if (stagedHash !== digest.digest("hex")) fail("COPY_FAILED");
    return stagedHash;
  } catch (error) {
    if (String(error?.message ?? "").startsWith("VOICE_PROFILE_")) throw error;
    fail("COPY_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Owns sensitive, user-scope RVC artifacts. Renderer APIs receive only the
 * reduced profile view; model paths and hashes are reserved for a future
 * weights-only local sidecar and are never loaded by JavaScript.
 */
export class VoiceProfileStore {
  #attestationKey;
  #copyArtifact;
  #directory;
  #ensureStorage;
  #newId;
  #now;
  #queue = Promise.resolve();
  #trainingDirectory;
  #verifyTrainingOutput;

  constructor({
    attestationKey,
    copyArtifact = copyNoFollow,
    directory,
    ensureStorage = async () => {},
    newId = () => `vp_${randomUUID().replaceAll("-", "")}`,
    now = Date.now,
    trainingDirectory,
    verifyTrainingOutput,
  } = {}) {
    this.#attestationKey = attestationKey;
    this.#copyArtifact = copyArtifact;
    this.#directory = directory;
    this.#ensureStorage = ensureStorage;
    this.#newId = newId;
    this.#now = now;
    this.#trainingDirectory = trainingDirectory;
    this.#verifyTrainingOutput = verifyTrainingOutput;
  }

  recover() {
    return this.#serialize(async () => {
      await this.#ensureRoot();
      let recovered = false;
      for (const entry of await readdir(this.#directory, {
        withFileTypes: true,
      })) {
        if (
          entry.name.includes(".staging-") ||
          entry.name.includes(".deleting-")
        ) {
          await rm(join(this.#directory, entry.name), {
            force: true,
            recursive: true,
          });
          recovered = true;
        }
      }
      return { recovered };
    });
  }

  importProfile(request = {}) {
    return this.#serialize(() => this.#importProfile(request));
  }

  async #ensureRoot() {
    await this.#ensureStorage();
    await assertPrivateLocalDirectory({ directory: this.#directory });
    await assertNoReparse(this.#directory, { directory: true });
  }

  promoteVerifiedTraining(request = {}) {
    return this.#serialize(() => this.#promoteVerifiedTraining(request));
  }

  listProfiles() {
    return this.#serialize(async () => {
      await this.#ensureRoot();
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
        verification: { ...manifest.verification },
      };
    });
  }

  deleteProfile(id) {
    return this.#serialize(async () => {
      const safeId = profileId(id);
      const source = this.#profilePath(safeId);
      try {
        await assertNoReparse(source, { directory: true });
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

  async #loadAttestationKey() {
    if (
      Buffer.isBuffer(this.#attestationKey) &&
      this.#attestationKey.length >= 32
    ) {
      return this.#attestationKey;
    }
    await mkdir(this.#directory, { recursive: true });
    await assertNoReparse(this.#directory, { directory: true });
    const keyPath = join(this.#directory, ATTESTATION_FILE);
    try {
      const info = await lstat(keyPath);
      if (isReparsePoint(info) || !info.isFile()) fail("ATTESTATION");
      const existing = await readFile(keyPath);
      if (existing.length < 32) fail("ATTESTATION");
      this.#attestationKey = existing;
      return existing;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (String(error?.message ?? "").startsWith("VOICE_PROFILE_"))
          throw error;
        fail("ATTESTATION");
      }
    }
    const key = randomBytes(32);
    const staging = `${keyPath}.staging-${randomUUID()}`;
    try {
      await writeFile(staging, key, { flag: "wx", mode: 0o600 });
      await rename(staging, keyPath);
      await assertNoReparse(keyPath);
      this.#attestationKey = key;
      return key;
    } catch {
      await rm(staging, { force: true }).catch(() => {});
      fail("ATTESTATION");
    }
  }

  async #signManifest(manifest) {
    const key = await this.#loadAttestationKey();
    return {
      algorithm: ATTESTATION_ALGORITHM,
      value: createHmac("sha256", key)
        .update(attestationPayload(manifest))
        .digest("hex"),
    };
  }

  async #hasValidAttestation(raw) {
    const attestation = attestationFrom(raw?.attestation);
    if (!attestation) return false;
    try {
      const key = await this.#loadAttestationKey();
      const expected = createHmac("sha256", key)
        .update(attestationPayload(raw))
        .digest("hex");
      return expected === attestation.value;
    } catch {
      return false;
    }
  }

  async #importProfile(request) {
    await this.#ensureRoot();
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
      await assertNoReparse(this.#directory, { directory: true });
      await mkdir(staging);
      const modelFile = join(staging, "model.pth");
      await this.#copyArtifact(modelSourcePath, modelFile);
      const indexFile = indexSourcePath
        ? join(staging, "model.index")
        : undefined;
      if (indexSourcePath) await this.#copyArtifact(indexSourcePath, indexFile);
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
        { encoding: "utf8", flag: "wx", mode: 0o600 },
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

  async #promoteVerifiedTraining(request) {
    await this.#ensureRoot();
    if (request?.confirmedOwnAuthorizedVoice !== true) {
      fail("CONSENT_REQUIRED");
    }
    if (typeof this.#verifyTrainingOutput !== "function") {
      fail("TRAINING_VERIFICATION_REQUIRED");
    }
    const finalConsent = finalConsentFrom(request?.finalConsent);
    const displayName = boundedDisplayName(request?.displayName);
    const modelSourcePath = localSourcePath(
      request?.modelSourcePath,
      ".pth",
      "TRAINING_ARTIFACT_REQUIRED",
    );
    if (!isInside(this.#trainingDirectory, modelSourcePath)) {
      fail("TRAINING_ARTIFACT_REQUIRED");
    }
    await assertNoReparse(this.#trainingDirectory, { directory: true });
    await assertImportableFile(modelSourcePath);
    const trainingStaging = join(
      this.#trainingDirectory,
      `.promotion-staging-${randomUUID()}`,
    );
    const stagedModel = join(trainingStaging, "model.pth");
    const profileIdValue = profileId(this.#newId());
    const destination = this.#profilePath(profileIdValue);
    const staging = `${destination}.staging-${randomUUID()}`;
    try {
      await mkdir(trainingStaging, { recursive: false, mode: 0o700 });
      // Training output is already in the private app root. Atomically claim it
      // into a private staging folder; rename moves a raced symlink itself, so
      // the post-move no-reparse check fails before verification can read it.
      const stagedHash = await moveRegularFileNoFollow(
        modelSourcePath,
        stagedModel,
      );
      let verification;
      try {
        verification = await this.#verifyTrainingOutput({
          modelPath: stagedModel,
        });
      } catch {
        fail("TRAINING_VERIFICATION_FAILED");
      }
      if (
        verification?.schema !== VERIFIED_SCHEMA ||
        !Number.isSafeInteger(verification?.tensorCount) ||
        verification.tensorCount < 1 ||
        !Number.isSafeInteger(verification?.configLength) ||
        verification.configLength < 8 ||
        verification?.sha256 !== stagedHash
      ) {
        fail("TRAINING_VERIFICATION_FAILED");
      }
      if ((await fileHash(stagedModel)) !== stagedHash) {
        fail("TRAINING_ARTIFACT_TAMPERED");
      }
      await mkdir(this.#directory, { recursive: true });
      await assertNoReparse(this.#directory, { directory: true });
      await mkdir(staging);
      const modelFile = join(staging, "model.pth");
      const outputHash = await moveRegularFileNoFollow(stagedModel, modelFile);
      if (outputHash !== stagedHash) fail("TRAINING_ARTIFACT_TAMPERED");
      const unsignedManifest = {
        artifacts: {
          model: { file: "model.pth", sha256: outputHash },
        },
        consent: {
          confirmedAtMs: finalConsent.confirmedAtMs,
          version: finalConsent.version,
        },
        displayName,
        id: profileIdValue,
        provenance: VERIFIED_PROVENANCE,
        schemaVersion: PROFILE_MANIFEST_VERSION,
        state: "verified",
        trainer: {
          commit: RVC_PINNED_TRAINER_COMMIT,
          provenance: VERIFIED_PROVENANCE,
          weightsOnlyRequired: true,
        },
        verification: {
          configLength: verification.configLength,
          outputHash,
          schema: VERIFIED_SCHEMA,
          tensorCount: verification.tensorCount,
          verifiedAtMs: Math.round(this.#now()),
        },
      };
      const manifest = {
        ...unsignedManifest,
        attestation: await this.#signManifest(unsignedManifest),
      };
      await writeFile(
        join(staging, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(staging, destination);
      const normalized = await this.#readManifest(profileIdValue);
      if (!normalized) fail("TRAINING_VERIFICATION_FAILED");
      return publicProfile(normalized);
    } catch (error) {
      await rm(staging, { force: true, recursive: true }).catch(() => {});
      if (String(error?.message ?? "").startsWith("VOICE_PROFILE_")) {
        throw error;
      }
      fail("TRAINING_PROMOTION_FAILED");
    } finally {
      await rm(trainingStaging, { force: true, recursive: true }).catch(
        () => {},
      );
    }
  }

  async #requiredManifest(id) {
    const manifest = await this.#readManifest(profileId(id));
    if (!manifest) fail("NOT_FOUND");
    return manifest;
  }

  async #readManifest(id) {
    try {
      const folder = this.#profilePath(id);
      await assertNoReparse(folder, { directory: true });
      const manifestPath = join(folder, "manifest.json");
      await assertNoReparse(manifestPath);
      const raw = JSON.parse(await readFile(manifestPath, "utf8"));
      const manifest = manifestFrom(raw);
      if (!manifest) return undefined;
      if (
        manifest.state === "verified" &&
        !(await this.#hasValidAttestation(raw))
      ) {
        // Legacy or manually altered local profiles stay discoverable and
        // deletable after upgrade, but are never executable without a fresh
        // trusted local-training promotion.
        return {
          ...manifest,
          provenance: PICKER_IMPORT_PROVENANCE,
          state: "unverified",
        };
      }
      return manifest;
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
        const path = join(folder, artifact.file);
        await assertNoReparse(path);
        if ((await fileHash(path)) !== artifact.sha256) {
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
