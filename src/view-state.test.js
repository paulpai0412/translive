import assert from "node:assert/strict";
import test from "node:test";

import {
  channelStateLabel,
  diagnosticEventLabel,
  diagnosticsPresentation,
  modeLabel,
  runStatePresentation,
  stoppedStatePresentation,
  voiceEmptyStateVisible,
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
});

test("derives diagnostics from the selected active mode and localized channel state", () => {
  assert.deepEqual(
    diagnosticsPresentation({
      mode: "media",
      status: { tx: "disabled", rx: "live" },
    }),
    {
      mode: "媒體翻譯",
      rx: "翻譯中",
      tx: "未啟用",
    },
  );
  assert.deepEqual(
    diagnosticsPresentation({
      mode: "media",
      status: { tx: "live", rx: "connecting" },
    }),
    {
      mode: "媒體翻譯",
      rx: "連線中",
      tx: "未啟用",
    },
  );
  assert.deepEqual(
    diagnosticsPresentation({
      mode: "microphone",
      status: { tx: "muted", rx: "live" },
    }),
    {
      mode: "麥克風翻譯",
      rx: "未啟用",
      tx: "已靜音",
    },
  );
});

test("names each selected mode in Traditional Chinese", () => {
  assert.equal(modeLabel("meeting"), "雙向會議");
  assert.equal(modeLabel("media"), "媒體翻譯");
  assert.equal(modeLabel("microphone"), "麥克風翻譯");
  assert.equal(modeLabel("assistant"), "會議助手");
});

test("stopped 畫面在音訊設定已還原時顯示確認訊息", () => {
  assert.deepEqual(
    stoppedStatePresentation({
      audioDefaultsState: "restored",
      routingState: "restored",
    }),
    {
      restoreLine: "原本的 Windows 音訊設定與 VoiceMeeter 路由已還原。",
      level: "ok",
    },
  );
});

test("stopped 畫面在不支援平台的狀態視為已還原", () => {
  const presentation = stoppedStatePresentation({
    audioDefaultsState: "unsupported",
    routingState: "unsupported",
  });
  assert.equal(presentation.level, "ok");
});

test("stopped 畫面在任一還原失敗或待還原時顯示警告", () => {
  for (const state of [
    "restore-failed",
    "recovery-needed",
    "legacy-recovery-needed",
    "checkpoint-clear-failed",
  ]) {
    const presentation = stoppedStatePresentation({
      audioDefaultsState: state,
      routingState: "restored",
    });
    assert.equal(presentation.level, "warn", state);
    assert.match(presentation.restoreLine, /尚未還原/);
  }
  const routingFailure = stoppedStatePresentation({
    audioDefaultsState: "restored",
    routingState: "restore-failed",
  });
  assert.equal(routingFailure.level, "warn");
});

test("stopped 畫面在狀態未知時不顯示還原訊息", () => {
  assert.deepEqual(
    stoppedStatePresentation({
      audioDefaultsState: undefined,
      routingState: undefined,
    }),
    { restoreLine: "", level: "none" },
  );
});

test("音色頁在沒有設定檔時顯示空白導引", () => {
  assert.equal(voiceEmptyStateVisible(0), true);
  assert.equal(voiceEmptyStateVisible(2), false);
});

test("assistant mode labels live state as recording, not translating", () => {
  assert.equal(channelStateLabel("live", "assistant"), "記錄中");
  assert.equal(channelStateLabel("live"), "翻譯中");
  assert.equal(channelStateLabel("live", "meeting"), "翻譯中");
  const presentation = runStatePresentation({
    appState: "live",
    mode: "assistant",
    status: { tx: "live", rx: "live" },
  });
  assert.equal(presentation.title, "記錄中");
});
