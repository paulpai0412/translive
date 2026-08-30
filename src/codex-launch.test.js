import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { resolveCodexLaunch } from "./codex-launch.js";

const BUNDLE_PATH = "/app/assets/codex/win32/codex.exe";
const SIGNATURE_PATH = "/app/assets/codex/win32/codex.exe.sig";
const MANIFEST_PATH = "/app/assets/codex/manifest.json";
const BUNDLE_BYTES = Buffer.from("signed-codex-binary");
const CHECKSUM = createHash("sha256").update(BUNDLE_BYTES).digest("hex");

function bundledFiles({ checksum = CHECKSUM, signature = true } = {}) {
  return {
    [MANIFEST_PATH]: JSON.stringify({
      schemaVersion: 1,
      platforms: {
        win32: {
          path: "assets/codex/win32/codex.exe",
          sha256: checksum,
          signaturePath: "assets/codex/win32/codex.exe.sig",
          version: "0.150.0",
        },
      },
    }),
    [BUNDLE_PATH]: BUNDLE_BYTES,
    ...(signature ? { [SIGNATURE_PATH]: Buffer.from("detached-signature") } : {}),
  };
}

function filesAdapter(files) {
  return {
    async readFile(path) {
      if (!(path in files)) throw new Error(`missing ${path}`);
      return files[path];
    },
    async access(path) {
      if (!(path in files)) throw new Error(`missing ${path}`);
    },
  };
}

test("packaged Windows launch prefers and verifies the bundled signed Codex asset", async () => {
  const files = bundledFiles();
  const result = await resolveCodexLaunch({
    appPath: "/app",
    hashFile: async (path) => createHash("sha256").update(files[path]).digest("hex"),
    isPackaged: true,
    platform: "win32",
    ...filesAdapter(files),
  });

  assert.deepEqual(result, {
    executable: BUNDLE_PATH,
    source: "bundled",
    version: "0.150.0",
  });
});

test("refuses a packaged Windows launch when bundle, signature, or checksum is invalid", async () => {
  for (const files of [
    bundledFiles({ signature: false }),
    bundledFiles({ checksum: "0".repeat(64) }),
  ]) {
    await assert.rejects(
      resolveCodexLaunch({
        appPath: "/app",
        hashFile: async (path) =>
          createHash("sha256").update(files[path]).digest("hex"),
        isPackaged: true,
        platform: "win32",
        ...filesAdapter(files),
      }),
      /bundled Codex/i,
    );
  }
});

test("development may explicitly use an external Codex executable", async () => {
  const result = await resolveCodexLaunch({
    appPath: "/app",
    env: { TRANSLIVE_CODEX_BIN: "C:\\dev\\codex.exe" },
    isPackaged: false,
    platform: "win32",
  });

  assert.deepEqual(result, {
    executable: "C:\\dev\\codex.exe",
    source: "external-development",
    version: undefined,
  });
});

test("packaged non-Windows paths require explicit test policy before using PATH", async () => {
  await assert.rejects(
    resolveCodexLaunch({
      appPath: "/app",
      isPackaged: true,
      platform: "linux",
    }),
    /external packaged Codex/i,
  );
  assert.deepEqual(
    await resolveCodexLaunch({
      allowExternalPackaged: true,
      appPath: "/app",
      env: { TRANSLIVE_CODEX_BIN: "codex-test" },
      isPackaged: true,
      platform: "linux",
    }),
    {
      executable: "codex-test",
      source: "external-packaged-test",
      version: undefined,
    },
  );
});
