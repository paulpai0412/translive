import { createHash } from "node:crypto";
import {
  access as defaultAccess,
  readFile as defaultReadFile,
} from "node:fs/promises";
import { posix, win32 } from "node:path";

const BUNDLE_ROOT = "assets/codex";

function externalLaunch(env, source) {
  return {
    executable: env.TRANSLIVE_CODEX_BIN || "codex",
    source,
    version: undefined,
  };
}

function pathApi(appPath) {
  return /^[a-z]:[\\/]/i.test(appPath) || appPath.includes("\\")
    ? win32
    : posix;
}

function safeBundlePath(appPath, platform, relativePath) {
  const normalized = posix.normalize(
    String(relativePath ?? "").replaceAll("\\", "/"),
  );
  const requiredPrefix = `${BUNDLE_ROOT}/${platform}/`;
  if (!normalized.startsWith(requiredPrefix) || normalized.includes("..")) {
    throw new Error("Bundled Codex manifest has an unsafe asset path");
  }
  return pathApi(appPath).resolve(appPath, normalized);
}

async function defaultHashFile(path, readFile) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function resolveCodexLaunch({
  allowExternalPackaged = false,
  appPath,
  env = process.env,
  hashFile,
  isPackaged,
  platform = process.platform,
  readFile = defaultReadFile,
  access = defaultAccess,
} = {}) {
  if (!isPackaged) return externalLaunch(env, "external-development");
  if (platform !== "win32") {
    if (!allowExternalPackaged) {
      throw new Error(
        "External packaged Codex is disabled outside the explicit dev/test policy",
      );
    }
    return externalLaunch(env, "external-packaged-test");
  }

  const manifestPath = pathApi(appPath).join(
    appPath,
    BUNDLE_ROOT,
    "manifest.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("Bundled Codex manifest is missing or invalid");
  }
  const asset = manifest?.platforms?.[platform];
  if (
    !asset ||
    typeof asset.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
    typeof asset.version !== "string"
  ) {
    throw new Error("Bundled Codex manifest is missing checksum or version");
  }
  const executable = safeBundlePath(appPath, platform, asset.path);
  const signature = safeBundlePath(appPath, platform, asset.signaturePath);
  try {
    await access(executable);
    await access(signature);
  } catch {
    throw new Error("Bundled Codex executable or signing input is missing");
  }
  const checksum = await (hashFile
    ? hashFile(executable)
    : defaultHashFile(executable, readFile));
  if (checksum.toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new Error("Bundled Codex checksum verification failed");
  }
  return { executable, source: "bundled", version: asset.version };
}

export async function assertWindowsCodexBundle({ appPath, ...options }) {
  return resolveCodexLaunch({
    appPath,
    isPackaged: true,
    platform: "win32",
    ...options,
  });
}
