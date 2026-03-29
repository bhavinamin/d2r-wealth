import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "d2-wealth-integration-"));
process.env.D2_BACKEND_DB_PATH = path.join(tempRoot, "backend.sqlite");
process.env.D2_APP_REDIRECT_URI = "http://127.0.0.1:4173";

const serverModuleUrl = `${pathToFileURL(path.join(process.cwd(), "backend", "server.mjs")).href}?integration=1`;
const dbModuleUrl = `${pathToFileURL(path.join(process.cwd(), "backend", "db.mjs")).href}?integration=1`;
const gatewayModuleUrl = `${pathToFileURL(path.join(process.cwd(), "gateway", "service.mjs")).href}?integration=1`;

const { createBackendServer } = await import(serverModuleUrl);
const { GatewayService } = await import(gatewayModuleUrl);
const db = await import(dbModuleUrl);

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
};

const createReport = (suffix, totalHr, importedAt, saveSetId = "save-set-alpha") => ({
  importedAt,
  totalHr,
  saveSetId,
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

const loadIntegrationContext = async (seed) => {
  const backend = createBackendServer();
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.address();
  assert.ok(backendAddress && typeof backendAddress === "object");

  const user = db.upsertDiscordUser({
    id: `discord-user-${seed}`,
    username: `ralph-${seed}`,
    global_name: "Ralph",
    avatar: null,
  });
  const account = db.listAccountsForUser(user.id)[0];
  const session = db.createSession(user.id);

  const close = async () => {
    await new Promise((resolve, reject) => backend.close((error) => (error ? reject(error) : resolve())));
  };

  return {
    GatewayService,
    backendBaseUrl: `http://127.0.0.1:${backendAddress.port}`,
    close,
    db,
    account,
    sessionCookie: `d2w_session=${encodeURIComponent(session.id)}`,
    tempRoot,
  };
};

const createPairing = async (backendBaseUrl, clientId) => {
  const { response, body } = await fetchJson(`${backendBaseUrl}/api/gateway/pairing-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId }),
  });

  assert.equal(response.status, 200);
  assert.equal(body.clientId, undefined);
  assert.match(body.pairingUrl, /\/auth\/discord\/start\?/);
  return body;
};

const approvePairing = async (backendBaseUrl, pairingId, sessionCookie) => {
  const { response, body } = await fetchJson(
    `${backendBaseUrl}/api/gateway/pairing-sessions/${encodeURIComponent(pairingId)}/approve`,
    {
      method: "POST",
      headers: { Cookie: sessionCookie },
    },
  );

  assert.equal(response.status, 200);
  return body;
};

const claimPairing = async (backendBaseUrl, pairingId, pairingSecret) =>
  fetchJson(`${backendBaseUrl}/api/gateway/pairing-sessions/${encodeURIComponent(pairingId)}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingSecret }),
  });

test("pairing issues a token only after approval and consumes the pairing on first successful claim", async (t) => {
  const ctx = await loadIntegrationContext("pairing");
  t.after(ctx.close);

  const pairing = await createPairing(ctx.backendBaseUrl, "desktop-alpha");

  const { response: forbiddenClaimResponse, body: forbiddenClaim } = await claimPairing(
    ctx.backendBaseUrl,
    pairing.pairingId,
    `${pairing.pairingSecret}-wrong`,
  );
  assert.equal(forbiddenClaimResponse.status, 403);
  assert.equal(forbiddenClaim.status, "forbidden");

  const { response: pendingClaimResponse, body: pendingClaim } = await claimPairing(
    ctx.backendBaseUrl,
    pairing.pairingId,
    pairing.pairingSecret,
  );
  assert.equal(pendingClaimResponse.status, 202);
  assert.equal(pendingClaim.status, "pending");

  const approved = await approvePairing(ctx.backendBaseUrl, pairing.pairingId, ctx.sessionCookie);
  assert.equal(approved.accountId, ctx.account.id);
  assert.equal(approved.clientId, "desktop-alpha");

  const { response: approvedClaimResponse, body: approvedClaim } = await claimPairing(
    ctx.backendBaseUrl,
    pairing.pairingId,
    pairing.pairingSecret,
  );
  assert.equal(approvedClaimResponse.status, 200);
  assert.equal(approvedClaim.status, "approved");
  assert.equal(approvedClaim.clientId, "desktop-alpha");
  assert.ok(approvedClaim.gatewayToken);

  const { response: consumedClaimResponse, body: consumedClaim } = await claimPairing(
    ctx.backendBaseUrl,
    pairing.pairingId,
    pairing.pairingSecret,
  );
  assert.equal(consumedClaimResponse.status, 410);
  assert.equal(consumedClaim.status, "consumed");
});

