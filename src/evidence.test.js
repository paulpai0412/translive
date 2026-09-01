import assert from "node:assert/strict";
import test from "node:test";

import { RunEvidence, textFingerprint } from "./evidence.js";

const base = { appVersion: "0.0.0-test", codex: {}, endpoints: [] };

test("realtime notes keep a bounded content-free event ring per direction", () => {
    const evidence = new RunEvidence(base);
    for (let index = 0; index < 230; index += 1) {
        evidence.recordRealtimeNote("rx", {
            atMs: 1_000 + index,
            kind: "item/completed",
            role: "assistant",
            item: `item-${index}`,
            text: `句子 ${index}。`,
        });
    }
    const notes = evidence.snapshot().realtimeNotes.rx;
    assert.equal(notes.length, 200);
    assert.equal(notes.at(-1).item, "item-229");
    assert.equal(notes.at(-1).textLength, 7);
    assert.equal(notes.at(-1).fp, textFingerprint("句子 229。"));

    // The ring is diagnostic evidence: no plaintext transcript content.
    assert.equal(JSON.stringify(evidence.snapshot()).includes("句子"), false);
    assert.equal("text" in notes.at(-1), false);
});

test("realtime notes are tracked independently per direction", () => {
    const evidence = new RunEvidence(base);
    evidence.recordRealtimeNote("tx", {
        atMs: 1,
        kind: "local/append",
        text: "a",
    });
    const snapshot = evidence.snapshot();
    assert.equal(snapshot.realtimeNotes.tx.length, 1);
    assert.equal(snapshot.realtimeNotes.rx.length, 0);
});

test("text fingerprints are stable and distinguish content", () => {
    assert.equal(textFingerprint("你好。"), textFingerprint("你好。"));
    assert.notEqual(textFingerprint("你好。"), textFingerprint("你好"));
    assert.match(textFingerprint("任何文字"), /^[0-9a-f]{8}$/);
});
