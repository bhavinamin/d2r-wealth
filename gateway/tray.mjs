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
let backendConnected = false;
let previousBackendConnected = null;
let pairingPromise = null;

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
const settingsFilePath = () => path.join(app.getPath("userData"), "settings.json");
const protocolName = "d2wealth";

const trayImage = (connected) => nativeImage.createFromPath(connected ? trayIconPaths.connected : trayIconPaths.disconnected).resize({ width: 16, height: 16 });
const currentSettings = () => readGatewaySettings(settingsFilePath());
const gatewayEndpoint = () => {
  const settings = currentSettings();
  return `http://${settings.host}:${settings.port}`;
};
const notify = (title, body, connected = backendConnected) => {
  if (!Notification.isSupported()) {
    return;
  }
  new Notification({ title, body, icon: connected ? trayIconPaths.connected : trayIconPaths.disconnected }).show();
};

const pairingReadinessStatus = async ({ timeoutMs = 12000, intervalMs = 1000 } = {}) =>
  waitForGatewayStatus((status) => Boolean(status.saveValidation?.checkedAt), { timeoutMs, intervalMs });

const applyAutoStart = (enabled) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args: app.isPackaged ? [] : [trayEntryArg],
  });
};

const readAutoStart = () => app.getLoginItemSettings().openAtLogin;

const updateTrayIcon = () => {
  tray?.setImage(trayImage(backendConnected));
};

const postJson = async (url, body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const disconnectGatewaySync = async (settings, tokenOverride = settings.syncToken) => {
  const backendUrl = String(settings.backendUrl ?? "").trim().replace(/\/+$/, "");
  const syncToken = String(tokenOverride ?? "").trim();
  if (!backendUrl || !syncToken) {
    return;
  }

  try {
    await fetch(`${backendUrl}/api/gateway/disconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${syncToken}`,
      },
      body: JSON.stringify({
        clientId: settings.clientId,
      }),
    });
  } catch {
  }
};

const pairGatewaySync = async () => {
  if (pairingPromise) {
    return pairingPromise;
  }

  pairingPromise = (async () => {
    try {
      const settings = currentSettings();
      const backendUrl = String(settings.backendUrl ?? "").trim().replace(/\/+$/, "");
      if (!backendUrl) {
        throw new Error("Gateway backend URL is not configured.");
      }

      const gatewayStatus = await pairingReadinessStatus();
      if (!gatewayStatus?.saveValidation?.valid) {
        throw new Error(gatewayStatus?.saveValidation?.message || "Choose a valid Diablo II save folder before pairing.");
      }

      if (settings.syncToken) {
        await disconnectGatewaySync(settings);
      }

      const pairingResponse = await postJson(`${backendUrl}/api/gateway/pairing-sessions`, {
        clientId: settings.clientId,
      });
      if (!pairingResponse.ok) {
        throw new Error(`Gateway pairing start failed with ${pairingResponse.status}`);
      }

      const pairing = await pairingResponse.json();
      await shell.openExternal(pairing.pairingUrl);

      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const claimResponse = await postJson(`${backendUrl}/api/gateway/pairing-sessions/${encodeURIComponent(pairing.pairingId)}/claim`, {
          pairingSecret: pairing.pairingSecret,
        });

        if (claimResponse.status === 202) {
          continue;
        }

        if (!claimResponse.ok) {
          throw new Error(`Gateway pairing claim failed with ${claimResponse.status}`);
        }

        const claim = await claimResponse.json();
        const saved = writeGatewaySettings({ ...settings, syncToken: claim.gatewayToken }, settingsFilePath());
        applyAutoStart(saved.autoStart);
        await restartGatewayProcess();
        await waitForGatewayLinked();
        await broadcastStatus();
        return;
      }

      throw new Error("Gateway pairing timed out.");
    } finally {
      pairingPromise = null;
    }
  })();

  return pairingPromise;
};

const protocolArg = (argv) => argv.find((value) => typeof value === "string" && value.startsWith(`${protocolName}://`)) ?? null;

const handleProtocolLaunch = async (rawUrl) => {
  if (!rawUrl) {
    return;
  }

  try {
    const url = new URL(rawUrl);
    const route = `${url.hostname}${url.pathname}`.replace(/\/+$/, "");
    if (route !== "pair" && route !== "/pair") {
      return;
    }
    const backendUrl = String(url.searchParams.get("backend") ?? "").trim();
    if (backendUrl) {
      writeGatewaySettings({ ...currentSettings(), backendUrl }, settingsFilePath());
    }
    await showSettingsWindow();
    const gatewayStatus = await pairingReadinessStatus({ timeoutMs: 6000, intervalMs: 500 });
    if (gatewayStatus?.saveValidation?.valid) {
      await pairGatewaySync();
      return;
    }
    notify(
      "Finish Gateway Setup",
      gatewayStatus?.saveValidation?.message || "Choose your Diablo II save folder, save it, then sign in with Discord.",
      false,
    );
    await broadcastStatus();
  } catch {
  }
};

