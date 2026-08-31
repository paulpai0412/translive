import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { filesUnder } from "./file-tree.mjs";

const fileGroups = await Promise.all([
  filesUnder("src"),
  filesUnder("scripts"),
  filesUnder("fixtures"),
]);
const javascript = fileGroups
  .flat()
  .filter(
    (file) =>
      file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"),
  );
for (const file of javascript) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const packageJson = await readFile("package.json", "utf8");
let packageMetadata;
try {
  packageMetadata = JSON.parse(packageJson);
} catch (error) {
  throw new Error(`package.json is not valid JSON: ${error.message}`);
}
if (
  packageMetadata.productName !== "TransLive" ||
  packageMetadata.translive?.appId !== "com.paulpai.translive" ||
  packageMetadata.version !== "0.1.0-beta.1"
) {
  throw new Error(
    "package.json must contain branded TransLive release metadata",
  );
}
for (const script of [
  "codex:bundle",
  "package:dir",
  "package:smoke",
  "package:verify",
]) {
  if (typeof packageMetadata.scripts?.[script] !== "string") {
    throw new Error(`package.json is missing ${script}`);
  }
}
if (packageMetadata.devDependencies?.["@electron/packager"] !== "20.3.0") {
  throw new Error(
    "package.json must pin @electron/packager for reproducible packaging",
  );
}
const jsConfig = await readFile("jsconfig.json", "utf8");
try {
  JSON.parse(jsConfig);
} catch (error) {
  throw new Error(`jsconfig.json is not valid JSON: ${error.message}`);
}
const html = await readFile("src/index.html", "utf8");
const main = await readFile("src/main.js", "utf8");
await readFile("assets/translive-brand/translive-tray.png");
await readFile("assets/translive-brand/translive.ico");
await readFile("docs/release/windows-packaging.md");
await readFile("scripts/package.mjs");
await readFile("scripts/package-smoke.mjs");
await readFile("scripts/create-release-icon.mjs");
await readFile("scripts/generate-codex-manifest.mjs");
const windowsMeetingScript = await readFile(
  "scripts/windows-meeting-devices.ps1",
  "utf8",
);
const voiceConversionProbeScript = await readFile(
  "scripts/probe-rvc-capability.ps1",
  "utf8",
);
const voiceTrainingRunner = await readFile(
  "scripts/rvc-training-runtime.py",
  "utf8",
);
const rvcRuntimeTrust = await readFile("scripts/rvc-runtime-trust.json", "utf8");
const rvcPythonVerifier = await readFile("scripts/verify-rvc-python.ps1", "utf8");
if (!main.includes('preload: join(sourceDirectory, "preload.cjs")')) {
  throw new Error("main.js must load the restricted preload bridge");
}
if (!main.includes("app.setAppUserModelId(RELEASE_METADATA.appId)")) {
  throw new Error("main.js must set the branded Windows AppUserModelID");
}
for (const required of [
  'ipcMain.handle("translive:account-status"',
  'ipcMain.handle("translive:account-login"',
  'ipcMain.handle("translive:account-login-cancel"',
  'ipcMain.handle("translive:cancel-start"',
  'ipcMain.handle("translive:meeting-setup-apply"',
  '"translive:audio-defaults-status"',
  'ipcMain.handle("translive:diagnostics-export"',
  'ipcMain.handle("translive:records-list"',
  'ipcMain.handle("translive:summary-session-start"',
  "new RecordsStore",
  "new SummaryController",
  "new WindowsAudioDefaultsController",
  "new WindowsAudioDefaultsStore",
  "new VoiceConversionCapabilityProbe",
  "new VoiceConversionController",
  "new VoiceProfileStore",
  "new VoiceTrainingRuntime",
  "new VoiceTrainingSessionController",
  "new VoiceTrainingStore",
  '"translive:voice-training-stop-recording"',
  "sanitizeMeetingSetupRequest(setup)",
  'ipcMain.handle("translive:tray-status"',
  "shell.openExternal(login.authUrl)",
  "new TrayController",
  "new RendererControlBridge",
  "new TranslationLifecycle",
  "resolveCodexLaunch",
  'ipcMain.on("translive:renderer-control-ack"',
  "windows-meeting-devices.ps1",
]) {
  if (!main.includes(required)) {
    throw new Error(`main.js is missing account integration: ${required}`);
  }
}
if (
  !voiceConversionProbeScript.includes("Get-CimInstance Win32_Processor") ||
  !voiceConversionProbeScript.includes("rvc-runtime-trust.json") ||
  !voiceConversionProbeScript.includes("Has-ReparsePoint") ||
  !voiceConversionProbeScript.includes("ConvertTo-Json -Compress") ||
  /Invoke-WebRequest|pip install|winget install|Copy-Item|Remove-Item|Get-Command/i.test(
    voiceConversionProbeScript,
  )
) {
  throw new Error(
    "probe-rvc-capability.ps1 must remain a read-only capability probe",
  );
}
if (
  !rvcRuntimeTrust.includes('"rvcCommit"') ||
  !rvcPythonVerifier.includes("Get-AuthenticodeSignature") ||
  !voiceTrainingRunner.includes("weights_only=True") ||
  !voiceTrainingRunner.includes("shell=False") ||
  !voiceTrainingRunner.includes("cpu-baseline") ||
  /requests\.get|urllib\.request|socket\.socket|http:\/\//i.test(
    voiceTrainingRunner,
  )
) {
  throw new Error(
    "rvc-training-runtime.py must keep local-only fixed CPU training and weights-only verification",
  );
}
for (const required of [
  'ValidateSet("detect", "resolve", "snapshot", "apply", "restore", "snapshot-all-roles", "apply-all-roles", "restore-all-roles")',
  "ResolveActiveEndpointId",
  "GetDefaultEndpointId",
  "SetDefaultEndpointId",
  "$CaptureName",
  "$RenderName",
]) {
  if (!windowsMeetingScript.includes(required)) {
    throw new Error(
      `windows-meeting-devices.ps1 is missing native endpoint resolution: ${required}`,
    );
  }
}
if (!html.includes('src="./renderer-entry.js"')) {
  throw new Error("index.html must load the renderer entrypoint");
}
for (const required of [
  "../assets/translive-brand/translive-mark.svg",
  'data-mode-button="meeting"',
  'data-mode-button="media"',
  'data-mode-button="microphone"',
  'id="account-login-button"',
  'id="account-login-cancel"',
  'id="meeting-platform"',
  'id="route-profile"',
  'id="tx-sink"',
  'id="diagnostics-drawer"',
  'id="mini-overlay-button"',
  'id="quick-setup-modal"',
  'id="tray-close-behavior"',
  'data-view-button="history"',
  'id="records-list"',
  'id="summary-confirm-modal"',
  'id="settings-retention-status"',
  'id="global-audio-status"',
  'id="voice-conversion-toggle"',
  'id="voice-profile-select"',
  'id="voice-profile-consent"',
  'id="voice-training-microphone"',
  'id="voice-training-consent"',
  'id="voice-training-final-consent"',
  'id="voice-training-start"',
  'id="voice-training-stop"',
  'id="voice-training-status"',
  'aria-label="本人音色錄製與訓練進度"',
  'aria-live="polite"',
  'role="alert"',
]) {
  if (!html.includes(required)) {
    throw new Error(`index.html is missing formal UI contract: ${required}`);
  }
}
if (
  !html.includes("Content-Security-Policy") ||
  !html.includes("script-src 'self'")
) {
  throw new Error("index.html must keep a restrictive Content-Security-Policy");
}
if (/<script(?![^>]*\bsrc=)/i.test(html)) {
  throw new Error("index.html must not contain inline scripts");
}
const preload = await readFile("src/preload.cjs", "utf8");
for (const required of [
  "diagnosticsExport",
  "recordsList",
  "recordsRetentionStatus",
  "aggregatesExport",
  "summarySessionStart",
  "summaryAggregateStart",
  "summaryCancel",
  "audioDefaultsStatus",
  "miniCaptionShow",
  "miniCaptionUpdate",
  "voiceConversionStatus",
  "voiceConversionSetEnabled",
  "voiceProfileImport",
  "voiceTrainingStatus",
  "voiceTrainingStartRecording",
  "voiceTrainingStopRecording",
  "voiceTrainingCancel",
  "rendererControlAck",
]) {
  if (!preload.includes(required)) {
    throw new Error(`preload.cjs is missing records contract: ${required}`);
  }
}
const renderer = await readFile("src/renderer-entry.js", "utf8");
if (renderer.includes('elements["cable-a-sink"]')) {
  throw new Error("renderer-entry.js must use the formal tx-sink control");
}
if (!renderer.includes('elements["tx-sink"]')) {
  throw new Error("renderer-entry.js must wire the formal tx-sink control");
}
if (!renderer.includes("exportAggregate")) {
  throw new Error("renderer-entry.js must expose aggregate export feedback");
}
if (!renderer.includes("diagnosticsExport")) {
  throw new Error("renderer-entry.js must expose redacted diagnostic export");
}
if (!renderer.includes("initializeVoiceTraining")) {
  throw new Error(
    "renderer-entry.js must expose local own-voice training status",
  );
}
if (!renderer.includes("initializeVoiceConversion")) {
  throw new Error(
    "renderer-entry.js must expose safe local voice conversion status",
  );
}
if (!renderer.includes("applyGlobalAudioStatus")) {
  throw new Error(
    "renderer-entry.js must expose safe global Windows audio status",
  );
}
if (!renderer.includes('event.type === "renderer-control"')) {
  throw new Error(
    "renderer-entry.js must acknowledge main-to-renderer controls",
  );
}
const releaseConfig = await readFile("src/release-config.js", "utf8");
if (releaseConfig.includes('value.startsWith("node_modules/")')) {
  throw new Error("release-config.js must not package arbitrary node_modules");
}
const packageScript = await readFile("scripts/package.mjs", "utf8");
if (!packageScript.includes("assertWindowsCodexBundle")) {
  throw new Error("package.mjs must require verified bundled Codex on Windows");
}
const gitignore = await readFile(".gitignore", "utf8");
if (!gitignore.includes(".translive-evidence/")) {
  throw new Error(".gitignore must exclude local evidence");
}

process.stdout.write(
  `Static check passed for ${javascript.length} JavaScript files, package JSON, Electron entrypoints, HTML CSP, and evidence ignore.\n`,
);
