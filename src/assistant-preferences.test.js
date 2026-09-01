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
      wakePhrase: "translive",
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
      wakePhrase: "translive",
    });
  } finally {
    await cleanup();
  }
});

test("normalizes unknown values back to safe defaults", async () => {
  const { prefs, cleanup } = await prefsFor();
  try {
    const saved = await prefs.save({
      answerDelivery: "yolo",
      wakeArmed: "yes",
    });
    assert.equal(saved.answerDelivery, "review");
    assert.equal(saved.wakeArmed, true);
  } finally {
    await cleanup();
  }
});

test("wake phrase persists and falls back to translive when invalid", async () => {
  const { directory, prefs, cleanup } = await prefsFor();
  try {
    await prefs.save({ answerDelivery: "review", wakeArmed: true, wakePhrase: "小泥小泥" });
    const reloaded = new AssistantPreferences({ directory });
    assert.equal((await reloaded.load()).wakePhrase, "小泥小泥");
    const normalized = await prefs.save({ wakePhrase: "   " });
    assert.equal(normalized.wakePhrase, "translive");
    const tooLong = await prefs.save({ wakePhrase: "x".repeat(41) });
    assert.equal(tooLong.wakePhrase, "translive");
  } finally {
    await cleanup();
  }
});

test("defaults include the translive wake phrase", async () => {
  const { prefs, cleanup } = await prefsFor();
  try {
    assert.equal((await prefs.load()).wakePhrase, "translive");
  } finally {
    await cleanup();
  }
});
