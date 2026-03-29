import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "d2-wealth-integration-"));
const backendDbPath = path.join(tempRoot, "backend.sqlite");
process.env.D2_BACKEND_DB_PATH = backendDbPath;
process.env.D2_APP_REDIRECT_URI = "http://127.0.0.1:4173";

const serverModuleUrl = `${pathToFileURL(path.join(process.cwd(), "backend", "server.mjs")).href}?integration=1`;
const dbModuleUrl = `${pathToFileURL(path.join(process.cwd(), "backend", "db.mjs")).href}?integration=1`;
const gatewayModuleUrl = `${pathToFileURL(path.join(process.cwd(), "gateway", "service.mjs")).href}?integration=1`;

const { createBackendServer } = await import(serverModuleUrl);
const { GatewayService } = await import(gatewayModuleUrl);
const { createSession, getDatabase, listAccountsForUser, readAccountClients, upsertDiscordUser } = await import(dbModuleUrl);

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
};

const createReport = (suffix, totalHr, importedAt) => ({
  importedAt,
  totalHr,
  saveSetId: "save-set-alpha",
  characters: [
    {
      name: `Sorc ${suffix}`,
      className: "Sorceress",
      level: 91,
      totalHr,
    },
  ],
  snapshot: {
    totalHr,
    equippedHr: Number((totalHr * 0.2).toFixed(2)),
    runeHr: Number((totalHr * 0.3).toFixed(2)),
    sharedHr: Number((totalHr * 0.1).toFixed(2)),
    stashHr: Number((totalHr * 0.4).toFixed(2)),
    characterCount: 1,
    capturedAt: importedAt,
  },
  topItems: [],
});

test("backend and gateway integration covers pairing, ingest, reads, and disconnect", async (t) => {
  const backend = createBackendServer();
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => backend.close((error) => (error ? reject(error) : resolve())));
    getDatabase().close();
  });

  const backendAddress = backend.address();
  assert.ok(backendAddress && typeof backendAddress === "object");
  const backendBaseUrl = `http://127.0.0.1:${backendAddress.port}`;

  const user = upsertDiscordUser({
    id: "discord-user-1",
    username: "ralph",
    global_name: "Ralph",
    avatar: null,
  });
  const account = listAccountsForUser(user.id)[0];
  const session = createSession(user.id);
  const sessionCookie = `d2w_session=${encodeURIComponent(session.id)}`;

  const { body: pairingCreated } = await fetchJson(`${backendBaseUrl}/api/gateway/pairing-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "desktop-alpha" }),
  });
  assert.match(pairingCreated.pairingUrl, /\/auth\/discord\/start\?/);

  const { response: pendingClaimResponse, body: pendingClaim } = await fetchJson(
    `${backendBaseUrl}/api/gateway/pairing-sessions/${encodeURIComponent(pairingCreated.pairingId)}/claim`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingSecret: pairingCreated.pairingSecret }),
    },
  );
  assert.equal(pendingClaimResponse.status, 202);
  assert.equal(pendingClaim.status, "pending");

  const { response: approveResponse, body: approved } = await fetchJson(
    `${backendBaseUrl}/api/gateway/pairing-sessions/${encodeURIComponent(pairingCreated.pairingId)}/approve`,
    {
      method: "POST",
      headers: { Cookie: sessionCookie },
    },
  );
  assert.equal(approveResponse.status, 200);
  assert.equal(approved.accountId, account.id);
  assert.equal(approved.clientId, "desktop-alpha");

  const { response: claimResponse, body: claimed } = await fetchJson(
    `${backendBaseUrl}/api/gateway/pairing-sessions/${encodeURIComponent(pairingCreated.pairingId)}/claim`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingSecret: pairingCreated.pairingSecret }),
    },
  );
  assert.equal(claimResponse.status, 200);
  assert.equal(claimed.status, "approved");
  assert.ok(claimed.gatewayToken);

  const saveDir = path.join(tempRoot, "saves");
  fs.mkdirSync(saveDir, { recursive: true });
  const service = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 0,
      saveDir,
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: backendBaseUrl,
      accountId: account.id,
      clientId: claimed.clientId,
      syncToken: claimed.gatewayToken,
    },
  });

  let report = createReport("A", 12.5, "2026-03-29T12:00:00.000Z");
  service.buildReport = async () => report;

  const firstIngest = await service.syncToBackend();
  assert.equal(firstIngest.totalHr, 12.5);

  report = createReport("B", 18.75, "2026-03-29T12:05:00.000Z");
  const secondIngest = await service.syncToBackend();
  assert.equal(secondIngest.totalHr, 18.75);

  const { response: latestResponse, body: latestBody } = await fetchJson(
    `${backendBaseUrl}/api/accounts/${encodeURIComponent(account.id)}/latest`,
    {
      headers: { Cookie: sessionCookie },
    },
  );
  assert.equal(latestResponse.status, 200);
  assert.equal(latestBody.clientId, "desktop-alpha");
  assert.equal(latestBody.report.totalHr, 18.75);
  assert.equal(latestBody.report.characters[0].name, "Sorc B");

  const { response: historyResponse, body: historyBody } = await fetchJson(
    `${backendBaseUrl}/api/accounts/${encodeURIComponent(account.id)}/history`,
    {
      headers: { Cookie: sessionCookie },
    },
  );
  assert.equal(historyResponse.status, 200);
  assert.equal(historyBody.history.length, 2);
  assert.deepEqual(
    historyBody.history.map((entry) => entry.totalHr),
    [12.5, 18.75],
  );

  assert.equal(readAccountClients(account.id).length, 1);

  const { response: disconnectResponse, body: disconnectBody } = await fetchJson(`${backendBaseUrl}/api/gateway/disconnect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${claimed.gatewayToken}`,
    },
    body: JSON.stringify({ clientId: claimed.clientId }),
  });
  assert.equal(disconnectResponse.status, 200);
  assert.equal(disconnectBody.ok, true);
  assert.equal(readAccountClients(account.id).length, 0);

  const { response: revokedIngestResponse, body: revokedIngestBody } = await fetchJson(`${backendBaseUrl}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${claimed.gatewayToken}`,
    },
    body: JSON.stringify({ clientId: claimed.clientId, report }),
  });
  assert.equal(revokedIngestResponse.status, 401);
  assert.match(revokedIngestBody.error, /Valid gateway token required/);

  const { response: loggedOutReadResponse, body: loggedOutReadBody } = await fetchJson(
    `${backendBaseUrl}/api/accounts/${encodeURIComponent(account.id)}/latest`,
    {
      headers: { Cookie: sessionCookie },
    },
  );
  assert.equal(loggedOutReadResponse.status, 401);
  assert.match(loggedOutReadBody.error, /Authentication required/);
});
