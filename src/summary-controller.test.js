import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RecordsStore } from "./records-store.js";
import { SummaryController } from "./summary-controller.js";

async function recordsFixture() {
  const records = new RecordsStore({
    directory: await mkdtemp(join(tmpdir(), "translive-summary-controller-")),
  });
  await records.grantPlaintextConsent({ confirmed: true });
  await records.saveSession({
    id: "session-a",
    metadata: {
      mode: "meeting",
      platform: "teams",
      startedAtMs: 1_000,
      endedAtMs: 2_000,
    },
    entries: [
      { atMs: 1_200, direction: "rx", side: "source", text: "First source" },
    ],
  });
  await records.saveSession({
    id: "session-b",
    metadata: {
      mode: "media",
      platform: "custom",
      startedAtMs: 3_000,
      endedAtMs: 4_000,
    },
    entries: [
      { atMs: 3_400, direction: "rx", side: "target", text: "Second target" },
    ],
  });
  return records;
}

function structuredSummary(kind, sessions) {
  const first = sessions[0];
  const citation = {
    sessionId: first.metadata.id,
    offsetMs: first.entries[0].offsetMs,
  };
  const sections =
    kind === "aggregate"
      ? {
          共同主題: [{ text: "生產", citations: [citation] }],
          決策演變: [],
          未完成待辦: [
            {
              text: "確認時程",
              owner: "未指定",
              date: "未指定",
              citations: [citation],
            },
          ],
          重複問題: [],
          衝突與未決問題: [],
        }
      : {
          重點: [{ text: "已確認", citations: [citation] }],
          決策: [],
          待辦: [
            {
              text: "確認時程",
              owner: "未指定",
              date: "未指定",
              citations: [citation],
            },
          ],
          未決問題: [],
        };
  return { sections };
}

function service() {
  const calls = [];
  return {
    calls,
    async generate(input) {
      calls.push(input);
      return structuredSummary(input.kind, input.sessions);
    },
  };
}

test("requires explicit confirmation before sending a session transcript to the summary service", async () => {
  const records = await recordsFixture();
  const summaryService = service();
  const controller = new SummaryController({ records, summaryService });

  await assert.rejects(
    controller.startSessionSummary({
      sessionId: "session-a",
      confirmed: false,
    }),
    /確認/i,
  );
  assert.equal(summaryService.calls.length, 0);
});

test("stores a structured single-session summary and publishes no transcript text", async () => {
  const records = await recordsFixture();
  const summaryService = service();
  const events = [];
  const controller = new SummaryController({
    records,
    summaryService,
    now: () => 99,
    publish: (event) => events.push(event),
  });

  const started = await controller.startSessionSummary({
    sessionId: "session-a",
    confirmed: true,
  });
  const completed = await controller.wait(started.requestId);

  assert.equal(completed.state, "completed");
  assert.equal(summaryService.calls.length, 1);
  const session = await records.readSession("session-a");
  for (const section of ["重點", "決策", "待辦", "未決問題", "來源"]) {
    assert.match(session.summary.markdown, new RegExp(`## ${section}`));
  }
  assert.match(session.summary.markdown, /負責人：未指定；日期：未指定/);
  assert.match(session.summary.markdown, /session-a @ 00:00\.200/);
  assert.equal(
    events.some((event) => /First source/.test(JSON.stringify(event))),
    false,
  );
});

test("sorts aggregate sessions chronologically and rejects an oversized request before model work", async () => {
  const records = await recordsFixture();
  const summaryService = service();
  const controller = new SummaryController({
    records,
    summaryService,
    now: () => 100,
  });

  const started = await controller.startAggregateSummary({
    sessionIds: ["session-b", "session-a"],
    confirmed: true,
  });
  const completed = await controller.wait(started.requestId);
  const aggregate = await records.readAggregate(completed.summaryId);

  assert.equal(completed.state, "completed");
  assert.deepEqual(
    summaryService.calls[0].sessions.map((session) => session.metadata.id),
    ["session-a", "session-b"],
  );
  assert.match(aggregate.markdown, /session-a @ 00:00\.200/);
  await assert.rejects(
    controller.startAggregateSummary({
      sessionIds: ["session-a"],
      confirmed: true,
    }),
    /至少選擇 2 場/i,
  );
});

