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

test("supports a custom Chinese wake phrase without a separator", () => {
  const gate = new WakeGate({ armed: true, phrase: "小泥小泥" });
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "小泥小泥,上次會議結論" }),
    { type: "question", question: "上次會議結論" },
  );
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "小泥小泥預算是多少" }),
    { type: "question", question: "預算是多少" },
  );
  assert.equal(
    gate.onFinalTranscript({ source: "me", text: "hey translive, 預算" }),
    null,
  );
});

test("custom phrases are regex-escaped and trim whitespace", () => {
  const gate = new WakeGate({ armed: true, phrase: " 小泥.小泥 " });
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "小泥.小泥 結論" }),
    { type: "question", question: "結論" },
  );
});

test("setPhrase switches the active phrase at runtime", () => {
  const gate = new WakeGate({ armed: true });
  gate.setPhrase("小泥小泥");
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "小泥小泥,測試" }),
    { type: "question", question: "測試" },
  );
  gate.setPhrase("");
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "hey translive, 回來了" }),
    { type: "question", question: "回來了" },
  );
});

test("speak-conclusions still works with a custom phrase", () => {
  const gate = new WakeGate({ armed: true, phrase: "小泥小泥" });
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "小泥小泥,口播結論" }),
    { type: "command", command: "speak-conclusions" },
  );
});

test("tolerates punctuation and casing inserted by real transcription", () => {
  const gate = new WakeGate({ armed: true });
  for (const text of [
    "Hey, TransLive, 預算多少",
    "hey translive: 預算多少",
    "TRANSLIVE，預算多少",
    "OK，TransLive 預算多少",
  ]) {
    assert.deepEqual(
      gate.onFinalTranscript({ source: "me", text }),
      { type: "question", question: "預算多少" },
      text,
    );
  }
});

test("tolerates Chinese prefixes with custom phrases", () => {
  const gate = new WakeGate({ armed: true, phrase: "小泥小泥" });
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "嘿，小泥小泥，結論是什麼" }),
    { type: "question", question: "結論是什麼" },
  );
  assert.deepEqual(
    gate.onFinalTranscript({ source: "me", text: "喂 小泥小泥:結論" }),
    { type: "question", question: "結論" },
  );
});
