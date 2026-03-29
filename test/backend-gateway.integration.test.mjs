import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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

const waitFor = async (predicate, { attempts = 40, intervalMs = 25 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(intervalMs);
  }

  assert.fail("Timed out waiting for expected condition.");
};

const connectEventStream = async (url, headers = {}) => {
  const controller = new AbortController();
  const decoder = new TextDecoder();
  const events = [];
  let isClosed = false;
  let buffer = "";
  let readyResolved = false;
  let resolveReady;
  let resolveClosed;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const response = await fetch(url, {
    headers: {
      Accept: "text/event-stream",
      ...headers,
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);

  void (async () => {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const eventMatch = part.match(/^event:\s*(.+)$/m);
          const dataMatch = part.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) {
            continue;
          }

          const event = eventMatch[1].trim();
          const data = JSON.parse(dataMatch[1]);
          events.push({ event, data });
          if (!readyResolved && event === "ready") {
            readyResolved = true;
            resolveReady();
          }
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        throw error;
      }
    } finally {
      resolveClosed();
    }
  })();

  await ready;

  return {
    events,
    async close() {
      if (isClosed) {
        return;
      }
      isClosed = true;
      controller.abort();
      await closed;
    },
  };
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
      equippedHr: Number((totalHr * 0.2).toFixed(2)),
      inventoryHr: Number((totalHr * 0.1).toFixed(2)),
      characterStashHr: Number((totalHr * 0.3).toFixed(2)),
      stashHr: Number((totalHr * 0.4).toFixed(2)),
      totalHr,
    },
  ],
  parsedSaveData: {
    saveSetId,
    characters: [
      {
        fileName: `Sorc${suffix}.d2s`,
        name: `Sorc ${suffix}`,
        className: "Sorceress",
        level: 91,
        equippedItems: [{ name: `Spirit ${suffix}`, location: "equipped" }],
        inventoryItems: [{ name: `Charm ${suffix}`, location: "inventory" }],
        cubeItems: [],
        stashItems: [{ name: `Shako ${suffix}`, location: "character-stash" }],
      },
    ],
    stashes: [
      {
        fileName: `Shared${suffix}.d2i`,
        kind: "shared",
        pages: [
          {
            pageIndex: 0,
            name: `Page ${suffix}`,
            items: [{ name: `Ber ${suffix}`, location: "shared-stash" }],
          },
        ],
        materialItems: [{ name: `Rune ${suffix}`, location: "shared-stash" }],
      },
    ],
  },
  snapshot: {
    totalHr,
    equippedHr: Number((totalHr * 0.2).toFixed(2)),
    inventoryHr: Number((totalHr * 0.1).toFixed(2)),
    characterStashHr: Number((totalHr * 0.3).toFixed(2)),
    runeHr: Number((totalHr * 0.3).toFixed(2)),
    sharedHr: Number((totalHr * 0.4).toFixed(2)),
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
    user,
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
  const pairingUrl = new URL(body.pairingUrl);
  const returnTo = pairingUrl.searchParams.get("returnTo");
  assert.ok(returnTo);
  const returnToUrl = new URL(returnTo);
  assert.equal(returnToUrl.searchParams.get("pair"), body.pairingId);
  assert.equal(returnToUrl.searchParams.get("backend"), backendBaseUrl);
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

test("gateway status summary reports explicit save, pairing, sync, and last-error states", async () => {
  const invalidService = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 3188,
      saveDir: path.join(tempRoot, "missing-saves"),
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: "http://127.0.0.1:9999",
      accountId: "account-missing",
      clientId: "desktop-missing",
      syncToken: "",
    },
  });

  await invalidService.refreshSaveValidation();
  const invalidStatus = invalidService.status();
  assert.equal(invalidStatus.statusSummary.save.state, "attention");
  assert.equal(invalidStatus.statusSummary.pairing.state, "blocked");
  assert.equal(invalidStatus.statusSummary.sync.state, "not-paired");
  assert.equal(invalidStatus.statusSummary.lastError?.scope, "save-validation");
  assert.match(String(invalidStatus.statusSummary.lastError?.message), /does not exist/i);

  const validSaveDir = path.join(tempRoot, "status-ready");
  fs.mkdirSync(validSaveDir, { recursive: true });
  fs.writeFileSync(path.join(validSaveDir, "hero.d2s"), "fixture", "utf8");

  const readyService = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 3189,
      saveDir: validSaveDir,
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: "http://127.0.0.1:9999",
      accountId: "account-ready",
      clientId: "desktop-ready",
      syncToken: "",
    },
  });

  readyService.buildReport = async () => ({
    importedAt: "2026-03-29T12:00:00.000Z",
    totalHr: 1,
    characters: [
      {
        name: "Ready",
        className: "Sorceress",
        level: 90,
        equippedHr: 0.25,
        inventoryHr: 0.15,
        characterStashHr: 0.1,
        stashHr: 0.25,
        totalHr: 0.5,
      },
    ],
    snapshot: {
      totalHr: 1,
      equippedHr: 0.25,
      inventoryHr: 0.15,
      characterStashHr: 0.1,
      runeHr: 0.25,
      sharedHr: 0.5,
      stashHr: 0.25,
      characterCount: 1,
      capturedAt: "2026-03-29T12:00:00.000Z",
    },
    topItems: [],
  });

  await readyService.refreshSaveValidation();
  const readyStatus = readyService.status();
  assert.equal(readyStatus.statusSummary.save.state, "ready");
  assert.equal(readyStatus.statusSummary.pairing.state, "ready");
  assert.equal(readyStatus.statusSummary.sync.state, "not-paired");
  assert.equal(readyStatus.statusSummary.lastError, null);
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
  const syncedStatus = service.status();
  assert.equal(syncedStatus.statusSummary.save.state, "ready");
  assert.equal(syncedStatus.statusSummary.pairing.state, "paired");
  assert.equal(syncedStatus.statusSummary.sync.state, "synced");
  assert.equal(syncedStatus.statusSummary.lastError, null);
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
  assert.equal(latestBody.parsedSaveData.characters[0].fileName, "SorcB.d2s");
  assert.equal(latestBody.parsedSaveData.characters[0].stashItems[0].name, "Shako B");
  assert.equal(latestBody.parsedSaveData.stashes[0].fileName, "SharedB.d2i");
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
  const rejectedStatus = service.status();
  assert.equal(rejectedStatus.statusSummary.save.state, "ready");
  assert.equal(rejectedStatus.statusSummary.pairing.state, "paired");
  assert.equal(rejectedStatus.statusSummary.sync.state, "error");
  assert.equal(rejectedStatus.statusSummary.lastError?.scope, "sync");
  assert.equal(rejectedStatus.statusSummary.lastError?.message, "Backend ingest failed with 401");

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

