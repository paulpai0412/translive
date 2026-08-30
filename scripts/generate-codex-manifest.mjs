import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { option } from "./package-options.mjs";

const root = resolve(import.meta.dirname, "..");
const input = option(process.argv, "input");
const signature = option(process.argv, "signature");
const version = option(process.argv, "version");
const platform = option(process.argv, "platform", "win32");
const out = resolve(root, option(process.argv, "out", `assets/codex/${platform}`));

if (!input || !signature || !version || platform !== "win32") {
  throw new Error(
    "Usage: node scripts/generate-codex-manifest.mjs --input <codex.exe> --signature <codex.exe.sig> --version <x.y.z> [--platform=win32]",
  );
}

const executable = resolve(input);
const signingInput = resolve(signature);
if (basename(executable).toLowerCase() !== "codex.exe") {
  throw new Error("Bundled Windows executable must be named codex.exe");
}

await mkdir(out, { recursive: true });
const bundledExecutable = resolve(out, "codex.exe");
const bundledSignature = resolve(out, "codex.exe.sig");
await copyFile(executable, bundledExecutable);
await copyFile(signingInput, bundledSignature);
const checksum = createHash("sha256")
  .update(await readFile(bundledExecutable))
  .digest("hex");
const manifest = {
  schemaVersion: 1,
  platforms: {
    win32: {
      path: "assets/codex/win32/codex.exe",
      sha256: checksum,
      signaturePath: "assets/codex/win32/codex.exe.sig",
      version,
    },
  },
};
await writeFile(
  resolve(root, "assets/codex/manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
process.stdout.write("Generated bundled Codex manifest and copied verified Windows release assets.\n");
