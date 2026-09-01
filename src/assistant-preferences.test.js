import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AssistantPreferences } from "./assistant-preferences.js";

async function prefsFor() {
  const directory = await mkdtemp(join(tmpdir(), "assistant-prefs-"));
  return {
    directory,
    prefs: new AssistantPreferences({ directory }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("defaults to review delivery with wake armed", async () => {
  const { prefs, cleanup } = await prefsFor();
  try {
    assert.deepEqual(await prefs.load(), {
      answerDelivery: "review",
      wakeArmed: true,
    });
  } finally {
    await cleanup();
  }
});

test("persists and reloads explicit values", async () => {
  const { directory, prefs, cleanup } = await prefsFor();
  try {
    await prefs.save({ answerDelivery: "auto", wakeArmed: false });
    const reloaded = new AssistantPreferences({ directory });
    assert.deepEqual(await reloaded.load(), {
      answerDelivery: "auto",
      wakeArmed: false,
    });
  } finally {
    await cleanup();
  }
});

test("normalizes unknown values back to safe defaults", async () => {
  const { prefs, cleanup } = await prefsFor();
  try {
    const saved = await prefs.save({ answerDelivery: "yolo", wakeArmed: "yes" });
    assert.equal(saved.answerDelivery, "review");
    assert.equal(saved.wakeArmed, true);
  } finally {
    await cleanup();
  }
});
