import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { execFile as defaultExecFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AccountController } from "./account-controller.js";
import { AssistantPreferences } from "./assistant-preferences.js";
import { resolveCodexLaunch } from "./codex-launch.js";
import { CodexTextTurn } from "./codex-text-turn.js";
import { buildDiagnostics } from "./diagnostics-service.js";
import { MeetingAssistantController } from "./meeting-assistant-controller.js";
import { MeetingIndex } from "./meeting-index.js";
import { rebuildMeetingIndexFromRecords } from "./meeting-index-rebuild.js";
import { MeetingSetupController } from "./meeting-setup-controller.js";
import { sanitizeMeetingSetupRequest } from "./meeting-setup-request.js";
import { MeetingSetupStore } from "./meeting-setup-store.js";
import { MiniCaptionWindowController } from "./mini-caption-window.js";
import { PhaseOneController } from "./phase-one-controller.js";
import { assertPrivateLocalDirectory } from "./private-local-storage.js";
import { allowsLocalAudioPermission } from "./permissions.js";
import { recordsDirectory } from "./records-path.js";
import { RecordsStore } from "./records-store.js";
import { RVC_RUNTIME_TRUST } from "./rvc-runtime-trust.js";
import { RendererControlBridge } from "./renderer-control-bridge.js";
import { RELEASE_METADATA } from "./release-config.js";
import { CodexSummaryService } from "./summary-service.js";
import { SummaryController } from "./summary-controller.js";
import { TranslationLifecycle } from "./translation-lifecycle.js";
import { TrayController } from "./tray-controller.js";
import { TrayPreferences } from "./tray-preferences.js";
import {
  createVoiceMeeterRoutingStore,
  VoiceMeeterRoutingAdapter,
  VoiceMeeterRoutingController,
} from "./voicemeeter-routing.js";
import { VoiceConversionCapabilityProbe } from "./voice-conversion-capability.js";
import { VoiceConversionController } from "./voice-conversion-controller.js";
import { VoiceProfileStore } from "./voice-profile-store.js";
import {
  loadRvcRuntimeManifest,
  VoiceTrainingRuntime,
} from "./voice-training-runtime.js";
import { VoiceTrainingSessionController } from "./voice-training-session-controller.js";
import { VoiceTrainingStore } from "./voice-training-store.js";
import { WindowsAudioDefaultsController } from "./windows-audio-defaults-controller.js";
import { WindowsAudioDefaultsStore } from "./windows-audio-defaults-store.js";
import { WindowsMeetingDeviceAdapter } from "./windows-meeting-device-adapter.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const execFile = promisify(defaultExecFile);
const require = createRequire(import.meta.url);
const {
  validateVoiceTrainingStopRequest,
} = require("./voice-training-ipc.cjs");
const isPrimaryInstance = app.requestSingleInstanceLock();
const windowIconPath = join(
  sourceDirectory,
  "../assets/translive-brand",
  process.platform === "win32" ? "translive.ico" : "translive-tray.png",
);
app.setAppUserModelId(RELEASE_METADATA.appId);
let mainWindow;
let accountController;
let accountState = "unknown";
let codexLaunch;
let activeMode = "meeting";
let controller;
let assistantController;
let assistantPreferences;
let meetingIndex;
let meetingSetupController;
let miniCaptionWindowController;
let quitting = false;
let recordsStore;
let summaryController;
let trayController;
let trayState = "ready";
let windowsAudioDefaultsController;
let globalAudioRoutingStarted = false;
let globalAudioStartupPromise;
let globalAudioState = { state: "unknown" };
let voiceConversionController;
let voiceMeeterRoutingController;
let voiceMeeterRoutingStartupPromise;
let voiceMeeterRoutingState = { state: "checking" };
let voiceProfileStore;
let voiceTrainingController;
let voiceTrainingRoot;
let voiceTrainingRuntime;
let voiceStorageReady;
let rendererControls;
let translationLifecycle;

function configurePermissions() {
  const currentSession = session.defaultSession;
  currentSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) =>
      allowsLocalAudioPermission({
        permission,
        origin: requestingOrigin,
        details,
      }),
  );
  currentSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        allowsLocalAudioPermission({
          permission,
          origin: webContents.getURL(),
          details,
        }),
      );
    },
  );
}

