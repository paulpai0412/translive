import assert from "node:assert/strict";
import test from "node:test";

import { summarizeSessionInBackground } from "./session-summary-job.js";

function fixture(overrides = {}) {
  const published = [];
  const indexed = [];
  const savedSummaries = [];
  return {
    published,
    indexed,
    savedSummaries,
    records: {
      readSession: async (id) => ({
        metadata: { id, mode: "meeting", startedAtMs: 1_000 },
        entries: [
          { offsetMs: 0, direction: "tx", side: "source", text: "內容" },
        ],
      }),
      saveSessionSummary: async (id, payload) => {
        savedSummaries.push({ id, payload });
      },
      ...overrides.records,
    },
    summaryService: overrides.summaryService ?? {
      generate: async () => ({
        sections: { 重點: [], 決策: [], 待辦: [], 未決問題: [] },
      }),
    },
  };
}

test("publishes generating then saved, persists, and reindexes", async () => {
  const f = fixture();
  const meetingIndex = { indexSession: (s) => f.indexed.push(s) };
  summarizeSessionInBackground({
    records: f.records,
    summaryService: f.summaryService,
    meetingIndex,
    publish: (e) => f.published.push(e),
    sessionId: "s-1",
  });
  assert.equal(f.published[0].state, "generating");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.savedSummaries.length, 1);
  assert.equal(f.indexed.length, 1);
  assert.ok(f.indexed[0].summary);
  assert.equal(f.published.at(-1).state, "saved");
});

test("a generation failure surfaces as failed and never throws", async () => {
  const f = fixture({
    summaryService: {
      generate: async () => {
        throw new Error("boom");
      },
    },
  });
  summarizeSessionInBackground({
    records: f.records,
    summaryService: f.summaryService,
    publish: (e) => f.published.push(e),
    sessionId: "s-1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.published.at(-1).state, "failed");
});
