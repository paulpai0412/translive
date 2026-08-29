import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountController } from "./account-controller.js";
import { PhaseOneController } from "./phase-one-controller.js";
import { allowsLocalAudioPermission } from "./permissions.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow;
let accountController;
let controller;
let quitting = false;

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

function publish(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("translive:event", event);
}

function createWindow() {
  mainWindow = new BrowserWindow({
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
  mainWindow.once("ready-to-show", () => mainWindow.show());
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
  ipcMain.handle("translive:start", async (_event, config) =>
    controller.start(config),
  );
  ipcMain.handle("translive:answer-applied", async (_event, direction) =>
    controller.answerApplied(direction),
  );
  ipcMain.handle("translive:stop", async () => controller.stop());
  ipcMain.handle("translive:cancel-start", async () => controller.cancelStart());
  ipcMain.handle("translive:set-muted", (_event, direction, muted) =>
    controller.setMuted(direction, Boolean(muted)),
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

app.whenReady().then(() => {
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
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting || !controller) return;
  quitting = true;
  event.preventDefault();
  Promise.allSettled([controller.dispose(), accountController.dispose()]).finally(
    () => app.quit(),
  );
});
