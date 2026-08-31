import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WindowsAudioDefaultsStore } from "./windows-audio-defaults-store.js";

const original = {
  capture: {
    consoleId: "physical-capture-console",
    multimediaId: "physical-capture-multimedia",
    communicationsId: "physical-capture-communications",
  },
  render: {
    consoleId: "physical-render-console",
    multimediaId: "physical-render-multimedia",
    communicationsId: "physical-render-communications",
  },
};
const target = {
  capture: { ...original.capture, communicationsId: "voicemeeter-b2" },
  render: { ...original.render, communicationsId: "voicemeeter-input" },
};
const checkpoint = {
  mode: "meeting",
  phase: "active",
  snapshot: original,
  target,
};

test("persists only a complete mode-scoped all-role checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-mode-audio-"));
  const store = new WindowsAudioDefaultsStore({ directory });
  await store.save(checkpoint);
  assert.deepEqual(await store.load(), checkpoint);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(directory, "windows-audio-defaults-restore.json"),
        "utf8",
      ),
    ),
    checkpoint,
  );
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test("loads a complete legacy all-role target so upgrades can restore it", async () => {
  const legacy = {
    phase: "active",
    snapshot: original,
    target: { captureId: "legacy-b2", renderId: "legacy-vaio" },
  };
  const store = new WindowsAudioDefaultsStore({
    directory: "/not-used",
    readFile: async () => JSON.stringify(legacy),
  });
  assert.deepEqual(await store.load(), {
    mode: "legacy",
    phase: "active",
    snapshot: original,
    target: {
      capture: {
        consoleId: "legacy-b2",
        multimediaId: "legacy-b2",
        communicationsId: "legacy-b2",
      },
      render: {
        consoleId: "legacy-vaio",
        multimediaId: "legacy-vaio",
        communicationsId: "legacy-vaio",
      },
    },
  });
});

test("rejects incomplete and unsupported-mode checkpoints", async () => {
  const store = new WindowsAudioDefaultsStore({
    directory: "/not-used",
    readFile: async () => '{"target":{"captureId":"legacy"}}',
  });
  assert.deepEqual(await store.load(), { invalid: true });
  for (const value of [
    { ...checkpoint, mode: "unknown" },
    { ...checkpoint, target: { capture: {}, render: {} } },
    { snapshot: original },
  ]) {
    await assert.rejects(
      store.save(value),
      /mode-scoped all-role Windows audio checkpoint/i,
    );
  }
});
