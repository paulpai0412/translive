import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  assertPrivateLocalDirectory,
  isDriveLocalWindowsPath,
} from "./private-local-storage.js";

test("accepts only drive-local Windows roots and rejects UNC or device paths", () => {
  assert.equal(isDriveLocalWindowsPath("C:\\Users\\Ada\\AppData\\Local\\TransLive"), true);
  for (const path of [
    "\\\\server\\share\\TransLive",
    "\\\\?\\C:\\Temp\\TransLive",
    "\\\\.\\PIPE\\TransLive",
    "relative\\TransLive",
  ]) {
    assert.equal(isDriveLocalWindowsPath(path), false, path);
  }
});

test("Windows private-root provisioning replaces broad ACLs and resets descendants", async () => {
  const script = await readFile(
    new URL("../scripts/ensure-rvc-private-root.ps1", import.meta.url),
    "utf8",
  );

  assert.match(script, /icacls\.exe \$root \/inheritance:r \/grant:r/);
  assert.match(script, /icacls\.exe \$root \/remove/);
  assert.match(script, /icacls\.exe \$children \/reset \/T/);
  assert.match(script, /S-1-5-18/);
  assert.match(script, /S-1-5-32-544/);
  assert.match(script, /\$allowed -notcontains \$sidValue/);
});

test("refuses a reparse-point storage root before handling sensitive artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "translive-private-root-"));
  const target = join(root, "target");
  const link = join(root, "linked");
  await mkdir(target);
  try {
    await symlink(target, link, "dir");
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("Windows symlink privilege unavailable");
    throw error;
  }

  await assert.rejects(
    assertPrivateLocalDirectory({ directory: link, platform: process.platform }),
    /TRANSLIVE_PRIVATE_STORAGE_REPARSE/,
  );
  await assert.doesNotReject(
    assertPrivateLocalDirectory({ directory: target, platform: process.platform }),
  );
});