const fetchGatewayStatus = async () => {
  const response = await fetch(`${gatewayEndpoint()}/health`);
  if (!response.ok) {
    throw new Error(`Gateway health failed with ${response.status}`);
  }
  return response.json();
};

const waitForGatewayLinked = async ({ timeoutMs = 20000, intervalMs = 1000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    try {
      lastStatus = await fetchGatewayStatus();
      if (lastStatus.syncToken && !lastStatus.lastBackendSyncError) {
        return lastStatus;
      }
    } catch {
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return lastStatus;
};

const waitForGatewayStatus = async (predicate, { timeoutMs = 20000, intervalMs = 1000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    try {
      lastStatus = await fetchGatewayStatus();
      if (predicate(lastStatus)) {
        return lastStatus;
      }
    } catch {
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return lastStatus;
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

  const nextBackendConnected = Boolean(status.syncToken && status.lastBackendSyncAt && !status.lastBackendSyncError);
  if (previousBackendConnected === null) {
    previousBackendConnected = nextBackendConnected;
  } else if (previousBackendConnected !== nextBackendConnected) {
    if (nextBackendConnected) {
      notify("D2 Wealth Gateway", "Gateway connected to D2 Wealth sync.", true);
    } else if (status.syncToken) {
      notify("D2 Wealth Gateway", "Gateway lost connection to D2 Wealth sync.", false);
    }
    previousBackendConnected = nextBackendConnected;
  }
  backendConnected = nextBackendConnected;

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
          } else if (eventName === "viewer-disconnected") {
            connectedViewers = Math.max(0, connectedViewers - 1);
          } else if (eventName === "settings-changed" || eventName === "backend-sync" || eventName === "files-changed" || eventName === "ready") {
            void broadcastStatus();
          }
        }
      });
      response.on("close", () => {
        connectedViewers = 0;
        setTimeout(startGatewayEvents, 3000);
      });
    },
  );

  request.on("error", () => {
    connectedViewers = 0;
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
    backendConnected = false;
    previousBackendConnected = false;
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
      width: 460,
      height: 520,
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

const registerProtocolClient = () => {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(protocolName);
    return;
  }

  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(protocolName, process.execPath, [path.resolve(process.argv[1])]);
    return;
  }

  app.setAsDefaultProtocolClient(protocolName);
};

const singleInstance = app.requestSingleInstanceLock();

if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const rawUrl = protocolArg(argv);
    if (rawUrl) {
      void handleProtocolLaunch(rawUrl);
    } else {
      void showSettingsWindow();
    }
  });
}

app.whenReady().then(async () => {
  app.setAppUserModelId("d2-wealth.gateway");
  registerProtocolClient();
  await bootstrap();
  const launchUrl = protocolArg(process.argv);
  if (launchUrl) {
    void handleProtocolLaunch(launchUrl);
  }

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
    const previous = currentSettings();
    const merged = { ...previous, ...nextSettings };
    const nextToken = typeof nextSettings.syncToken === "string" ? nextSettings.syncToken.trim() : previous.syncToken;
    const tokenChanged = previous.syncToken && previous.syncToken !== nextToken;
    const tokenCleared = previous.syncToken && !nextToken;

    if (tokenChanged || tokenCleared) {
      await disconnectGatewaySync(previous, previous.syncToken);
    }

    const saved = writeGatewaySettings(merged, settingsFilePath());
    applyAutoStart(saved.autoStart);
    await restartGatewayProcess();
    const validatedStatus =
      (await waitForGatewayStatus(
        (status) =>
          status.saveDir === saved.saveDir &&
          Boolean(status.saveValidation?.checkedAt) &&
          (!saved.syncToken || Boolean(status.lastBackendSyncAt || status.lastBackendSyncError)),
        { timeoutMs: 25000 },
      ).catch(() => null)) ??
      (await fetchGatewayStatus().catch(() => ({ ...saved, running: false, files: [] })));
    return {
      ...validatedStatus,
      autoStart: readAutoStart(),
    };
  });
  ipcMain.handle("gateway:pair", async () => {
    await pairGatewaySync();
    return {
      ...(await fetchGatewayStatus().catch(() => ({ ...currentSettings(), running: false, files: [] }))),
      autoStart: readAutoStart(),
    };
  });
  ipcMain.handle("gateway:disconnect", async () => {
    const previous = currentSettings();
    if (previous.syncToken) {
      await disconnectGatewaySync(previous);
    }
    const saved = writeGatewaySettings({ ...previous, syncToken: "" }, settingsFilePath());
    applyAutoStart(saved.autoStart);
    await restartGatewayProcess();
    return {
      ...(await fetchGatewayStatus().catch(() => ({ ...saved, running: false, files: [] }))),
      autoStart: readAutoStart(),
    };
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
  ipcMain.handle("tray-menu:quit", async () => {
    isQuitting = true;
    menuWindow?.hide();
    await disconnectGatewaySync(currentSettings());
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
  await disconnectGatewaySync(currentSettings());
  await stopGatewayProcess();
  app.exit(0);
});
