import assert from "node:assert/strict";
import test from "node:test";

import { createStartupSession } from "./startup-session.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("cancelling while a later peer is opening closes every partially created peer", async () => {
  const secondPeer = deferred();
  const stopped = [];
  let startedRuntime = false;
  const session = createStartupSession({
    directions: ["tx", "rx"],
    createPeer: async ({ direction }) => {
      if (direction === "tx") return { sdp: "tx", stop: () => stopped.push("tx") };
      return secondPeer.promise;
    },
    startRuntime: async () => {
      startedRuntime = true;
    },
    cancelRuntime: async () => {},
  });

  const start = session.start({ tx: {}, rx: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await session.cancel();
  secondPeer.resolve({ sdp: "rx", stop: () => stopped.push("rx") });

  await assert.rejects(start, { name: "AbortError" });
  assert.deepEqual(stopped.sort(), ["rx", "tx"]);
  assert.equal(startedRuntime, false);
});

test("cancelling while the main runtime starts requests runtime cleanup after it settles", async () => {
  const runtime = deferred();
  let cancelRuntimeCalls = 0;
  let peerStops = 0;
  const session = createStartupSession({
    directions: ["rx"],
    createPeer: async () => ({ sdp: "rx", stop: () => peerStops++ }),
    startRuntime: async () => runtime.promise,
    cancelRuntime: async () => {
      cancelRuntimeCalls++;
    },
  });

  const start = session.start({ rx: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await session.cancel();
  runtime.resolve({ aggregate: "connecting" });

  await assert.rejects(start, { name: "AbortError" });
  assert.equal(peerStops, 1);
  assert.ok(cancelRuntimeCalls >= 1);
});
