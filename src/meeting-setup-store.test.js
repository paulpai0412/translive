import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MeetingSetupStore } from "./meeting-setup-store.js";

test("persists only restorable communication endpoint snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-meeting-store-"));
  const store = new MeetingSetupStore({ directory });

  await store.save({
    app: "teams",
    snapshot: { captureId: "old-mic", renderId: "old-speaker" },
  });

  assert.deepEqual(await store.load(), {
    app: "teams",
    snapshot: { captureId: "old-mic", renderId: "old-speaker" },
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "meeting-device-restore.json"), "utf8")),
    {
      app: "teams",
      snapshot: { captureId: "old-mic", renderId: "old-speaker" },
    },
  );
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test("rejects malformed saved device state", async () => {
  const store = new MeetingSetupStore({
    directory: "/not-used",
    readFile: async () => '{"app":"teams","snapshot":{"captureId":false}}',
  });

  assert.equal(await store.load(), undefined);
});