test("cancels an in-flight summary without an unhandled operation rejection", async () => {
  const records = await recordsFixture();
  let rejectGeneration;
  const summaryService = {
    generate: () =>
      new Promise((_resolve, reject) => {
        rejectGeneration = reject;
      }),
  };
  const events = [];
  const controller = new SummaryController({
    records,
    summaryService,
    publish: (event) => events.push(event),
  });

  const started = await controller.startSessionSummary({
    sessionId: "session-a",
    confirmed: true,
  });
  const cancellation = controller.cancel(started.requestId);
  rejectGeneration(
    Object.assign(new Error("canceled"), { name: "AbortError" }),
  );

  assert.deepEqual(cancellation, {
    requestId: started.requestId,
    state: "canceling",
  });
  await assert.rejects(controller.wait(started.requestId), {
    name: "AbortError",
  });
  assert.equal(events.at(-1).state, "canceled");
});

test("does not recreate an aggregate after delete all while generation is in flight", async () => {
  const records = await recordsFixture();
  let resolveGeneration;
  const summaryService = {
    generate: (input) =>
      new Promise((resolve) => {
        resolveGeneration = () =>
          resolve(structuredSummary(input.kind, input.sessions));
      }),
  };
  const controller = new SummaryController({ records, summaryService });

  const started = await controller.startAggregateSummary({
    sessionIds: ["session-a", "session-b"],
    confirmed: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await records.deleteAllSessions({ confirmation: "DELETE" });
  resolveGeneration();

  await assert.rejects(controller.wait(started.requestId));
  assert.deepEqual(await records.listSessions(), []);
  assert.deepEqual(await records.listAggregates(), []);
});

test("cancels during aggregate persistence without retaining the just-written summary", async () => {
  const records = await recordsFixture();
  const originalSave = records.saveAggregateSummary.bind(records);
  let releasePersistence;
  let persistenceStarted;
  const persistenceStartedPromise = new Promise((resolve) => {
    persistenceStarted = resolve;
  });
  const persistenceReleasePromise = new Promise((resolve) => {
    releasePersistence = resolve;
  });
  records.saveAggregateSummary = async (summary) => {
    const result = await originalSave(summary);
    persistenceStarted();
    await persistenceReleasePromise;
    return result;
  };
  const events = [];
  const controller = new SummaryController({
    records,
    summaryService: service(),
    publish: (event) => events.push(event),
  });

  const started = await controller.startAggregateSummary({
    sessionIds: ["session-a", "session-b"],
    confirmed: true,
  });
  await persistenceStartedPromise;
  controller.cancel(started.requestId);
  releasePersistence();

  await assert.rejects(controller.wait(started.requestId), {
    name: "AbortError",
  });
  assert.deepEqual(await records.listAggregates(), []);
  assert.equal(
    events.some((event) => event.state === "completed"),
    false,
  );
  assert.equal(events.at(-1).state, "canceled");
});

test("restores a prior single-session summary when cancellation arrives during replacement", async () => {
  const records = await recordsFixture();
  const originalSession = await records.readSession("session-a");
  const oldStructured = structuredSummary("session", [originalSession]);
  await records.saveSessionSummary("session-a", {
    generatedAtMs: 1,
    markdown: "# 舊摘要\n",
    sourceSessions: [
      {
        id: "session-a",
        timestamps: originalSession.entries.map((entry) => entry.offsetMs),
      },
    ],
    structured: oldStructured,
  });

  const originalSave = records.saveSessionSummary.bind(records);
  let releasePersistence;
  let persistenceStarted;
  const persistenceStartedPromise = new Promise((resolve) => {
    persistenceStarted = resolve;
  });
  const persistenceReleasePromise = new Promise((resolve) => {
    releasePersistence = resolve;
  });
  records.saveSessionSummary = async (...args) => {
    const result = await originalSave(...args);
    persistenceStarted();
    await persistenceReleasePromise;
    return result;
  };
  const events = [];
  const controller = new SummaryController({
    records,
    summaryService: service(),
    publish: (event) => events.push(event),
  });

  const started = await controller.startSessionSummary({
    sessionId: "session-a",
    confirmed: true,
  });
  await persistenceStartedPromise;
  controller.cancel(started.requestId);
  releasePersistence();

  await assert.rejects(controller.wait(started.requestId), {
    name: "AbortError",
  });
  const restored = await records.readSession("session-a");
  assert.equal(restored.summary.markdown, "# 舊摘要\n");
  assert.equal(
    events.some((event) => event.state === "completed"),
    false,
  );
  assert.equal(events.at(-1).state, "canceled");
});
