import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  RVC_RUNTIME_CONTRACT,
  VoiceTrainingRuntime,
  loadRvcRuntimeManifest,
  normalizeRvcRuntimeManifest,
  verifyPythonImportTree,
} from "./voice-training-runtime.js";

const ROOT = "/user-data/TransLive/rvc-runtime";
const TRAINING_ROOT = "/user-data/TransLive/voice-training";
const MODEL = `${TRAINING_ROOT}/vt_alpha/output/model.pth`;
const INPUT = `${TRAINING_ROOT}/vt_alpha/recording.webm`;
const WAV = `${TRAINING_ROOT}/vt_alpha/normalized.wav`;

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    runtime: {
      assets: {
        files: [
          {
            path: "source/assets/hubert_base/config.json",
            sha256: "f".repeat(64),
          },
          { path: "source/assets/rmvpe/rmvpe.pt", sha256: "1".repeat(64) },
        ],
        hfRevision: RVC_RUNTIME_CONTRACT.hfRevision,
      },
      directmlVersion: RVC_RUNTIME_CONTRACT.directmlVersion,
      ffmpeg: {
        path: "tools/ffmpeg.exe",
        sha256: "a".repeat(64),
        version: RVC_RUNTIME_CONTRACT.ffmpegVersion,
      },
      ffprobe: {
        path: "tools/ffprobe.exe",
        sha256: "9".repeat(64),
        version: RVC_RUNTIME_CONTRACT.ffmpegVersion,
      },
      python: {
        path: ".venv/Scripts/python.exe",
        sha256: "b".repeat(64),
        version: RVC_RUNTIME_CONTRACT.pythonVersion,
      },
      rvcCommit: RVC_RUNTIME_CONTRACT.rvcCommit,
      runner: {
        path: "tools/rvc-training-runtime.py",
        sha256: "c".repeat(64),
      },
      source: {
        files: [
          {
            path: "source/infer/rtrvc.py",
            sha256: "d".repeat(64),
          },
          {
            path: "source/train/train.py",
            sha256: "e".repeat(64),
          },
        ],
        hfRevision: RVC_RUNTIME_CONTRACT.hfRevision,
      },
      torchVersion: RVC_RUNTIME_CONTRACT.torchVersion,
    },
    ...overrides,
  };
}

function runtimeFixture({ commandRunner, spawn, run, terminate } = {}) {
  return new VoiceTrainingRuntime({
    commandRunner,
    manifest: manifest(),
    outputRoot: TRAINING_ROOT,
    run:
      run ??
      (async () => ({
        stdout: JSON.stringify({
          configLength: 18,
          schema: "rvc-checkpoint-v2",
          sha256: "f".repeat(64),
          tensorCount: 12,
          verified: true,
        }),
      })),
    runtimeRoot: ROOT,
    spawn,
    terminate,
    validateRuntime: async () => {},
    verifyPython: async () => true,
  });
}

test("rejects unlisted Python startup hooks across the complete import tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "translive-rvc-import-tree-"));
  const site = join(root, ".venv", "Lib", "site-packages");
  await mkdir(join(site, "safe_package"), { recursive: true });
  await writeFile(join(site, "safe_package", "__init__.py"), "SAFE = True\n");
  const fileHash = createHash("sha256")
    .update(await readFile(join(site, "safe_package", "__init__.py")))
    .digest("hex");
  const treeHash = createHash("sha256")
    .update(`safe_package/__init__.py\0${fileHash}\n`)
    .digest("hex");
  const expected = {
    fileCount: 1,
    root: ".venv/Lib/site-packages",
    sha256: treeHash,
  };

  await assert.doesNotReject(verifyPythonImportTree(root, expected));
  await writeFile(
    join(site, "sitecustomize.py"),
    "raise RuntimeError('injected')\n",
  );
  await assert.rejects(
    verifyPythonImportTree(root, expected),
    /VOICE_TRAINING_RUNTIME_PYTHON_IMPORT_TRUST/,
  );
});

