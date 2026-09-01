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

test("Restart immediately creates a fresh translation instead of returning to setup", async () => {
  const renderer = await readFile(
    new URL("./renderer-entry.js", import.meta.url),
    "utf8",
  );

  assert.match(
    renderer,
    /elements\["restart-button"\]\.addEventListener\("click", startTranslation\)/,
  );
  assert.doesNotMatch(
    renderer,
    /elements\["restart-button"\][\s\S]{0,100}setAppState\("ready"\)/,
  );
});

test("WebRTC playout uses direction-owned AudioContext sinks instead of HTML audio", async () => {
  const renderer = await readFile(
    new URL("./renderer-entry.js", import.meta.url),
    "utf8",
  );

  assert.match(renderer, /import \{ DirectionalAudioOutput \}/);
  assert.match(renderer, /new DirectionalAudioOutput\(\{/);
  assert.match(renderer, /await audioOutput\?\.(prepare|attach)/);
  assert.match(renderer, /await audioOutput\?\.prepare\(\)/);
  assert.match(renderer, /await audioOutput\.attach\(remoteStream\)/);
  assert.match(renderer, /audioOutput\?\.setMuted\(muted\)/);
  assert.match(renderer, /await audioOutput\?\.close\(\)/);
  assert.doesNotMatch(renderer, /audio = document\.createElement\("audio"\)/);
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
    /const canceled =[\s\S]{0,120}await releaseRendererResources\(\);[\s\S]{0,180}await window\.translive\.cancelStart\(\);[\s\S]{0,180}if \(canceled\)/,
  );
});

test("shows a safe global Windows audio-routing status", async () => {
  const [html, preload, renderer] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL("./preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("./renderer-entry.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="global-audio-status"[^>]*role="status"/);
  assert.match(html, /開始翻譯時只切換目前模式需要的\s+Windows\s+音訊角色/);
  assert.match(preload, /audioDefaultsStatus/);
  assert.match(renderer, /audioDefaultsStatus\(\)/);
  assert.match(renderer, /event\.type === "global-audio"/);
  assert.match(renderer, /只套用目前模式需要的路由/);
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

test("renderer renders RX target captions immediately with no pacing path", async () => {
  const renderer = await readFile(
    new URL("./renderer-entry.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(renderer, /deferred|pacedTargets|speech-fallback/);
  assert.match(
    renderer,
    /function appendTranscript\(\{ direction, role, text, final = false \}\)/,
  );
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

  assert.match(html, /本機自訂音色\s+RVC/);
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
  assert.match(html, /DirectML\s+目前僅作推論候選/);
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
  assert.match(renderer, /addEventListener\("devicechange"/);
  assert.match(html, /id="test-tx-sink"/);
  assert.match(html, /id="test-headphones"/);
  assert.match(html, /id="voice-empty-state"/);
  assert.match(renderer, /createOutputTester/);
  assert.match(renderer, /voiceEmptyStateVisible/);
  assert.match(renderer, /new MediaRecorder/);
  assert.match(renderer, /audio\/webm;codecs=opus/);
  assert.match(renderer, /voiceTrainingStopRecording/);
  assert.match(renderer, /voice-training-final-consent/);
  assert.match(renderer, /consentVersion: VOICE_TRAINING_POLICY\.version/);
  assert.doesNotMatch(
    renderer,
    /fetch\(|WebSocket|OpenAI|recording\.webm|normalized\.wav|output\.pth/,
  );
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

test("formal UI exposes the meeting assistant mode with reviewable answers", async () => {
  const [html, renderer] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL("./renderer-entry.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /data-mode-button="assistant"/);
  assert.match(html, /class="qa-card" id="qa-card" hidden/);
  assert.match(html, /aria-label="會議助手問答"/);
  assert.match(html, /id="speak-conclusions-button"/);
  assert.match(html, /id="qa-approve"[\s\S]{0,60}送入會議語音/);
  assert.match(html, /id="qa-reject"/);
  assert.match(html, /id="assistant-answer-delivery"/);
  assert.match(html, /id="assistant-wake-armed"/);
  assert.match(html, /id="auto-summary-enabled"/);
  assert.match(html, /id="stopped-back-home"[^>]*>\s*返回主頁/);
  assert.match(renderer, /stopped-back-home.*setAppState\("ready"\)/s);
  assert.match(html, /id="assistant-wake-phrase"[^>]*maxlength="40"/);
  assert.match(html, /id="qa-hint"/);

  assert.match(renderer, /assistant: \["tx", "rx"\]/);
  assert.match(
    renderer,
    /ui\.mode === "assistant"\) return startAssistant\(\)/,
  );
  assert.match(renderer, /window\.translive\.assistantStart\(/);
  assert.match(renderer, /event\.direction !== "qa"/);
  assert.match(renderer, /playRemote: false/);
  assert.match(renderer, /createMediaStreamDestination/);
  assert.match(renderer, /silentGain\.gain\.value = 0/);
  assert.match(renderer, /ui\.passthroughStream = ui\.active\.tx\?\.stream/);
  assert.match(renderer, /ui\.passthrough\?\.setMuted\(muted\)/);
  assert.match(
    renderer,
    /!\(?\["meeting", "assistant"\]\.includes\(ui\.mode\)/,
  );
});
