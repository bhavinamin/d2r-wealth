import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { URL } from "node:url";
import { buildGatewayReport } from "./report.mjs";
import { normalizeGatewaySettings, readGatewaySettings, writeGatewaySettings } from "./settings.mjs";

const ALLOWED_EXTENSIONS = new Set([".d2s", ".d2i", ".sss", ".cst"]);
const CHANGE_DEBOUNCE_MS = 1500;

export class GatewayService {
  constructor(options = {}) {
    this.settingsPath = options.settingsPath;
    this.settings = normalizeGatewaySettings(options.settings ?? readGatewaySettings(this.settingsPath));
    this.onClientConnected = options.onClientConnected ?? null;
    this.onClientDisconnected = options.onClientDisconnected ?? null;
    this.server = null;
    this.watcher = null;
    this.changeTimer = null;
    this.pendingChanges = new Set();
    this.clients = new Set();
    this.lastBackendSyncAt = null;
    this.lastBackendSyncError = null;
    this.syncInFlight = null;
    this.lastSaveValidation = {
      valid: false,
      message: "Waiting for save scan.",
      characterCount: 0,
      checkedAt: null,
    };
  }

  listSaveFiles() {
    const { saveDir } = this.settings;
    if (!fs.existsSync(saveDir)) {
      return [];
    }

    return fs
      .readdirSync(saveDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => {
        const fullPath = path.join(saveDir, entry.name);
        const stats = fs.statSync(fullPath);
        return {
          name: entry.name,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          type: path.extname(entry.name).toLowerCase(),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  status() {
    return {
      ...this.settings,
      running: Boolean(this.server?.listening),
      files: this.listSaveFiles(),
      saveValidation: this.lastSaveValidation,
      lastBackendSyncAt: this.lastBackendSyncAt,
      lastBackendSyncError: this.lastBackendSyncError,
      watchedAt: new Date().toISOString(),
    };
  }

  async refreshSaveValidation() {
    const checkedAt = new Date().toISOString();
    try {
      if (!fs.existsSync(this.settings.saveDir)) {
        this.lastSaveValidation = {
          valid: false,
          message: "Selected folder does not exist.",
          characterCount: 0,
          checkedAt,
        };
        return this.lastSaveValidation;
      }

      const files = this.listSaveFiles();
      const characterFiles = files.filter((file) => file.type === ".d2s");
      if (!characterFiles.length) {
        this.lastSaveValidation = {
          valid: false,
          message: "No .d2s character save was found in this folder.",
          characterCount: 0,
          checkedAt,
        };
        return this.lastSaveValidation;
      }

      const report = await this.buildReport();
      const characterCount = report.characters.length;
      const firstCharacter = report.characters[0];
      if (!characterCount) {
        this.lastSaveValidation = {
          valid: false,
          message: "Character save files were found, but none could be parsed.",
          characterCount: 0,
          checkedAt,
        };
        return this.lastSaveValidation;
      }

      this.lastSaveValidation = {
        valid: true,
        message:
          characterCount === 1
            ? `Validated ${firstCharacter.name} (${firstCharacter.className} level ${firstCharacter.level}).`
            : `Validated ${characterCount} character saves in this folder.`,
        characterCount,
        checkedAt,
      };
      return this.lastSaveValidation;
    } catch (error) {
      this.lastSaveValidation = {
        valid: false,
        message: error instanceof Error ? `Save validation failed: ${error.message}` : "Save validation failed.",
        characterCount: 0,
        checkedAt,
      };
      return this.lastSaveValidation;
    }
  }

  async syncToBackend() {
    if (!this.settings.backendUrl || !this.settings.syncToken) {
      return null;
    }

    if (this.syncInFlight) {
      return this.syncInFlight;
    }

    this.syncInFlight = (async () => {
      try {
        await this.refreshSaveValidation();
        const report = await this.buildReport();
        const response = await fetch(`${this.settings.backendUrl.replace(/\/+$/, "")}/api/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.settings.syncToken}`,
          },
          body: JSON.stringify({
            clientId: this.settings.clientId,
            report,
          }),
        });

        if (!response.ok) {
          throw new Error(`Backend ingest failed with ${response.status}`);
        }

        this.lastBackendSyncAt = new Date().toISOString();
        this.lastBackendSyncError = null;
        this.sendEvent("backend-sync", {
          syncedAt: this.lastBackendSyncAt,
          backendUrl: this.settings.backendUrl,
          clientId: this.settings.clientId,
        });
        return report;
      } catch (error) {
        this.lastBackendSyncError = error instanceof Error ? error.message : "Backend sync failed.";
        throw error;
      } finally {
        this.syncInFlight = null;
      }
    })();

    return this.syncInFlight;
  }

  sendEvent(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  sendJson(response, statusCode, body) {
    const payload = JSON.stringify(body);
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    response.end(payload);
  }

  startWatcher() {
    if (this.watcher || !fs.existsSync(this.settings.saveDir)) {
      return;
    }

    this.watcher = fs.watch(this.settings.saveDir, { recursive: false }, (_eventType, filename) => {
      if (!filename) {
        return;
      }

      const ext = path.extname(filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return;
      }

      this.pendingChanges.add(filename);
      if (this.changeTimer) {
        clearTimeout(this.changeTimer);
      }

      this.changeTimer = setTimeout(() => {
        const changed = Array.from(this.pendingChanges);
        this.pendingChanges.clear();
        this.changeTimer = null;
        this.sendEvent("files-changed", {
          changed,
          files: this.listSaveFiles(),
          emittedAt: new Date().toISOString(),
        });
        void this.refreshSaveValidation()
          .then(() => {
            this.sendEvent("settings-changed", this.status());
          })
          .catch(() => {});
        void this.syncToBackend().catch(() => {});
      }, CHANGE_DEBOUNCE_MS);
    });
  }

  stopWatcher() {
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }

    this.pendingChanges.clear();

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  async updateSettings(nextSettings) {
    const merged = normalizeGatewaySettings({ ...this.settings, ...nextSettings });
    const hostChanged = merged.host !== this.settings.host;
    const portChanged = merged.port !== this.settings.port;
    const saveDirChanged = merged.saveDir !== this.settings.saveDir;

    this.settings = writeGatewaySettings(merged, this.settingsPath);

    if (saveDirChanged) {
      this.stopWatcher();
      this.startWatcher();
    }

    await this.refreshSaveValidation();
    this.sendEvent("settings-changed", this.status());

    if (hostChanged || portChanged) {
      await this.restartServer();
    }

    if (merged.syncToken) {
      void this.syncToBackend().catch(() => {});
    }

    return this.settings;
  }

  async buildReport() {
    return buildGatewayReport(this.settings.saveDir);
  }

  async handleRequest(request, response) {
    if (!request.url) {
      this.sendJson(response, 400, { error: "Missing request URL." });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      response.end();
      return;
    }

    if (url.pathname === "/health") {
      this.sendJson(response, 200, { ok: true, ...this.status() });
      return;
    }

    if (url.pathname === "/manifest") {
      this.sendJson(response, 200, {
        saveDir: this.settings.saveDir,
        files: this.listSaveFiles(),
        refreshedAt: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname === "/settings" && request.method === "GET") {
      this.sendJson(response, 200, this.status());
      return;
    }

    if (url.pathname === "/settings" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }

      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const settings = await this.updateSettings(payload);
        this.sendJson(response, 200, settings);
      } catch (error) {
        this.sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid settings payload." });
      }
      return;
    }

    if (url.pathname === "/report") {
      try {
        const report = await this.buildReport();
        this.sendJson(response, 200, report);
      } catch (error) {
        this.sendJson(response, 500, { error: error instanceof Error ? error.message : "Failed to build report." });
      }
      return;
    }

    if (url.pathname === "/events") {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      const clientType = String(request.headers["x-d2-gateway-client"] ?? "").toLowerCase();
      const isInternalClient = clientType === "tray";
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      response.write(`event: ready\ndata: ${JSON.stringify(this.status())}\n\n`);
      this.clients.add(response);
      if (!isInternalClient) {
        this.sendEvent("viewer-connected", { remoteAddress, connectedAt: new Date().toISOString() });
        this.onClientConnected?.({ remoteAddress });
      }
      request.on("close", () => {
        this.clients.delete(response);
        if (!isInternalClient) {
          this.sendEvent("viewer-disconnected", { remoteAddress, disconnectedAt: new Date().toISOString() });
          this.onClientDisconnected?.({ remoteAddress });
        }
      });
      return;
    }

    if (url.pathname === "/file") {
      const name = url.searchParams.get("name");
      if (!name) {
        this.sendJson(response, 400, { error: "Missing file name." });
        return;
      }

      const safeName = path.basename(name);
      const ext = path.extname(safeName).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        this.sendJson(response, 400, { error: "Unsupported file type." });
        return;
      }

      const fullPath = path.join(this.settings.saveDir, safeName);
      if (!fs.existsSync(fullPath)) {
        this.sendJson(response, 404, { error: "File not found." });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Content-Disposition": `attachment; filename="${safeName}"`,
      });
      fs.createReadStream(fullPath).pipe(response);
      return;
    }

    this.sendJson(response, 404, { error: "Not found." });
  }

  async start() {
    if (this.server?.listening) {
      return this.status();
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.settings.port, this.settings.host, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    this.startWatcher();
    await this.refreshSaveValidation();
    void this.syncToBackend().catch(() => {});
    return this.status();
  }

  async stop() {
    this.stopWatcher();
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();

    if (!this.server?.listening) {
      return;
    }

    const server = this.server;
    this.server = null;
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async restartServer() {
    const wasRunning = Boolean(this.server?.listening);
    if (wasRunning) {
      await this.stop();
      await this.start();
    }
  }
}
