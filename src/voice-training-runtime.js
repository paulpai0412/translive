import { spawn as defaultSpawn } from "node:child_process";
import { execFile as defaultExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat as defaultLstat,
  readFile as defaultReadFile,
  readdir as defaultReaddir,
  rm as defaultRm,
  stat as defaultStat,
} from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { RVC_RUNTIME_TRUST } from "./rvc-runtime-trust.js";
import {
  VOICE_TRAINING_POLICY,
  validateVoiceTrainingInspection,
} from "./voice-training-policy.js";

const execFile = promisify(defaultExecFile);
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SESSION_ID_PATTERN = /^vt_[A-Za-z0-9_-]{1,96}$/;
const PROGRESS_LIMIT = 100;
const STAGE_LIMIT = 64;
const COMMAND_OUTPUT_LIMIT = 256 * 1024;
const PACKAGED_RUNNER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/rvc-training-runtime.py",
);

export const RVC_RUNTIME_CONTRACT = Object.freeze({
  directmlVersion: "0.2.5.dev240914",
  ffmpegVersion: "9.0.1",
  hfRevision: "e6d0c1a17da07c33557852f9dfa2bd44cc75737d",
  pythonVersion: "3.12",
  rvcCommit: "81eed5e8f68b6bed1789f682fe78cdd324495afc",
  torchVersion: "2.4.1+cpu",
  version: 1,
});

function fail(code) {
  throw new Error(`VOICE_TRAINING_RUNTIME_${code}`);
}

function pathApi(root) {
  return /^[A-Za-z]:[\\/]/.test(String(root ?? "")) ||
    String(root ?? "").includes("\\")
    ? win32
    : posix;
}

function relativePath(value, code = "MANIFEST") {
  const path = String(value ?? "").replaceAll("\\", "/");
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").includes("..")
  ) {
    fail(code);
  }
  return path;
}

function hash(value, code = "MANIFEST") {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) fail(code);
  return value.toLowerCase();
}

function versionStartsWith(value, expected) {
  return typeof value === "string" && value.startsWith(expected);
}

function file(value) {
  const path = relativePath(value?.path);
  return { path, sha256: hash(value?.sha256) };
}

function sourceFiles(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 512) {
    fail("MANIFEST");
  }
  const files = value.map(file);
  if (new Set(files.map((item) => item.path)).size !== files.length) {
    fail("MANIFEST");
  }
  return files;
}

function packageRecordTreeDigest(records) {
  return createHash("sha256")
    .update(
      records.map((entry) => `${entry.path}\0${entry.sha256}\n`).join(""),
    )
    .digest("hex");
}

function packageEnvironment(value) {
  if (!value || typeof value !== "object") return undefined;
  const records = sourceFiles(value.records);
  const sitePackages = relativePath(value.sitePackages, "MANIFEST");
  const treeSha256 = hash(value.treeSha256, "MANIFEST");
  let importTree;
  if (value.importTree !== undefined) {
    const root = relativePath(value.importTree?.root, "MANIFEST");
    const fileCount = Number(value.importTree?.fileCount);
    if (
      root !== sitePackages ||
      !Number.isSafeInteger(fileCount) ||
      fileCount < 1
    ) {
      fail("MANIFEST");
    }
    importTree = {
      fileCount,
      root,
      sha256: hash(value.importTree?.sha256, "MANIFEST"),
    };
  }
  if (
    sitePackages !== ".venv/Lib/site-packages" &&
    !sitePackages.startsWith(".venv/Lib/site-packages/")
  ) {
    fail("MANIFEST");
  }
  if (packageRecordTreeDigest(records) !== treeSha256) fail("MANIFEST");
  return { importTree, records, sitePackages, treeSha256 };
}

function includeImportTreeFile(relativePath) {
  const parts = relativePath.split("/");
  return (
    !parts.includes("__pycache__") &&
    !parts.includes(".cache") &&
    !relativePath.endsWith(".pyc") &&
    !relativePath.endsWith(".pyo")
  );
}