test("gateway sync covers token-based ingest, latest/history reads, and disconnect cleanup", async (t) => {
  const ctx = await loadIntegrationContext("sync");
  t.after(ctx.close);

  const pairing = await createPairing(ctx.backendBaseUrl, "desktop-alpha");
  await approvePairing(ctx.backendBaseUrl, pairing.pairingId, ctx.sessionCookie);

  const { response: claimResponse, body: claimed } = await claimPairing(
    ctx.backendBaseUrl,
    pairing.pairingId,
    pairing.pairingSecret,
  );
  assert.equal(claimResponse.status, 200);
  assert.equal(claimed.status, "approved");

  const saveDir = path.join(ctx.tempRoot, "saves");
  const testSaveDir = path.join(saveDir, "sync");
  fs.mkdirSync(testSaveDir, { recursive: true });
  fs.writeFileSync(path.join(testSaveDir, "hero.d2s"), "fixture", "utf8");

  const service = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 3187,
      saveDir: testSaveDir,
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: ctx.backendBaseUrl,
      accountId: ctx.account.id,
      clientId: claimed.clientId,
      syncToken: claimed.gatewayToken,
    },
  });

  let report = createReport("A", 12.5, "2026-03-29T12:00:00.000Z");
  service.buildReport = async () => report;

  const firstIngest = await service.syncToBackend();
  assert.equal(firstIngest.totalHr, 12.5);
  assert.match(String(service.lastBackendSyncAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(service.lastBackendSyncError, null);
  assert.match(String(service.lastSuccessfulAccountUpdateAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(service.syncLog[0].event, "ingest-response");
  assert.equal(service.syncLog[0].outcome, "accepted");
  assert.equal(service.syncLog[0].lastSuccessfulAccountUpdateAt, service.lastSuccessfulAccountUpdateAt);
  assert.equal(service.syncLog[1].event, "ingest-attempt");
  assert.equal(service.syncLog[1].outcome, "attempted");
  assert.deepEqual(ctx.db.readAccountClients(ctx.account.id).map((client) => client.clientId), ["desktop-alpha"]);

  report = createReport("B", 18.75, "2026-03-29T12:05:00.000Z");
  const secondIngest = await service.syncToBackend();
  assert.equal(secondIngest.totalHr, 18.75);

  const { response: latestResponse, body: latestBody } = await fetchJson(
    `${ctx.backendBaseUrl}/api/accounts/${encodeURIComponent(ctx.account.id)}/latest`,
    {
      headers: { Cookie: ctx.sessionCookie },
    },
  );
  assert.equal(latestResponse.status, 200);
  assert.equal(latestBody.clientId, "desktop-alpha");
  assert.equal(latestBody.report.totalHr, 18.75);
  assert.equal(latestBody.report.characters[0].name, "Sorc B");
  assert.equal(latestBody.lastSuccessfulAccountUpdateAt, latestBody.receivedAt);

  const { response: historyResponse, body: historyBody } = await fetchJson(
    `${ctx.backendBaseUrl}/api/accounts/${encodeURIComponent(ctx.account.id)}/history`,
    {
      headers: { Cookie: ctx.sessionCookie },
    },
  );
  assert.equal(historyResponse.status, 200);
  assert.equal(historyBody.history.length, 2);
  assert.deepEqual(
    historyBody.history.map((entry) => ({ totalHr: entry.totalHr, capturedAt: entry.capturedAt })),
    [
      { totalHr: 12.5, capturedAt: "2026-03-29T12:00:00.000Z" },
      { totalHr: 18.75, capturedAt: "2026-03-29T12:05:00.000Z" },
    ],
  );

  const { response: disconnectResponse, body: disconnectBody } = await fetchJson(`${ctx.backendBaseUrl}/api/gateway/disconnect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${claimed.gatewayToken}`,
    },
    body: JSON.stringify({ clientId: claimed.clientId }),
  });
  assert.equal(disconnectResponse.status, 200);
  assert.equal(disconnectBody.ok, true);
  assert.equal(ctx.db.readAccountClients(ctx.account.id).length, 0);

  await assert.rejects(service.syncToBackend(), /Backend ingest failed with 401/);
  assert.equal(service.lastBackendSyncError, "Backend ingest failed with 401");
  assert.equal(service.syncLog[0].event, "ingest-response");
  assert.equal(service.syncLog[0].outcome, "rejected");
  assert.equal(service.syncLog[0].httpStatus, 401);
  assert.equal(service.syncLog[0].reason, "invalid_gateway_token");
  assert.equal(service.syncLog[0].lastSuccessfulAccountUpdateAt, latestBody.lastSuccessfulAccountUpdateAt);
  assert.equal(service.syncLog[1].event, "ingest-attempt");
  assert.equal(service.syncLog[1].outcome, "attempted");

  const { response: revokedIngestResponse, body: revokedIngestBody } = await fetchJson(`${ctx.backendBaseUrl}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${claimed.gatewayToken}`,
    },
    body: JSON.stringify({ clientId: claimed.clientId, report }),
  });
  assert.equal(revokedIngestResponse.status, 401);
  assert.match(revokedIngestBody.error, /Valid gateway token required/);
  assert.equal(revokedIngestBody.ingest.status, "rejected");
  assert.equal(revokedIngestBody.ingest.reason, "invalid_gateway_token");

  const { response: loggedOutReadResponse, body: loggedOutReadBody } = await fetchJson(
    `${ctx.backendBaseUrl}/api/accounts/${encodeURIComponent(ctx.account.id)}/latest`,
    {
      headers: { Cookie: ctx.sessionCookie },
    },
  );
  assert.equal(loggedOutReadResponse.status, 401);
  assert.match(loggedOutReadBody.error, /Authentication required/);
});

test.after(() => {
  db.getDatabase().close();
});