function stateForEvent(event) {
  if (event.aggregate) return event.aggregate;
  if (event.type === "blocked") return "blocked";
  if (event.type === "stopped" || event.action === "stopped") return "stopped";
  return trayState;
}

async function restoreMeetingDevices() {
  const result = await meetingSetupController.restore();
  if (result.reason) {
    publish({
      type: "meeting-setup",
      state: result.reason,
      message: "無法還原 Windows 通訊裝置，將在下次啟動時重試。",
    });
  }
  return result;
}

async function restoreTranslationAudioRouting() {
  let meeting;
  let mode;
  try {
    meeting = await restoreMeetingDevices();
  } catch {
    meeting = { reason: "restore-failed", restored: false };
  }
  try {
    mode = await windowsAudioDefaultsController.restore();
  } catch {
    mode = { reason: "restore-failed", restored: false };
  }
  const state =
    meeting.reason ?? mode.reason ?? (mode.restored ? "restored" : "prepared");
  globalAudioState = { state };
  publish({ type: "global-audio", state });
  return {
    meeting,
    mode,
    reason: meeting.reason ?? mode.reason,
    restored: Boolean(meeting.restored || mode.restored),
  };
}

async function requireVoiceMeeterRouting() {
  const status = await voiceMeeterRoutingStartupPromise?.catch(() => ({
    state: "unavailable",
  }));
  if (status?.state !== "active") {
    throw new Error("VOICEMEETER_ROUTING_NOT_READY");
  }
  return status;
}

async function applyTranslationAudioRouting(mode) {
  const status = await windowsAudioDefaultsController.applyMode(mode);
  globalAudioState = status;
  publish({ type: "global-audio", ...status });
  if (status.state !== "active") {
    throw new Error("WINDOWS_MODE_AUDIO_ROUTING_NOT_READY");
  }
  return status;
}

function sendRendererControl(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Renderer window is unavailable");
  }
  mainWindow.webContents.send("translive:event", event);
}

function requireMainRenderer(event) {
  if (event?.sender !== mainWindow?.webContents) {
    throw new Error("TRANSLIVE_UNAUTHORIZED_RENDERER");
  }
}

function localRvcRuntimeDirectory() {
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || !localAppData) return undefined;
  return join(localAppData, "TransLive", "rvc-runtime");
}

async function ensurePrivateVoiceStorage(directory) {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(app.getAppPath(), "scripts", "ensure-rvc-private-root.ps1"),
        "-Directory",
        directory,
      ],
      { timeout: 30_000, windowsHide: true },
    );
    return JSON.parse(String(stdout).trim())?.ready === true;
  } catch {
    return false;
  }
}

async function verifyRvcPython({ path }) {
  try {
    const { stdout } = await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(app.getAppPath(), "scripts", "verify-rvc-python.ps1"),
        "-PythonPath",
        path,
      ],
      { timeout: 30_000, windowsHide: true },
    );
    return JSON.parse(String(stdout).trim())?.verified === true;
  } catch {
    return false;
  }
}

async function configureVoiceTrainingRuntime(capability) {
  if (capability?.provider === "unavailable" || !voiceTrainingController) {
    voiceTrainingRuntime = undefined;
    return voiceTrainingController?.configureRuntime(undefined);
  }
  try {
    if (!(await voiceStorageReady)) {
      throw new Error("VOICE_STORAGE_UNAVAILABLE");
    }
    const runtimeRoot = localRvcRuntimeDirectory();
    if (!runtimeRoot) throw new Error("VOICE_TRAINING_RUNTIME_UNAVAILABLE");
    await assertPrivateLocalDirectory({ directory: runtimeRoot });
    const trustedRunnerPath = join(
      app.getAppPath(),
      "scripts",
      "rvc-training-runtime.py",
    );
    const validateRuntime = () =>
      loadRvcRuntimeManifest({
        runtimeRoot,
        trust: RVC_RUNTIME_TRUST,
        trustedRunnerPath,
      });
    const manifest = await validateRuntime();
    voiceTrainingRuntime = new VoiceTrainingRuntime({
      manifest,
      outputRoot: voiceTrainingRoot,
      runtimeRoot,
      trust: RVC_RUNTIME_TRUST,
      trustedRunnerPath,
      validateRuntime,
      verifyPython: verifyRvcPython,
    });
    return voiceTrainingController.configureRuntime(voiceTrainingRuntime);
  } catch {
    voiceTrainingRuntime = undefined;
    return voiceTrainingController.configureRuntime(undefined);
  }
}

