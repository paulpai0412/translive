import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MeetingAssistantController } from "./meeting-assistant-controller.js";
import { MeetingIndex } from "./meeting-index.js";
import { RecordsStore } from "./records-store.js";

class FakeCodexClient extends EventEmitter {
  realtime = [];
  speech = [];
  #nextThread = 0;

  async start() {}

  async startEphemeralThread() {
    return { id: `thread-${++this.#nextThread}` };
  }

  async startRealtime(params) {
    this.realtime.push(params);
    return {};
  }

  async stopRealtime() {}

  async appendSpeech(threadId, text) {
    this.speech.push({ threadId, text });
  }

  async close() {
    this.closed = true;
  }

  emitTranscript(threadId, { role = "user", text }) {
    this.emit("notification", {
      method: "thread/realtime/transcript/done",
      params: { threadId, role, text },
    });
  }
}

function validConfig(overrides = {}) {
  return {
    platform: "teams",
    routeProfile: "vb-cable",
    mode: "meeting",
    headphonesConfirmed: true,
    autoSummary: false,
    tx: {
      sourceEndpointId: "mic",
      sourceEndpointName: "Physical Microphone",
      sourceEndpointKind: "audioinput",
      sinkEndpointId: "cable-a",
      sinkEndpointName: "Cable-A Input",
      sinkEndpointKind: "audiooutput",
      sdp: "v=0\r\nfixture-offer",
    },
    rx: {
      sourceEndpointId: "cable-b",
      sourceEndpointName: "Cable-B Output",
      sourceEndpointKind: "audioinput",
      sinkEndpointId: "headphones",
      sinkEndpointName: "USB Headphones",
      sinkEndpointKind: "audiooutput",
      sdp: "v=0\r\nfixture-offer",
    },
    ...overrides,
  };
}

