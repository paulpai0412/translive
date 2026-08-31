import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("formal UI exposes every app state and destructive action through accessible controls", async () => {
  const [html, renderer] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL("./renderer-entry.js", import.meta.url), "utf8"),
  ]);

  for (const state of [
    "checking",
    "logged-out",
    "auth-waiting",
    "ready",
    "connecting",
    "live",
    "degraded",
    "blocked",
    "stopped",
  ]) {
    assert.match(html, new RegExp(`data-state-show="[^"]*${state}`));
  }
  for (const modal of [
    "quick-setup-modal",
    "consent-modal",
    "delete-confirm-modal",
    "summary-confirm-modal",
  ]) {
    const pattern = new RegExp(
      `id="${modal}"[\\s\\S]{0,220}role="dialog"[\\s\\S]{0,120}aria-modal="true"`,
    );
    assert.match(html, pattern, modal);
  }
  assert.match(html, /id="diagnostics-drawer"[\s\S]{0,120}role="dialog"/);
  assert.match(
    html,
    /id="assertive-error"[\s\S]{0,100}role="alert"[\s\S]{0,100}aria-live="assertive"/,
  );
  assert.match(html, /id="records-status" role="status"/);
  assert.match(html, /id="copy-diagnostics"[\s\S]{0,80}>\s*匯出遮罩診斷包/);
  assert.match(renderer, /event\.key === "Tab" && openModal/);
  assert.match(renderer, /focusOrigins\.set\(modal, document\.activeElement\)/);
  assert.match(renderer, /origin\?\.isConnected\) origin\.focus\(\)/);
  assert.match(renderer, /event\.key !== "Escape"/);
});

