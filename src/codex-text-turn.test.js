import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { CodexTextTurn } from "./codex-text-turn.js";

function fakeClient({ output = "answer text", turnStatus = "completed" } = {}) {
  const client = new EventEmitter();
  client.calls = [];
  client.start = async () => {};
  client.close = async () => {
    client.closed = true;
  };
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") {
      queueMicrotask(() => {
        client.emit("notification", {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", delta: output },
        });
        client.emit("notification", {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: turnStatus } },
        });
      });
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`Unexpected method ${method}`);
  };
  return client;
}

test("runs a prompt on an ephemeral thread and returns the text", async () => {
  const client = fakeClient({ output: "口播稿內容" });
  const service = new CodexTextTurn({ createClient: () => client });
  const text = await service.run("prompt body");
  assert.equal(text, "口播稿內容");
  const turn = client.calls.find((call) => call.method === "turn/start");
  assert.equal(turn.params.input[0].text, "prompt body");
  assert.equal(turn.params.sandboxPolicy.networkAccess, false);
  assert.equal(client.closed, true);
});

test("rejects when the turn does not complete", async () => {
  const client = fakeClient({ turnStatus: "failed" });
  const service = new CodexTextTurn({ createClient: () => client });
  await assert.rejects(() => service.run("prompt"), /did not complete/);
  assert.equal(client.closed, true);
});

test("ignores notifications from other threads", async () => {
  const client = fakeClient();
  const original = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "turn/start") {
      queueMicrotask(() => {
        client.emit("notification", {
          method: "item/agentMessage/delta",
          params: { threadId: "other", delta: "noise" },
        });
      });
    }
    return original(method, params);
  };
  const service = new CodexTextTurn({ createClient: () => client });
  assert.equal(await service.run("p"), "answer text");
});
