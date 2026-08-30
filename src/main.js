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
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountController } from "./account-controller.js";
import { resolveCodexLaunch } from "./codex-launch.js";
import { buildDiagnostics } from "./diagnostics-service.js";
import { MeetingSetupController } from "./meeting-setup-controller.js";
import { sanitizeMeetingSetupRequest } from "./meeting-setup-request.js";
import { MeetingSetupStore } from "./meeting-setup-store.js";
import { MiniCaptionWindowController } from "./mini-caption-window.js";
import { PhaseOneController } from "./phase-one-controller.js";
import { allowsLocalAudioPermission } from "./permissions.js";
import { recordsDirectory } from "./records-path.js";
import { RecordsStore } from "./records-store.js";
import { RendererControlBridge } from "./renderer-control-bridge.js";
import { RELEASE_METADATA } from "./release-config.js";
import { CodexSummaryService } from "./summary-service.js";
import { SummaryController } from "./summary-controller.js";
import { TranslationLifecycle } from "./translation-lifecycle.js";
import { TrayController } from "./tray-controller.js";
import { TrayPreferences } from "./tray-preferences.js";
import { WindowsAudioDefaultsController } from "./windows-audio-defaults-controller.js";
import { WindowsAudioDefaultsStore } from "./windows-audio-defaults-store.js";
import { WindowsMeetingDeviceAdapter } from "./windows-meeting-device-adapter.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
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

function sendRendererControl(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Renderer window is unavailable");
  }
  mainWindow.webContents.send("translive:event", event);
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
  ipcMain.handle("translive:preflight", (_event, config) =>
    controller.preflight(config),
  );
  ipcMain.handle("translive:start", async (_event, config) => {
    activeMode = config.mode ?? "meeting";
    const result = await controller.start(config);
    trayState = result.aggregate;
    trayController?.update({
      appState: trayState,
      mode: activeMode,
      status: result.status,
    });
    return result;
  });
  ipcMain.handle("translive:answer-applied", async (_event, direction) =>
    controller.answerApplied(direction),
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
  ipcMain.handle("translive:cancel-start", async () =>
    controller.cancelStart(),
  );
  ipcMain.handle("translive:set-muted", (_event, direction, muted) =>
    controller.setMuted(direction, Boolean(muted)),
  );
  ipcMain.handle("translive:meeting-setup-apply", async (_event, setup) => {
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
    return { deleted: true };
  });
  ipcMain.handle("translive:records-delete-all", async (_event, request) => {
    await recordsStore.deleteAllSessions({
      confirmation: request?.confirmation,
    });
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
    controller.recordMetric(metric),
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

if (!isPrimaryInstance) {
  app.quit();
} else {
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
    summaryController = new SummaryController({
      records: recordsStore,
      summaryService: new CodexSummaryService({
        codexExecutable: codexLaunch.executable,
        cwd: app.getAppPath(),
      }),
      publish,
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
      ? windowsAudioDefaultsController.start()
      : Promise.resolve({ state: "legacy-recovery-needed" });
    const globalAudioStartup = await globalAudioStartupPromise;
    globalAudioState = globalAudioStartup;
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
      restoreMeetingDevices,
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
      translationLifecycle?.stop("app-quit", { rendererControl: false }),
      accountController?.dispose(),
      summaryController?.dispose(),
      trayController?.dispose(),
    ])
      .then(async () => {
        await globalAudioStartupPromise?.catch(() => {});
        if (!globalAudioRoutingStarted) return undefined;
        return windowsAudioDefaultsController?.restore();
      })
      .then((result) => {
        if (result?.reason) {
          globalAudioState = { state: result.reason };
          publish({ type: "global-audio", state: result.reason });
        }
      })
      .finally(() => {
        miniCaptionWindowController?.dispose();
        rendererControls?.dispose();
        app.quit();
      });
  });
}
