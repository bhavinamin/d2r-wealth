import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import { app, BrowserWindow, Tray, shell, ipcMain, dialog, nativeImage, Notification } from "electron";
import { readGatewaySettings, writeGatewaySettings } from "./settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray = null;
let settingsWindow = null;
let menuWindow = null;
let gatewayProcess = null;
let eventRequest = null;
let isQuitting = false;
let connectedViewers = 0;

const trayEntryArg = path.join(__dirname, "tray.mjs");
const gatewayServerEntry = path.join(__dirname, "server.mjs");
const trayIconPaths = {
  connected: path.join(__dirname, "assets", "tray-icon-connected.png"),
  disconnected: path.join(__dirname, "assets", "tray-icon-disconnected.png"),
};
const settingsHtml = path.join(__dirname, "settings.html");
const preloadScript = path.join(__dirname, "preload.cjs");
const menuHtml = path.join(__dirname, "menu.html");
const menuPreloadScript = path.join(__dirname, "menu-preload.cjs");

const trayImage = (connected) => nativeImage.createFromPath(connected ? trayIconPaths.connected : trayIconPaths.disconnected).resize({ width: 16, height: 16 });
const currentSettings = () => readGatewaySettings();
const gatewayEndpoint = () => {
  const settings = currentSettings();
  return `http://${settings.host}:${settings.port}`;
};
const dashboardLaunchUrl = () => {
  const settings = currentSettings();
  const url = new URL(settings.dashboardUrl);
  if (settings.backendUrl) {
    url.searchParams.set("backend", settings.backendUrl);
  }
  return url.toString();
};
const backendPortalUrl = () => `${currentSettings().backendUrl.replace(/\/+$/, "")}/portal`;

const notify = (title, body, connected = connectedViewers > 0) => {
  if (!Notification.isSupported()) {
    return;
  }
  new Notification({ title, body, icon: connected ? trayIconPaths.connected : trayIconPaths.disconnected }).show();
};

const applyAutoStart = (enabled) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args: app.isPackaged ? [] : [trayEntryArg],
  });
};

const readAutoStart = () => app.getLoginItemSettings().openAtLogin;

const updateTrayIcon = () => {
  tray?.setImage(trayImage(connectedViewers > 0));
};

const fetchGatewayStatus = async () => {
  const response = await fetch(`${gatewayEndpoint()}/health`);
  if (!response.ok) {
    throw new Error(`Gateway health failed with ${response.status}`);
  }
  return response.json();
};

const broadcastStatus = async () => {
  const settings = currentSettings();
  let status = {
    ...settings,
    autoStart: readAutoStart(),
    running: false,
    files: [],
    lastBackendSyncAt: null,
    lastBackendSyncError: null,
  };

  try {
    const live = await fetchGatewayStatus();
    status = { ...live, autoStart: readAutoStart() };
  } catch {
    status.autoStart = readAutoStart();
  }

  updateTrayIcon();
  tray?.setToolTip(`D2 Wealth Gateway\n${settings.host}:${settings.port}`);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("gateway:status-updated", status);
  }
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.webContents.send("tray-menu:status-updated", status);
  }
};

const stopGatewayEvents = () => {
  eventRequest?.destroy();
  eventRequest = null;
};

const startGatewayEvents = () => {
  stopGatewayEvents();
  const url = new URL(`${gatewayEndpoint()}/events`);
  const request = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "X-D2-Gateway-Client": "tray",
      },
    },
    (response) => {
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        buffer += chunk;
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const eventMatch = part.match(/^event:\s*(.+)$/m);
          const dataMatch = part.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) {
            continue;
          }

          const eventName = eventMatch[1].trim();
          const data = JSON.parse(dataMatch[1]);
          if (eventName === "viewer-connected") {
            connectedViewers += 1;
            updateTrayIcon();
            notify("D2 Wealth Gateway", `Dashboard connected from ${data.remoteAddress}`, true);
          } else if (eventName === "viewer-disconnected") {
            connectedViewers = Math.max(0, connectedViewers - 1);
            updateTrayIcon();
            notify("D2 Wealth Gateway", `Dashboard disconnected from ${data.remoteAddress}`, false);
          } else if (eventName === "settings-changed" || eventName === "backend-sync" || eventName === "files-changed" || eventName === "ready") {
            void broadcastStatus();
          }
        }
      });
      response.on("close", () => {
        connectedViewers = 0;
        updateTrayIcon();
        setTimeout(startGatewayEvents, 3000);
      });
    },
  );

  request.on("error", () => {
    connectedViewers = 0;
    updateTrayIcon();
    setTimeout(startGatewayEvents, 3000);
  });
  request.end();
  eventRequest = request;
};

