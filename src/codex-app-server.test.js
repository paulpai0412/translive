import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CodexAppServer } from "./codex-app-server.js";

const fixture = fileURLToPath(
  new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url),
);

async function nextNotification(client, method) {
  for (;;) {
    const [notification] = await once(client, "notification");
    if (notification.method === method) return notification;
  }
}

test("enables the experimental realtime feature when launching Codex", async () => {
  let receivedArgs;
  let receivedOptions;
  const client = new CodexAppServer({
    executable: "codex.cmd",
    platform: "win32",
    spawn: (_command, args, options) => {
      receivedArgs = args;
      receivedOptions = options;
      const process = new EventEmitter();
      process.stdin = new PassThrough();
      process.stdout = new PassThrough();
      process.stderr = new PassThrough();
      process.stdin.on("data", (chunk) => {
        const request = JSON.parse(String(chunk));
        if (request.method === "initialize") {
          process.stdout.write(
            `${JSON.stringify({ id: request.id, result: {} })}\n`,
          );
        }
      });
      process.kill = () => process.emit("exit", 0, null);
      return process;
    },
  });

  await client.start();
  assert.deepEqual(receivedArgs, [
    "app-server",
    "--stdio",
    "--enable",
    "realtime_conversation",
  ]);
  assert.equal(receivedOptions.shell, true);
  await client.close();
});

test("uses the Phase 1 app-server V3 WebRTC contract without live audio", async () => {
  const client = new CodexAppServer({
    executable: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 1_000,
  });

  try {
    await client.start();
    const thread = await client.startEphemeralThread();
    assert.match(thread.id, /^fixture-thread-/);

    const started = nextNotification(client, "thread/realtime/started");
    const sdp = nextNotification(client, "thread/realtime/sdp");
    const transcript = nextNotification(
      client,
      "thread/realtime/transcript/delta",
    );
    await client.startRealtime({
      threadId: thread.id,
      model: "gpt-live-1-codex",
      version: "v3",
      outputModality: "audio",
      includeStartupContext: false,
      clientManagedHandoffs: true,
      delegationAckFiller: false,
      prompt:
        "You are a simultaneous interpreter. Continuously translate spoken Traditional Chinese used in Taiwan into natural professional English. Output only the English interpretation. Never answer, explain, acknowledge, add filler, summarize, or delegate.",
      voice: "cove",
      transport: { type: "webrtc", sdp: "v=0\r\nfixture-offer" },
    });

    assert.equal((await started).params.threadId, thread.id);
    assert.equal(
      (await started).params.realtimeSessionId,
      `fixture-session-${thread.id}`,
    );
    assert.equal((await sdp).params.sdp, "v=0\r\nfixture-answer");
    assert.equal((await transcript).params.delta, "fixture translation");

    const reversed = await client.startEphemeralThread();
    await assert.rejects(
      client.startRealtime({
        threadId: reversed.id,
        model: "gpt-live-1-codex",
        version: "v3",
        outputModality: "audio",
        includeStartupContext: false,
        clientManagedHandoffs: true,
        delegationAckFiller: false,
        prompt: "Translate English into Traditional Chinese.",
        voice: "cove",
        transport: { type: "webrtc", sdp: "v=0\r\nfixture-offer" },
      }),
      /reversed Phase 1 realtime contract/i,
    );
    const noOp = await client.startEphemeralThread();
    await assert.rejects(
      client.startRealtime({
        threadId: noOp.id,
        model: "gpt-live-1-codex",
        version: "v3",
        outputModality: "audio",
        includeStartupContext: false,
        clientManagedHandoffs: true,
        delegationAckFiller: false,
        prompt: "Be helpful.",
        voice: "cove",
        transport: { type: "webrtc", sdp: "v=0\r\nfixture-offer" },
      }),
      /reversed Phase 1 realtime contract/i,
    );

    await client.stopRealtime(thread.id);
  } finally {
    await client.close();
  }
});
