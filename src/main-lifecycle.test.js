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
  assert.match(source, /if \(isPrimaryInstance\) \{/);
  assert.match(source, /\} else \{\s+app\.quit\(\);/);
  assert.match(source, /app\.on\("second-instance", \(\) => \{/);
  assert.match(source, /trayController\?\.showWindow\(\)/);
  assert.match(source, /globalAudioRoutingStarted = !startupRestore\.reason;/);
  assert.match(
    source,
    /globalAudioStartupPromise = globalAudioRoutingStarted\s+\? windowsAudioDefaultsController\.prepare\(\)\s+: Promise\.resolve\(\{ state: "legacy-recovery-needed" \}\)/,
  );
});

test("applies mode routing at Start and restores quick setup before mode roles", async () => {
  const source = await mainSource();
  assert.match(
    source,
    /translive:start"[\s\S]{0,320}await applyTranslationAudioRouting\(activeMode\)/,
  );
  assert.match(
    source,
    /restoreTranslationAudioRouting[\s\S]{0,750}restoreMeetingDevices\(\)[\s\S]{0,450}windowsAudioDefaultsController\.restore\(\)/,
  );
  assert.match(
    source,
    /restoreMeetingDevices: restoreTranslationAudioRouting/,
  );
});

test("opens the raw-audio app before optional RVC initialization settles", async () => {
  const source = await mainSource();
  const createWindowAt = source.indexOf("createWindow();");
  const afterWindowCreation = source.slice(createWindowAt);

  assert.ok(createWindowAt >= 0);
  assert.match(afterWindowCreation, /void voiceStorageReady\s+\.then/);
  assert.match(
    afterWindowCreation,
    /return voiceConversionController\.initialize\(\)/,
  );
  assert.doesNotMatch(
    source,
    /const voiceConversionStartup = await voiceConversionController\.initialize\(\)/,
  );
  assert.match(source, /void voiceStorageReady\s+\.then/);
});

test("limits every RVC IPC to the main renderer and requires explicit profile deletion confirmation", async () => {
  const source = await mainSource();

  for (const channel of [
    "voice-conversion-status",
    "voice-conversion-set-enabled",
    "voice-profile-import",
    "voice-profile-delete",
  ]) {
    const pattern = new RegExp(
      `translive:${channel}"[\\s\\S]{0,180}requireMainRenderer\\(event\\)`,
    );
    assert.match(source, pattern, channel);
  }
  assert.match(source, /confirmedDeleteProfile !== true/);
  assert.match(
    source,
    /voiceConversionController\.deleteProfile\(request\.id\)/,
  );
});

test("owns one sender-validated local own-voice training boundary", async () => {
  const source = await mainSource();

  for (const channel of [
    "voice-training-status",
    "voice-training-start-recording",
    "voice-training-pause-recording",
    "voice-training-resume-recording",
    "voice-training-stop-recording",
    "voice-training-start",
    "voice-training-cancel",
    "voice-training-delete",
  ]) {
    const pattern = new RegExp(
      `translive:${channel}"[\\s\\S]{0,240}requireMainRenderer\\(event\\)`,
    );
    assert.match(source, pattern, channel);
  }
  assert.match(
    source,
    /new VoiceTrainingStore\(\{[\s\S]{0,120}directory: voiceTrainingRoot,[\s\S]{0,120}ensureStorage: ensureVoiceStorage/,
  );
  assert.match(source, /new VoiceTrainingSessionController\(\{/);
  assert.match(
    source,
    /loadRvcRuntimeManifest\(\{[\s\S]{0,120}runtimeRoot,[\s\S]{0,120}trust: RVC_RUNTIME_TRUST/,
  );
  assert.match(source, /voiceTrainingController\?\.dispose\(\)/);
  assert.doesNotMatch(source, /console\.log\([^)]*voice-training/i);
});

test("provisions private ACLs for both voice data and the executable RVC runtime", async () => {
  const source = await mainSource();

  assert.match(source, /ensurePrivateVoiceStorage\(voiceProfileRoot\)/);
  assert.match(source, /ensurePrivateVoiceStorage\(voiceTrainingRoot\)/);
  assert.match(source, /ensurePrivateVoiceStorage\(runtimeStorageRoot\)/);
  assert.match(source, /results\.every\(Boolean\)/);
});

test("keeps existing voice profiles under app userData and requires fresh training consent", async () => {
  const source = await mainSource();

  assert.match(
    source,
    /const voiceProfileRoot = join\(voiceUserDataRoot, "voice-profiles"\)[\s\S]*new VoiceProfileStore\(\{[\s\S]{0,180}directory: voiceProfileRoot/,
  );
  assert.match(
    source,
    /confirmedOwnAuthorizedVoice:\s+request\?\.confirmedOwnAuthorizedVoice === true/,
  );
  assert.match(source, /consentVersion: request\?\.consentVersion/);
  assert.match(source, /validateVoiceTrainingStopRequest\(request\)/);
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

test("app quit disposes local voice conversion sidecars before process exit", async () => {
  const source = await mainSource();

  assert.match(source, /voiceConversionController\?\.dispose\(\)/);
  assert.match(
    source,
    /Promise\.allSettled\(\[[\s\S]{0,420}voiceConversionController\?\.dispose\(\)/,
  );
});

test("translation waits for automatic VoiceMeeter routing and exit restores it first", async () => {
  const source = await mainSource();

  assert.match(
    source,
    /translive:preflight"[\s\S]{0,180}await requireVoiceMeeterRouting\(\)/,
  );
  assert.match(
    source,
    /translive:start"[\s\S]{0,180}await requireVoiceMeeterRouting\(\)/,
  );
  const voiceMeeterRestore = source.indexOf(
    "voiceMeeterRoutingController?.restore()",
  );
  const windowsRestore = source.indexOf("return restoreTranslationAudioRouting();");
  assert.ok(voiceMeeterRestore >= 0);
  assert.ok(windowsRestore > voiceMeeterRestore);
});

test("early quit awaits global-audio startup and uses optional cleanup before restore", async () => {
  const source = await mainSource();

  assert.match(
    source,
    /translationLifecycle\?\.stop\("app-quit", \{[\s\S]{0,100}restoreDevices: false/,
  );
  assert.match(source, /trayController\?\.dispose\(\)/);
  assert.match(
    source,
    /await globalAudioStartupPromise\?\.catch\(\(\) => \{\}\);/,
  );
  assert.match(source, /if \(!globalAudioRoutingStarted\) return undefined;/);
  assert.match(source, /return restoreTranslationAudioRouting\(\);/);
});
