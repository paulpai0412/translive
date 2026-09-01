import assert from "node:assert/strict";
import test from "node:test";

import {
  SLOT_LABELS,
  decideDeviceChangeReaction,
} from "./device-change-controller.js";

test("live 中當前模式所需裝置消失時回報警告並列出裝置", () => {
  const reaction = decideDeviceChangeReaction({
    appState: "live",
    missingSlots: ["headphones"],
    mode: "meeting",
  });
  assert.equal(reaction.level, "warn");
  assert.match(reaction.message, /耳機輸出/);
  assert.match(reaction.message, /中斷/);
});

test("degraded 中裝置消失同樣回報警告", () => {
  const reaction = decideDeviceChangeReaction({
    appState: "degraded",
    missingSlots: ["txSink"],
    mode: "microphone",
  });
  assert.equal(reaction.level, "warn");
  assert.match(reaction.message, /虛擬麥克風輸出/);
});

test("live 中缺少的 slot 不屬於目前模式時保持靜默", () => {
  const reaction = decideDeviceChangeReaction({
    appState: "live",
    missingSlots: ["physicalMic"],
    mode: "media",
  });
  assert.equal(reaction.level, "none");
  assert.equal(reaction.message, "");
});

test("live 中沒有缺少裝置時保持靜默", () => {
  const reaction = decideDeviceChangeReaction({
    appState: "live",
    missingSlots: [],
    mode: "meeting",
  });
  assert.equal(reaction.level, "none");
});

test("ready 與其他狀態的裝置變更由既有 ready-message 呈現，不重複警告", () => {
  for (const appState of ["ready", "connecting", "stopped", "blocked"]) {
    const reaction = decideDeviceChangeReaction({
      appState,
      missingSlots: ["headphones"],
      mode: "meeting",
    });
    assert.equal(reaction.level, "none", appState);
  }
});

test("SLOT_LABELS 涵蓋所有裝置 slot", () => {
  assert.deepEqual(Object.keys(SLOT_LABELS).sort(), [
    "headphones",
    "physicalMic",
    "rxSource",
    "txSink",
  ]);
});
