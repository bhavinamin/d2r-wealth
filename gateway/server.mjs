import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { URL } from "node:url";
import { buildGatewayReport } from "./report.mjs";

const DEFAULT_SAVE_DIR = String.raw`C:\Users\Bhavin\Saved Games\Diablo II Resurrected\mods\D2RMM_SOLO`;
const PORT = Number(process.env.D2_GATEWAY_PORT ?? 3187);
const HOST = process.env.D2_GATEWAY_HOST ?? "127.0.0.1";
const SAVE_DIR = path.resolve(process.env.D2_SAVE_DIR ?? process.argv[2] ?? DEFAULT_SAVE_DIR);
const ALLOWED_EXTENSIONS = new Set([".d2s", ".d2i", ".sss", ".cst"]);

/** @type {Set<http.ServerResponse>} */
const clients = new Set();
/** @type {fs.FSWatcher | null} */
let watcher = null;

const sendJson = (response, statusCode, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(payload);
};

const sendEvent = (event, data) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
};

const listSaveFiles = () => {
  if (!fs.existsSync(SAVE_DIR)) {
    return [];
  }

  return fs
    .readdirSync(SAVE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const fullPath = path.join(SAVE_DIR, entry.name);
      const stats = fs.statSync(fullPath);
      return {
        name: entry.name,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        type: path.extname(entry.name).toLowerCase(),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
};

const startWatcher = () => {
  if (watcher || !fs.existsSync(SAVE_DIR)) {
    return;
  }

  watcher = fs.watch(SAVE_DIR, { recursive: false }, (_eventType, filename) => {
    if (!filename) {
      return;
    }

    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return;
    }

    sendEvent("files-changed", {
      changed: filename,
      files: listSaveFiles(),
      emittedAt: new Date().toISOString(),
    });
  });
};

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    sendJson(response, 400, { error: "Missing request URL." });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    });
    response.end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      saveDir: SAVE_DIR,
      files: listSaveFiles().length,
      watchedAt: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/manifest") {
    sendJson(response, 200, {
      saveDir: SAVE_DIR,
      files: listSaveFiles(),
      refreshedAt: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/report") {
    try {
      const report = await buildGatewayReport(SAVE_DIR);
      sendJson(response, 200, report);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Failed to build report." });
    }
    return;
  }

  if (url.pathname === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ saveDir: SAVE_DIR, files: listSaveFiles() })}\n\n`);
    clients.add(response);
    request.on("close", () => {
      clients.delete(response);
    });
    return;
  }

  if (url.pathname === "/file") {
    const name = url.searchParams.get("name");
    if (!name) {
      sendJson(response, 400, { error: "Missing file name." });
      return;
    }

    const safeName = path.basename(name);
    const ext = path.extname(safeName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      sendJson(response, 400, { error: "Unsupported file type." });
      return;
    }

    const fullPath = path.join(SAVE_DIR, safeName);
    if (!fs.existsSync(fullPath)) {
      sendJson(response, 404, { error: "File not found." });
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

  sendJson(response, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  startWatcher();
  console.log(`D2 gateway listening on http://${HOST}:${PORT}`);
  console.log(`Watching ${SAVE_DIR}`);
});