test("pins a local RVC runtime manifest instead of accepting arbitrary paths or versions", () => {
  const normalized = normalizeRvcRuntimeManifest(manifest(), {
    runtimeRoot: ROOT,
  });
  assert.deepEqual(
    {
      hfRevision: normalized.source.hfRevision,
      pythonVersion: normalized.python.version,
      rvcCommit: normalized.rvcCommit,
      torchVersion: normalized.torchVersion,
    },
    {
      hfRevision: "e6d0c1a17da07c33557852f9dfa2bd44cc75737d",
      pythonVersion: "3.12",
      rvcCommit: "81eed5e8f68b6bed1789f682fe78cdd324495afc",
      torchVersion: "2.4.1+cpu",
    },
  );
  for (const invalid of [
    manifest({
      runtime: {
        ...manifest().runtime,
        python: { ...manifest().runtime.python, path: "../python.exe" },
      },
    }),
    manifest({ runtime: { ...manifest().runtime, torchVersion: "latest" } }),
    manifest({
      runtime: {
        ...manifest().runtime,
        source: { ...manifest().runtime.source, hfRevision: "main" },
      },
    }),
  ]) {
    assert.throws(
      () => normalizeRvcRuntimeManifest(invalid, { runtimeRoot: ROOT }),
      /VOICE_TRAINING_RUNTIME_MANIFEST/,
    );
  }
});

test("inspects actual local WebM Opus before fixed ffmpeg normalization without a shell", async () => {
  const calls = [];
  const runtime = runtimeFixture({
    commandRunner: (command, args, options) => {
      calls.push({ args, command, options });
      const isProbe = command.endsWith("ffprobe.exe");
      const isAnalysis = args.includes(
        "silencedetect=n=-50dB:d=0.1,volumedetect",
      );
      return {
        cancel() {},
        completed: Promise.resolve(
          isProbe
            ? {
                stdout: JSON.stringify({
                  format: { duration: "540", format_name: "matroska,webm" },
                  streams: [
                    {
                      channels: 1,
                      codec_name: "opus",
                      codec_type: "audio",
                      sample_rate: "48000",
                    },
                  ],
                }),
              }
            : isAnalysis
              ? {
                  stderr:
                    "[Parsed_silencedetect_0 @ 000] silence_duration: 12.0\n[Parsed_volumedetect_1 @ 000] mean_volume: -18.0 dB\n[Parsed_volumedetect_1 @ 000] max_volume: -3.0 dB\n",
                }
              : { stdout: "" },
        ),
      };
    },
  });

  const job = runtime.normalize({ inputPath: INPUT, outputPath: WAV });
  const inspection = await job.completed;

  assert.deepEqual(inspection, {
    channels: 1,
    codec: "opus",
    decodedBytes: 51_840_000,
    durationMs: 540_000,
    rmsDb: -18,
    sampleRate: 48_000,
    silenceRatio: 12 / 540,
  });
  assert.deepEqual(
    calls.map((call) => call.command),
    [
      `${ROOT}/tools/ffprobe.exe`,
      `${ROOT}/tools/ffmpeg.exe`,
      `${ROOT}/tools/ffmpeg.exe`,
    ],
  );
  assert.equal(
    calls.every((call) => call.options.shell === false),
    true,
  );
});

test("parses only tagged filter statistics, never input metadata", async () => {
  const runtime = runtimeFixture({
    commandRunner: (command, args) => {
      if (command.endsWith("ffprobe.exe")) {
        return {
          cancel() {},
          completed: Promise.resolve({
            stdout: JSON.stringify({
              format: { duration: "540", format_name: "webm" },
              streams: [
                {
                  channels: 1,
                  codec_name: "opus",
                  codec_type: "audio",
                  sample_rate: "48000",
                },
              ],
            }),
          }),
        };
      }
      if (args.includes("silencedetect=n=-50dB:d=0.1,volumedetect")) {
        return {
          cancel() {},
          completed: Promise.resolve({
            stderr: [
              "Input #0, matroska,webm, from input:",
              "  mean_volume: -99.0 dB",
              "  max_volume: 0.0 dB",
              "[Parsed_silencedetect_0 @ 000] silence_end: 12.0 | silence_duration: 12.0",
              "[Parsed_volumedetect_1 @ 000] mean_volume: -18.0 dB",
              "[Parsed_volumedetect_1 @ 000] max_volume: -3.0 dB",
            ].join("\n"),
          }),
        };
      }
      return { cancel() {}, completed: Promise.resolve({}) };
    },
  });

  const inspection = await runtime.normalize({
    inputPath: INPUT,
    outputPath: WAV,
  }).completed;
  assert.equal(inspection.rmsDb, -18);
  assert.equal(inspection.silenceRatio, 12 / 540);
});

