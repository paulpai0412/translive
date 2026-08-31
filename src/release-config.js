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
  "src/adaptive-pacing-controller.js",
  "src/audio-output.js",
  "src/codex-app-server.js",
  "src/device-recommendations.js",
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
  "src/mini-caption-window.js",
  "src/mini-caption.html",
  "src/mini-caption.css",
  "src/mini-caption-preload.cjs",
  "src/mini-caption-renderer.js",
  "src/permissions.js",
  "src/phase-one-controller.js",
  "src/private-local-storage.js",
  "src/preload.cjs",
  "src/records-path.js",
  "src/records-store.js",
  "src/release-config.js",
  "src/rvc-runtime-trust.js",
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
  "src/voice-conversion-capability.js",
  "src/voice-conversion-controller.js",
  "src/voice-profile-store.js",
  "src/voice-training-policy.js",
  "src/voice-training-runtime.js",
  "src/voice-training-session-controller.js",
  "src/voice-training-store.js",
  "src/voice-training-ipc.cjs",
  "src/voicemeeter-route-health.js",
  "src/voicemeeter-routing.js",
  "src/view-state.js",
  "src/windows-audio-defaults-controller.js",
  "src/windows-audio-defaults-store.js",
  "src/windows-meeting-device-adapter.js",
  "scripts",
  "scripts/create-rvc-runtime-manifest.mjs",
  "scripts/ensure-rvc-private-root.ps1",
  "scripts/probe-rvc-capability.ps1",
  "scripts/rvc-runtime-trust.json",
  "scripts/rvc-training-runtime.py",
  "scripts/verify-rvc-python.ps1",
  "scripts/windows-meeting-devices.ps1",
  "scripts/windows-voicemeeter-routing.ps1",
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