export async function verifyPythonImportTree(
  runtimeRoot,
  expected,
  { lstat = defaultLstat, readFile = defaultReadFile, readdir = defaultReaddir } = {},
) {
  if (!expected) fail("PYTHON_IMPORT_TRUST");
  const api = pathApi(runtimeRoot);
  const root = api.join(runtimeRoot, expected.root);
  await assertNoReparsePath(root, { directory: true, lstat, root: runtimeRoot });
  const entries = [];
  async function walk(directory, prefix = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = api.join(directory, child.name);
      const info = await lstat(absolute);
      if (isReparsePoint(info)) fail("PYTHON_IMPORT_TRUST");
      if (child.isDirectory()) {
        await walk(absolute, relative);
      } else if (child.isFile() && includeImportTreeFile(relative)) {
        entries.push({ path: relative, sha256: await hashFile(absolute, readFile) });
      }
    }
  }
  await walk(root);
  entries.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
  const digest = packageRecordTreeDigest(entries);
  if (entries.length !== expected.fileCount || digest !== expected.sha256) {
    fail("PYTHON_IMPORT_TRUST");
  }
  return true;
}

function sameEntries(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.path === right[index].path && entry.sha256 === right[index].sha256,
    )
  );
}

function isReparsePoint(info) {
  return (
    info?.isSymbolicLink?.() === true ||
    info?.isReparsePoint === true ||
    (Number.isSafeInteger(info?.mode) && (info.mode & 0o170000) === 0o120000)
  );
}

function inside(root, value) {
  const api = pathApi(root);
  const resolvedRoot = api.resolve(root);
  const resolved = api.resolve(value);
  const relative = api.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || api.isAbsolute(relative)) {
    fail("PATH");
  }
  return resolved;
}

function sessionId(value) {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    fail("SESSION");
  }
  return value;
}

function trainingPath(root, value, extension) {
  const api = pathApi(root);
  const path = inside(root, value);
  if (api.extname(path).toLowerCase() !== extension) fail("PATH");
  return path;
}

function boundedProgress(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > PROGRESS_LIMIT) {
    return undefined;
  }
  return value;
}

function boundedStage(value) {
  if (typeof value !== "string") return undefined;
  const stage = value.replace(/[\r\n\t]/g, " ").trim();
  if (!stage || Array.from(stage).length > STAGE_LIMIT) return undefined;
  return stage;
}

function isolatedPythonEnvironment(runtimeRoot, environment = process.env) {
  const api = pathApi(runtimeRoot);
  const pythonDirectory = api.dirname(
    api.join(runtimeRoot, ".venv", "Scripts", "python.exe"),
  );
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  const separator = api === win32 ? ";" : ":";
  return {
    ComSpec: systemRoot ? api.join(systemRoot, "System32", "cmd.exe") : "",
    PATH: [
      pythonDirectory,
      systemRoot ? api.join(systemRoot, "System32") : undefined,
    ]
      .filter(Boolean)
      .join(separator),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHOME: "",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: "",
    PYTHONSAFEPATH: "1",
    PYTHONUSERBASE: "",
    SystemRoot: systemRoot ?? "",
    WINDIR: systemRoot ?? "",
  };
}

function assertDriveLocalRoot(value, platform) {
  if (platform !== "win32") return;
  const root = String(value ?? "");
  if (
    !/^[A-Za-z]:[\\/]/.test(root) ||
    /^\\\\/.test(root) ||
    /^\\\\[.?]\\/.test(root)
  ) {
    fail("LOCAL_ROOT");
  }
}

async function assertNoReparsePath(path, {
  directory,
  lstat = defaultLstat,
  root,
} = {}) {
  const api = pathApi(path);
  const absolute = api.resolve(path);
  const start = root ? api.resolve(root) : api.parse(absolute).root;
  const relative = api.relative(start, absolute);
  if (relative.startsWith("..") || api.isAbsolute(relative)) fail("PATH");
  let cursor = start;
  const segments = relative ? relative.split(/[\\/]/).filter(Boolean) : [];
  for (const segment of segments) {
    cursor = api.join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch {
      fail("REPARSE");
    }
    if (isReparsePoint(info)) fail("REPARSE");
  }
  let target;
  try {
    target = await lstat(absolute);
  } catch {
    fail("REPARSE");
  }
  if (isReparsePoint(target) || (directory ? !target.isDirectory() : !target.isFile())) {
    fail("REPARSE");
  }
  return absolute;
}