test("normalizes local recording through fixed ffmpeg arguments without a shell", async () => {
  const runtime = runtimeFixture({
    commandRunner: () => ({ cancel() {}, completed: Promise.resolve({}) }),
  });

  assert.throws(
    () =>
      runtime.normalize({ inputPath: "/tmp/recording.webm", outputPath: WAV }),
    /VOICE_TRAINING_RUNTIME_PATH/,
  );
});

test("fails closed before launch when no independent Python trust verifier is supplied", async () => {
  const runtime = new VoiceTrainingRuntime({
    manifest: manifest(),
    outputRoot: TRAINING_ROOT,
    runtimeRoot: ROOT,
    validateRuntime: async () => {},
  });

  await assert.rejects(
    runtime.verifyOutput({ modelPath: MODEL }),
    /VOICE_TRAINING_RUNTIME_PYTHON_TRUST/,
  );
});

test("runs a CPU-only fixed local training command and supports progress cancellation", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalled = false;
  child.kill = () => {
    child.killCalled = true;
    child.emit("close", 1);
  };
  const calls = [];
  const terminated = [];
  const runtime = runtimeFixture({
    spawn: (command, args, options) => {
      calls.push({ args, command, options });
      return child;
    },
    terminate: async (process) => {
      terminated.push(process);
      process.kill();
    },
  });
  const progress = [];
  const job = runtime.startTraining({
    inputPath: WAV,
    outputPath: MODEL,
    provider: "cpu-baseline",
    sessionId: "vt_alpha",
    onProgress: (item) => progress.push(item),
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit("data", '{"progress":20,"stage":"features"}\n');
  job.cancel();
  await assert.rejects(job.completed, /VOICE_TRAINING_RUNTIME_CANCELED/);

  assert.equal(child.killCalled, true);
  assert.deepEqual(terminated, [child]);
  assert.deepEqual(progress, [{ progress: 20, stage: "features" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, `${ROOT}/.venv/Scripts/python.exe`);
  assert.deepEqual(calls[0].args, [
    "-I",
    `${ROOT}/tools/rvc-training-runtime.py`,
    "--mode",
    "train",
    "--runtime-root",
    ROOT,
    "--work-root",
    TRAINING_ROOT,
    "--session-id",
    "vt_alpha",
    "--input",
    WAV,
    "--output",
    MODEL,
    "--provider",
    "cpu-baseline",
  ]);
  assert.equal(calls[0].options.cwd, ROOT);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.PYTHONPATH, "");
  await assert.rejects(
    runtime.startTraining({
      inputPath: WAV,
      outputPath: MODEL,
      provider: "directml-candidate",
      sessionId: "vt_alpha",
    }).completed,
    /VOICE_TRAINING_RUNTIME_PROVIDER/,
  );
});

test("does not clean a training workspace when process-tree termination fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "translive-rvc-kill-failure-"));
  const outputRoot = join(root, "voice-training");
  const residue = join(root, "source", "logs", "vt_alpha", "residue.txt");
  await mkdir(dirname(residue), { recursive: true });
  await mkdir(join(outputRoot, "vt_alpha"), { recursive: true });
  await writeFile(residue, "sensitive");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 123;
  const runtime = new VoiceTrainingRuntime({
    manifest: manifest(),
    outputRoot,
    runtimeRoot: root,
    spawn: () => child,
    terminate: async () => {
      throw new Error("taskkill failed");
    },
    validateRuntime: async () => {},
    verifyPython: async () => true,
  });
  const job = runtime.startTraining({
    inputPath: join(outputRoot, "vt_alpha", "normalized.wav"),
    outputPath: join(outputRoot, "vt_alpha", "output.pth"),
    provider: "cpu-baseline",
    sessionId: "vt_alpha",
  });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(job.cancel(), /taskkill failed/);
  assert.equal(await readFile(residue, "utf8"), "sensitive");
});

test("launches trusted Python in isolated mode with no inherited Python search path", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("close", 1);
  const calls = [];
  const runtime = runtimeFixture({
    spawn: (command, args, options) => {
      calls.push({ args, command, options });
      return child;
    },
    terminate: async (process) => process.kill(),
  });
  const job = runtime.startTraining({
    inputPath: WAV,
    outputPath: MODEL,
    provider: "cpu-baseline",
    sessionId: "vt_alpha",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await job.cancel();
  await assert.rejects(job.completed, /VOICE_TRAINING_RUNTIME_CANCELED/);

  assert.equal(calls[0].args[0], "-I");
  assert.equal(calls[0].options.env.PYTHONPATH, "");
  assert.equal(calls[0].options.env.PYTHONHOME, "");
  assert.equal(calls[0].options.env.PYTHONNOUSERSITE, "1");
  assert.equal(calls[0].options.env.PYTHONSAFEPATH, "1");
});

test("loads only a fixed hash-verified local runtime manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "translive-rvc-runtime-"));
  for (const path of [
    ".venv/Scripts/python.exe",
    "tools/ffmpeg.exe",
    "tools/ffprobe.exe",
    "tools/rvc-training-runtime.py",
    "source/infer/rtrvc.py",
    "source/train/train.py",
    "source/assets/hubert_base/config.json",
    "source/assets/rmvpe/rmvpe.pt",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path);
  }
  const digest = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const value = manifest();
  value.runtime.python.sha256 = await digest(
    join(root, value.runtime.python.path),
  );
  value.runtime.ffmpeg.sha256 = await digest(
    join(root, value.runtime.ffmpeg.path),
  );
  value.runtime.ffprobe.sha256 = await digest(
    join(root, value.runtime.ffprobe.path),
  );
  value.runtime.runner.sha256 = await digest(
    join(root, value.runtime.runner.path),
  );
  for (const entry of [
    ...value.runtime.source.files,
    ...value.runtime.assets.files,
  ]) {
    entry.sha256 = await digest(join(root, entry.path));
  }
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(value));

  assert.deepEqual(
    await loadRvcRuntimeManifest({
      runtimeRoot: root,
      trust: value.runtime,
      trustedRunnerPath: join(root, "tools", "rvc-training-runtime.py"),
    }),
    value,
  );
  await writeFile(join(root, "source/infer/rtrvc.py"), "tampered");
  await assert.rejects(
    loadRvcRuntimeManifest({
      runtimeRoot: root,
      trust: value.runtime,
      trustedRunnerPath: join(root, "tools", "rvc-training-runtime.py"),
    }),
    /VOICE_TRAINING_RUNTIME_MANIFEST/,
  );
  await assert.rejects(
    loadRvcRuntimeManifest({
      manifestPath: join(root, "other.json"),
      runtimeRoot: root,
      trust: value.runtime,
      trustedRunnerPath: join(root, "tools", "rvc-training-runtime.py"),
    }),
    /VOICE_TRAINING_RUNTIME_MANIFEST_PATH/,
  );
});

