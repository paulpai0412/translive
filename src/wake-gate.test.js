import assert from "node:assert/strict";
import test from "node:test";

import { WakeGate } from "./wake-gate.js";

test("extracts the question after the wake phrase", () => {
  const gate = new WakeGate({ armed: true });
  assert.deepEqual(
    gate.onFinalTranscript({
      source: "me",
      text: "hey translive, 上次會議結論是什麼",
    }),
    { type: "question", question: "上次會議結論是什麼" },
  );
});

test("accepts ok prefix, case variations, and fullwidth comma", () => {
  const gate = new WakeGate({ armed: true });
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "OK TransLive,budget 多少" }),
    { type: "question", question: "budget 多少" },
  );
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "TransLive 帶我去找決策" }),
    { type: "question", question: "帶我去找決策" },
  );
});

test("ignores remote source entirely", () => {
  const gate = new WakeGate({ armed: true });
  assert.equal(
    gate.onFinalTranscript({ source: "remote", text: "hey translive, 你好" }),
    null,
  );
});

test("ignores everything while disarmed", () => {
  const gate = new WakeGate({ armed: false });
  assert.equal(
    gate.onFinalTranscript({ source: "me", text: "hey translive, 你好" }),
    null,
  );
});

test("ignores everything while suspended", () => {
  const gate = new WakeGate({ armed: true });
  gate.suspend();
  assert.equal(
    gate.onFinalTranscript({ source: "me", text: "hey translive, 你好" }),
    null,
  );
  gate.resume();
  assert.notEqual(
    gate.onFinalTranscript({ source: "me", text: "hey translive, 你好" }),
    null,
  );
});

test("rejects missing or empty questions", () => {
  const gate = new WakeGate({ armed: true });
  for (const text of ["hey translive", "hey translive,", "translive", "喂"]) {
    assert.equal(gate.onFinalTranscript({ source: "me", text }), null, text);
  }
});

test("recognizes the speak-conclusions command", () => {
  const gate = new WakeGate({ armed: true });
  for (const question of ["口播結論", "播結論", "read the conclusions"]) {
    assert.deepEqual(
      gate.onFinalTranscript({
        source: "me",
        text: `hey translive, ${question}`,
      }),
      { type: "command", command: "speak-conclusions" },
      question,
    );
  }
});

test("arming state can be toggled at runtime", () => {
  const gate = new WakeGate({ armed: false });
  gate.setArmed(true);
  assert.notEqual(
    gate.onFinalTranscript({ source: "me", text: "hey translive, 測試" }),
    null,
  );
  gate.setArmed(false);
  assert.equal(
    gate.onFinalTranscript({ source: "me", text: "hey translive, 測試" }),
    null,
  );
});