function publish(event) {
  if (event.type === "account") accountState = event.state;
  trayState = stateForEvent(event);
  trayController?.update({
    appState: trayState,
    mode: activeMode,
    status: controller?.status(),
  });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("translive:event", event);
}

async function exportMarkdown({ fileName, markdown, title }) {
  const destination = await dialog.showSaveDialog(mainWindow, {
    defaultPath: fileName,
    filters: [{ name: "Markdown", extensions: ["md"] }],
    title,
  });
  if (destination.canceled || !destination.filePath) return { exported: false };
  await writeFile(destination.filePath, markdown, {
    encoding: "utf8",
    flag: "wx",
  });
  return { exported: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: windowIconPath,
    width: 1_060,
    height: 820,
    minWidth: 880,
    minHeight: 680,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(sourceDirectory, "preload.cjs"),
    },
  });
  trayController?.setWindow(mainWindow);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    if (quitting) return;
    if (!trayController?.shouldHideOnClose()) {
      event.preventDefault();
      miniCaptionWindowController?.dispose();
      app.quit();
      return;
    }
    event.preventDefault();
    void trayController.handleWindowClose().then((result) => {
      if (result.notice && Notification.isSupported()) {
        new Notification({
          title: "TransLive",
          body: "TransLive 已縮至系統匣，翻譯仍會繼續。",
        }).show();
      }
    });
  });
  mainWindow.loadFile(join(sourceDirectory, "index.html"));
}

