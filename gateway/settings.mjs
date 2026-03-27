import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_SAVE_DIR = path.join(os.homedir(), "Saved Games", "Diablo II Resurrected");
const appDataRoot = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const defaultSettingsRoot = process.env.D2_GATEWAY_SETTINGS_DIR
  ? path.resolve(process.env.D2_GATEWAY_SETTINGS_DIR)
  : process.versions.electron
    ? path.join(appDataRoot, "D2 Wealth Gateway")
    : path.resolve(process.cwd(), "gateway");
export const DEFAULT_GATEWAY_SETTINGS = {
  host: "127.0.0.1",
  port: 3187,
  saveDir: DEFAULT_SAVE_DIR,
  autoStart: false,
  dashboardUrl: process.env.D2_GATEWAY_DASHBOARD_URL || "http://127.0.0.1:5173",
  backendUrl: process.env.D2_GATEWAY_BACKEND_URL || "http://127.0.0.1:3197",
  accountId: "",
  clientId: os.hostname().toLowerCase(),
  syncToken: "",
};

export const DEFAULT_SETTINGS_PATH = process.env.D2_GATEWAY_SETTINGS_PATH
  ? path.resolve(process.env.D2_GATEWAY_SETTINGS_PATH)
  : path.join(defaultSettingsRoot, "settings.json");

const sanitizePort = (value) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return DEFAULT_GATEWAY_SETTINGS.port;
  }
  return port;
};

const sanitizeHost = (value) => {
  const host = String(value ?? "").trim();
  return host || DEFAULT_GATEWAY_SETTINGS.host;
};

const sanitizeSaveDir = (value) => {
  const saveDir = String(value ?? "").trim();
  return saveDir ? path.resolve(saveDir) : path.resolve(DEFAULT_GATEWAY_SETTINGS.saveDir);
};

const sanitizeAutoStart = (value) => Boolean(value);
const sanitizeDashboardUrl = (value) => {
  const dashboardUrl = String(value ?? "").trim();
  return dashboardUrl || DEFAULT_GATEWAY_SETTINGS.dashboardUrl;
};
const sanitizeBackendUrl = (value) => {
  const backendUrl = String(value ?? "").trim();
  return backendUrl || DEFAULT_GATEWAY_SETTINGS.backendUrl;
};
const sanitizeAccountId = (value) => String(value ?? "").trim();
const sanitizeClientId = (value) => {
  const clientId = String(value ?? "").trim();
  return clientId || DEFAULT_GATEWAY_SETTINGS.clientId;
};
const sanitizeSyncToken = (value) => String(value ?? "").trim();

export const normalizeGatewaySettings = (input = {}) => ({
  host: sanitizeHost(input.host),
  port: sanitizePort(input.port),
  saveDir: sanitizeSaveDir(input.saveDir),
  autoStart: sanitizeAutoStart(input.autoStart),
  dashboardUrl: sanitizeDashboardUrl(input.dashboardUrl),
  backendUrl: sanitizeBackendUrl(input.backendUrl),
  accountId: sanitizeAccountId(input.accountId),
  clientId: sanitizeClientId(input.clientId),
  syncToken: sanitizeSyncToken(input.syncToken),
});

export const readGatewaySettings = (settingsPath = DEFAULT_SETTINGS_PATH) => {
  if (!fs.existsSync(settingsPath)) {
    return normalizeGatewaySettings();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return normalizeGatewaySettings(raw);
  } catch {
    return normalizeGatewaySettings();
  }
};

export const writeGatewaySettings = (input, settingsPath = DEFAULT_SETTINGS_PATH) => {
  const normalized = normalizeGatewaySettings(input);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
};