test("rejects a mutable manifest that tries to select a different executable or source receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "translive-rvc-trust-"));
  for (const path of [
    ".venv/Scripts/python.exe",
    "tools/ffmpeg.exe",
    "tools/ffprobe.exe",
    "tools/rvc-training-runtime.py",
    "source/infer/rtrvc.py",
    "source/train/train.py",
    "source/assets/hubert_base/config.json",
    "source/assets/rmvpe/rmvpe.pt",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path);
  }
  const digest = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const trusted = manifest();
  for (const entry of [
    trusted.runtime.python,
    trusted.runtime.ffmpeg,
    trusted.runtime.ffprobe,
    trusted.runtime.runner,
    ...trusted.runtime.source.files,
    ...trusted.runtime.assets.files,
  ]) {
    entry.sha256 = await digest(join(root, entry.path));
  }
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(trusted));

  await assert.rejects(
    loadRvcRuntimeManifest({
      runtimeRoot: root,
      trust: {
        ...trusted.runtime,
        python: { ...trusted.runtime.python },
        ffmpeg: { ...trusted.runtime.ffmpeg },
        runner: { ...trusted.runtime.runner },
        source: {
          ...trusted.runtime.source,
          files: trusted.runtime.source.files.map((entry) => ({ ...entry })),
        },
      },
    }),
    /VOICE_TRAINING_RUNTIME_TRUST/,
    "a runtime needs an independently trusted packaged runner receipt",
  );

  const trustedRunner = join(root, "tools", "rvc-training-runtime.py");
  await assert.doesNotReject(
    loadRvcRuntimeManifest({
      runtimeRoot: root,
      trust: trusted.runtime,
      trustedRunnerPath: trustedRunner,
    }),
  );

  const forged = structuredClone(trusted);
  forged.runtime.python.path = "tools/evil.exe";
  await writeFile(join(root, "tools", "evil.exe"), "evil");
  forged.runtime.python.sha256 = await digest(join(root, "tools", "evil.exe"));
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(forged));
  await assert.rejects(
    loadRvcRuntimeManifest({
      runtimeRoot: root,
      trust: trusted.runtime,
      trustedRunnerPath: trustedRunner,
    }),
    /VOICE_TRAINING_RUNTIME_TRUST/,
  );
});

