import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { smokePackage } from "./package-smoke.mjs";

async function writeStagedWindowsApp(appDirectory) {
  const executable = join(
    appDirectory,
    "assets",
    "codex",
    "win32",
    "codex.exe",
  );
  const bytes = Buffer.from("staged-signed-codex");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await Promise.all([
    mkdir(join(appDirectory, "src"), { recursive: true }),
    mkdir(join(appDirectory, "scripts"), { recursive: true }),
    mkdir(join(appDirectory, "assets", "translive-brand"), { recursive: true }),
    mkdir(join(appDirectory, "assets", "codex", "win32"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(appDirectory, "package.json"),
      JSON.stringify({
        productName: "TransLive",
        translive: { appId: "com.paulpai.translive" },
        version: "0.1.0-beta.1",
      }),
    ),
    writeFile(join(appDirectory, "src", "main.js"), "export {};\n"),
    writeFile(join(appDirectory, "scripts", "windows-meeting-devices.ps1"), ""),
    writeFile(
      join(appDirectory, "assets", "translive-brand", "translive-mark.svg"),
      "<svg/>\n",
    ),
    writeFile(executable, bytes),
    writeFile(`${executable}.sig`, "staged-signature\n"),
    writeFile(
      join(appDirectory, "assets", "codex", "manifest.json"),
      JSON.stringify({
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
    ),
  ]);
  return executable;
}

test("package smoke resolves a staged verified Windows Codex bundle from packaged resources", async () => {
  const appDirectory = await mkdtemp(join(tmpdir(), "translive-packaged-app-"));
  const executable = await writeStagedWindowsApp(appDirectory);

  const result = await smokePackage({
    appDirectory,
    arch: "x64",
    platform: "win32",
  });

  assert.deepEqual(result.codexLaunch, {
    executable,
    source: "bundled",
    version: "0.150.0",
  });
});

test("package smoke rejects unapproved source and brand files", async () => {
  const appDirectory = await mkdtemp(join(tmpdir(), "translive-packaged-app-"));
  await writeStagedWindowsApp(appDirectory);
  await Promise.all([
    writeFile(join(appDirectory, "src", "private-token.txt"), "secret"),
    writeFile(join(appDirectory, "src", ".npmrc"), "registry=private"),
    writeFile(
      join(appDirectory, "assets", "translive-brand", "private-key.pem"),
      "private key",
    ),
  ]);

  await assert.rejects(
    smokePackage({ appDirectory, arch: "x64", platform: "win32" }),
    (error) => {
      assert.match(error.message, /unapproved files/i);
      assert.match(error.message, /private-token\.txt/i);
      assert.match(error.message, /\.npmrc/i);
      assert.match(error.message, /private-key\.pem/i);
      return true;
    },
  );
});