/**
 * Parses the mutable runtime manifest shape only. Callers must additionally
 * compare it with an app-packaged trust receipt before launching anything.
 */
export function normalizeRvcRuntimeManifest(value, { runtimeRoot } = {}) {
  if (!runtimeRoot || value?.schemaVersion !== RVC_RUNTIME_CONTRACT.version) {
    fail("MANIFEST");
  }
  const runtime = value.runtime;
  if (!runtime || typeof runtime !== "object") fail("MANIFEST");
  if (
    runtime.rvcCommit !== RVC_RUNTIME_CONTRACT.rvcCommit ||
    runtime.source?.hfRevision !== RVC_RUNTIME_CONTRACT.hfRevision ||
    runtime.assets?.hfRevision !== RVC_RUNTIME_CONTRACT.hfRevision ||
    !versionStartsWith(runtime.python?.version, RVC_RUNTIME_CONTRACT.pythonVersion) ||
    runtime.torchVersion !== RVC_RUNTIME_CONTRACT.torchVersion ||
    runtime.directmlVersion !== RVC_RUNTIME_CONTRACT.directmlVersion ||
    !versionStartsWith(runtime.ffmpeg?.version, RVC_RUNTIME_CONTRACT.ffmpegVersion)
  ) {
    fail("MANIFEST");
  }
  const api = pathApi(runtimeRoot);
  const normalized = {
    assets: {
      files: sourceFiles(runtime.assets.files),
      hfRevision: runtime.assets.hfRevision,
    },
    directmlVersion: runtime.directmlVersion,
    ffmpeg: { ...file(runtime.ffmpeg), version: runtime.ffmpeg.version },
    ffprobe: { ...file(runtime.ffprobe), version: runtime.ffprobe.version },
    python: { ...file(runtime.python), version: runtime.python.version },
    pythonEnvironment: packageEnvironment(runtime.pythonEnvironment),
    rvcCommit: runtime.rvcCommit,
    runner: file(runtime.runner),
    source: {
      files: sourceFiles(runtime.source.files),
      hfRevision: runtime.source.hfRevision,
      treeSha256: runtime.source.treeSha256
        ? hash(runtime.source.treeSha256, "MANIFEST")
        : undefined,
    },
    torchVersion: runtime.torchVersion,
  };
  for (const entry of [
    normalized.ffmpeg,
    normalized.ffprobe,
    normalized.python,
    normalized.runner,
    ...normalized.source.files,
    ...normalized.assets.files,
    ...(normalized.pythonEnvironment?.records ?? []),
  ]) {
    inside(runtimeRoot, api.join(runtimeRoot, entry.path));
  }
  return normalized;
}

function normalizeTrustedRuntime(value, { runtimeRoot } = {}) {
  return normalizeRvcRuntimeManifest(
    { schemaVersion: RVC_RUNTIME_CONTRACT.version, runtime: value },
    { runtimeRoot },
  );
}

function assertManifestMatchesTrust(manifest, trusted) {
  if (
    manifest.rvcCommit !== trusted.rvcCommit ||
    manifest.torchVersion !== trusted.torchVersion ||
    manifest.directmlVersion !== trusted.directmlVersion ||
    manifest.source.hfRevision !== trusted.source.hfRevision ||
    manifest.source.treeSha256 !== trusted.source.treeSha256 ||
    manifest.assets.hfRevision !== trusted.assets.hfRevision ||
    manifest.python.version !== trusted.python.version ||
    manifest.ffmpeg.version !== trusted.ffmpeg.version ||
    manifest.python.path !== trusted.python.path ||
    manifest.python.sha256 !== trusted.python.sha256 ||
    manifest.pythonEnvironment?.sitePackages !== trusted.pythonEnvironment?.sitePackages ||
    manifest.pythonEnvironment?.treeSha256 !== trusted.pythonEnvironment?.treeSha256 ||
    manifest.pythonEnvironment?.importTree?.root !== trusted.pythonEnvironment?.importTree?.root ||
    manifest.pythonEnvironment?.importTree?.fileCount !== trusted.pythonEnvironment?.importTree?.fileCount ||
    manifest.pythonEnvironment?.importTree?.sha256 !== trusted.pythonEnvironment?.importTree?.sha256 ||
    !sameEntries(
      manifest.pythonEnvironment?.records ?? [],
      trusted.pythonEnvironment?.records ?? [],
    ) ||
    manifest.ffmpeg.path !== trusted.ffmpeg.path ||
    manifest.ffmpeg.sha256 !== trusted.ffmpeg.sha256 ||
    manifest.ffprobe.path !== trusted.ffprobe.path ||
    manifest.ffprobe.sha256 !== trusted.ffprobe.sha256 ||
    manifest.ffprobe.version !== trusted.ffprobe.version ||
    manifest.runner.path !== trusted.runner.path ||
    manifest.runner.sha256 !== trusted.runner.sha256 ||
    !sameEntries(manifest.source.files, trusted.source.files) ||
    !sameEntries(manifest.assets.files, trusted.assets.files)
  ) {
    fail("TRUST");
  }
}

