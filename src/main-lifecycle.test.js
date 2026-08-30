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