test("backend stores parsed save data per save-set account and updates rows on re-sync", async (t) => {
  const ctx = await loadIntegrationContext("save-set-accounts");
  t.after(ctx.close);

  const firstPairing = await createPairing(ctx.backendBaseUrl, "desktop-alpha");
  await approvePairing(ctx.backendBaseUrl, firstPairing.pairingId, ctx.sessionCookie);
  const { response: firstClaimResponse, body: firstClaim } = await claimPairing(
    ctx.backendBaseUrl,
    firstPairing.pairingId,
    firstPairing.pairingSecret,
  );
  assert.equal(firstClaimResponse.status, 200);

  const firstSaveDir = path.join(ctx.tempRoot, "save-set-alpha");
  fs.mkdirSync(firstSaveDir, { recursive: true });
  fs.writeFileSync(path.join(firstSaveDir, "hero.d2s"), "fixture", "utf8");

  const alphaService = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 3192,
      saveDir: firstSaveDir,
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: ctx.backendBaseUrl,
      accountId: ctx.account.id,
      clientId: firstClaim.clientId,
      syncToken: firstClaim.gatewayToken,
    },
  });

  let alphaReport = createReport("Alpha", 9.5, "2026-03-29T12:20:00.000Z", "save-set-alpha");
  alphaService.buildReport = async () => alphaReport;

  await alphaService.syncToBackend();
  const alphaAccountId = alphaService.settings.accountId;
  assert.equal(ctx.db.listAccountsForUser(ctx.user.id).length, 1);
  assert.equal(
    ctx.db.getDatabase().prepare("SELECT COUNT(*) AS count FROM account_parsed_characters WHERE account_id = ?").get(alphaAccountId).count,
    1,
  );

  alphaReport = createReport("Alpha", 10.75, "2026-03-29T12:25:00.000Z", "save-set-alpha");
  alphaReport.characters[0].level = 93;
  alphaReport.parsedSaveData.characters[0].level = 93;
  alphaReport.parsedSaveData.characters[0].stashItems = [{ name: "Arachnid Mesh", location: "character-stash" }];
  await alphaService.syncToBackend();

  const alphaLatest = ctx.db.readAccountLatest(alphaAccountId);
  assert.equal(alphaLatest.accountId, alphaAccountId);
  assert.equal(alphaLatest.parsedSaveData.characters[0].level, 93);
  assert.equal(alphaLatest.parsedSaveData.characters[0].stashItems[0].name, "Arachnid Mesh");
  assert.equal(
    ctx.db.getDatabase().prepare("SELECT COUNT(*) AS count FROM account_parsed_characters WHERE account_id = ?").get(alphaAccountId).count,
    1,
  );
  assert.equal(ctx.db.listAccountsForUser(ctx.user.id).length, 1);

  const secondPairing = await createPairing(ctx.backendBaseUrl, "desktop-beta");
  await approvePairing(ctx.backendBaseUrl, secondPairing.pairingId, ctx.sessionCookie);
  const { response: secondClaimResponse, body: secondClaim } = await claimPairing(
    ctx.backendBaseUrl,
    secondPairing.pairingId,
    secondPairing.pairingSecret,
  );
  assert.equal(secondClaimResponse.status, 200);

  const secondSaveDir = path.join(ctx.tempRoot, "save-set-beta");
  fs.mkdirSync(secondSaveDir, { recursive: true });
  fs.writeFileSync(path.join(secondSaveDir, "hero.d2s"), "fixture", "utf8");

  const betaService = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 3193,
      saveDir: secondSaveDir,
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: ctx.backendBaseUrl,
      accountId: alphaAccountId,
      clientId: secondClaim.clientId,
      syncToken: secondClaim.gatewayToken,
    },
  });

  betaService.buildReport = async () => createReport("Beta", 7.25, "2026-03-29T12:30:00.000Z", "save-set-beta");
  await betaService.syncToBackend();

  const betaAccountId = betaService.settings.accountId;
  assert.notEqual(betaAccountId, alphaAccountId);
  const accounts = ctx.db.listAccountsForUser(ctx.user.id);
  assert.equal(accounts.length, 2);
  assert.deepEqual(
    accounts.map((account) => account.save_set_id).sort(),
    ["save-set-alpha", "save-set-beta"],
  );

  const betaLatest = ctx.db.readAccountLatest(betaAccountId);
  assert.equal(betaLatest.parsedSaveData.characters[0].fileName, "SorcBeta.d2s");
  assert.equal(betaLatest.parsedSaveData.stashes[0].fileName, "SharedBeta.d2i");
});

