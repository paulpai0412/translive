import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

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
try {
  JSON.parse(packageJson);
} catch (error) {
  throw new Error(`package.json is not valid JSON: ${error.message}`);
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
const windowsMeetingScript = await readFile(
  "scripts/windows-meeting-devices.ps1",
  "utf8",
);
if (!main.includes('preload: join(sourceDirectory, "preload.cjs")')) {
  throw new Error("main.js must load the restricted preload bridge");
}
for (const required of [
  'ipcMain.handle("translive:account-status"',
  'ipcMain.handle("translive:account-login"',
  'ipcMain.handle("translive:account-login-cancel"',
  'ipcMain.handle("translive:cancel-start"',
  'ipcMain.handle("translive:meeting-setup-apply"',
  'ipcMain.handle("translive:records-list"',
  'ipcMain.handle("translive:summary-session-start"',
  "new RecordsStore",
  "new SummaryController",
  "sanitizeMeetingSetupRequest(setup)",
  'ipcMain.handle("translive:tray-status"',
  "shell.openExternal(login.authUrl)",
  "new TrayController",
  "windows-meeting-devices.ps1",
]) {
  if (!main.includes(required)) {
    throw new Error(`main.js is missing account integration: ${required}`);
  }
}
for (const required of [
  'ValidateSet("detect", "resolve", "snapshot", "apply", "restore")',
  "ResolveActiveEndpointId",
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
  'id="mini-overlay"',
  'id="quick-setup-modal"',
  'id="tray-close-behavior"',
  'data-view-button="history"',
  'id="records-list"',
  'id="summary-confirm-modal"',
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
  "recordsList",
  "aggregatesExport",
  "summarySessionStart",
  "summaryAggregateStart",
  "summaryCancel",
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
const gitignore = await readFile(".gitignore", "utf8");
if (!gitignore.includes(".translive-evidence/")) {
  throw new Error(".gitignore must exclude local evidence");
}

process.stdout.write(
  `Static check passed for ${javascript.length} JavaScript files, package JSON, Electron entrypoints, HTML CSP, and evidence ignore.\n`,
);
