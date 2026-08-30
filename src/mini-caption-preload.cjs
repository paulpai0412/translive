const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("transliveMini", {
  returnToMain: () => ipcRenderer.send("translive:mini-caption-return"),
  onCaption: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot ?? {});
    ipcRenderer.on("translive:mini-caption", handler);
    return () => ipcRenderer.removeListener("translive:mini-caption", handler);
  },
});
