import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  RELEASE_METADATA,
  packageIgnore,
  packagedPathIsAllowed,
} from "./release-config.js";

test("defines branded Windows release metadata", () => {
  const packageJson = createRequire(import.meta.url)("../package.json");
  assert.deepEqual(RELEASE_METADATA, {
    appId: "com.paulpai.translive",
    productName: "TransLive",
    version: "0.1.0-beta.1",
  });
  assert.equal(packageJson.productName, RELEASE_METADATA.productName);
  assert.equal(packageJson.translive.appId, RELEASE_METADATA.appId);
  assert.equal(packageJson.version, RELEASE_METADATA.version);
});

test("packages only production runtime files and excludes secrets, evidence, and tests", () => {
  for (const path of [
    "package.json",
    "src/device-recommendations.js",
    "src/json-file-store.js",
    "src/mini-caption-window.js",
    "src/mini-caption.html",
    "src/mini-caption.css",
    "src/mini-caption-preload.cjs",
    "src/mini-caption-renderer.js",
    "src/main.js",
    "src/voice-conversion-capability.js",
    "src/voice-conversion-controller.js",
    "src/voice-profile-store.js",
    "src/private-local-storage.js",
    "src/rvc-runtime-trust.js",
    "src/voice-training-ipc.cjs",
    "src/voice-training-policy.js",
    "src/voice-training-runtime.js",
    "src/voice-training-session-controller.js",
    "src/voice-training-store.js",
    "src/voicemeeter-routing.js",
    "src/windows-audio-defaults-controller.js",
    "src/windows-audio-defaults-store.js",
    "src/windows-meeting-device-adapter.js",
    "assets/translive-brand/translive.ico",
    "assets/codex/manifest.json",
    "assets/codex/win32/codex.exe",
    "assets/codex/win32/codex.exe.sig",
    "scripts/windows-meeting-devices.ps1",
    "scripts/create-rvc-runtime-manifest.mjs",
    "scripts/ensure-rvc-private-root.ps1",
    "scripts/probe-rvc-capability.ps1",
    "scripts/rvc-runtime-trust.json",
    "scripts/rvc-training-runtime.py",
    "scripts/verify-rvc-python.ps1",
    "scripts/windows-voicemeeter-routing.ps1",
  ]) {
    assert.equal(packagedPathIsAllowed(path), true, path);
  }
  for (const path of [
    ".env",
    ".scratch/login.txt",
    ".translive-evidence/run.json",
    ".pi/todos/task.md",
    "docs/research/private.md",
    "fixtures/fake-codex-app-server.mjs",
    "src/records-store.test.js",
    "src/private-token.txt",
    "src/.npmrc",
    "assets/translive-brand/private-key.pem",
    "scripts/check.mjs",
    "release/TransLive-linux-x64/resources/app/src/main.js",
    "node_modules/.cache/jiti/shared-session-tokens.mjs",
    "node_modules/electron/index.js",
    "assets/codex/win32/unverified.exe",
  ]) {
    assert.equal(packagedPathIsAllowed(path), false, path);
  }
  assert.equal(packageIgnore("/repo/src/main.js", "/repo"), false);
  assert.equal(packageIgnore("/repo/src/main.test.js", "/repo"), true);
  assert.equal(
    packageIgnore("/repo/assets/codex/win32/codex.exe", "/repo"),
    false,
  );
  assert.equal(packageIgnore("/package.json", "/repo"), false);
  assert.equal(packageIgnore("/src", "/repo"), false);
  assert.equal(packageIgnore("/src/main.test.js", "/repo"), true);
  assert.equal(
    packageIgnore(
      "/repo/node_modules/.cache/jiti/shared-session-tokens.mjs",
      "/repo",
    ),
    true,
  );
});

test("allowlists the pinyin-pro runtime dependency but not arbitrary node_modules", async () => {
  const { packagedPathIsAllowed } = await import("./release-config.js");
  assert.equal(
    packagedPathIsAllowed("node_modules/pinyin-pro/dist/esm/index.mjs"),
    true,
  );
  assert.equal(packagedPathIsAllowed("node_modules/pinyin-pro"), true);
  assert.equal(packagedPathIsAllowed("node_modules/electron/index.js"), false);
});