function registerIpc() {
  ipcMain.handle("translive:account-status", async () => {
    const result = await accountController.status();
    accountState = result.state;
    return result;
  });
  ipcMain.handle("translive:account-login", async () => {
    const login = await accountController.startLogin();
    try {
      await shell.openExternal(login.authUrl);
      return { state: "waiting" };
    } catch (error) {
      await accountController.cancelLogin();
      throw error;
    }
  });
  ipcMain.handle("translive:account-logout", () =>
    translationLifecycle.logout(accountController),
  );
  ipcMain.handle("translive:account-login-cancel", () =>
    accountController.cancelLogin(),
  );
  ipcMain.handle("translive:audio-defaults-status", () => globalAudioState);
  ipcMain.handle(
    "translive:voicemeeter-routing-status",
    () => voiceMeeterRoutingState,
  );
  ipcMain.handle("translive:voice-conversion-status", (event) => {
    requireMainRenderer(event);
    return voiceConversionController.status();
  });
  ipcMain.handle(
    "translive:voice-conversion-set-enabled",
    async (event, request) => {
      requireMainRenderer(event);
      const status = await voiceConversionController.setEnabled({
        enabled: request?.enabled === true,
        profileId:
          typeof request?.profileId === "string"
            ? request.profileId
            : undefined,
      });
      publish({ type: "voice-conversion", status });
      return status;
    },
  );
  ipcMain.handle("translive:voice-profile-import", async (event, request) => {
    requireMainRenderer(event);
    if (request?.confirmedOwnAuthorizedVoice !== true) {
      throw new Error("VOICE_PROFILE_CONSENT_REQUIRED");
    }
    const selected = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: "RVC model", extensions: ["pth"] }],
      properties: ["openFile"],
      title: "選擇本人已訓練的 RVC 模型",
    });
    if (selected.canceled || !selected.filePaths[0]) {
      return { imported: false, status: voiceConversionController.status() };
    }
    const profile = await voiceConversionController.importProfile({
      confirmedOwnAuthorizedVoice: true,
      displayName: request?.displayName,
      modelSourcePath: selected.filePaths[0],
    });
    const status = voiceConversionController.status();
    publish({ type: "voice-conversion", status });
    return { imported: true, profile, status };
  });
  ipcMain.handle("translive:voice-profile-delete", async (event, request) => {
    requireMainRenderer(event);
    if (request?.confirmedDeleteProfile !== true) {
      throw new Error("VOICE_PROFILE_DELETE_CONFIRMATION_REQUIRED");
    }
    const status = await voiceConversionController.deleteProfile(request.id);
    publish({ type: "voice-conversion", status });
    return status;
  });
  ipcMain.handle("translive:voice-training-status", async (event) => {
    requireMainRenderer(event);
    return voiceTrainingController.status();
  });
  ipcMain.handle(
    "translive:voice-training-start-recording",
    async (event, request) => {
      requireMainRenderer(event);
      return voiceTrainingController.startRecording({
        confirmedOwnAuthorizedVoice:
          request?.confirmedOwnAuthorizedVoice === true,
        displayName: request?.displayName,
        microphoneLabel: request?.microphoneLabel,
      });
    },
  );
  ipcMain.handle(
    "translive:voice-training-pause-recording",
    async (event, id) => {
      requireMainRenderer(event);
      return voiceTrainingController.pauseRecording(id);
    },
  );
  ipcMain.handle(
    "translive:voice-training-resume-recording",
    async (event, id) => {
      requireMainRenderer(event);
      return voiceTrainingController.resumeRecording(id);
    },
  );
  ipcMain.handle(
    "translive:voice-training-stop-recording",
    async (event, request) => {
      requireMainRenderer(event);
      return voiceTrainingController.stopRecording(
        validateVoiceTrainingStopRequest(request),
      );
    },
  );
  ipcMain.handle("translive:voice-training-start", async (event, request) => {
    requireMainRenderer(event);
    await voiceTrainingController.startTraining({
      confirmedOwnAuthorizedVoice:
        request?.confirmedOwnAuthorizedVoice === true,
      consentVersion: request?.consentVersion,
      id: request?.id,
    });
    return voiceTrainingController.status();
  });
  ipcMain.handle("translive:voice-training-cancel", async (event) => {
    requireMainRenderer(event);
    return voiceTrainingController.cancel();
  });
  ipcMain.handle("translive:voice-training-delete", async (event, request) => {
    requireMainRenderer(event);
    if (request?.confirmedDeleteTraining !== true) {
      throw new Error("VOICE_TRAINING_DELETE_CONFIRMATION_REQUIRED");
    }
    return voiceTrainingController.delete(request.id);
  });
  ipcMain.handle("translive:mini-caption-show", (event, snapshot) => {
    if (event.sender !== mainWindow?.webContents) return { shown: false };
    return miniCaptionWindowController?.show(snapshot) ?? { shown: false };
  });
  ipcMain.on("translive:mini-caption-update", (event, snapshot) => {
    if (event.sender !== mainWindow?.webContents) return;
    miniCaptionWindowController?.update(snapshot);
  });
  ipcMain.on("translive:mini-caption-return", () =>
    miniCaptionWindowController?.hideAndFocusMain(),
  );
  ipcMain.handle("translive:preflight", async (_event, config) => {
    await requireVoiceMeeterRouting();
    activeMode = config.mode ?? "meeting";
    await applyTranslationAudioRouting(activeMode);
    const result = await controller.preflight(config);
    if (!result.ok) await restoreTranslationAudioRouting();
    return result;
  });
  ipcMain.handle("translive:start", async (_event, config) => {
    await requireVoiceMeeterRouting();
    activeMode = config.mode ?? "meeting";
    await applyTranslationAudioRouting(activeMode);
    const assistantPrefs = await assistantPreferences.load();
    let result;
    try {
      result = await controller.start({ ...assistantPrefs, ...config });
    } catch (error) {
      await restoreTranslationAudioRouting();
      throw error;
    }
    trayState = result.aggregate;
    trayController?.update({
      appState: trayState,
      mode: activeMode,
      status: result.status,
    });
    return result;
  });
  ipcMain.handle("translive:answer-applied", async (_event, direction) =>
    // SDP answers belong to whichever mode owns the live run; routing to
    // the wrong controller leaves the active one stuck at "connecting".
    assistantController?.isActive()
      ? assistantController.answerApplied(direction)
      : controller.answerApplied(direction),
  );
  ipcMain.handle("translive:stop", async () => {
    const result = await translationLifecycle.stop("user-stop", {
      rendererControl: false,
    });
    trayState = "stopped";
    trayController?.update({
      appState: trayState,
      mode: activeMode,
      status: result.status ?? controller.status(),
    });
    return result;
  });
  ipcMain.handle("translive:cancel-start", async () => {
    try {
      return await controller.cancelStart();
    } finally {
      await restoreTranslationAudioRouting();
    }
  });
  ipcMain.handle("translive:set-muted", (_event, direction, muted) =>
    controller.setMuted(direction, Boolean(muted)),
  );
  ipcMain.handle("translive:meeting-setup-apply", async (_event, setup) => {
    await applyTranslationAudioRouting("meeting");
    const result = await meetingSetupController.apply(
      sanitizeMeetingSetupRequest(setup),
    );
    publish({ type: "meeting-setup", state: result.state, app: result.app });
    return result;
  });
  ipcMain.handle("translive:meeting-setup-restore", async () => {
    const result = await restoreMeetingDevices();
    if (!result.reason) {
      publish({
        type: "meeting-setup",
        state: result.restored ? "restored" : "idle",
      });
    }
    return result;
  });
  ipcMain.handle("translive:meeting-setup-open-settings", (_event, appName) =>
    meetingSetupController.openManualSettings(appName),
  );
  ipcMain.handle("translive:diagnostics-export", async () => {
    const bundle = buildDiagnostics({
      accountState,
      appVersion: app.getVersion(),
      evidence: controller.diagnostics(),
      status: controller.status(),
    });
    const destination = await dialog.showSaveDialog(mainWindow, {
      defaultPath: "translive-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
      title: "匯出遮罩診斷包",
    });
    if (destination.canceled || !destination.filePath)
      return { exported: false };
    await writeFile(
      destination.filePath,
      `${JSON.stringify(bundle, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    return { exported: true };
  });
  ipcMain.handle("translive:records-consent-status", () =>
    recordsStore.consentStatus(),
  );
  ipcMain.handle("translive:records-retention-status", () =>
    recordsStore.retentionStatus(),
  );
  ipcMain.handle("translive:records-consent-grant", (_event, request) =>
    recordsStore.grantPlaintextConsent({
      confirmed: request?.confirmed === true,
    }),
  );
  ipcMain.handle("translive:records-list", () => recordsStore.listSessions());
  ipcMain.handle("translive:records-read", (_event, id) =>
    recordsStore.readSession(id),
  );
  ipcMain.handle("translive:records-delete", async (_event, id) => {
    await recordsStore.deleteSession(id);
    meetingIndex?.removeSession(id);
    return { deleted: true };
  });
  ipcMain.handle("translive:records-delete-all", async (_event, request) => {
    await recordsStore.deleteAllSessions({
      confirmation: request?.confirmation,
    });
    meetingIndex?.rebuild([]);
    return { deleted: true };
  });
  ipcMain.handle("translive:records-open-folder", async (_event, id) => {
    const result = await shell.openPath(recordsStore.sessionFolder(id));
    return { opened: result === "" };
  });
  ipcMain.handle("translive:records-export", async (_event, id) => {
    const exported = await recordsStore.exportSession(id);
    return exportMarkdown({ ...exported, title: "匯出逐字稿" });
  });
  ipcMain.handle("translive:aggregates-list", () =>
    recordsStore.listAggregates(),
  );
  ipcMain.handle("translive:aggregates-read", (_event, id) =>
    recordsStore.readAggregate(id),
  );
  ipcMain.handle("translive:aggregates-delete", async (_event, id) => {
    await recordsStore.deleteAggregate(id);
    return { deleted: true };
  });
  ipcMain.handle("translive:aggregates-export", async (_event, id) => {
    const exported = await recordsStore.exportAggregate(id);
    return exportMarkdown({ ...exported, title: "匯出跨場摘要" });
  });
  ipcMain.handle("translive:aggregates-open-folder", async (_event, id) => {
    const result = await shell.openPath(recordsStore.aggregateFolder(id));
    return { opened: result === "" };
  });
  ipcMain.handle("translive:summary-session-start", (_event, request) =>
    summaryController.startSessionSummary({
      confirmed: request?.confirmed === true,
      sessionId: request?.sessionId,
    }),
  );
  ipcMain.handle("translive:summary-aggregate-start", (_event, request) =>
    summaryController.startAggregateSummary({
      confirmed: request?.confirmed === true,
      sessionIds: request?.sessionIds,
    }),
  );
  ipcMain.handle("translive:summary-cancel", (_event, requestId) =>
    summaryController.cancel(requestId),
  );
  ipcMain.handle("translive:assistant-start", async (_event, config) => {
    // Assistant mode shares the meeting dual-channel device layout.
    await requireVoiceMeeterRouting();
    activeMode = "meeting";
    await applyTranslationAudioRouting("meeting");
    const preferences = await assistantPreferences.load();
    let result;
    try {
      result = await assistantController.start({ ...preferences, ...config });
    } catch (error) {
      await restoreTranslationAudioRouting();
      throw error;
    }
    trayState = result.aggregate;
    trayController?.update({
      appState: trayState,
      mode: activeMode,
      status: result.status,
    });
    return result;
  });
  ipcMain.handle("translive:assistant-stop", async () => {
    const result = await assistantController.stop();
    await restoreTranslationAudioRouting();
    trayState = "stopped";
    trayController?.update({ appState: trayState, mode: activeMode });
    return result;
  });
  ipcMain.handle("translive:assistant-pending", () =>
    assistantController.pendingAnswer(),
  );
  ipcMain.handle("translive:assistant-approve", (_event, id) =>
    assistantController.approveAnswer(id),
  );
  ipcMain.handle("translive:assistant-reject", (_event, id) =>
    assistantController.rejectAnswer(id),
  );
  ipcMain.handle("translive:assistant-speak-conclusions", () =>
    assistantController.speakConclusions(),
  );
  ipcMain.handle("translive:assistant-set-wake-armed", (_event, armed) =>
    assistantController.setWakeArmed(armed),
  );
  ipcMain.handle("translive:assistant-preferences-load", () =>
    assistantPreferences.load(),
  );
  ipcMain.handle("translive:assistant-preferences-save", (_event, request) =>
    assistantPreferences.save(request),
  );
  ipcMain.handle("translive:tray-status", () => trayController.status());
  ipcMain.handle("translive:tray-set-close-behavior", (_event, behavior) =>
    trayController.setCloseBehavior(behavior),
  );
  ipcMain.handle("translive:tray-show", () => {
    trayController.showWindow();
    return { shown: true };
  });
  ipcMain.on("translive:renderer-control-ack", (_event, acknowledgement) =>
    rendererControls?.acknowledge(acknowledgement ?? {}),
  );
  ipcMain.on("translive:metric", (_event, metric) =>
    assistantController?.isActive()
      ? assistantController.recordMetric(metric)
      : controller.recordMetric(metric),
  );
  ipcMain.on("translive:renderer-error", (_event, { direction, message }) =>
    controller.reportRendererError(direction, message),
  );
  ipcMain.on(
    "translive:renderer-blocked",
    (_event, { config, reason }) =>
      void controller.recordRendererBlockedAttempt(config, reason),
  );
}

// The primary Electron process owns the shared Windows and local-voice lifecycle.
if (isPrimaryInstance) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (trayController) trayController.showWindow();
    else mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    configurePermissions();
    codexLaunch = await resolveCodexLaunch({
      allowExternalPackaged:
        process.env.TRANSLIVE_ALLOW_EXTERNAL_PACKAGED_CODEX === "1",
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
    });
    accountController = new AccountController({
      codexExecutable: codexLaunch.executable,
      cwd: app.getAppPath(),
      publish,
    });
    recordsStore = new RecordsStore({
      directory: recordsDirectory({
        fallback: app.getPath("userData"),
        platform: process.platform,
      }),
    });
    meetingIndex = new MeetingIndex({
      databaseFile: join(recordsStore.directory(), "meeting-index.db"),
    });
    // Historical sessions (recorded before the assistant feature) become
    // searchable only after a rebuild from the store.
    rebuildMeetingIndexFromRecords(recordsStore, meetingIndex).catch(() => {});
    summaryController = new SummaryController({
      records: recordsStore,
      summaryService: new CodexSummaryService({
        codexExecutable: codexLaunch.executable,
        cwd: app.getAppPath(),
      }),
      publish,
      meetingIndex,
    });
    controller = new PhaseOneController({
      appVersion: app.getVersion(),
      codexExecutable: codexLaunch.executable,
      codexVersion: codexLaunch.version ?? process.env.TRANSLIVE_CODEX_VERSION,
      cwd: app.getAppPath(),
      evidenceDirectory:
        process.env.TRANSLIVE_EVIDENCE_DIR ||
        join(app.getPath("userData"), ".translive-evidence"),
      publish,
      records: recordsStore,
      meetingIndex,
      summaryService: new CodexSummaryService({
        codexExecutable: codexLaunch.executable,
        cwd: app.getAppPath(),
      }),
      answer: (prompt) =>
        new CodexTextTurn({
          codexExecutable: codexLaunch.executable,
          cwd: app.getAppPath(),
        }).run(prompt),
    });
    assistantPreferences = new AssistantPreferences({
      directory: app.getPath("userData"),
    });
    assistantController = new MeetingAssistantController({
      appVersion: app.getVersion(),
      answer: (prompt) =>
        new CodexTextTurn({
          codexExecutable: codexLaunch.executable,
          cwd: app.getAppPath(),
        }).run(prompt),
      codexExecutable: codexLaunch.executable,
      codexVersion: codexLaunch.version ?? process.env.TRANSLIVE_CODEX_VERSION,
      cwd: app.getAppPath(),
      evidenceDirectory:
        process.env.TRANSLIVE_EVIDENCE_DIR ||
        join(app.getPath("userData"), ".translive-evidence"),
      meetingIndex,
      publish,
      records: recordsStore,
      summaryService: new CodexSummaryService({
        codexExecutable: codexLaunch.executable,
        cwd: app.getAppPath(),
      }),
    });
    const windowsAudioAdapter = new WindowsMeetingDeviceAdapter({
      openExternal: (url) => shell.openExternal(url),
      scriptPath: join(
        app.getAppPath(),
        "scripts",
        "windows-meeting-devices.ps1",
      ),
    });
    meetingSetupController = new MeetingSetupController({
      adapter: windowsAudioAdapter,
      store: new MeetingSetupStore({ directory: app.getPath("userData") }),
    });
    // Restore a legacy quick-setup snapshot before the global snapshot takes over.
    const startupRestore = await meetingSetupController.restorePending();
    windowsAudioDefaultsController = new WindowsAudioDefaultsController({
      adapter: windowsAudioAdapter,
      store: new WindowsAudioDefaultsStore({
        directory: app.getPath("userData"),
      }),
    });
    globalAudioRoutingStarted = !startupRestore.reason;
    globalAudioStartupPromise = globalAudioRoutingStarted
      ? windowsAudioDefaultsController.prepare()
      : Promise.resolve({ state: "legacy-recovery-needed" });
    const globalAudioStartup = await globalAudioStartupPromise;
    globalAudioState = globalAudioStartup;
    voiceMeeterRoutingController = new VoiceMeeterRoutingController({
      adapter: new VoiceMeeterRoutingAdapter({
        scriptPath: join(
          app.getAppPath(),
          "scripts",
          "windows-voicemeeter-routing.ps1",
        ),
      }),
      store: createVoiceMeeterRoutingStore({
        directory: app.getPath("userData"),
      }),
    });
    voiceMeeterRoutingStartupPromise = voiceMeeterRoutingController
      .start()
      .then((status) => {
        voiceMeeterRoutingState = status;
        return status;
      })
      .catch(() => {
        voiceMeeterRoutingState = { state: "unavailable" };
        return voiceMeeterRoutingState;
      });
    const voiceUserDataRoot = app.getPath("userData");
    const voiceProfileRoot = join(voiceUserDataRoot, "voice-profiles");
    voiceTrainingRoot = join(voiceUserDataRoot, "voice-training");
    const runtimeStorageRoot = localRvcRuntimeDirectory();
    voiceStorageReady = Promise.all([
      ensurePrivateVoiceStorage(voiceProfileRoot),
      ensurePrivateVoiceStorage(voiceTrainingRoot),
      runtimeStorageRoot
        ? ensurePrivateVoiceStorage(runtimeStorageRoot)
        : Promise.resolve(false),
    ]).then((results) => results.every(Boolean));
    const ensureVoiceStorage = async () => {
      if (!(await voiceStorageReady)) {
        throw new Error("VOICE_STORAGE_UNAVAILABLE");
      }
    };
    voiceProfileStore = new VoiceProfileStore({
      directory: voiceProfileRoot,
      ensureStorage: ensureVoiceStorage,
      trainingDirectory: voiceTrainingRoot,
      verifyTrainingOutput: (request) => {
        if (!voiceTrainingRuntime) {
          throw new Error("VOICE_TRAINING_RUNTIME_UNAVAILABLE");
        }
        return voiceTrainingRuntime.verifyOutput(request);
      },
    });
    voiceTrainingController = new VoiceTrainingSessionController({
      onProfileVerified: async () => {
        const status = await voiceConversionController.initialize();
        publish({ type: "voice-conversion", status });
      },
      profiles: voiceProfileStore,
      publish,
      store: new VoiceTrainingStore({
        directory: voiceTrainingRoot,
        ensureStorage: ensureVoiceStorage,
      }),
    });
    void voiceProfileStore.recover().catch(() => {});
    void voiceTrainingController.recover().catch(() => {
      publish({ type: "voice-training", status: { state: "failed" } });
    });
    voiceConversionController = new VoiceConversionController({
      capabilityProbe: new VoiceConversionCapabilityProbe({
        platform: process.platform,
        scriptPath: join(
          app.getAppPath(),
          "scripts",
          "probe-rvc-capability.ps1",
        ),
      }),
      profiles: voiceProfileStore,
    });
    miniCaptionWindowController = new MiniCaptionWindowController({
      createWindow: (options) =>
        new BrowserWindow({
          ...options,
          icon: windowIconPath,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: join(sourceDirectory, "mini-caption-preload.cjs"),
          },
        }),
      getMainWindow: () => mainWindow,
      getWorkArea: () => screen.getPrimaryDisplay().workArea,
      pagePath: join(sourceDirectory, "mini-caption.html"),
    });
    createWindow();
    rendererControls = new RendererControlBridge({ send: sendRendererControl });
    translationLifecycle = new TranslationLifecycle({
      controller,
      disposeSummaries: () => summaryController.dispose(),
      rendererControls,
      restoreMeetingDevices: restoreTranslationAudioRouting,
      publish,
    });
    trayController = new TrayController({
      app,
      controller: {
        status: () => controller.status(),
        setMuted: (direction, muted) =>
          translationLifecycle.setMuted(direction, muted),
        stop: () => translationLifecycle.stop("tray-stop"),
      },
      iconPath: join(
        sourceDirectory,
        "../assets/translive-brand/translive-tray.png",
      ),
      Menu,
      nativeImage,
      preferences: new TrayPreferences({ directory: app.getPath("userData") }),
      publish,
      Tray,
      window: mainWindow,
    });
    await trayController.initialize({
      appState: trayState,
      mode: activeMode,
      status: controller.status(),
    });
    registerIpc();
    publish({ type: "global-audio", state: globalAudioStartup.state });
    publish({
      type: "voicemeeter-routing",
      state: voiceMeeterRoutingState.state,
    });
    void voiceMeeterRoutingStartupPromise.then((status) =>
      publish({ type: "voicemeeter-routing", state: status.state }),
    );
    // Optional RVC discovery/training setup must never delay raw GPT audio.
    void voiceStorageReady
      .then((ready) => {
        if (!ready) throw new Error("VOICE_STORAGE_UNAVAILABLE");
        return voiceConversionController.initialize();
      })
      .then(async (status) => {
        publish({ type: "voice-conversion", status });
        const trainingStatus = await configureVoiceTrainingRuntime(status);
        publish({ type: "voice-training", status: trainingStatus });
      })
      .catch(async () => {
        voiceTrainingRuntime = undefined;
        const trainingStatus =
          await voiceTrainingController.configureRuntime(undefined);
        publish({
          type: "voice-conversion",
          status: {
            enabled: false,
            profiles: [],
            provider: "unavailable",
            reason: "initialization-failed",
            state: "unavailable",
          },
        });
        publish({ type: "voice-training", status: trainingStatus });
      });
    if (startupRestore.reason) {
      publish({
        type: "meeting-setup",
        state: startupRestore.reason,
        message: "無法還原前次 Windows 通訊裝置，請在設定中手動確認。",
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      trayController?.showWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!trayController?.shouldHideOnClose()) app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitting || !controller) return;
    quitting = true;
    event.preventDefault();
    Promise.allSettled([
      translationLifecycle?.stop("app-quit", {
        rendererControl: false,
        restoreDevices: false,
      }),
      accountController?.dispose(),
      assistantController?.dispose(),
      summaryController?.dispose(),
      trayController?.dispose(),
      voiceConversionController?.dispose(),
      voiceTrainingController?.dispose(),
    ])
      .then(async () => {
        await voiceMeeterRoutingStartupPromise?.catch(() => {});
        const voiceMeeterRestore =
          await voiceMeeterRoutingController?.restore();
        if (voiceMeeterRestore?.reason) {
          voiceMeeterRoutingState = { state: voiceMeeterRestore.reason };
        }
        await globalAudioStartupPromise?.catch(() => {});
        if (!globalAudioRoutingStarted) return undefined;
        return restoreTranslationAudioRouting();
      })
      .finally(() => {
        miniCaptionWindowController?.dispose();
        rendererControls?.dispose();
        app.quit();
      });
  });
} else {
  app.quit();
}
