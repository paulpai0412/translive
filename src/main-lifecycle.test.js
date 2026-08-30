import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function mainSource() {
  return readFile(new URL("./main.js", import.meta.url), "utf8");
}

test("only the primary Electron instance can initialize shared Windows audio routing", async () => {
  const source = await mainSource();

  assert.match(
    source,
    /const isPrimaryInstance = app\.requestSingleInstanceLock\(\);/,
  );
  assert.match(source, /if \(!isPrimaryInstance\) \{\s+app\.quit\(\);/);
  assert.match(source, /app\.on\("second-instance", \(\) => \{/);
  assert.match(source, /trayController\?\.showWindow\(\)/);
  assert.match(source, /globalAudioRoutingStarted = !startupRestore\.reason;/);
  assert.match(
    source,
    /globalAudioStartupPromise = globalAudioRoutingStarted\s+\? windowsAudioDefaultsController\.start\(\)\s+: Promise\.resolve\(\{ state: "legacy-recovery-needed" \}\)/,
  );
});

test("owns mini captions in a separate non-modal window with a bounded renderer IPC seam", async () => {
  const source = await mainSource();

  assert.match(
    source,
    /import \{ MiniCaptionWindowController \} from "\.\/mini-caption-window\.js"/,
  );
  assert.match(source, /new MiniCaptionWindowController\(\{/);
  assert.match(source, /mini-caption-preload\.cjs/);
  assert.match(source, /ipcMain\.handle\("translive:mini-caption-show"/);
  assert.match(source, /ipcMain\.on\("translive:mini-caption-update"/);
  assert.match(source, /ipcMain\.on\("translive:mini-caption-return"/);
  assert.match(source, /miniCaptionWindowController\?\.dispose\(\)/);
});

test("exit close disposes a hidden mini window before quitting the app", async () => {
  const source = await mainSource();

  assert.match(
    source,
    /if \(!trayController\?\.shouldHideOnClose\(\)\) \{\s+event\.preventDefault\(\);\s+miniCaptionWindowController\?\.dispose\(\);\s+app\.quit\(\);\s+return;/,
  );
});

test("early quit awaits global-audio startup and uses optional cleanup before restore", async () => {
  const source = await mainSource();

  assert.match(source, /translationLifecycle\?\.stop\("app-quit"/);
  assert.match(source, /trayController\?\.dispose\(\)/);
  assert.match(
    source,
    /await globalAudioStartupPromise\?\.catch\(\(\) => \{\}\);/,
  );
  assert.match(source, /if \(!globalAudioRoutingStarted\) return undefined;/);
  assert.match(source, /windowsAudioDefaultsController\?\.restore\(\)/);
});
