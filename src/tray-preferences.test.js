import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TrayPreferences } from "./tray-preferences.js";

test("defaults to close-to-tray and stores only tray preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-tray-preferences-"));
  const preferences = new TrayPreferences({ directory });

  assert.deepEqual(await preferences.load(), {
    closeBehavior: "tray",
    closeNoticeShown: false,
  });

  await preferences.save({ closeBehavior: "exit", closeNoticeShown: true });
  const persisted = JSON.parse(
    await readFile(join(directory, "tray-preferences.json"), "utf8"),
  );
  assert.deepEqual(persisted, {
    closeBehavior: "exit",
    closeNoticeShown: true,
  });
});

test("normalizes malformed tray preferences to safe defaults", async () => {
  const preferences = new TrayPreferences({
    directory: "/not-used",
    readFile: async () => '{"closeBehavior":"unexpected","closeNoticeShown":"yes"}',
  });

  assert.deepEqual(await preferences.load(), {
    closeBehavior: "tray",
    closeNoticeShown: false,
  });
});
