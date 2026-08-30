import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WindowsAudioDefaultsStore } from "./windows-audio-defaults-store.js";

const snapshot = {
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

const checkpoint = {
  phase: "active",
  snapshot,
  target: {
    captureId: "voicemeeter-b2",
    renderId: "voicemeeter-input",
  },
};

test("durably persists only a complete phase-aware all-role Windows audio checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-global-audio-"));
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

test("marks incomplete or legacy persisted checkpoints unsafe instead of silently using them", async () => {
  const store = new WindowsAudioDefaultsStore({
    directory: "/not-used",
    readFile: async () =>
      '{"snapshot":{"capture":{"consoleId":"mic"},"render":{}}}',
  });

  assert.deepEqual(await store.load(), { invalid: true });
  await assert.rejects(
    store.save({ snapshot }),
    /phase-aware all-role Windows audio checkpoint/i,
  );
});
