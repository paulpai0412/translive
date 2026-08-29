import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
} from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountController } from "./account-controller.js";
import { MeetingSetupController } from "./meeting-setup-controller.js";
import { sanitizeMeetingSetupRequest } from "./meeting-setup-request.js";
import { MeetingSetupStore } from "./meeting-setup-store.js";
import { PhaseOneController } from "./phase-one-controller.js";
import { allowsLocalAudioPermission } from "./permissions.js";
import { TrayController } from "./tray-controller.js";
import { TrayPreferences } from "./tray-preferences.js";
import { WindowsMeetingDeviceAdapter } from "./windows-meeting-device-adapter.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow;
let accountController;
let activeMode = "meeting";
let controller;
let meetingSetupController;
let quitting = false;
let trayController;
let trayState = "ready";

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

function publish(event) {
  trayState = stateForEvent(event);
  trayController?.update({
    appState: trayState,
    mode: activeMode,
    status: controller?.status(),
  });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("translive:event", event);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: join(sourceDirectory, "../assets/translive-brand/translive-tray.png"),
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
    if (quitting || !trayController?.shouldHideOnClose()) return;
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
  ipcMain.handle("translive:account-status", () => accountController.status());
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
  ipcMain.handle("translive:account-logout", () => accountController.logout());
  ipcMain.handle("translive:account-login-cancel", () =>
    accountController.cancelLogin(),
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
    const result = await controller.stop();
    const meetingRestore = await restoreMeetingDevices();
    trayState = "stopped";
    trayController?.update({
      appState: trayState,
      mode: activeMode,
      status: result.status,
    });
    return { ...result, meetingRestore };
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
  ipcMain.handle("translive:tray-status", () => trayController.status());
  ipcMain.handle("translive:tray-set-close-behavior", (_event, behavior) =>
    trayController.setCloseBehavior(behavior),
  );
  ipcMain.handle("translive:tray-show", () => {
    trayController.showWindow();
    return { shown: true };
  });
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

app.whenReady().then(async () => {
  configurePermissions();
  accountController = new AccountController({
    cwd: app.getAppPath(),
    publish,
  });
  controller = new PhaseOneController({
    appVersion: app.getVersion(),
    cwd: app.getAppPath(),
    evidenceDirectory:
      process.env.TRANSLIVE_EVIDENCE_DIR ||
      join(app.getPath("userData"), ".translive-evidence"),
    publish,
  });
  meetingSetupController = new MeetingSetupController({
    adapter: new WindowsMeetingDeviceAdapter({
      openExternal: (url) => shell.openExternal(url),
      scriptPath: join(
        app.getAppPath(),
        "scripts",
        "windows-meeting-devices.ps1",
      ),
    }),
    store: new MeetingSetupStore({ directory: app.getPath("userData") }),
  });
  const startupRestore = await meetingSetupController.restorePending();
  createWindow();
  trayController = new TrayController({
    app,
    controller: {
      status: () => controller.status(),
      setMuted: (direction, muted) => controller.setMuted(direction, muted),
      stop: async () => {
        const result = await controller.stop("tray-stop");
        const meetingRestore = await restoreMeetingDevices();
        return { ...result, meetingRestore };
      },
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
    controller.dispose(),
    accountController.dispose(),
    restoreMeetingDevices(),
    trayController.dispose(),
  ]).finally(() => app.quit());
});
