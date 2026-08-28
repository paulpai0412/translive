import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  codexLaunchOptions,
  inspectCodexRuntime,
  resolveCodexExecutable,
} from "./codex-runtime.js";

test("uses a trusted Windows shell for npm cmd shims and direct launch on Linux", () => {
  assert.equal(codexLaunchOptions({ platform: "win32" }).shell, true);
  assert.equal(codexLaunchOptions({ platform: "linux" }).shell, false);
});

test("resolves a configured executable and records a checksum when available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-codex-runtime-"));
  const executable = join(directory, "codex.cmd");
  await writeFile(executable, "trusted shim", "utf8");

  const resolved = await resolveCodexExecutable(executable, {
    platform: "win32",
  });
  const runtime = await inspectCodexRuntime({
    executable,
    cwd: directory,
    platform: "win32",
    runCommand: async (_command, args, options) => {
      assert.equal(options.shell, true);
      if (args[0] === "--version") return { stdout: "codex-cli 0.145.0\n" };
      return { stdout: "Logged in using ChatGPT\n" };
    },
  });

  assert.equal(resolved, executable);
  assert.equal(runtime.semanticVersion, "0.145.0");
  assert.equal(runtime.loggedIn, true);
  assert.match(runtime.checksum, /^[a-f0-9]{64}$/);
});

test("parses authenticated status from stderr without accepting not logged in", async () => {
  const inspect = (loginResult) =>
    inspectCodexRuntime({
      executable: "codex",
      cwd: process.cwd(),
      includeChecksum: false,
      runCommand: async (_command, args) =>
        args[0] === "--version"
          ? { stdout: "codex-cli 0.145.0\n", stderr: "" }
          : loginResult,
    });

  assert.equal(
    (
      await inspect({
        stdout: "",
        stderr: "Logged in using ChatGPT\n",
      })
    ).loggedIn,
    true,
  );
  assert.equal(
    (
      await inspect({
        stdout: "Not logged in\n",
        stderr: "",
      })
    ).loggedIn,
    false,
  );
});