test("gateway performs an initial sync on startup once a valid token and save folder are present", async (t) => {
  const ctx = await loadIntegrationContext("startup");
  t.after(ctx.close);

  const pairing = await createPairing(ctx.backendBaseUrl, "desktop-startup");
  await approvePairing(ctx.backendBaseUrl, pairing.pairingId, ctx.sessionCookie);

  const { response: claimResponse, body: claimed } = await claimPairing(
    ctx.backendBaseUrl,
    pairing.pairingId,
    pairing.pairingSecret,
  );
  assert.equal(claimResponse.status, 200);
  assert.equal(claimed.status, "approved");

  const saveDir = path.join(ctx.tempRoot, "startup-sync");
  fs.mkdirSync(saveDir, { recursive: true });
  fs.writeFileSync(path.join(saveDir, "hero.d2s"), "fixture", "utf8");

  const service = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 0,
      saveDir,
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: ctx.backendBaseUrl,
      accountId: ctx.account.id,
      clientId: claimed.clientId,
      syncToken: claimed.gatewayToken,
    },
  });
  t.after(async () => {
    await service.stop();
  });

  service.buildReport = async () => createReport("Startup", 14.25, "2026-03-29T12:10:00.000Z");

  const started = await service.start();
  assert.ok(["pending", "syncing", "synced"].includes(started.statusSummary.sync.state));

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { response, body } = await fetchJson(
      `${ctx.backendBaseUrl}/api/accounts/${encodeURIComponent(ctx.account.id)}/latest`,
      {
        headers: { Cookie: ctx.sessionCookie },
      },
    );
    if (response.status === 200 && body?.report) {
      assert.equal(body.report.totalHr, 14.25);
      assert.equal(body.clientId, claimed.clientId);
      assert.equal(service.status().statusSummary.sync.state, "synced");
      return;
    }
    await delay(50);
  }

  assert.fail("Timed out waiting for startup sync to reach the backend.");
});

