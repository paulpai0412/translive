import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RecordsStore } from "./records-store.js";

function entry(overrides = {}) {
  return {
    atMs: 1_700_000_000_000,
    direction: "rx",
    side: "source",
    text: "We expect to begin production.",
    ...overrides,
  };
}

test("persists one redacted transcript directory atomically without audio or credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-records-"));
  const store = new RecordsStore({ directory });
  await store.grantPlaintextConsent({ confirmed: true });

  const saved = await store.saveSession({
    id: "session-001",
    metadata: {
      endedAtMs: 1_700_000_060_000,
      mode: "meeting",
      platform: "teams",
      startedAtMs: 1_700_000_000_000,
    },
    entries: [
      entry({ text: "Authorization: Bearer sk-secret-value" }),
      entry({
        atMs: 1_700_000_001_000,
        direction: "tx",
        side: "target",
        text: "We expect to begin production.",
        audio: "must-not-persist",
        sdp: "v=0\r\na=candidate:secret",
      }),
    ],
  });

  assert.equal(saved.id, "session-001");
  assert.equal(saved.mode, "meeting");
  assert.equal(saved.platform, "teams");
  assert.equal(saved.durationMs, 60_000);
  assert.equal(saved.entryCount, 2);
  assert.equal(saved.hasSummary, false);
  assert.match(saved.path, /sessions[\\/]session-001$/);
  assert.equal((await store.listSessions())[0].id, "session-001");

  const session = await store.readSession("session-001");
  assert.equal(session.entries.length, 2);
  assert.equal(session.entries[0].side, "source");
  assert.equal(session.entries[1].side, "target");
  assert.equal(session.entries[0].offsetMs, 0);
  assert.equal(session.entries[1].offsetMs, 1_000);
  assert.doesNotMatch(
    JSON.stringify(session),
    /sk-secret-value|candidate:secret|must-not-persist|v=0/,
  );

  const files = await readdir(join(directory, "sessions", "session-001"));
  assert.deepEqual(files.sort(), [
    "manifest.json",
    "metadata.json",
    "transcript.json",
    "transcript.md",
  ]);
  assert.equal(
    (await readdir(join(directory, "sessions"))).some((name) =>
      name.includes(".tmp"),
    ),
    false,
  );
});

test("stores distinct single-session and aggregate summaries with source session references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-records-summary-"));
  const store = new RecordsStore({ directory });
  await store.grantPlaintextConsent({ confirmed: true });
  await store.saveSession({
    id: "session-a",
    metadata: {
      mode: "meeting",
      platform: "teams",
      startedAtMs: 1,
      endedAtMs: 2,
    },
    entries: [entry()],
  });
  await store.saveSession({
    id: "session-b",
    metadata: {
      mode: "media",
      platform: "custom",
      startedAtMs: 3,
      endedAtMs: 4,
    },
    entries: [entry({ atMs: 3, text: "Second meeting" })],
  });

  const single = await store.saveSessionSummary("session-a", {
    generatedAtMs: 10,
    markdown: "# 單場摘要\n\n## 重點\n- 已確認\n",
    sourceSessions: [{ id: "session-a", timestamps: [1] }],
  });
  const aggregate = await store.saveAggregateSummary({
    generatedAtMs: 11,
    id: "aggregate-001",
    markdown: "# 跨場摘要匯整\n\n## 共同主題\n- 僅限 session-a 的內容\n",
    sourceSessions: [
      { id: "session-a", timestamps: [1] },
      { id: "session-b", timestamps: [3] },
    ],
  });

  assert.equal(
    (await store.readSession("session-a")).summary.markdown,
    single.markdown,
  );
  assert.deepEqual(await store.listAggregates(), [
    {
      id: "aggregate-001",
      kind: "aggregate",
      generatedAtMs: 11,
      sourceSessions: [
        { id: "session-a", timestamps: [1] },
        { id: "session-b", timestamps: [3] },
      ],
    },
  ]);
  assert.equal(
    (await store.readAggregate("aggregate-001")).markdown,
    aggregate.markdown,
  );

  await store.deleteSession("session-a");
  assert.deepEqual(await store.listAggregates(), []);
  await assert.rejects(store.readAggregate("aggregate-001"));
  await assert.rejects(
    readFile(
      join(directory, "summaries", "aggregate-aggregate-001", "summary.md"),
    ),
  );
  const [remaining] = await store.listSessions();
  assert.equal(remaining.id, "session-b");
  assert.equal(remaining.durationMs, 1);
  assert.equal(remaining.hasSummary, false);
  assert.deepEqual(remaining.languages, {
    rxTarget: "繁體中文（台灣）",
    txSource: "未指定",
    txTarget: "未指定",
  });
  assert.deepEqual(await store.listAggregates(), []);
  await assert.rejects(
    readFile(join(directory, "sessions", "session-a", "metadata.json")),
  );
});

test("rejects unsafe record identifiers and malformed transcript entries", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "translive-records-validation-"),
  );
  const store = new RecordsStore({ directory });
  await store.grantPlaintextConsent({ confirmed: true });

  await assert.rejects(
    store.saveSession({
      id: "../outside",
      metadata: {},
      entries: [entry()],
    }),
    /identifier/i,
  );
  await assert.rejects(
    store.saveSession({
      id: "session-safe",
      metadata: {
        startedAtMs: 1,
        endedAtMs: 2,
      },
      entries: [{ atMs: "never", side: "source", text: "bad" }],
    }),
    /transcript entry/i,
  );
});

test("listSessions reports hasSummary once a summary exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-records-"));
  const store = new RecordsStore({ directory });
  await store.grantPlaintextConsent({ confirmed: true });
  await store.saveSession({
    id: "session-has-summary",
    metadata: {
      endedAtMs: 1_700_000_060_000,
      mode: "meeting",
      platform: "teams",
      startedAtMs: 1_700_000_000_000,
    },
    entries: [entry({ text: "內容" })],
  });
  let [listed] = await store.listSessions();
  assert.equal(listed.hasSummary, false);
  await store.saveSessionSummary("session-has-summary", {
    generatedAtMs: 1_700_000_061_000,
    markdown: "# x",
    sourceSessions: [
      { id: "session-has-summary", timestamps: [0] },
    ],
    structured: { sections: { 重點: [], 決策: [], 待辦: [], 未決問題: [] } },
  });
  [listed] = await store.listSessions();
  assert.equal(listed.hasSummary, true);
});
