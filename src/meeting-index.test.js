import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MeetingIndex } from "./meeting-index.js";

function sessionFixture(overrides = {}) {
  const { metadata: metadataOverrides = {}, ...rest } = overrides;
  return {
    metadata: {
      id: "session-1",
      mode: "meeting",
      startedAtMs: Date.parse("2026-08-31T09:00:00+08:00"),
      endedAtMs: Date.parse("2026-08-31T10:00:00+08:00"),
      ...metadataOverrides,
    },
    entries: rest.entries ?? defaultEntries(),
    ...rest,
  };
}

function defaultEntries() {
  return [
    {
      offsetMs: 60_000,
      direction: "tx",
      side: "source",
      text: "rollout 延後到九月五號,由 Alice 負責",
    },
    {
      offsetMs: 120_000,
      direction: "rx",
      side: "source",
      text: "budget approved for the pilot",
    },
  ];
}

async function tempIndex() {
  const directory = await mkdtemp(join(tmpdir(), "meeting-index-"));
  const index = new MeetingIndex({
    databaseFile: join(directory, "index.db"),
  });
  return { directory, index };
}

test("finds English terms in transcript chunks with citations", async () => {
  const { directory, index } = await tempIndex();
  try {
    index.indexSession(sessionFixture());
    const hits = index.search("budget");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, "session-1");
    assert.equal(hits[0].offsetMs, 120_000);
    assert.equal(hits[0].tier, "transcript");
    assert.equal(hits[0].direction, "rx");
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("finds Chinese terms of three or more characters", async () => {
  const { directory, index } = await tempIndex();
  try {
    index.indexSession(sessionFixture());
    const hits = index.search("九月五號");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, "session-1");
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("falls back to substring scan for two-character CJK terms", async () => {
  const { directory, index } = await tempIndex();
  try {
    index.indexSession(sessionFixture());
    const hits = index.search("延後");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].offsetMs, 60_000);
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ranks summary tier before transcript tier", async () => {
  const { directory, index } = await tempIndex();
  try {
    index.indexSession(
      sessionFixture({
        summary: {
          sections: {
            決策: [
              {
                text: "rollout 改期到九月五號",
                citations: [{ sessionId: "session-1", offsetMs: 60_000 }],
              },
            ],
          },
        },
      }),
    );
    const hits = index.search("rollout");
    assert.ok(hits.length >= 2);
    assert.equal(hits[0].tier, "summary");
    assert.equal(hits[0].heading, "決策");
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("filters sessions by date range", async () => {
  const { directory, index } = await tempIndex();
  try {
    index.indexSession(sessionFixture());
    index.indexSession(
      sessionFixture({
        metadata: {
          id: "session-2",
          startedAtMs: Date.parse("2026-07-01T09:00:00+08:00"),
          endedAtMs: Date.parse("2026-07-01T10:00:00+08:00"),
        },
      }),
    );
    const hits = index.search("budget", {
      dateFrom: Date.parse("2026-08-01T00:00:00+08:00"),
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, "session-1");
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("removeSession deletes all of its chunks", async () => {
  const { directory, index } = await tempIndex();
  try {
    index.indexSession(sessionFixture());
    index.removeSession("session-1");
    assert.deepEqual(index.search("budget"), []);
    assert.deepEqual(index.search("延後"), []);
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns no hits for empty queries or an empty index", async () => {
  const { directory, index } = await tempIndex();
  try {
    index.indexSession(sessionFixture());
    assert.deepEqual(index.search(""), []);
    assert.deepEqual(index.search("   "), []);
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rebuild restores the index from session packages", async () => {
  const { directory, index } = await tempIndex();
  try {
    index.indexSession(sessionFixture());
    index.rebuild([]);
    assert.deepEqual(index.search("budget"), []);
    index.rebuild([sessionFixture()]);
    assert.equal(index.search("budget").length, 1);
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("indexes translation-mode target entries in the same index", async () => {
  const { directory, index } = await tempIndex();
  try {
    index.indexSession(
      sessionFixture({
        metadata: { id: "translation-1", mode: "meeting" },
        entries: [
          {
            offsetMs: 5_000,
            direction: "tx",
            side: "target",
            text: "the rollout moves to September fifth",
          },
        ],
      }),
    );
    const hits = index.search("rollout");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, "translation-1");
    assert.equal(hits[0].side, "target");
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeting-index-"));
  const databaseFile = join(directory, "index.db");
  try {
    const first = new MeetingIndex({ databaseFile });
    first.indexSession(sessionFixture());
    first.close();
    const second = new MeetingIndex({ databaseFile });
    assert.equal(second.search("budget").length, 1);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
