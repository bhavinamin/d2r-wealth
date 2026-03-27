const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trayMenu", {
  openSettings: () => ipcRenderer.invoke("tray-menu:open-settings"),
  quit: () => ipcRenderer.invoke("tray-menu:quit"),
  loadStatus: () => ipcRenderer.invoke("tray-menu:status"),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("tray-menu:status-updated", listener);
    return () => ipcRenderer.removeListener("tray-menu:status-updated", listener);
  },
});
