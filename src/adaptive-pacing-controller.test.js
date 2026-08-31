import assert from "node:assert/strict";
import test from "node:test";

import {
  AdaptivePacingController,
  NATURAL_SYNC_PACING_POLICY,
  estimateSpeechDurationMs,
} from "./adaptive-pacing-controller.js";

test("natural-sync policy estimates speech duration by language instead of a fixed segment size", () => {
  assert.deepEqual(
    {
      id: NATURAL_SYNC_PACING_POLICY.id,
      version: NATURAL_SYNC_PACING_POLICY.version,
    },
    { id: "natural-sync", version: 1 },
  );
  const policy = {
    ...NATURAL_SYNC_PACING_POLICY,
    chineseCharactersPerSecond: 4,
    latinWordsPerSecond: 2,
  };

  assert.equal(estimateSpeechDurationMs("即時翻譯", policy), 1_000);
  assert.equal(
    estimateSpeechDurationMs("steady spoken translation", policy),
    1_500,
  );
  assert.equal(estimateSpeechDurationMs("即時翻譯 translation", policy), 1_500);
});

test("waits at short punctuation and sends the first eligible clause immediately", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      minimumAudibleCharacters: 6,
    },
  });

  const short = controller.ingest({ text: "太短。", atMs: 0 });
  assert.deepEqual(
    short.map(({ type, reason }) => ({ type, reason })),
    [{ type: "wait", reason: "below-minimum" }],
  );

  const decisions = controller.ingest({
    text: "這是第一個完整子句。",
    atMs: 10,
  });
  const flush = decisions.find((decision) => decision.type === "flush");

  assert.deepEqual(
    {
      characters: flush.characters,
      kind: flush.kind,
      text: flush.text,
    },
    {
      characters: 13,
      kind: "fast-start",
      text: "太短。這是第一個完整子句。",
    },
  );
  assert.equal(flush.dispatchAtMs, 10);
});

test("uses semantic punctuation for steady segments after fast start", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      minimumAudibleCharacters: 4,
    },
  });

  const first = controller.ingest({ text: "第一段完成。", atMs: 0 });
  const second = controller.ingest({ text: "第二段完成。", atMs: 10 });

  assert.equal(
    first.find((decision) => decision.type === "flush").kind,
    "fast-start",
  );
  assert.equal(
    second.find((decision) => decision.type === "flush").kind,
    "steady",
  );
});

test("schedules committed speech at estimated natural playout spacing", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      chineseCharactersPerSecond: 4,
      minimumAudibleCharacters: 4,
    },
  });
  const first = controller
    .ingest({ text: "第一段完成。", atMs: 0 })
    .find((decision) => decision.type === "flush");
  const second = controller
    .ingest({ text: "第二段完成。", atMs: 10 })
    .find((decision) => decision.type === "flush");

  assert.equal(
    second.dispatchAtMs,
    first.dispatchAtMs + first.estimatedDurationMs,
  );
  assert.deepEqual(
    controller.dispatch({ id: second.id, atMs: second.dispatchAtMs - 1 }),
    {
      type: "wait",
      id: first.id,
      dispatchAtMs: first.dispatchAtMs,
      reason: "head-of-queue",
    },
  );
  assert.deepEqual(
    controller.dispatch({ id: first.id, atMs: first.dispatchAtMs }),
    expectDispatch(first),
  );
});