test("gateway debounces syncs for relevant save-file changes and ignores unrelated files", async () => {
  const watchedSaveDir = path.join(tempRoot, "watch-debounce");
  fs.mkdirSync(watchedSaveDir, { recursive: true });
  fs.writeFileSync(path.join(watchedSaveDir, "hero.d2s"), "fixture", "utf8");

  const service = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 3190,
      saveDir: watchedSaveDir,
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: "http://127.0.0.1:9999",
      accountId: "account-watch",
      clientId: "desktop-watch",
      syncToken: "watch-token",
    },
    changeDebounceMs: 25,
  });

  let watchHandler = null;
  let syncAttempts = 0;
  const originalWatch = fs.watch;
  service.refreshSaveValidation = async () => ({
    valid: true,
    message: "ok",
    characterCount: 1,
    checkedAt: new Date().toISOString(),
    nextRetryAt: null,
  });
  service.syncToBackend = async () => {
    syncAttempts += 1;
  };

  fs.watch = (_saveDir, _options, handler) => {
    watchHandler = handler;
    return {
      close() {},
    };
  };

  try {
    service.startWatcher();
    assert.ok(watchHandler);

    watchHandler("rename", "notes.txt");
    watchHandler("change", "hero.d2s");
    watchHandler("change", "shared.sss");
    watchHandler("change", "hero.d2s");
    await delay(80);

    assert.equal(syncAttempts, 1);
  } finally {
    service.stopWatcher();
    fs.watch = originalWatch;
  }
});

