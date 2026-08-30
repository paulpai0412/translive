import { relative } from "node:path";

export const RELEASE_METADATA = Object.freeze({
  appId: "com.paulpai.translive",
  productName: "TransLive",
  version: "0.1.0-beta.1",
});

const PACKAGED_PATHS = new Set([
  "",
  ".",
  "package.json",
  "src",
  "src/account-controller.js",
  "src/codex-app-server.js",
  "src/codex-launch.js",
  "src/codex-runtime.js",
  "src/diagnostics-service.js",
  "src/dual-channel-run.js",
  "src/evidence.js",
  "src/index.html",
  "src/json-file-store.js",
  "src/main.js",
  "src/meeting-setup-controller.js",
  "src/meeting-setup-request.js",
  "src/meeting-setup-store.js",
  "src/permissions.js",
  "src/phase-one-controller.js",
  "src/preload.cjs",
  "src/records-path.js",
  "src/records-store.js",
  "src/release-config.js",
  "src/renderer-control-bridge.js",
  "src/renderer-control.js",
  "src/renderer-entry.js",
  "src/renderer-state.js",
  "src/startup-session.js",
  "src/styles.css",
  "src/summary-controller.js",
  "src/summary-service.js",
  "src/text-sanitizer.js",
  "src/translation-lifecycle.js",
  "src/tray-controller.js",
  "src/tray-preferences.js",
  "src/view-state.js",
  "src/windows-audio-defaults-controller.js",
  "src/windows-audio-defaults-store.js",
  "src/windows-meeting-device-adapter.js",
  "scripts",
  "scripts/windows-meeting-devices.ps1",
  "assets",
  "assets/translive-brand",
  "assets/translive-brand/translive-mark.svg",
  "assets/translive-brand/translive-tray.png",
  "assets/translive-brand/translive.ico",
  "assets/codex",
  "assets/codex/manifest.json",
  "assets/codex/win32",
  "assets/codex/win32/codex.exe",
  "assets/codex/win32/codex.exe.sig",
]);

function normalizedPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}

export function packagedPathIsAllowed(path) {
  return PACKAGED_PATHS.has(normalizedPath(path));
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
