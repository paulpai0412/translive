import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { resolveCodexLaunch } from "../src/codex-launch.js";
import {
  packagedPathIsAllowed,
  RELEASE_METADATA,
} from "../src/release-config.js";
import { filesUnder } from "./file-tree.mjs";
import { option } from "./package-options.mjs";

async function readPackagedJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Packaged app manifest is missing or invalid");
  }
}

export async function smokePackage({ appDirectory, platform }) {
  const appPackage = await readPackagedJson(join(appDirectory, "package.json"));
  if (appPackage.productName !== RELEASE_METADATA.productName) {
    throw new Error("Packaged productName does not match release metadata");
  }
  if (appPackage.translive?.appId !== RELEASE_METADATA.appId) {
    throw new Error("Packaged appId does not match release metadata");
  }
  if (appPackage.version !== RELEASE_METADATA.version) {
    throw new Error("Packaged version does not match release metadata");
  }
  await stat(join(appDirectory, "src", "main.js"));
  await stat(join(appDirectory, "scripts", "windows-meeting-devices.ps1"));
  await stat(
    join(appDirectory, "assets", "translive-brand", "translive-mark.svg"),
  );

  let codexLaunch;
  if (platform === "win32") {
    codexLaunch = await resolveCodexLaunch({
      appPath: appDirectory,
      isPackaged: true,
      platform,
    });
  }

  const packageFiles = await filesUnder(appDirectory);
  const unapproved = packageFiles
    .map((path) => path.slice(appDirectory.length + 1).replaceAll("\\", "/"))
    .filter((path) => !packagedPathIsAllowed(path));
  if (unapproved.length > 0) {
    throw new Error(
      `Packaged app contains unapproved files: ${unapproved.join(", ")}`,
    );
  }
  return { codexLaunch };
}

async function smoke() {
  const root = resolve(import.meta.dirname, "..");
  const out = resolve(root, option(process.argv, "out", "release"));
  const platform = option(process.argv, "platform", process.platform);
  const arch = option(
    process.argv,
    "arch",
    process.arch === "x64" ? "x64" : process.arch,
  );
  const packageDirectory = join(
    out,
    `${RELEASE_METADATA.productName}-${platform}-${arch}`,
  );
  const appDirectory = join(packageDirectory, "resources", "app");
  await smokePackage({ appDirectory, platform });
  process.stdout.write(
    `Package smoke passed: ${RELEASE_METADATA.productName} ${RELEASE_METADATA.version} (${platform}/${arch})\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await smoke();
  } catch (error) {
    process.stderr.write(`Package smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