test("gateway ignores the tray event subscription when reporting connected viewers", async (t) => {
  const saveDir = path.join(tempRoot, "viewer-events");
  fs.mkdirSync(saveDir, { recursive: true });
  fs.writeFileSync(path.join(saveDir, "hero.d2s"), "fixture", "utf8");

  const connectedClients = [];
  const disconnectedClients = [];
  const service = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 0,
      saveDir,
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: "",
      accountId: "account-viewers",
      clientId: "desktop-viewers",
      syncToken: "",
    },
    onClientConnected(client) {
      connectedClients.push(client);
    },
    onClientDisconnected(client) {
      disconnectedClients.push(client);
    },
  });
  service.buildReport = async () => createReport("Events", 1, "2026-03-29T12:15:00.000Z");

  await service.start();
  t.after(async () => {
    await service.stop();
  });

  const address = service.server?.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const trayClient = await connectEventStream(`${baseUrl}/events`, {
    "X-D2-Gateway-Client": "tray",
  });
  t.after(async () => {
    await trayClient.close();
  });

  assert.deepEqual(trayClient.events.map((entry) => entry.event), ["ready"]);
  assert.equal(connectedClients.length, 0);
  assert.equal(disconnectedClients.length, 0);

  const viewerClient = await connectEventStream(`${baseUrl}/events`);
  await waitFor(() => trayClient.events.some((entry) => entry.event === "viewer-connected"));

  assert.equal(viewerClient.events[0]?.event, "ready");
  assert.equal(trayClient.events.filter((entry) => entry.event === "viewer-connected").length, 1);
  assert.equal(trayClient.events.filter((entry) => entry.event === "viewer-disconnected").length, 0);
  assert.equal(connectedClients.length, 1);
  assert.equal(disconnectedClients.length, 0);

  await viewerClient.close();
  await waitFor(() => trayClient.events.some((entry) => entry.event === "viewer-disconnected"));

  assert.equal(trayClient.events.filter((entry) => entry.event === "viewer-connected").length, 1);
  assert.equal(trayClient.events.filter((entry) => entry.event === "viewer-disconnected").length, 1);
  assert.equal(connectedClients.length, 1);
  assert.equal(disconnectedClients.length, 1);

  await trayClient.close();
});

test("gateway schedules a safe retry after transient backend failures and recovers on the next attempt", async (t) => {
  const saveDir = path.join(tempRoot, "retry-sync");
  fs.mkdirSync(saveDir, { recursive: true });
  fs.writeFileSync(path.join(saveDir, "hero.d2s"), "fixture", "utf8");

  let ingestAttempts = 0;
  const backend = createBackendServer();
  const originalEmit = backend.emit.bind(backend);
  backend.emit = function patchedEmit(eventName, request, response) {
    if (eventName === "request" && request.url === "/api/ingest") {
      ingestAttempts += 1;
      if (ingestAttempts === 1) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          error: "Temporary outage",
          ingest: {
            status: "rejected",
            reason: "temporary_unavailable",
          },
        }));
        return true;
      }
    }
    return originalEmit(eventName, request, response);
  };

  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    await new Promise((resolve, reject) => backend.close((error) => (error ? reject(error) : resolve())));
  });

  const ctx = await loadIntegrationContext("retry");
  t.after(ctx.close);

  const pairing = await createPairing(`http://127.0.0.1:${address.port}`, "desktop-retry");
  await approvePairing(`http://127.0.0.1:${address.port}`, pairing.pairingId, ctx.sessionCookie);

  const { response: claimResponse, body: claimed } = await claimPairing(
    `http://127.0.0.1:${address.port}`,
    pairing.pairingId,
    pairing.pairingSecret,
  );
  assert.equal(claimResponse.status, 200);
  assert.equal(claimed.status, "approved");

  const service = new GatewayService({
    settings: {
      host: "127.0.0.1",
      port: 3191,
      saveDir,
      autoStart: false,
      dashboardUrl: "http://127.0.0.1:4173",
      backendUrl: `http://127.0.0.1:${address.port}`,
      accountId: ctx.account.id,
      clientId: claimed.clientId,
      syncToken: claimed.gatewayToken,
    },
    initialRetryDelayMs: 25,
    maxRetryDelayMs: 25,
  });
  t.after(async () => {
    await service.stop();
  });

  service.buildReport = async () => createReport("Retry", 22.5, "2026-03-29T12:15:00.000Z");

  service.requestSync();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (ingestAttempts >= 2 && service.lastBackendSyncError === null && service.lastSuccessfulAccountUpdateAt) {
      assert.equal(service.status().statusSummary.sync.state, "synced");
      assert.equal(service.syncLog[0].outcome, "accepted");
      assert.ok(service.syncLog.some((entry) => entry.outcome === "rejected" && entry.httpStatus === 503));
      return;
    }
    await delay(25);
  }

  assert.fail("Timed out waiting for retry sync recovery.");
});

test.after(() => {
  db.getDatabase().close();
});