async function hashFile(path, readFile = defaultReadFile) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Rechecks the local runtime immediately before it can be used. Runtime paths
 * and hashes come only from an app-packaged trust receipt; the writable local
 * manifest must exactly match it and cannot select executables or code.
 */
export async function loadRvcRuntimeManifest({
  lstat = defaultLstat,
  manifestPath,
  platform = process.platform,
  readFile = defaultReadFile,
  runtimeRoot,
  stat = defaultStat,
  trust = RVC_RUNTIME_TRUST,
  trustedRunnerPath = PACKAGED_RUNNER_PATH,
  verifyImportTree = verifyPythonImportTree,
} = {}) {
  assertDriveLocalRoot(runtimeRoot, platform);
  const api = pathApi(runtimeRoot);
  const expectedManifest = api.join(runtimeRoot, "runtime-manifest.json");
  if (api.resolve(manifestPath ?? expectedManifest) !== api.resolve(expectedManifest)) {
    fail("MANIFEST_PATH");
  }
  await assertNoReparsePath(runtimeRoot, {
    directory: true,
    lstat,
    root: api.parse(api.resolve(runtimeRoot)).root,
  });
  let raw;
  try {
    raw = JSON.parse(await readFile(expectedManifest, "utf8"));
  } catch {
    fail("MANIFEST");
  }
  const normalized = normalizeRvcRuntimeManifest(raw, { runtimeRoot });
  if (!trust || !trustedRunnerPath) fail("TRUST");
  const trusted = normalizeTrustedRuntime(trust, { runtimeRoot });
  assertManifestMatchesTrust(normalized, trusted);
  await assertNoReparsePath(trustedRunnerPath, { lstat });
  if ((await hashFile(trustedRunnerPath, readFile)) !== trusted.runner.sha256) {
    fail("TRUST");
  }
  if (trusted.pythonEnvironment?.importTree) {
    await verifyImportTree(runtimeRoot, trusted.pythonEnvironment.importTree, {
      lstat,
      readFile,
    });
  } else if (trust === RVC_RUNTIME_TRUST) {
    fail("PYTHON_IMPORT_TRUST");
  }
  for (const entry of [
    normalized.python,
    normalized.ffmpeg,
    normalized.ffprobe,
    normalized.runner,
    ...normalized.source.files,
    ...normalized.assets.files,
    ...(normalized.pythonEnvironment?.records ?? []),
  ]) {
    const path = api.join(runtimeRoot, entry.path);
    try {
      await assertNoReparsePath(path, { lstat, root: runtimeRoot });
      const info = await stat(path);
      if (!info.isFile() || (await hashFile(path, readFile)) !== entry.sha256) {
        fail("MANIFEST");
      }
    } catch (error) {
      if (String(error?.message ?? "").startsWith("VOICE_TRAINING_RUNTIME_")) {
        throw error;
      }
      fail("MANIFEST");
    }
  }
  return raw;
}

function parseVerification(stdout) {
  let result;
  try {
    result = JSON.parse(String(stdout ?? "").trim());
  } catch {
    fail("VERIFICATION");
  }
  if (
    result?.verified !== true ||
    result?.schema !== "rvc-checkpoint-v2" ||
    !Number.isSafeInteger(result?.tensorCount) ||
    result.tensorCount < 1 ||
    !Number.isSafeInteger(result?.configLength) ||
    result.configLength < 8 ||
    typeof result?.sha256 !== "string" ||
    !HASH_PATTERN.test(result.sha256)
  ) {
    fail("VERIFICATION");
  }
  return {
    configLength: result.configLength,
    schema: result.schema,
    sha256: result.sha256.toLowerCase(),
    tensorCount: result.tensorCount,
  };
}

