import assert from "node:assert/strict";
import test from "node:test";

import { RendererControlBridge } from "./renderer-control-bridge.js";

test("sends a renderer control to a hidden window and waits for its acknowledgement", async () => {
  const sent = [];
  const bridge = new RendererControlBridge({
    send: (event) => sent.push(event),
    timeoutMs: 100,
    nextId: () => "renderer-control-1",
  });

  const pending = bridge.request({
    action: "mute",
    direction: "tx",
    muted: true,
  });

  assert.deepEqual(sent, [
    {
      type: "renderer-control",
      controlId: "renderer-control-1",
      action: "mute",
      direction: "tx",
      muted: true,
    },
  ]);
  assert.equal(bridge.acknowledge({ controlId: "renderer-control-1", state: "applied" }), true);
  assert.deepEqual(await pending, { controlId: "renderer-control-1", state: "applied" });
});

test("rejects a failed renderer acknowledgement without leaving a pending control", async () => {
  const bridge = new RendererControlBridge({
    send: () => {},
    timeoutMs: 100,
    nextId: () => "renderer-control-2",
  });

  const pending = bridge.request({ action: "stop" });
  assert.equal(
    bridge.acknowledge({
      controlId: "renderer-control-2",
      state: "failed",
    }),
    true,
  );
  await assert.rejects(pending, /Renderer cleanup failed/);
  assert.equal(bridge.acknowledge({ controlId: "renderer-control-2", state: "applied" }), false);
});
