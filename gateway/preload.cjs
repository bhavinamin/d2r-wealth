const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gatewayTray", {
  loadStatus: () => ipcRenderer.invoke("gateway:status"),
  saveSettings: (settings) => ipcRenderer.invoke("gateway:save-settings", settings),
  browseSaveDir: () => ipcRenderer.invoke("gateway:browse-save-dir"),
  openDashboard: () => ipcRenderer.invoke("gateway:open-dashboard"),
  openBackendPortal: () => ipcRenderer.invoke("gateway:open-backend-portal"),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("gateway:status-updated", listener);
    return () => ipcRenderer.removeListener("gateway:status-updated", listener);
  },
});
