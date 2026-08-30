import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { packager } from "@electron/packager";

import { assertWindowsCodexBundle } from "../src/codex-launch.js";
import { assertPackagePolicy } from "../src/release-package-policy.js";
import { packageIgnore, RELEASE_METADATA } from "../src/release-config.js";
import { option } from "./package-options.mjs";

const root = resolve(import.meta.dirname, "..");
const platform = option(process.argv, "platform", process.platform);
const arch = option(
  process.argv,
  "arch",
  process.arch === "x64" ? "x64" : process.arch,
);
const out = resolve(root, option(process.argv, "out", "release"));
const policy = option(
  process.argv,
  "policy",
  platform === "win32" ? "release" : "dev",
);
await assertPackagePolicy({
  assertWindowsCodexBundle,
  platform,
  policy,
  root,
});
await import("./create-release-icon.mjs");

const icon = resolve(
  root,
  platform === "win32"
    ? "assets/translive-brand/translive.ico"
    : "assets/translive-brand/translive-tray.png",
);

await mkdir(out, { recursive: true });
const paths = await packager({
  appVersion: RELEASE_METADATA.version,
  arch,
  asar: false,
  dir: root,
  executableName: RELEASE_METADATA.productName,
  icon,
  ignore: (path) => packageIgnore(path, root),
  name: RELEASE_METADATA.productName,
  out,
  overwrite: true,
  platform,
  prune: true,
});

for (const path of paths) process.stdout.write(`${path}\n`);
