import assert from "node:assert/strict";
import test from "node:test";

import {
  createRendererControlHandler,
  releaseRendererResources,
} from "./renderer-control.js";

function peer(name, calls) {
  return {
    setMuted(muted) {
      calls.push(`${name}:mute:${muted}`);
    },
    async stop() {
      calls.push(`${name}:stop`);
    },
  };
}

test("main-triggered cancellation clears stopped peers from the renderer active registry", async () => {
  const calls = [];
  let active = { tx: peer("tx", calls) };

  await releaseRendererResources({
    active: () => active,
    cancelStartup: async () => {
      calls.push("startup:cancel");
    },
    clearActive: () => {
      active = {};
    },
  });

  assert.deepEqual(calls, ["startup:cancel", "tx:stop"]);
  assert.deepEqual(active, {});
});

test("tray mute updates the renderer-owned TX peer before acknowledging", async () => {
  const calls = [];
  let active = { tx: peer("tx", calls), rx: peer("rx", calls) };
  const handle = createRendererControlHandler({
    active: () => active,
    clearActive: () => {
      active = {};
    },
  });

  const result = await handle({
    action: "mute",
    controlId: "control-1",
    direction: "tx",
    muted: true,
  });

  assert.deepEqual(calls, ["tx:mute:true"]);
  assert.deepEqual(result, { controlId: "control-1", state: "applied" });
  assert.ok(active.tx);
});

test("tray stop releases every renderer-owned peer before acknowledging", async () => {
  const calls = [];
  let active = { tx: peer("tx", calls), rx: peer("rx", calls) };
  const handle = createRendererControlHandler({
    active: () => active,
    clearActive: () => {
      active = {};
    },
  });

  const result = await handle({ action: "stop", controlId: "control-2" });

  assert.deepEqual(calls.sort(), ["rx:stop", "tx:stop"]);
  assert.deepEqual(active, {});
  assert.deepEqual(result, { controlId: "control-2", state: "applied" });
});

test("logout releases renderer peers even when the window is hidden", async () => {
  const calls = [];
  let active = { rx: peer("rx", calls) };
  const handle = createRendererControlHandler({
    active: () => active,
    clearActive: () => {
      active = {};
    },
  });

  const result = await handle({ action: "logout", controlId: "control-3" });

  assert.deepEqual(calls, ["rx:stop"]);
  assert.deepEqual(active, {});
  assert.deepEqual(result, { controlId: "control-3", state: "applied" });
});
