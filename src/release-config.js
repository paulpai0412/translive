import { relative } from "node:path";

export const RELEASE_METADATA = Object.freeze({
  appId: "com.paulpai.translive",
  productName: "TransLive",
  version: "0.1.0-beta.1",
});

function normalizedPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}

export function packagedPathIsAllowed(path) {
  const value = normalizedPath(path);
  if (value === "" || value === ".") return true;
  if (value === "package.json") return true;
  if (value === "scripts" || value === "scripts/windows-meeting-devices.ps1") {
    return true;
  }
  if (
    value === "assets" ||
    value === "assets/translive-brand" ||
    value.startsWith("assets/translive-brand/") ||
    value === "assets/codex" ||
    value === "assets/codex/win32"
  ) {
    return true;
  }
  if (
    [
      "assets/codex/manifest.json",
      "assets/codex/win32/codex.exe",
      "assets/codex/win32/codex.exe.sig",
    ].includes(value)
  ) {
    return true;
  }
  if (value === "src") return true;
  if (value.startsWith("src/")) {
    return !/\.test\.[cm]?js$/i.test(value);
  }
  return false;
}

export function packageIgnore(path, projectRoot) {
  const value = normalizedPath(path);
  const root = normalizedPath(projectRoot).replace(/\/$/, "");
  const relativePath =
    value === root || value.startsWith(`${root}/`)
      ? relative(projectRoot, path)
      : value;
  const normalized = normalizedPath(relativePath).replace(/^\/+/, "");
  return normalized.startsWith("../") || !packagedPathIsAllowed(normalized);
}
