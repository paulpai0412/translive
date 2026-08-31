import { lstat as defaultLstat, mkdir as defaultMkdir } from "node:fs/promises";
import { posix, win32 } from "node:path";

function fail(code) {
  throw new Error(`TRANSLIVE_PRIVATE_STORAGE_${code}`);
}

function pathApi(path) {
  return /^[A-Za-z]:[\\/]/.test(String(path ?? "")) ||
    String(path ?? "").includes("\\")
    ? win32
    : posix;
}

function isReparsePoint(info) {
  return (
    info?.isSymbolicLink?.() === true ||
    info?.isReparsePoint === true ||
    (Number.isSafeInteger(info?.mode) && (info.mode & 0o170000) === 0o120000)
  );
}

export function isDriveLocalWindowsPath(value) {
  const path = String(value ?? "");
  return (
    /^[A-Za-z]:[\\/]/.test(path) &&
    !/^\\\\/.test(path) &&
    !/^\\\\[.?]\\/.test(path)
  );
}

/**
 * Creates/checks a user-owned local root before any voice artifact is handled.
 * Windows caller code separately applies the current-user ACL; this boundary
 * rejects network/device paths and any reparse point in the resolved path.
 */
export async function assertPrivateLocalDirectory({
  directory,
  lstat = defaultLstat,
  mkdir = defaultMkdir,
  platform = process.platform,
} = {}) {
  if (typeof directory !== "string" || !directory) fail("PATH");
  if (platform === "win32" && !isDriveLocalWindowsPath(directory)) {
    fail("PATH");
  }
  const api = pathApi(directory);
  const absolute = api.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const root = api.parse(absolute).root;
  const relative = api.relative(root, absolute);
  let cursor = root;
  for (const segment of relative.split(/[\\/]/).filter(Boolean)) {
    cursor = api.join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch {
      fail("REPARSE");
    }
    if (!info.isDirectory() || isReparsePoint(info)) fail("REPARSE");
  }
  return absolute;
}
