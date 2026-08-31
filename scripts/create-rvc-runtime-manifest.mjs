import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";

import { assertPrivateLocalDirectory } from "../src/private-local-storage.js";
import { RVC_RUNTIME_TRUST } from "../src/rvc-runtime-trust.js";
import { verifyPythonImportTree } from "../src/voice-training-runtime.js";

const localAppData = process.env.LOCALAPPDATA;
if (
  process.platform !== "win32" ||
  typeof localAppData !== "string" ||
  !/^[A-Za-z]:[\\/]/.test(localAppData)
) {
  throw new Error("This manifest must be generated under a drive-local Windows LOCALAPPDATA");
}

const runtimeRoot = join(localAppData, "TransLive", "rvc-runtime");
await assertPrivateLocalDirectory({ directory: runtimeRoot, platform: "win32" });

function isReparsePoint(info) {
  return (
    info?.isSymbolicLink?.() === true ||
    info?.isReparsePoint === true ||
    (Number.isSafeInteger(info?.mode) && (info.mode & 0o170000) === 0o120000)
  );
}

async function digest(path) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertTrustedFile(entry) {
  const path = win32.join(runtimeRoot, entry.path);
  const info = await lstat(path);
  if (!info.isFile() || isReparsePoint(info) || (await digest(path)) !== entry.sha256) {
    throw new Error("A fixed runtime receipt file is missing or modified");
  }
}

const packagedRunner = join(import.meta.dirname, "rvc-training-runtime.py");
const runnerDestination = win32.join(runtimeRoot, RVC_RUNTIME_TRUST.runner.path);
await mkdir(win32.dirname(runnerDestination), { recursive: true, mode: 0o700 });
await copyFile(packagedRunner, runnerDestination);

await verifyPythonImportTree(
  runtimeRoot,
  RVC_RUNTIME_TRUST.pythonEnvironment.importTree,
);

for (const entry of [
  RVC_RUNTIME_TRUST.python,
  RVC_RUNTIME_TRUST.ffmpeg,
  RVC_RUNTIME_TRUST.ffprobe,
  RVC_RUNTIME_TRUST.runner,
  ...RVC_RUNTIME_TRUST.source.files,
  ...RVC_RUNTIME_TRUST.assets.files,
  ...RVC_RUNTIME_TRUST.pythonEnvironment.records,
]) {
  await assertTrustedFile(entry);
}

await writeFile(
  win32.join(runtimeRoot, "runtime-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      runtime: RVC_RUNTIME_TRUST,
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o600 },
);
process.stdout.write("Created fixed local RVC runtime manifest.\n");
