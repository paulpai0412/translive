import assert from "node:assert/strict";
import test from "node:test";

import { MeetingQa } from "./meeting-qa.js";

const CHUNKS = [
  {
    sessionId: "s-1",
    tier: "summary",
    heading: "決策",
    text: "rollout 改期到九月五號",
    offsetMs: 60_000,
  },
  {
    sessionId: "s-1",
    tier: "transcript",
    heading: "",
    text: "rollout 延後到九月五號,由 Alice 負責",
    offsetMs: 60_000,
  },
];

function qaFor(overrides = {}) {
  const calls = { answer: [], speak: [], publish: [], audit: [] };
  const qa = new MeetingQa({
    index: { search: () => CHUNKS },
    answer: async (prompt) => {
      calls.answer.push(prompt);
      return JSON.stringify({
        text: "上次的結論是 rollout 改到九月五號,負責人是 Alice。",
        citations: [{ sessionId: "s-1", offsetMs: 60_000 }],
      });
    },
    speak: async (text) => calls.speak.push(text),
    publish: (event) => calls.publish.push(event),
    audit: (entry) => calls.audit.push(entry),
    ...overrides,
  });
  return { calls, qa };
}

test("review delivery holds the answer until approved", async () => {
  const { calls, qa } = qaFor();
  const result = await qa.ask("上次會議結論是什麼");
  assert.equal(result.state, "pending");
  assert.equal(calls.speak.length, 0);
  const pending = calls.publish.find((e) => e.type === "qa-pending");
  assert.ok(pending.answer.text.includes("九月五號"));
  assert.deepEqual(pending.answer.citations, [
    { sessionId: "s-1", offsetMs: 60_000 },
  ]);
  await qa.approveAnswer(pending.answer.id);
  assert.deepEqual(calls.speak, [
    "上次的結論是 rollout 改到九月五號,負責人是 Alice。",
  ]);
  assert.equal(qa.pending(), undefined);
  assert.deepEqual(
    calls.audit.map((e) => e.outcome),
    ["pending", "sent"],
  );
});

test("reject discards the answer without speaking", async () => {
  const { calls, qa } = qaFor();
  const result = await qa.ask("上次會議結論是什麼");
  await qa.rejectAnswer(result.answer.id);
  assert.equal(calls.speak.length, 0);
  assert.equal(qa.pending(), undefined);
  assert.deepEqual(
    calls.audit.map((e) => e.outcome),
    ["pending", "rejected"],
  );
});

test("auto delivery speaks immediately without a pending state", async () => {
  const { calls, qa } = qaFor({ delivery: "auto" });
  const result = await qa.ask("上次會議結論是什麼");
  assert.equal(result.state, "sent");
  assert.equal(calls.speak.length, 1);
  assert.equal(qa.pending(), undefined);
  assert.deepEqual(
    calls.audit.map((e) => e.outcome),
    ["sent-auto"],
  );
});

test("no evidence yields an honest answer without calling the model", async () => {
  const { calls, qa } = qaFor({ index: { search: () => [] } });
  const result = await qa.ask("上次會議結論是什麼");
  assert.equal(result.state, "pending");
  assert.equal(calls.answer.length, 0);
  assert.match(result.answer.text, /找不到/);
  assert.deepEqual(result.answer.citations, []);
});

test("citations are filtered to retrieved chunks", async () => {
  const { qa } = qaFor({
    answer: async () =>
      JSON.stringify({
        text: "答案",
        citations: [
          { sessionId: "s-1", offsetMs: 60_000 },
          { sessionId: "hallucinated", offsetMs: 1 },
        ],
      }),
  });
  const result = await qa.ask("問題問題");
  assert.deepEqual(result.answer.citations, [
    { sessionId: "s-1", offsetMs: 60_000 },
  ]);
});

test("a new question supersedes a pending answer", async () => {
  const { calls, qa } = qaFor();
  const first = await qa.ask("第一個問題");
  const second = await qa.ask("第二個問題");
  assert.notEqual(first.answer.id, second.answer.id);
  assert.equal(qa.pending().id, second.answer.id);
  assert.ok(calls.audit.some((e) => e.outcome === "superseded"));
});

test("invalid model output surfaces an error and nothing pends", async () => {
  const { calls, qa } = qaFor({ answer: async () => "not json" });
  const result = await qa.ask("問題問題");
  assert.equal(result.state, "error");
  assert.equal(qa.pending(), undefined);
  assert.ok(calls.publish.some((e) => e.type === "qa-error"));
});

test("speakConclusions requires a finished summary", async () => {
  const { qa } = qaFor({ currentSession: () => ({ id: "s-9" }) });
  const result = await qa.speakConclusions();
  assert.equal(result.state, "no-summary");
});

test("speakConclusions answers from the summary without searching", async () => {
  let searched = false;
  const { calls, qa } = qaFor({
    index: {
      search: () => {
        searched = true;
        return [];
      },
    },
    currentSession: () => ({
      id: "s-9",
      summary: {
        sections: {
          決策: [
            { text: "rollout 改期到九月五號", citations: [{ sessionId: "s-9", offsetMs: 60_000 }] },
          ],
          待辦: [
            { text: "Alice 更新時程", citations: [{ sessionId: "s-9", offsetMs: 90_000 }] },
          ],
        },
      },
    }),
  });
  const result = await qa.speakConclusions();
  assert.equal(result.state, "pending");
  assert.equal(searched, false);
  assert.ok(calls.answer[0].includes("rollout 改期到九月五號"));
  assert.ok(calls.answer[0].includes("Alice 更新時程"));
});
