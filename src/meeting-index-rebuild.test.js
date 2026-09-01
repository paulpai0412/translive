import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MeetingIndex } from "./meeting-index.js";
import { rebuildMeetingIndexFromRecords } from "./meeting-index-rebuild.js";
import { RecordsStore } from "./records-store.js";

test("rebuilds the index from stored sessions including summaries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rebuild-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = new RecordsStore({ directory });
  await records.grantPlaintextConsent({ confirmed: true });
  await records.saveSession({
    id: "old-1",
    metadata: {
      startedAtMs: Date.parse("2026-08-20T09:00:00+08:00"),
      endedAtMs: Date.parse("2026-08-20T10:00:00+08:00"),
      mode: "meeting",
      platform: "teams",
    },
    entries: [
      { atMs: Date.parse("2026-08-20T09:01:00+08:00"), direction: "tx", side: "source", text: "第一季預算核定十萬元" },
    ],
  });
  await records.saveSessionSummary("old-1", {
    generatedAtMs: Date.now(),
    markdown: "# x",
    sourceSessions: [
      { id: "old-1", timestamps: [60_000] },
    ],
    structured: {
      sections: {
        重點: [],
        決策: [
          { text: "預算十萬元", citations: [{ sessionId: "old-1", offsetMs: 60_000 }] },
        ],
        待辦: [],
        未決問題: [],
      },
    },
  });

  const index = new MeetingIndex();
  const count = await rebuildMeetingIndexFromRecords(records, index);
  assert.equal(count, 1);
  assert.ok(index.search("預算").some((hit) => hit.sessionId === "old-1"));
  assert.ok(
    index.search("預算十萬").some(
      (hit) => hit.tier === "summary" && hit.sessionId === "old-1",
    ),
  );
});

test("rebuild on an empty store yields an empty index", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rebuild-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = new RecordsStore({ directory });
  const index = new MeetingIndex();
  index.indexSession({
    metadata: { id: "stale", startedAtMs: 1 },
    entries: [{ offsetMs: 0, direction: "tx", side: "source", text: "stale" }],
  });
  const count = await rebuildMeetingIndexFromRecords(records, index);
  assert.equal(count, 0);
  assert.deepEqual(index.search("stale"), []);
});
