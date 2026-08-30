import assert from "node:assert/strict";
import test from "node:test";

import {
  channelStateLabel,
  diagnosticEventLabel,
  modeLabel,
  runStatePresentation,
} from "./view-state.js";

test("localizes runtime channel states for the visible UI", () => {
  assert.equal(channelStateLabel("connecting"), "連線中");
  assert.equal(channelStateLabel("live"), "翻譯中");
  assert.equal(channelStateLabel("disabled"), "未啟用");
  assert.equal(channelStateLabel("failed"), "已中斷");
});

test("describes degraded state by the active mode and failed direction", () => {
  assert.deepEqual(
    runStatePresentation({
      appState: "degraded",
      mode: "meeting",
      status: { tx: "live", rx: "failed" },
    }),
    {
      title: "接收翻譯已中斷",
      detail: "對方仍能聽到你的翻譯，但你暫時聽不到繁中翻譯。",
      level: "warning",
    },
  );
  assert.deepEqual(
    runStatePresentation({
      appState: "degraded",
      mode: "media",
      status: { tx: "disabled", rx: "failed" },
    }),
    {
      title: "媒體翻譯已中斷",
      detail: "目前媒體音訊不會翻譯至繁中，請重新建立翻譯連線。",
      level: "warning",
    },
  );
});

test("keeps raw event codes out of visible diagnostic summaries", () => {
  assert.equal(diagnosticEventLabel("sdp"), "音訊連線協商");
  assert.equal(diagnosticEventLabel("transcript"), "字幕更新");
  assert.equal(diagnosticEventLabel("blocked"), "連線受阻");
  assert.equal(diagnosticEventLabel("meeting-setup"), "會議裝置設定");
  assert.equal(diagnosticEventLabel("tray"), "系統匣操作");
  assert.equal(diagnosticEventLabel("record"), "紀錄已保存");
  assert.equal(diagnosticEventLabel("summary"), "摘要狀態更新");
  assert.equal(diagnosticEventLabel("pacing"), "翻譯節奏調整");
});

test("names each selected mode in Traditional Chinese", () => {
  assert.equal(modeLabel("meeting"), "雙向會議");
  assert.equal(modeLabel("media"), "媒體翻譯");
  assert.equal(modeLabel("microphone"), "麥克風翻譯");
});
