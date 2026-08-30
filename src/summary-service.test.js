import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CodexSummaryService,
  formatSummaryMarkdown,
  prepareSummarySessions,
} from "./summary-service.js";

function structuredOutput() {
  return {
    sections: {
      重點: [
        {
          text: "確認生產時程",
          citations: [{ sessionId: "session-001", offsetMs: 1_000 }],
        },
      ],
      決策: [],
      待辦: [
        {
          text: "確認驗證時程",
          owner: "未指定",
          date: "未指定",
          citations: [{ sessionId: "session-001", offsetMs: 2_000 }],
        },
      ],
      未決問題: [],
    },
  };
}

class FakeSummaryClient extends EventEmitter {
  closed = false;
  requests = [];

  async start() {}

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "summary-thread" } };
    if (method === "turn/start") {
      setImmediate(() => {
        this.emit("notification", {
          method: "item/agentMessage/delta",
          params: {
            threadId: "summary-thread",
            turnId: "turn-1",
            itemId: "item-1",
            delta: JSON.stringify(structuredOutput()),
          },
        });
        this.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "summary-thread",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      });
      return { turn: { id: "turn-1" } };
    }
    if (method === "turn/interrupt") return {};
    throw new Error(`Unexpected request: ${method}`);
  }

  async close() {
    this.closed = true;
  }
}

function sessions() {
  return [
    {
      metadata: {
        id: "session-001",
        mode: "meeting",
        startedAtMs: 1_000,
        endedAtMs: 3_000,
      },
      entries: [
        {
          atMs: 2_000,
          direction: "rx",
          side: "source",
          text: "Authorization: Bearer sk-secret-value",
        },
        {
          atMs: 3_000,
          direction: "rx",
          side: "target",
          text: "Second line",
        },
      ],
    },
  ];
}

test("formats semantic Traditional-Chinese list headings with validated citations", () => {
  const markdown = formatSummaryMarkdown({
    kind: "session",
    modelOutput: structuredOutput(),
    sourceSessions: [{ id: "session-001", timestamps: [1_000, 2_000] }],
  });

  for (const heading of ["重點", "決策", "待辦", "未決問題", "來源"]) {
    assert.match(markdown, new RegExp(`## ${heading}`));
  }
  assert.match(markdown, /- 確認生產時程【session-001 @ 00:01\.000】/);
  assert.match(markdown, /負責人：未指定；日期：未指定/);
});

test("sorts and bounds summary input before it reaches Codex", () => {
  const prepared = prepareSummarySessions([
    {
      metadata: { id: "late", startedAtMs: 20, endedAtMs: 21 },
      entries: [],
    },
    {
      metadata: { id: "early", startedAtMs: 10, endedAtMs: 11 },
      entries: [],
    },
  ]);
  assert.deepEqual(
    prepared.map((session) => session.metadata.id),
    ["early", "late"],
  );
  assert.throws(
    () => prepareSummarySessions(Array.from({ length: 21 }, () => sessions()[0])),
    /最多可匯整/i,
  );
});

test("uses a pinned-valid ephemeral text turn and never forwards tokens", async () => {
  const client = new FakeSummaryClient();
  const service = new CodexSummaryService({
    createClient: () => client,
    cwd: process.cwd(),
  });

  const structured = await service.generate({
    kind: "session",
    sessions: sessions(),
  });

  assert.equal(structured.sections.重點[0].text, "確認生產時程");
  assert.equal(client.closed, true);
  const serialized = JSON.stringify(client.requests);
  const thread = client.requests.find(
    (request) => request.method === "thread/start",
  );
  const turn = client.requests.find(
    (request) => request.method === "turn/start",
  );
  assert.equal(thread.params.ephemeral, true);
  assert.equal(thread.params.approvalPolicy, "never");
  assert.equal(thread.params.sandbox, "read-only");
  assert.equal(turn.params.approvalPolicy, "never");
  assert.equal(turn.params.sandboxPolicy, "read-only");
  assert.match(turn.params.input[0].text, /只輸出符合以下 JSON schema/);
  assert.doesNotMatch(serialized, /sk-secret-value/);
  assert.doesNotMatch(serialized, /audio|sdp/i);
});

test("rejects an interrupted turn and sends no transcript request when canceled before thread creation", async () => {
  const interrupted = new FakeSummaryClient();
  interrupted.request = async (method, params) => {
    interrupted.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "summary-thread" } };
    if (method === "turn/start") {
      setImmediate(() => {
        interrupted.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "summary-thread",
            turn: { id: "turn-1", status: "interrupted" },
          },
        });
      });
      return { turn: { id: "turn-1" } };
    }
    if (method === "turn/interrupt") return {};
    throw new Error(`Unexpected request: ${method}`);
  };
  const service = new CodexSummaryService({
    createClient: () => interrupted,
    cwd: process.cwd(),
  });
  await assert.rejects(
    service.generate({ kind: "session", sessions: sessions() }),
    /did not complete/,
  );

  const aborted = new AbortController();
  aborted.abort();
  const untouched = new FakeSummaryClient();
  const canceledService = new CodexSummaryService({
    createClient: () => untouched,
    cwd: process.cwd(),
  });
  await assert.rejects(
    canceledService.generate({
      kind: "session",
      sessions: sessions(),
      signal: aborted.signal,
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(untouched.requests, []);
});

test("bounds cancellation before a delayed thread can send a summary turn", async () => {
  let rejectThread;
  const client = new FakeSummaryClient();
  client.request = (method, params) => {
    client.requests.push({ method, params });
    if (method === "thread/start") {
      return new Promise((_, reject) => {
        rejectThread = reject;
      });
    }
    if (method === "turn/interrupt") return Promise.resolve({});
    throw new Error(`Unexpected request: ${method}`);
  };
  client.close = async () => {
    client.closed = true;
    rejectThread?.(abortErrorForTest());
  };
  const abortController = new AbortController();
  const service = new CodexSummaryService({
    createClient: () => client,
    cwd: process.cwd(),
  });

  const pending = service.generate({
    kind: "session",
    sessions: sessions(),
    signal: abortController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  abortController.abort();

  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(client.closed, true);
  assert.equal(
    client.requests.some((request) => request.method === "turn/start"),
    false,
  );
});

function abortErrorForTest() {
  const error = new Error("canceled");
  error.name = "AbortError";
  return error;
}
