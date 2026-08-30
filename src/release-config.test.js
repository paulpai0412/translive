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
    "src/main.js",
    "src/windows-meeting-device-adapter.js",
    "assets/translive-brand/translive.ico",
    "assets/codex/manifest.json",
    "assets/codex/win32/codex.exe",
    "assets/codex/win32/codex.exe.sig",
    "scripts/windows-meeting-devices.ps1",
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
