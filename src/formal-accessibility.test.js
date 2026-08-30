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