test("uses backlog hysteresis to coalesce only future text and never lose committed order", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      chineseCharactersPerSecond: 8,
      minimumAudibleCharacters: 4,
      fastStartTargetMs: 400,
      steadySegmentTargetMs: 600,
      coalescedSegmentTargetMs: 1_000,
      backlogEnterMs: 500,
      backlogExitMs: 100,
      lagWarningEnterMs: 550,
      lagWarningExitMs: 100,
    },
  });

  const first = controller.ingest({ text: "第一段完成。", atMs: 0 });
  assert.deepEqual(
    first
      .filter((decision) => ["coalesce", "lag-warning"].includes(decision.type))
      .map(({ type, state }) => ({ type, state })),
    [
      { type: "coalesce", state: "entered" },
      { type: "lag-warning", state: "active" },
    ],
  );

  const held = controller.ingest({ text: "第二段完成。", atMs: 10 });
  assert.deepEqual(
    held.map(({ type, reason }) => ({ type, reason })),
    [{ type: "wait", reason: "coalescing" }],
  );

  const resumed = controller.ingest({ text: "第三段完成。", atMs: 1_000 });
  const drained = controller.drain({ atMs: 3_000 });
  const flushed = [...first, ...resumed, ...drained].filter(
    (decision) => decision.type === "flush",
  );

  assert.equal(
    flushed.map((segment) => segment.text).join(""),
    "第一段完成。第二段完成。第三段完成。",
  );
  assert.equal(
    resumed.some(
      (decision) => decision.type === "coalesce" && decision.state === "exited",
    ),
    true,
  );
  assert.equal(
    resumed.some(
      (decision) =>
        decision.type === "lag-warning" && decision.state === "cleared",
    ),
    true,
  );
  assert.equal(controller.metrics({ atMs: 3_000 }).lagWarningCount >= 1, true);
});

test("caps a long sentence at the policy playout bound and retains its remainder", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      chineseCharactersPerSecond: 4,
      minimumAudibleCharacters: 4,
      fastStartTargetMs: 1_000,
      steadySegmentTargetMs: 1_000,
      maxSegmentPlayoutMs: 1_250,
      boundaryToleranceMs: 0,
      maxOutstandingSegments: 2,
      maxScheduledBacklogMs: 2_500,
    },
  });

  const decisions = controller.ingest({
    text: `${"甲".repeat(20_000)}。`,
    final: true,
    atMs: 0,
  });
  const flushes = decisions.filter((decision) => decision.type === "flush");

  assert.equal(flushes.length > 0, true);
  assert.equal(
    flushes.every((segment) => segment.estimatedDurationMs <= 1_250),
    true,
  );
  assert.equal(
    flushes.map((segment) => segment.text).join("").length < 20_001,
    true,
  );
  assert.equal(controller.unsent().characters > 0, true);
});

test("wakes at planned playout completion when a backlog bound holds future text", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      chineseCharactersPerSecond: 4,
      minimumAudibleCharacters: 4,
      fastStartTargetMs: 1_000,
      steadySegmentTargetMs: 1_000,
      maxSegmentPlayoutMs: 1_500,
      boundaryToleranceMs: 0,
      maxScheduledBacklogMs: 1_600,
      maxOutstandingSegments: 2,
    },
  });
  const first = controller
    .ingest({ text: "第一段完成。第二段完成。", final: true, atMs: 0 })
    .find((decision) => decision.type === "flush");

  assert.equal(controller.dispatch({ id: first.id, atMs: 0 }).type, "dispatch");
  assert.equal(controller.nextWakeAtMs({ atMs: 0 }), first.estimatedDurationMs);
  assert.equal(
    controller
      .drain({ atMs: first.estimatedDurationMs })
      .some((decision) => decision.type === "flush"),
    true,
  );
});

test("refills non-final buffered text without treating it as a final tail", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      chineseCharactersPerSecond: 4,
      minimumAudibleCharacters: 4,
      fastStartTargetMs: 1_000,
      maxSegmentPlayoutMs: 3_500,
    },
  });
  const first = controller
    .ingest({ text: "第一段完成。短", atMs: 0 })
    .find((decision) => decision.type === "flush");

  controller.dispatch({ id: first.id, atMs: 0 });
  assert.deepEqual(controller.refill({ atMs: first.estimatedDurationMs }), [
    { type: "wait", reason: "below-minimum" },
  ]);
});

test("does not dispatch a later segment before the head of the natural-playout queue", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      chineseCharactersPerSecond: 4,
      minimumAudibleCharacters: 4,
    },
  });
  const first = controller
    .ingest({ text: "第一段完成。", atMs: 0 })
    .find((decision) => decision.type === "flush");
  const second = controller
    .ingest({ text: "第二段完成。", atMs: 1 })
    .find((decision) => decision.type === "flush");

  assert.deepEqual(
    controller.dispatch({ id: second.id, atMs: second.dispatchAtMs }),
    {
      type: "wait",
      id: first.id,
      dispatchAtMs: first.dispatchAtMs,
      reason: "head-of-queue",
    },
  );
});

