import assert from "node:assert/strict";
import test from "node:test";

import { createOutputTester } from "./output-tester.js";

function fakeContext({ failOnSetSink = false } = {}) {
  const calls = { started: 0, closed: 0, sinkId: undefined };
  return {
    calls,
    currentTime: 0,
    destination: {},
    async setSinkId(id) {
      if (failOnSetSink) throw new Error("sink rejected");
      calls.sinkId = id;
    },
    createOscillator() {
      return {
        frequency: { value: 0 },
        type: "",
        connect() {},
        start() {
          calls.started += 1;
        },
        stop() {},
      };
    },
    createGain() {
      return {
        gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
        connect() {},
      };
    },
    async close() {
      calls.closed += 1;
    },
  };
}

test("測試音使用指定的 sink 播放並在完成後關閉 context", async () => {
  const context = fakeContext();
  const tester = createOutputTester({
    contextFactory: () => context,
    toneDurationSeconds: 0.01,
  });
  await tester.play({ sinkId: "device-1" });
  assert.equal(context.calls.sinkId, "device-1");
  assert.equal(context.calls.started, 1);
  assert.equal(context.calls.closed, 1);
  assert.equal(tester.state(), "idle");
});

test("播放期間狀態為 playing", async () => {
  const context = fakeContext();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tester = createOutputTester({
    contextFactory: () => context,
    toneDurationSeconds: 0.01,
    wait: () => gate,
  });
  const pending = tester.play({ sinkId: "device-2" });
  assert.equal(tester.state(), "playing");
  release();
  await pending;
  assert.equal(tester.state(), "idle");
});

test("setSinkId 失敗時進入 error 狀態、關閉 context 且不丟出未捕捉例外", async () => {
  const context = fakeContext({ failOnSetSink: true });
  const tester = createOutputTester({ contextFactory: () => context });
  await tester.play({ sinkId: "bad-device" });
  assert.equal(tester.state(), "error");
  assert.equal(context.calls.closed, 1);
});

test("播放中忽略重複觸發", async () => {
  const context = fakeContext();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tester = createOutputTester({
    contextFactory: () => context,
    wait: () => gate,
  });
  const first = tester.play({ sinkId: "device-3" });
  await tester.play({ sinkId: "device-4" });
  release();
  await first;
  assert.equal(context.calls.started, 1);
});

test("context 不支援 setSinkId 時進入 error 狀態", async () => {
  const context = fakeContext();
  delete context.setSinkId;
  const tester = createOutputTester({ contextFactory: () => context });
  await tester.play({ sinkId: "device-5" });
  assert.equal(tester.state(), "error");
});