async function controllerFor(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "assistant-"));
  const records = new RecordsStore({ directory: join(directory, "records") });
  await records.grantPlaintextConsent({ confirmed: true });
  const client = overrides.client ?? new FakeCodexClient();
  const published = [];
  const answerCalls = [];
  const summaryService = overrides.summaryService ?? {
    generate: async ({ sessions }) => ({
      sections: {
        重點: [],
        決策: [
          {
            text: "rollout 改期到九月五號",
            citations: [
              {
                sessionId: sessions[0].metadata.id,
                offsetMs: sessions[0].entries[0]?.offsetMs ?? 0,
              },
            ],
          },
        ],
        待辦: [],
        未決問題: [],
      },
    }),
  };
  const meetingIndex = overrides.meetingIndex ?? new MeetingIndex();
  meetingIndex.indexSession({
    metadata: {
      id: "past-1",
      mode: "meeting-assistant",
      startedAtMs: Date.parse("2026-08-30T09:00:00+08:00"),
    },
    entries: [
      {
        offsetMs: 1000,
        direction: "tx",
        side: "source",
        text: "預算核定為十萬元",
      },
    ],
  });
  const controller = new MeetingAssistantController({
    appVersion: "test",
    answer: async (prompt) => {
      answerCalls.push(prompt);
      return JSON.stringify({ text: "答案是九月五號。", citations: [] });
    },
    createClient: () => client,
    evidenceDirectory: join(directory, "evidence"),
    inspectRuntime: async () => ({
      executable: "codex",
      version: "codex 0.145.0",
      semanticVersion: "0.145.0",
      loggedIn: true,
    }),
    meetingIndex,
    publish: (event) => published.push(event),
    records,
    summaryService,
    ...overrides.controller,
  });
  return {
    answerCalls,
    client,
    controller,
    directory,
    meetingIndex,
    published,
    records,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function waitForPublish(published, type, state, timeoutMs = 5_000) {
  const started = Date.now();
  for (;;) {
    const event = published.find(
      (entry) => entry.type === type && (!state || entry.state === state),
    );
    if (event) return event;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${type}:${state ?? "*"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function threadFor(client, index = 0) {
  return client.realtime[index].threadId;
}

test("answerApplied transitions the channel and reports aggregate", async (t) => {
  const { controller, published, cleanup } = await controllerFor();
  t.after(cleanup);
  await controller.start(validConfig());
  assert.equal(controller.isActive(), true);
  const result = await controller.answerApplied("tx");
  assert.ok(result.aggregate);
  assert.ok(
    published.some(
      (event) => event.type === "state" && event.direction === "tx",
    ),
  );
  await controller.stop();
  assert.equal(controller.isActive(), false);
});

test("starts with renderer-sent mode assistant", async (t) => {
  const { client, controller, cleanup } = await controllerFor();
  t.after(cleanup);
  const result = await controller.start(validConfig({ mode: "assistant" }));
  assert.ok(result.status);
  assert.equal(client.realtime.length, 2);
  await controller.stop();
});

test("starts without a headphone confirmation (no audio is routed there)", async (t) => {
  const { client, controller, cleanup } = await controllerFor();
  t.after(cleanup);
  const config = validConfig();
  delete config.headphonesConfirmed;
  const result = await controller.start(config);
  assert.ok(result.status);
  assert.equal(client.realtime.length, 2);
  await controller.stop();
});

test("starts two transcribe-only realtime sessions", async (t) => {
  const { client, controller, cleanup } = await controllerFor();
  t.after(cleanup);
  const result = await controller.start(validConfig());
  assert.equal(client.realtime.length, 2);
  for (const params of client.realtime) {
    assert.match(params.prompt, /verbatim/i);
    assert.doesNotMatch(params.prompt, /translate .* into/i);
  }
  assert.ok(result.status);
  await controller.stop();
});

test("records only role=user speech as source entries", async (t) => {
  const { client, controller, published, records, cleanup } =
    await controllerFor();
  t.after(cleanup);
  await controller.start(validConfig());
  client.emitTranscript(threadFor(client, 0), {
    role: "user",
    text: "我們下週一見",
  });
  client.emitTranscript(threadFor(client, 0), {
    role: "assistant",
    text: "我們下週一見",
  });
  client.emitTranscript(threadFor(client, 1), {
    role: "user",
    text: "see you Monday",
  });
  const transcriptEvents = published.filter(
    (event) => event.type === "transcript",
  );
  assert.equal(transcriptEvents.length, 2);
  assert.ok(transcriptEvents.every((event) => event.role === "user"));
  await controller.stop();
  const [session] = await records.listSessions();
  const record = await records.readSession(session.id);
  assert.equal(record.entries.length, 2);
  assert.deepEqual(
    record.entries.map((entry) => [entry.direction, entry.side]),
    [
      ["tx", "source"],
      ["rx", "source"],
    ],
  );
  assert.ok(
    published.some(
      (event) => event.type === "record" && event.state === "saved",
    ),
  );
});

test("wake phrase on me triggers a question; remote never triggers", async (t) => {
  const { answerCalls, client, controller, published, cleanup } =
    await controllerFor();
  t.after(cleanup);
  await controller.start(validConfig({ qaSdp: "v=0\r\nqa-offer" }));
  client.emitTranscript(threadFor(client, 1), { text: "hey translive, 預算" });
  assert.equal(answerCalls.length, 0);
  client.emitTranscript(threadFor(client, 0), { text: "hey translive, 預算" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answerCalls.length, 1);
  assert.ok(published.some((event) => event.type === "qa-pending"));
  await controller.stop();
});

test("gate suspends while an answer is pending and resumes after approval", async (t) => {
  const { answerCalls, client, controller, cleanup } = await controllerFor();
  t.after(cleanup);
  await controller.start(validConfig({ qaSdp: "v=0\r\nqa-offer" }));
  const me = threadFor(client, 0);
  client.emitTranscript(me, { text: "hey translive, 預算" });
  await new Promise((resolve) => setImmediate(resolve));
  client.emitTranscript(me, { text: "hey translive, 預算" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answerCalls.length, 1);
  const pending = controller.pendingAnswer();
  assert.ok(pending);
  await controller.approveAnswer(pending.id);
  assert.equal(client.speech.length, 1);
  assert.equal(client.speech[0].text, "答案是九月五號。");
  client.emitTranscript(me, { text: "hey translive, 預算" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answerCalls.length, 2);
  await controller.stop();
});

test("stop saves the record, generates the summary, and indexes both", async (t) => {
  const { client, controller, meetingIndex, published, records, cleanup } =
    await controllerFor();
  t.after(cleanup);
  await controller.start(validConfig({ autoSummary: true }));
  client.emitTranscript(threadFor(client, 0), {
    text: "rollout 延後到九月五號",
  });
  await controller.stop();
  await waitForPublish(published, "summary", "saved");
  const [session] = await records.listSessions();
  const record = await records.readSession(session.id);
  assert.equal(record.metadata.hasSummary, true);
  const hits = meetingIndex.search("rollout");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].tier, "summary");
});

test("a summary failure still saves the transcript", async (t) => {
  const { client, controller, published, records, cleanup } =
    await controllerFor({
      summaryService: {
        generate: async () => {
          throw new Error("summary exploded");
        },
      },
    });
  t.after(cleanup);
  await controller.start(validConfig({ autoSummary: true }));
  client.emitTranscript(threadFor(client, 0), { text: "內容" });
  await controller.stop();
  await waitForPublish(published, "summary", "failed");
  const sessions = await records.listSessions();
  assert.equal(sessions.length, 1);
  assert.ok(
    published.some(
      (event) => event.type === "summary" && event.state === "failed",
    ),
  );
});

test("auto delivery speaks without approval", async (t) => {
  const { client, controller, cleanup } = await controllerFor();
  t.after(cleanup);
  await controller.start(
    validConfig({ qaSdp: "v=0\r\nqa-offer", answerDelivery: "auto" }),
  );
  client.emitTranscript(threadFor(client, 0), { text: "hey translive, 預算" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.speech.length, 1);
  await controller.stop();
});

test("custom wake phrase from config activates the gate", async (t) => {
  const { answerCalls, client, controller, cleanup } = await controllerFor();
  t.after(cleanup);
  await controller.start(validConfig({ wakePhrase: "小泥小泥" }));
  const me = threadFor(client, 0);
  client.emitTranscript(me, { text: "hey translive, 預算" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answerCalls.length, 0);
  client.emitTranscript(me, { text: "小泥小泥,預算" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answerCalls.length, 1);
  await controller.stop();
});

test("armed=false keeps the gate closed", async (t) => {
  const { answerCalls, client, controller, cleanup } = await controllerFor();
  t.after(cleanup);
  await controller.start(validConfig({ wakeArmed: false }));
  client.emitTranscript(threadFor(client, 0), { text: "hey translive, 預算" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answerCalls.length, 0);
  await controller.stop();
});

test("pre-context start failures still write blocked evidence", async (t) => {
  const { controller, directory, cleanup } = await controllerFor();
  t.after(cleanup);
  const config = validConfig();
  delete config.tx.sdp;
  await assert.rejects(() => controller.start(config), /SDP/);
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(join(directory, "evidence"));
  assert.ok(files.some((name) => name.endsWith(".json")));
});

test("stop returns after the record saves; summary completes in background", async (t) => {
  let resolveSummary;
  const summaryGate = new Promise((resolve) => {
    resolveSummary = resolve;
  });
  const { client, controller, published, cleanup } = await controllerFor({
    summaryService: {
      generate: async ({ sessions }) => {
        await summaryGate;
        return {
          sections: {
            重點: [],
            決策: [
              {
                text: "背景摘要決策",
                citations: [
                  {
                    sessionId: sessions[0].metadata.id,
                    offsetMs: sessions[0].entries[0]?.offsetMs ?? 0,
                  },
                ],
              },
            ],
            待辦: [],
            未決問題: [],
          },
        };
      },
    },
  });
  t.after(cleanup);
  await controller.start(validConfig({ autoSummary: true }));
  client.emitTranscript(threadFor(client, 0), { text: "內容" });

  const stopResult = await controller.stop();
  assert.equal(stopResult.aggregate, "stopped");
  // stop() resolved while the summary was still pending
  assert.ok(
    published.some((event) => event.type === "record" && event.state === "saved"),
  );
  assert.ok(!published.some((event) => event.type === "summary" && event.state === "saved"));

  resolveSummary();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    published.some((event) => event.type === "summary" && event.state === "saved"),
  );
});