test("admits a 101st segment after one of 100 outstanding segments dispatches", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      chineseCharactersPerSecond: 1_000,
      minimumAudibleCharacters: 4,
      minimumEstimatedSpeechMs: 1,
      fastStartTargetMs: 1,
      steadySegmentTargetMs: 1,
      coalescedSegmentTargetMs: 1,
      maxSegmentPlayoutMs: 1,
      boundaryToleranceMs: 0,
      backlogEnterMs: 100_000,
      maxOutstandingSegments: 100,
      maxScheduledBacklogMs: 10_000,
    },
  });
  const source = Array.from({ length: 101 }, () => "甲乙丙丁。").join("");
  const scheduled = controller.ingest({ text: source, final: true, atMs: 0 });
  const first = scheduled.find((decision) => decision.type === "flush");

  assert.equal(
    scheduled.filter((decision) => decision.type === "flush").length,
    100,
  );
  assert.equal(controller.dispatch({ id: first.id, atMs: 0 }).type, "dispatch");
  const refilled = controller.drain({ atMs: 1 });
  assert.equal(
    refilled.filter((decision) => decision.type === "flush").length,
    1,
  );
  assert.equal(controller.metrics({ atMs: 1 }).scheduledSegments, 101);
});

test("speaks a complete final that fits the policy cap instead of stranding a tiny suffix", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      chineseCharactersPerSecond: 4,
      minimumAudibleCharacters: 12,
      maxSegmentPlayoutMs: 3_500,
      boundaryToleranceMs: 0,
    },
  });
  const text = "甲乙丙丁戊己庚辛壬癸子丑寅";
  const flush = controller
    .ingest({ text, final: true, atMs: 0 })
    .find((decision) => decision.type === "flush");

  assert.equal(flush.text, text);
  assert.deepEqual(controller.unsent(), { characters: 13, segments: 1 });
});

test("sends a complete short final immediately while partial fragments still wait", () => {
  const finalController = new AdaptivePacingController({
    policy: { ...NATURAL_SYNC_PACING_POLICY, minimumAudibleCharacters: 12 },
  });
  const flush = finalController
    .ingest({ text: "OK", final: true, atMs: 0 })
    .find((decision) => decision.type === "flush");
  assert.equal(flush.text, "OK");
  assert.equal(flush.kind, "fast-start");

  const partialController = new AdaptivePacingController({
    policy: { ...NATURAL_SYNC_PACING_POLICY, minimumAudibleCharacters: 12 },
  });
  assert.deepEqual(partialController.ingest({ text: "OK", atMs: 0 }), [
    { type: "wait", reason: "below-minimum" },
  ]);
});

test("uses a rolling outstanding cap", () => {
  const controller = new AdaptivePacingController({
    policy: {
      ...NATURAL_SYNC_PACING_POLICY,
      chineseCharactersPerSecond: 4,
      minimumAudibleCharacters: 4,
      // Retain the former policy field as a compatibility alias while the
      // implementation treats the limit as rolling outstanding work.
      maxCommittedSegments: 1,
    },
  });
  const first = controller
    .ingest({ text: "第一段完成。", atMs: 0 })
    .find((decision) => decision.type === "flush");
  const held = controller.ingest({ text: "第二段完成。", atMs: 1 });

  assert.deepEqual(
    held.map(({ type, reason }) => ({ type, reason })),
    [{ type: "wait", reason: "outstanding-limit" }],
  );
  assert.equal(
    controller.dispatch({ id: first.id, atMs: first.dispatchAtMs }).type,
    "dispatch",
  );
  assert.equal(
    controller
      .drain({ atMs: 2_000 })
      .some((decision) => decision.type === "flush"),
    true,
  );

});

function expectDispatch(segment) {
  return {
    type: "dispatch",
    id: segment.id,
    text: segment.text,
    characters: segment.characters,
    estimatedDurationMs: segment.estimatedDurationMs,
  };
}