test("formal UI provides Traditional-Chinese actionable persistence and summary failures", async () => {
  const renderer = await readFile(
    new URL("./renderer-entry.js", import.meta.url),
    "utf8",
  );

  for (const message of [
    "逐字稿保存失敗，請開啟診斷查看詳情。",
    "無法產生摘要，請檢查 ChatGPT 登入與網路後再試。",
    "無法匯出遮罩診斷包，請確認儲存位置後再試。",
    "無法刪除全部紀錄，請稍後再試。",
  ]) {
    assert.match(renderer, new RegExp(message));
  }
  assert.doesNotMatch(renderer, /error\.message.*showAssertiveError/);
  assert.doesNotMatch(renderer, /快速設定無法完成：\$\{error\.message\}/);
  assert.doesNotMatch(renderer, /無法列出裝置：\$\{error\.message\}/);
  assert.doesNotMatch(renderer, /blocked-detail"\]\.textContent = detail/);
  assert.match(renderer, /無法產生摘要，請檢查 ChatGPT 登入與網路後再試。/);
  assert.match(renderer, /無法刪除這場紀錄，請稍後再試。/);
  assert.match(renderer, /無法刪除跨場摘要，請稍後再試。/);
  assert.match(renderer, /event\.type === "cleanup"/);
  assert.match(renderer, /已登出，但部分本機清理未完成。請開啟診斷確認。/);
  assert.doesNotMatch(renderer, /cleanup.*error\.message/);
  assert.match(
    renderer,
    /if \(canceled\) \{\s+await releaseRendererResources\(\);/,
  );
});

test("shows a safe global Windows audio-routing status", async () => {
  const [html, preload, renderer] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL("./preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("./renderer-entry.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="global-audio-status"[^>]*role="status"/);
  assert.match(
    html,
    /TransLive 開啟時會將 Windows 預設輸入與輸出暫時導向 VoiceMeeter/,
  );
  assert.match(preload, /audioDefaultsStatus/);
  assert.match(renderer, /audioDefaultsStatus\(\)/);
  assert.match(renderer, /event\.type === "global-audio"/);
  assert.match(renderer, /Windows 預設音訊已暫時導向 VoiceMeeter/);
  assert.match(renderer, /Windows 音訊設定未變更/);
  assert.match(renderer, /legacy-recovery-needed/);
  assert.match(renderer, /recovery-needed/);
  assert.match(renderer, /checkpoint-clear-failed/);
  assert.doesNotMatch(renderer, /global-audio.*captureId/);
  assert.doesNotMatch(renderer, /global-audio.*renderId/);
});

test("shows automatic VoiceMeeter internal routing without exposing bus snapshots", async () => {
  const [html, preload, renderer] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL("./preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("./renderer-entry.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="voicemeeter-routing-status"[^>]*role="status"/);
  assert.match(preload, /voiceMeeterRoutingStatus/);
  assert.match(renderer, /voiceMeeterRoutingStatus\(\)/);
  assert.match(renderer, /event\.type === "voicemeeter-routing"/);
  assert.match(renderer, /VAIO → B1、AUX → B2/);
  assert.doesNotMatch(renderer, /voicemeeter-routing.*Strip\[/);
});

test("renderer advances deferred RX target captions only when speech fallback dispatches", async () => {
  const renderer = await readFile(
    new URL("./renderer-entry.js", import.meta.url),
    "utf8",
  );

  assert.match(renderer, /if \(deferred\) \{/);
  assert.match(renderer, /event\.type === "speech-fallback"/);
  assert.match(renderer, /advanceSpeechFallbackCaption\(event\)/);
  assert.match(renderer, /if \(state === "unsent"\) \{/);
  assert.match(renderer, /部分尾端翻譯未朗讀，字幕與逐字稿已保留。/);
});

test("keeps saved-record paths concise, diagnostics current, and captions outside the main renderer", async () => {
  const [html, css, preload, renderer] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL("./styles.css", import.meta.url), "utf8"),
    readFile(new URL("./preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("./renderer-entry.js", import.meta.url), "utf8"),
  ]);

  assert.match(
    renderer,
    /stopped-copy"\]\.title = presentation\.pathDetail \?\? ""/,
  );
  assert.match(css, /\.stopped-panel p,[\s\S]{0,180}overflow-wrap: anywhere/);
  assert.match(
    renderer,
    /diagnosticsPresentation\(\{[\s\S]{0,100}mode: ui\.mode/,
  );
  assert.doesNotMatch(
    renderer,
    /elements\[`diag-\$\{event\.direction\}`\]\.textContent = event\.state/,
  );
  assert.match(
    renderer,
    /function setMode\(mode\)[\s\S]{0,1800}renderDiagnostics\(\)/,
  );
  assert.match(
    renderer,
    /function setChannelState\(direction, state\)[\s\S]{0,1000}renderDiagnostics\(\)/,
  );
  assert.match(preload, /miniCaptionShow/);
  assert.match(preload, /miniCaptionUpdate/);
  assert.match(renderer, /miniCaptionShow\(miniCaptionSnapshot\(\)\)/);
  assert.match(renderer, /miniCaptionUpdate\(miniCaptionSnapshot\(\)\)/);
  assert.doesNotMatch(html, /id="mini-overlay"/);
  assert.doesNotMatch(css, /\.mini-overlay/);
});

test("RVC settings require opt-in consent and expose only safe status/profile fields", async () => {
  const [html, main, preload, renderer] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL("./main.js", import.meta.url), "utf8"),
    readFile(new URL("./preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("./renderer-entry.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /本機自訂音色 RVC/);
  assert.match(html, /id="voice-conversion-toggle"[^>]*role="switch"/);
  assert.match(html, /id="voice-profile-select"/);
  assert.match(html, /id="voice-profile-consent"/);
  assert.match(html, /id="voice-profile-import"/);
  assert.match(html, /id="voice-profile-delete-confirm"/);
  assert.match(html, /id="voice-profile-delete"/);
  assert.match(html, /僅可使用本人或已明確授權的聲音/);
  assert.match(html, /id="voice-conversion-status"[^>]*role="status"/);
  for (const method of [
    "voiceConversionStatus",
    "voiceConversionSetEnabled",
    "voiceProfileImport",
    "voiceProfileDelete",
  ]) {
    assert.match(preload, new RegExp(method));
  }
  assert.match(main, /"translive:voice-conversion-status"/);
  assert.match(main, /"translive:voice-conversion-set-enabled"/);
  assert.match(main, /"translive:voice-profile-import"/);
  assert.match(main, /"translive:voice-profile-delete"/);
  assert.match(renderer, /自訂音色暫停，正在播放原 GPT 音色/);
  assert.match(renderer, /需要已驗證的本機 RVC runtime/);
  assert.match(renderer, /voiceProfileDelete/);
  assert.match(renderer, /confirmedDeleteProfile/);
  assert.doesNotMatch(renderer, /modelPath|indexPath|embeddingPath|samplePath/);
  assert.doesNotMatch(
    renderer,
    /VoiceConversionDeadline|createVoiceConversionFrame/,
  );
  assert.doesNotMatch(main, /FakeVoiceConversionSidecar/);
});

test("own-voice training settings keep recording local and expose accessible lifecycle controls", async () => {
  const [html, main, preload, renderer] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL("./main.js", import.meta.url), "utf8"),
    readFile(new URL("./preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("./renderer-entry.js", import.meta.url), "utf8"),
  ]);

  for (const id of [
    "voice-training-microphone",
    "voice-training-consent",
    "voice-training-final-consent",
    "voice-training-start",
    "voice-training-pause",
    "voice-training-resume",
    "voice-training-stop",
    "voice-training-cancel",
    "voice-training-delete",
    "voice-training-status",
    "voice-training-progress",
    "voice-training-level",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(
    html,
    /id="voice-training-progress"[\s\S]{0,120}aria-label="本人音色錄製與訓練進度"/,
  );
  assert.match(html, /CPU 訓練可能需要較長時間/);
  assert.match(html, /DirectML 目前僅作推論候選/);
  for (const method of [
    "voiceTrainingStatus",
    "voiceTrainingStartRecording",
    "voiceTrainingPauseRecording",
    "voiceTrainingResumeRecording",
    "voiceTrainingStopRecording",
    "voiceTrainingStart",
    "voiceTrainingCancel",
    "voiceTrainingDelete",
  ]) {
    assert.match(preload, new RegExp(method), method);
  }
  assert.match(main, /"translive:voice-training-stop-recording"/);
  assert.match(main, /requireMainRenderer\(event\)/);
  assert.match(renderer, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(renderer, /new MediaRecorder/);
  assert.match(renderer, /audio\/webm;codecs=opus/);
  assert.match(renderer, /voiceTrainingStopRecording/);
  assert.match(renderer, /voice-training-final-consent/);
  assert.match(renderer, /consentVersion: VOICE_TRAINING_POLICY\.version/);
  assert.doesNotMatch(renderer, /fetch\(|WebSocket|OpenAI|recording\.webm|normalized\.wav|output\.pth/);
});

test("applies route-valid device recommendations while preserving manual physical choices", async () => {
  const renderer = await readFile(
    new URL("./renderer-entry.js", import.meta.url),
    "utf8",
  );

  assert.match(renderer, /recommendModeDevices\(\{/);
  assert.match(renderer, /applyModeDeviceRecommendations\(\);/);
  assert.match(renderer, /rememberManualPhysicalDevice\("physicalMic"\)/);
  assert.match(renderer, /rememberManualPhysicalDevice\("headphones"\)/);
  assert.match(renderer, /headphones-confirmed"\]\.checked = false/);
  assert.match(renderer, /route-profile"\]\.addEventListener\("change"/);
});

test("enumerates audio devices as soon as ChatGPT is connected", async () => {
  const renderer = await readFile(
    new URL("./renderer-entry.js", import.meta.url),
    "utf8",
  );

  assert.match(
    renderer,
    /setAppState\(result\.state === "connected" \? "ready" : "logged-out"\);\s+if \(result\.state === "connected"\) await refreshDevices\(\);/,
  );
  assert.match(
    renderer,
    /if \(event\.state === "connected"\) \{\s+setAppState\("ready"\);\s+await refreshDevices\(\);/,
  );
});
