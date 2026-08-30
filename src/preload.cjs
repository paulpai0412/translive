const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("translive", {
  accountStatus: () => ipcRenderer.invoke("translive:account-status"),
  accountLogin: () => ipcRenderer.invoke("translive:account-login"),
  accountLogout: () => ipcRenderer.invoke("translive:account-logout"),
  accountLoginCancel: () =>
    ipcRenderer.invoke("translive:account-login-cancel"),
  preflight: (config) => ipcRenderer.invoke("translive:preflight", config),
  start: (config) => ipcRenderer.invoke("translive:start", config),
  answerApplied: (direction) =>
    ipcRenderer.invoke("translive:answer-applied", direction),
  stop: () => ipcRenderer.invoke("translive:stop"),
  cancelStart: () => ipcRenderer.invoke("translive:cancel-start"),
  setMuted: (direction, muted) =>
    ipcRenderer.invoke("translive:set-muted", direction, muted),
  meetingSetupApply: (setup) =>
    ipcRenderer.invoke("translive:meeting-setup-apply", setup),
  meetingSetupRestore: () =>
    ipcRenderer.invoke("translive:meeting-setup-restore"),
  meetingSetupOpenSettings: (appName) =>
    ipcRenderer.invoke("translive:meeting-setup-open-settings", appName),
  diagnosticsExport: () =>
    ipcRenderer.invoke("translive:diagnostics-export"),
  recordsConsentStatus: () =>
    ipcRenderer.invoke("translive:records-consent-status"),
  recordsRetentionStatus: () =>
    ipcRenderer.invoke("translive:records-retention-status"),
  recordsConsentGrant: (request) =>
    ipcRenderer.invoke("translive:records-consent-grant", request),
  recordsList: () => ipcRenderer.invoke("translive:records-list"),
  recordsRead: (id) => ipcRenderer.invoke("translive:records-read", id),
  recordsDelete: (id) => ipcRenderer.invoke("translive:records-delete", id),
  recordsDeleteAll: (request) =>
    ipcRenderer.invoke("translive:records-delete-all", request),
  recordsOpenFolder: (id) =>
    ipcRenderer.invoke("translive:records-open-folder", id),
  recordsExport: (id) => ipcRenderer.invoke("translive:records-export", id),
  aggregatesList: () => ipcRenderer.invoke("translive:aggregates-list"),
  aggregatesRead: (id) => ipcRenderer.invoke("translive:aggregates-read", id),
  aggregatesDelete: (id) =>
    ipcRenderer.invoke("translive:aggregates-delete", id),
  aggregatesExport: (id) =>
    ipcRenderer.invoke("translive:aggregates-export", id),
  aggregatesOpenFolder: (id) =>
    ipcRenderer.invoke("translive:aggregates-open-folder", id),
  summarySessionStart: (request) =>
    ipcRenderer.invoke("translive:summary-session-start", request),
  summaryAggregateStart: (request) =>
    ipcRenderer.invoke("translive:summary-aggregate-start", request),
  summaryCancel: (requestId) =>
    ipcRenderer.invoke("translive:summary-cancel", requestId),
  trayStatus: () => ipcRenderer.invoke("translive:tray-status"),
  traySetCloseBehavior: (behavior) =>
    ipcRenderer.invoke("translive:tray-set-close-behavior", behavior),
  trayShow: () => ipcRenderer.invoke("translive:tray-show"),
  recordMetric: (metric) => ipcRenderer.send("translive:metric", metric),
  rendererError: (direction, message) =>
    ipcRenderer.send("translive:renderer-error", { direction, message }),
  rendererBlocked: (config, reason) =>
    ipcRenderer.send("translive:renderer-blocked", { config, reason }),
  rendererControlAck: (acknowledgement) =>
    ipcRenderer.send("translive:renderer-control-ack", acknowledgement),
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("translive:event", handler);
    return () => ipcRenderer.removeListener("translive:event", handler);
  },
});