const startGatewayProcess = () => {
  if (gatewayProcess) {
    return;
  }

  gatewayProcess = spawn(process.execPath, [gatewayServerEntry], {
    cwd: app.isPackaged ? process.resourcesPath : process.cwd(),
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      D2_GATEWAY_SETTINGS_PATH: path.join(app.getPath("userData"), "settings.json"),
    },
  });

  gatewayProcess.on("exit", () => {
    gatewayProcess = null;
    connectedViewers = 0;
    updateTrayIcon();
    if (!isQuitting) {
      setTimeout(() => {
        startGatewayProcess();
      }, 3000);
    }
  });
};

const stopGatewayProcess = async () => {
  stopGatewayEvents();
  if (!gatewayProcess) {
    return;
  }

  const processToStop = gatewayProcess;
  gatewayProcess = null;
  await new Promise((resolve) => {
    processToStop.once("exit", resolve);
    processToStop.kill();
  });
};

const restartGatewayProcess = async () => {
  await stopGatewayProcess();
  startGatewayProcess();
  setTimeout(() => {
    startGatewayEvents();
    void broadcastStatus();
  }, 1500);
};

const showSettingsWindow = async () => {
  if (!settingsWindow) {
    settingsWindow = new BrowserWindow({
      width: 560,
      height: 720,
      title: "D2 Wealth Gateway",
      resizable: false,
      autoHideMenuBar: true,
      backgroundColor: "#14100d",
      webPreferences: {
        preload: preloadScript,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    settingsWindow.on("closed", () => {
      settingsWindow = null;
    });
  }

  await settingsWindow.loadFile(settingsHtml);
  await broadcastStatus();
  settingsWindow.show();
  settingsWindow.focus();
};

const ensureMenuWindow = () => {
  if (menuWindow && !menuWindow.isDestroyed()) {
    return menuWindow;
  }

  menuWindow = new BrowserWindow({
    width: 220,
    height: 178,
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    movable: false,
    focusable: true,
    autoHideMenuBar: true,
    backgroundColor: "#120d0a",
    webPreferences: {
      preload: menuPreloadScript,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  menuWindow.on("blur", () => {
    menuWindow?.hide();
  });
  menuWindow.on("closed", () => {
    menuWindow = null;
  });

  void menuWindow.loadFile(menuHtml);
  return menuWindow;
};

const showMenuWindow = async () => {
  if (!tray) {
    return;
  }

  const window = ensureMenuWindow();
  const bounds = tray.getBounds();
  window.setPosition(Math.max(0, Math.round(bounds.x - 170)), Math.max(0, Math.round(bounds.y - 180)), false);
  await broadcastStatus();
  window.show();
  window.focus();
};

const bootstrap = async () => {
  const settings = currentSettings();
  applyAutoStart(settings.autoStart);
  tray = new Tray(trayImage(false));
  tray.on("double-click", () => void showSettingsWindow());
  tray.on("right-click", () => void showMenuWindow());
  tray.on("click", () => void showMenuWindow());
  startGatewayProcess();
  setTimeout(() => {
    startGatewayEvents();
    void broadcastStatus();
  }, 1500);
  notify("D2 Wealth Gateway", "Gateway is running in the Windows system tray.", false);
};

app.whenReady().then(async () => {
  app.setAppUserModelId("d2-wealth.gateway");
  await bootstrap();

  ipcMain.handle("gateway:status", async () => {
    await broadcastStatus();
    return {
      ...(await fetchGatewayStatus().catch(() => ({ ...currentSettings(), running: false, files: [] }))),
      autoStart: readAutoStart(),
    };
  });
  ipcMain.handle("gateway:browse-save-dir", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  });
  ipcMain.handle("gateway:save-settings", async (_event, nextSettings) => {
    const saved = writeGatewaySettings({ ...currentSettings(), ...nextSettings });
    applyAutoStart(saved.autoStart);
    await restartGatewayProcess();
    return {
      ...(await fetchGatewayStatus().catch(() => ({ ...saved, running: false, files: [] }))),
      autoStart: readAutoStart(),
    };
  });
  ipcMain.handle("gateway:open-dashboard", async () => {
    await shell.openExternal(dashboardLaunchUrl());
  });
  ipcMain.handle("gateway:open-backend-portal", async () => {
    await shell.openExternal(backendPortalUrl());
  });
  ipcMain.handle("tray-menu:status", async () => {
    await broadcastStatus();
    return {
      ...(await fetchGatewayStatus().catch(() => ({ ...currentSettings(), running: false, files: [] }))),
      autoStart: readAutoStart(),
    };
  });
  ipcMain.handle("tray-menu:open-settings", async () => {
    menuWindow?.hide();
    await showSettingsWindow();
  });
  ipcMain.handle("tray-menu:open-dashboard", async () => {
    menuWindow?.hide();
    await shell.openExternal(dashboardLaunchUrl());
  });
  ipcMain.handle("tray-menu:quit", async () => {
    isQuitting = true;
    menuWindow?.hide();
    await stopGatewayProcess();
    app.quit();
  });
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", async (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  isQuitting = true;
  await stopGatewayProcess();
  app.exit(0);
});