function parseTaggedFilterStatistics(value) {
  let meanVolume;
  let maxVolume;
  let silenceSeconds = 0;
  for (const line of String(value ?? "").split(/\r?\n/)) {
    const volume =
      /^\[Parsed_volumedetect_[^\]]+\]\s+(mean_volume|max_volume):\s*(-?[\d.]+)\s*dB$/i.exec(
        line.trim(),
      );
    if (volume) {
      const measured = Number(volume[2]);
      if (volume[1].toLowerCase() === "mean_volume") meanVolume = measured;
      else maxVolume = measured;
      continue;
    }
    const silence =
      /^\[Parsed_silencedetect_[^\]]+\].*\bsilence_duration:\s*([\d.]+)$/i.exec(
        line.trim(),
      );
    if (silence) silenceSeconds += Number(silence[1]);
  }
  if (!Number.isFinite(meanVolume) || !Number.isFinite(maxVolume)) {
    fail("INSPECTION");
  }
  return { maxVolume, meanVolume, silenceSeconds };
}

function parseInspection(probe, analysis) {
  let parsed;
  try {
    parsed = JSON.parse(String(probe.stdout ?? ""));
  } catch {
    fail("INSPECTION");
  }
  const stream = Array.isArray(parsed?.streams)
    ? parsed.streams.find((entry) => entry?.codec_type === "audio")
    : undefined;
  const formatNames = String(parsed?.format?.format_name ?? "").split(",");
  if (!formatNames.includes("webm")) fail("INSPECTION");
  const durationSeconds = Number(parsed?.format?.duration ?? stream?.duration);
  const channels = Number(stream?.channels);
  const sampleRate = Number(stream?.sample_rate);
  const codec = String(stream?.codec_name ?? "").toLowerCase();
  const durationMs = Math.round(durationSeconds * 1_000);
  const decodedBytes = Math.ceil(durationSeconds * sampleRate * channels * 2);
  const statistics = parseTaggedFilterStatistics(analysis.stderr);
  if (!Number.isFinite(durationMs) || durationMs <= 0) fail("INSPECTION");
  if (!Number.isFinite(statistics.maxVolume) || statistics.maxVolume >= -0.1) {
    fail("INSPECTION");
  }
  return validateVoiceTrainingInspection({
    channels,
    codec,
    decodedBytes,
    durationMs,
    rmsDb: statistics.meanVolume,
    sampleRate,
    silenceRatio: statistics.silenceSeconds / durationSeconds,
  });
}

function trimOutput(value) {
  return `${value}`.slice(-COMMAND_OUTPUT_LIMIT);
}

function startCommandJob({ spawn, terminate }, command, args, options) {
  let child;
  let canceled = false;
  let settled = false;
  let stdout = "";
  let stderr = "";
  const completed = new Promise((resolve, reject) => {
    try {
      child = spawn(command, args, {
        ...options,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk) => {
        stdout = trimOutput(`${stdout}${String(chunk)}`);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = trimOutput(`${stderr}${String(chunk)}`);
      });
      child.once("error", () => {
        if (settled) return;
        settled = true;
        reject(failedError(canceled));
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        if (canceled) return reject(failedError(true));
        if (code === 0) return resolve({ stderr, stdout });
        reject(failedError(false));
      });
    } catch {
      settled = true;
      reject(failedError(canceled));
    }
  });
  completed.catch(() => {});
  return {
    cancel() {
      if (canceled || settled) return undefined;
      canceled = true;
      return terminate(child);
    },
    completed,
  };
}

/**
 * Main-process adapter for fixed local normalization/training/verification.
 * It has no network endpoint and accepts no renderer executable, runtime root,
 * provider, or model path.
 */
export class VoiceTrainingRuntime {
  #commandRunner;
  #manifest;
  #outputRoot;
  #run;
  #runtimeRoot;
  #spawn;
  #terminate;
  #validateRuntime;
  #verifyPython;