test("rejects a runtime source reparse point even when a mutable manifest hash matches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "translive-rvc-reparse-"));
  for (const path of [
    ".venv/Scripts/python.exe",
    "tools/ffmpeg.exe",
    "tools/ffprobe.exe",
    "tools/rvc-training-runtime.py",
    "source/infer/rtrvc.py",
    "source/train/train.py",
    "source/assets/hubert_base/config.json",
    "source/assets/rmvpe/rmvpe.pt",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path);
  }
  const digest = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const value = manifest();
  for (const entry of [
    value.runtime.python,
    value.runtime.ffmpeg,
    value.runtime.ffprobe,
    value.runtime.runner,
    ...value.runtime.source.files,
    ...value.runtime.assets.files,
  ]) {
    entry.sha256 = await digest(join(root, entry.path));
  }
  const target = join(root, "outside-rtrvc.py");
  await writeFile(target, "source/infer/rtrvc.py");
  await rm(join(root, "source/infer/rtrvc.py"));
  try {
    await symlink(target, join(root, "source/infer/rtrvc.py"));
  } catch (error) {
    if (error?.code === "EPERM")
      return t.skip("Windows symlink privilege unavailable");
    throw error;
  }
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(value));

  await assert.rejects(
    loadRvcRuntimeManifest({
      runtimeRoot: root,
      trust: value.runtime,
      trustedRunnerPath: join(root, "tools/rvc-training-runtime.py"),
    }),
    /VOICE_TRAINING_RUNTIME_REPARSE/,
  );
});

test("cleans only the fixed RVC workspace artifacts after forced cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "translive-rvc-cleanup-"));
  const outputRoot = join(root, "voice-training");
  for (const path of [
    "source/logs/vt_alpha/raw.wav",
    "source/assets/weights/vt_alpha.pth",
    "source/assets/indices/vt_alpha.index",
    "source/assets/weights/unrelated.pth",
    "source/logs/unrelated/keep.txt",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "sensitive");
  }
  const cleanup = new VoiceTrainingRuntime({
    manifest: manifest(),
    outputRoot,
    runtimeRoot: root,
    validateRuntime: async () => {},
    verifyPython: async () => true,
  });

  await cleanup.cleanupSession("vt_alpha");

  await assert.rejects(readFile(join(root, "source/logs/vt_alpha/raw.wav")));
  await assert.rejects(
    readFile(join(root, "source/assets/weights/vt_alpha.pth")),
  );
  await assert.rejects(
    readFile(join(root, "source/assets/indices/vt_alpha.index")),
  );
  assert.equal(
    await readFile(join(root, "source/assets/weights/unrelated.pth"), "utf8"),
    "sensitive",
  );
  assert.equal(
    await readFile(join(root, "source/logs/unrelated/keep.txt"), "utf8"),
    "sensitive",
  );
});

test("requires independent weights-only verification and expected RVC schema before promotion", async () => {
  const runtime = runtimeFixture({
    run: async () => ({
      stdout: JSON.stringify({
        configLength: 18,
        schema: "rvc-checkpoint-v2",
        sha256: "f".repeat(64),
        tensorCount: 12,
        verified: true,
      }),
    }),
  });
  assert.deepEqual(await runtime.verifyOutput({ modelPath: MODEL }), {
    configLength: 18,
    schema: "rvc-checkpoint-v2",
    sha256: "f".repeat(64),
    tensorCount: 12,
  });

  const forged = runtimeFixture({
    run: async () => ({ stdout: JSON.stringify({ verified: true }) }),
  });
  await assert.rejects(
    forged.verifyOutput({ modelPath: MODEL }),
    /VOICE_TRAINING_RUNTIME_VERIFICATION/,
  );
});
