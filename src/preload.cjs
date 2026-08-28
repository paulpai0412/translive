const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("translive", {
  preflight: (config) => ipcRenderer.invoke("translive:preflight", config),
  start: (config) => ipcRenderer.invoke("translive:start", config),
  answerApplied: (direction) =>
    ipcRenderer.invoke("translive:answer-applied", direction),
  stop: () => ipcRenderer.invoke("translive:stop"),
  setMuted: (direction, muted) =>
    ipcRenderer.invoke("translive:set-muted", direction, muted),
  recordMetric: (metric) => ipcRenderer.send("translive:metric", metric),
  rendererError: (direction, message) =>
    ipcRenderer.send("translive:renderer-error", { direction, message }),
  rendererBlocked: (config, reason) =>
    ipcRenderer.send("translive:renderer-blocked", { config, reason }),
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("translive:event", handler);
    return () => ipcRenderer.removeListener("translive:event", handler);
  },
});
