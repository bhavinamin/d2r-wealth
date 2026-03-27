const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gatewayTray", {
  loadStatus: () => ipcRenderer.invoke("gateway:status"),
  saveSettings: (settings) => ipcRenderer.invoke("gateway:save-settings", settings),
  browseSaveDir: () => ipcRenderer.invoke("gateway:browse-save-dir"),
  pairGateway: () => ipcRenderer.invoke("gateway:pair"),
  disconnectGateway: () => ipcRenderer.invoke("gateway:disconnect"),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("gateway:status-updated", listener);
    return () => ipcRenderer.removeListener("gateway:status-updated", listener);
  },
});