  constructor({
    commandRunner,
    manifest,
    outputRoot,
    run = execFile,
    runtimeRoot,
    spawn = defaultSpawn,
    terminate = (child) => terminateTrainingProcess(child, run),
    trust = RVC_RUNTIME_TRUST,
    trustedRunnerPath = PACKAGED_RUNNER_PATH,
    validateRuntime,
    verifyPython = async () => false,
  } = {}) {
    this.#runtimeRoot = runtimeRoot;
    this.#outputRoot = outputRoot;
    this.#manifest = normalizeRvcRuntimeManifest(manifest, { runtimeRoot });
    this.#run = run;
    this.#spawn = spawn;
    this.#terminate = terminate;
    this.#commandRunner =
      commandRunner ??
      ((command, args, options) =>
        startCommandJob(
          { spawn: this.#spawn, terminate: this.#terminate },
          command,
          args,
          options,
        ));
    this.#validateRuntime =
      validateRuntime ??
      (() =>
        loadRvcRuntimeManifest({
          runtimeRoot: this.#runtimeRoot,
          trust,
          trustedRunnerPath,
        }));
    this.#verifyPython = verifyPython;
  }

  async #assertTrustedLaunch() {
    await this.#validateRuntime();
    const result = await this.#verifyPython({
      path: pathApi(this.#runtimeRoot).join(
        this.#runtimeRoot,
        this.#manifest.python.path,
      ),
      version: this.#manifest.python.version,
    });
    if (result !== true) fail("PYTHON_TRUST");
  }

  normalize({ inputPath, outputPath } = {}) {
    const input = trainingPath(this.#outputRoot, inputPath, ".webm");
    const output = trainingPath(this.#outputRoot, outputPath, ".wav");
    const api = pathApi(this.#runtimeRoot);
    const operation = { canceled: false, current: undefined };
    const runCommand = async (command, args) => {
      if (operation.canceled) throw failedError(true);
      // Every external binary is revalidated at its launch boundary; a mutable
      // runtime receipt cannot race a long normalization pipeline into running.
      await this.#validateRuntime();
      const job = this.#commandRunner(command, args, {
        cwd: this.#runtimeRoot,
        env: isolatedPythonEnvironment(this.#runtimeRoot),
        shell: false,
        windowsHide: true,
      });
      if (!job?.completed || typeof job.cancel !== "function") {
        fail("COMMAND");
      }
      operation.current = job;
      const result = await job.completed;
      if (operation.canceled) throw failedError(true);
      return result;
    };
    const completed = (async () => {
      await this.#assertTrustedLaunch();
      const inspection = parseInspection(
        await runCommand(
          api.join(this.#runtimeRoot, this.#manifest.ffprobe.path),
          [
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=format_name,duration:stream=codec_name,codec_type,channels,sample_rate,duration",
            "-of",
            "json",
            input,
          ],
        ),
        await runCommand(
          api.join(this.#runtimeRoot, this.#manifest.ffmpeg.path),
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "info",
            "-i",
            input,
            "-vn",
            "-af",
            "silencedetect=n=-50dB:d=0.1,volumedetect",
            "-f",
            "null",
            "-",
          ],
        ),
      );
      await runCommand(api.join(this.#runtimeRoot, this.#manifest.ffmpeg.path), [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input,
        "-vn",
        "-ac",
        String(VOICE_TRAINING_POLICY.normalization.channels),
        "-ar",
        String(VOICE_TRAINING_POLICY.normalization.sampleRate),
        "-c:a",
        VOICE_TRAINING_POLICY.normalization.sampleFormat,
        output,
      ]);
      return inspection;
    })();
    completed.catch(() => {});
    return {
      cancel() {
        if (operation.canceled) return undefined;
        operation.canceled = true;
        return operation.current?.cancel();
      },
      completed,
    };
  }

  startTraining({
    inputPath,
    onProgress = () => {},
    outputPath,
    provider,
    sessionId: requestedSessionId,
  } = {}) {
    const api = pathApi(this.#runtimeRoot);
    const cleanupSession = (id) => this.cleanupSession(id);
    const terminate = this.#terminate;
    const operation = { canceled: false, child: undefined, session: undefined };
    const completed = (async () => {
      await this.#assertTrustedLaunch();
      if (operation.canceled) throw failedError(true);
      if (provider !== "cpu-baseline") fail("PROVIDER");
      const session = sessionId(requestedSessionId);
      operation.session = session;
      const input = trainingPath(this.#outputRoot, inputPath, ".wav");
      const output = trainingPath(this.#outputRoot, outputPath, ".pth");
      const child = this.#spawn(
        api.join(this.#runtimeRoot, this.#manifest.python.path),
        [
          "-I",
          api.join(this.#runtimeRoot, this.#manifest.runner.path),
          "--mode",
          "train",
          "--runtime-root",
          this.#runtimeRoot,
          "--work-root",
          this.#outputRoot,
          "--session-id",
          session,
          "--input",
          input,
          "--output",
          output,
          "--provider",
          "cpu-baseline",
        ],
        {
          cwd: this.#runtimeRoot,
          env: isolatedPythonEnvironment(this.#runtimeRoot),
          shell: false,
          windowsHide: true,
        },
      );
      operation.child = child;
      let outputBuffer = "";
      return new Promise((resolve, reject) => {
        child.stdout?.on("data", (chunk) => {
          outputBuffer = `${outputBuffer}${String(chunk)}`.slice(-16_384);
          const lines = outputBuffer.split(/\r?\n/);
          outputBuffer = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const update = JSON.parse(line);
              const progress = boundedProgress(update?.progress);
              const stage = boundedStage(update?.stage);
              if (progress !== undefined && stage) onProgress({ progress, stage });
            } catch {
              // Upstream output is deliberately ignored rather than logged.
            }
          }
        });
        child.once("error", () => reject(failedError(operation.canceled)));
        child.once("close", (code) => {
          if (operation.canceled) return reject(failedError(true));
          if (code === 0) return resolve({ modelPath: output });
          reject(failedError(false));
        });
      });
    })();
    completed.catch(() => {});
    return {
      async cancel() {
        if (operation.canceled) return undefined;
        operation.canceled = true;
        if (operation.child) await terminate(operation.child);
        if (operation.session) await cleanupSession(operation.session);
      },
      completed,
    };
  }

  async cleanupSession(requestedSessionId) {
    const session = sessionId(requestedSessionId);
    const api = pathApi(this.#runtimeRoot);
    const fixed = [
      { path: api.join(this.#runtimeRoot, "source", "logs", session), recursive: true },
      {
        path: api.join(this.#runtimeRoot, "source", "assets", "weights", `${session}.pth`),
        recursive: false,
      },
      {
        path: api.join(this.#runtimeRoot, "source", "assets", "indices", `${session}.index`),
        recursive: false,
      },
      {
        path: api.join(this.#runtimeRoot, "source", "assets", "indices", `${session}.npy`),
        recursive: false,
      },
    ];
    for (const { path, recursive } of fixed) {
      try {
        const info = await defaultLstat(path);
        // Removing a reparse point itself never walks its target.
        await defaultRm(path, {
          force: true,
          recursive: !isReparsePoint(info) && recursive,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") fail("CLEANUP");
      }
    }
    return { cleaned: true };
  }

  async verifyOutput({ modelPath } = {}) {
    await this.#assertTrustedLaunch();
    const model = trainingPath(this.#outputRoot, modelPath, ".pth");
    const api = pathApi(this.#runtimeRoot);
    const { stdout } = await this.#run(
      api.join(this.#runtimeRoot, this.#manifest.python.path),
      [
        "-I",
        api.join(this.#runtimeRoot, this.#manifest.runner.path),
        "--mode",
        "verify",
        "--work-root",
        this.#outputRoot,
        "--model",
        model,
      ],
      {
        cwd: this.#runtimeRoot,
        env: isolatedPythonEnvironment(this.#runtimeRoot),
        timeout: 60_000,
        windowsHide: true,
      },
    );
    return parseVerification(stdout);
  }
}

async function terminateTrainingProcess(child, run) {
  if (process.platform === "win32" && Number.isSafeInteger(child?.pid)) {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    await run(
      win32.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { timeout: 15_000, windowsHide: true },
    );
    return;
  }
  if (child?.kill?.() === false) fail("PROCESS_TREE");
}

function failedError(canceled) {
  return new Error(
    canceled
      ? "VOICE_TRAINING_RUNTIME_CANCELED"
      : "VOICE_TRAINING_RUNTIME_TRAINING_FAILED",
  );
}
