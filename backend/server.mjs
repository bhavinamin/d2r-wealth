import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import {
  approveGatewayPairing,
  claimGatewayPairing,
  createGatewayPairing,
  createGatewayToken,
  createSession,
  deleteSession,
  deleteSessionsForAccount,
  getSession,
  ingestAccountReport,
  listAccountsForUser,
  listGatewayTokens,
  readBackendHealth,
  readAccountClients,
  readAccountHistory,
  readAccountLatest,
  removeGatewayClient,
  revokeGatewayToken,
  upsertDiscordUser,
  userCanAccessAccount,
  validateGatewayToken,
} from "./db.mjs";

const PORT = Number(process.env.D2_BACKEND_PORT ?? 3197);
const HOST = process.env.D2_BACKEND_HOST ?? "127.0.0.1";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ?? `http://${HOST}:${PORT}/auth/discord/callback`;
const APP_REDIRECT_URI = process.env.D2_APP_REDIRECT_URI ?? "http://127.0.0.1:5173";
const COOKIE_NAME = "d2w_session";
const COOKIE_SECURE = process.env.D2_COOKIE_SECURE === "true" || APP_REDIRECT_URI.startsWith("https://");

const portalHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>D2 Wealth Portal</title>
    <style>
      body { font-family: Segoe UI, sans-serif; background:#111; color:#eee; margin:0; padding:24px; }
      main { max-width: 900px; margin:0 auto; display:grid; gap:18px; }
      section { background:#1a1a1a; border:1px solid #2c2c2c; border-radius:16px; padding:18px; }
      button { border:0; padding:10px 14px; border-radius:10px; cursor:pointer; font-weight:700; }
      input { width:100%; padding:10px 12px; border-radius:10px; border:1px solid #3a3a3a; background:#101010; color:#fff; }
      .primary { background:#f0b763; color:#1a140f; }
      .row { display:grid; gap:10px; }
      code { color:#f0b763; }
      .token { padding:12px; border-radius:12px; background:#101010; border:1px solid #353535; }
      .hidden { display:none; }
    </style>
  </head>
  <body>
    <main>
      <section id="auth">
        <h1>D2 Wealth Portal</h1>
        <p>Sign in with Discord to manage your account and pair your local gateway.</p>
        <button class="primary" id="login">Sign in with Discord</button>
      </section>
      <section id="app" class="hidden">
        <div id="me"></div>
        <div class="row">
          <label>Account
            <select id="account"></select>
          </label>
          <label>Gateway Pairing
            <input id="tokenLabel" value="Pair from the Windows tray app" readonly />
          </label>
          <button class="primary" id="createToken" disabled>Use the tray app to pair</button>
        </div>
        <div id="newToken" class="token hidden"></div>
        <h2>Existing Tokens</h2>
        <div id="tokens"></div>
      </section>
    </main>
    <script>
      const auth = document.getElementById('auth');
      const app = document.getElementById('app');
      const me = document.getElementById('me');
      const account = document.getElementById('account');
      const tokenLabel = document.getElementById('tokenLabel');
      const tokens = document.getElementById('tokens');
      const newToken = document.getElementById('newToken');
      document.getElementById('login').onclick = () => {
        location.href = '/auth/discord/start?returnTo=' + encodeURIComponent(location.href);
      };
      const render = async () => {
        const meResponse = await fetch('/api/me', { credentials: 'include' });
        if (meResponse.status === 401) { auth.classList.remove('hidden'); app.classList.add('hidden'); return; }
        const payload = await meResponse.json();
        auth.classList.add('hidden'); app.classList.remove('hidden');
        me.textContent = 'Signed in as ' + payload.user.username;
        account.innerHTML = payload.accounts.map(a => '<option value="' + a.id + '">' + a.name + '</option>').join('');
        await loadTokens();
      };
      const loadTokens = async () => {
        const accountId = account.value;
        if (!accountId) return;
        const response = await fetch('/api/accounts/' + encodeURIComponent(accountId) + '/gateway-tokens', { credentials: 'include' });
        const payload = await response.json();
        tokens.innerHTML = payload.tokens.map(t => '<div class="token"><strong>' + t.label + '</strong><div><code>' + t.token_prefix + '...</code></div></div>').join('') || '<p>No tokens yet.</p>';
      };
      account.onchange = loadTokens;
      document.getElementById('createToken').onclick = async () => {
        const accountId = account.value;
        const response = await fetch('/api/accounts/' + encodeURIComponent(accountId) + '/gateway-tokens', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: tokenLabel.value })
        });
        const payload = await response.json();
        newToken.classList.remove('hidden');
        newToken.textContent = 'Gateway pairing now starts from the Windows tray app.';
      };
      render();
    </script>
  </body>
</html>`;

const oauthStates = new Map();

const corsHeaders = (request) => ({
  "Access-Control-Allow-Origin": request.headers.origin ?? APP_REDIRECT_URI,
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Credentials": "true",
  Vary: "Origin",
});

const sendJson = (request, response, statusCode, body, headers = {}) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(request),
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const sendRedirect = (response, location, headers = {}) => {
  response.writeHead(302, {
    Location: location,
    ...headers,
  });
  response.end();
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const parseCookies = (request) =>
  Object.fromEntries(
    String(request.headers.cookie ?? "")
      .split(";")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const index = chunk.indexOf("=");
        return [chunk.slice(0, index), decodeURIComponent(chunk.slice(index + 1))];
      }),
  );

const sessionCookie = (sessionId) =>
  `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${COOKIE_SECURE ? "; Secure" : ""}`;

const clearSessionCookie = () => `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? "; Secure" : ""}`;

const sessionForRequest = (request) => {
  const cookies = parseCookies(request);
  const sessionId = cookies[COOKIE_NAME];
  return sessionId ? getSession(sessionId) : null;
};

const requireSession = (request, response) => {
  const session = sessionForRequest(request);
  if (!session) {
    sendJson(request, response, 401, { error: "Authentication required." });
    return null;
  }
  return session;
};

const requireAccountAccess = (request, response, accountId) => {
  const session = requireSession(request, response);
  if (!session) {
    return null;
  }

  if (!userCanAccessAccount(session.user_id, accountId)) {
    sendJson(request, response, 403, { error: "Forbidden." });
    return null;
  }

  return session;
};

const bearerToken = (request) => {
  const header = String(request.headers.authorization ?? "");
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
};

const logSyncEvent = (event) => {
  const level = event.outcome === "rejected" ? "warn" : "info";
  console[level](JSON.stringify({
    scope: "backend-sync",
    loggedAt: new Date().toISOString(),
    ...event,
  }));
};

const exchangeDiscordCode = async (code) => {
  const payload = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: DISCORD_REDIRECT_URI,
  });

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Discord token exchange failed with ${tokenResponse.status}`);
  }

  const tokenPayload = await tokenResponse.json();
  const userResponse = await fetch("https://discord.com/api/users/@me", {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
    },
  });

  if (!userResponse.ok) {
    throw new Error(`Discord user fetch failed with ${userResponse.status}`);
  }

  return userResponse.json();
};

export const createBackendServer = () => http.createServer(async (request, response) => {
  if (!request.url) {
      sendJson(request, response, 400, { error: "Missing request URL." });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      ...corsHeaders(request),
    });
    response.end();
    return;
  }

  if (url.pathname === "/health") {
    const health = readBackendHealth();
    sendJson(request, response, health.ok ? 200 : 503, {
      ...health,
      host: HOST,
      port: PORT,
      discordConfigured: Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET),
    });
    return;
  }

  if (url.pathname === "/auth/discord/start") {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
      sendJson(request, response, 500, { error: "Discord OAuth is not configured." });
      return;
    }

    const state = crypto.randomBytes(16).toString("hex");
    const returnTo = url.searchParams.get("returnTo") || APP_REDIRECT_URI;
    oauthStates.set(state, { returnTo, createdAt: Date.now() });
    const discordUrl = new URL("https://discord.com/oauth2/authorize");
    discordUrl.searchParams.set("client_id", DISCORD_CLIENT_ID);
    discordUrl.searchParams.set("response_type", "code");
    discordUrl.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
    discordUrl.searchParams.set("scope", "identify");
    discordUrl.searchParams.set("state", state);
    sendRedirect(response, discordUrl.toString());
    return;
  }

  if (url.pathname === "/auth/discord/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthState = state ? oauthStates.get(state) : null;
    if (!code || !state || !oauthState) {
      sendJson(request, response, 400, { error: "Invalid Discord OAuth callback." });
      return;
    }

    oauthStates.delete(state);

    try {
      const discordProfile = await exchangeDiscordCode(code);
      const user = upsertDiscordUser(discordProfile);
      const session = createSession(user.id);
      sendRedirect(response, oauthState.returnTo, {
        "Set-Cookie": sessionCookie(session.id),
      });
    } catch (error) {
      sendJson(request, response, 500, { error: error instanceof Error ? error.message : "Discord authentication failed." });
    }
    return;
  }

  if (url.pathname === "/api/me") {
    const session = sessionForRequest(request);
    if (!session) {
      sendJson(request, response, 401, { error: "Authentication required." });
      return;
    }

    sendJson(request, response, 200, {
      user: {
        id: session.user_id,
        username: session.username,
        avatarUrl: session.avatar_url,
      },
      accounts: listAccountsForUser(session.user_id),
    });
    return;
  }

  if (url.pathname === "/portal") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(portalHtml);
    return;
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    const cookies = parseCookies(request);
    if (cookies[COOKIE_NAME]) {
      deleteSession(cookies[COOKIE_NAME]);
    }
    sendJson(request, response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    return;
  }

  if (url.pathname === "/api/ingest" && request.method === "POST") {
    const rawToken = bearerToken(request);
    const tokenRow = validateGatewayToken(rawToken);
    if (!tokenRow) {
      const ingest = {
        status: "rejected",
        reason: "invalid_gateway_token",
        httpStatus: 401,
      };
      logSyncEvent({
        event: "ingest",
        outcome: "rejected",
        ...ingest,
      });
      sendJson(request, response, 401, { error: "Valid gateway token required.", ingest });
      return;
    }

    try {
      const payload = JSON.parse(await readBody(request));
      if (!payload.report) {
        const ingest = {
          status: "rejected",
          reason: "missing_report",
          httpStatus: 400,
          accountId: tokenRow.account_id,
          clientId: String(payload.clientId ?? "gateway"),
        };
        logSyncEvent({
          event: "ingest",
          outcome: "rejected",
          ...ingest,
        });
        sendJson(request, response, 400, { error: "Missing report.", ingest });
        return;
      }

      const accountId = String(payload.accountId ?? tokenRow.account_id);
      if (accountId !== tokenRow.account_id) {
        const ingest = {
          status: "rejected",
          reason: "account_mismatch",
          httpStatus: 403,
          accountId,
          tokenAccountId: tokenRow.account_id,
          clientId: String(payload.clientId ?? "gateway"),
        };
        logSyncEvent({
          event: "ingest",
          outcome: "rejected",
          ...ingest,
        });
        sendJson(request, response, 403, { error: "Gateway token does not match target account.", ingest });
        return;
      }

      const clientId = String(payload.clientId ?? "gateway");
      const latest = ingestAccountReport({
        accountId,
        gatewayTokenId: tokenRow.id,
        clientId,
        report: payload.report,
        parsedSaveData: payload.parsedSaveData ?? null,
        receivedAt: new Date().toISOString(),
      });

      const ingest = {
        status: "accepted",
        reason: "ingest_recorded",
        httpStatus: 200,
        accountId: latest.accountId,
        clientId,
        importedAt: payload.report.importedAt ?? null,
        totalHr: payload.report.totalHr ?? null,
        saveSetId: latest.saveSetId,
        receivedAt: latest.receivedAt,
        lastSuccessfulAccountUpdateAt: latest.receivedAt,
      };
      logSyncEvent({
        event: "ingest",
        outcome: "accepted",
        ...ingest,
      });
      sendJson(request, response, 200, { ok: true, latest, ingest });
    } catch (error) {
      const ingest = {
        status: "rejected",
        reason: "invalid_ingest_payload",
        httpStatus: 400,
        accountId: tokenRow.account_id,
      };
      logSyncEvent({
        event: "ingest",
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Invalid ingest payload.",
        ...ingest,
      });
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : "Invalid ingest payload.", ingest });
    }
    return;
  }

  if (url.pathname === "/api/gateway/pairing-sessions" && request.method === "POST") {
    try {
      const payload = JSON.parse(await readBody(request));
      const clientId = String(payload.clientId ?? "gateway").trim() || "gateway";
      const created = createGatewayPairing({ clientId });
      const backendHost = request.headers.host || `${HOST}:${PORT}`;
      const pairReturnUrl = new URL(`${APP_REDIRECT_URI.replace(/\/+$/, "")}/`);
      pairReturnUrl.searchParams.set("pair", created.id);
      pairReturnUrl.searchParams.set("backend", `${url.protocol}//${backendHost}`);
      sendJson(request, response, 200, {
        pairingId: created.id,
        pairingSecret: created.pairingSecret,
        expiresAt: created.expiresAt,
        pairingUrl: `${APP_REDIRECT_URI.replace(/\/+$/, "")}/auth/discord/start?returnTo=${encodeURIComponent(pairReturnUrl.toString())}`,
      });
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : "Invalid pairing payload." });
    }
    return;
  }

  const pairingClaimMatch = url.pathname.match(/^\/api\/gateway\/pairing-sessions\/([^/]+)\/claim$/);
  if (pairingClaimMatch && request.method === "POST") {
    try {
      const payload = JSON.parse(await readBody(request));
      const result = claimGatewayPairing({
        pairingId: decodeURIComponent(pairingClaimMatch[1]),
        pairingSecret: String(payload.pairingSecret ?? ""),
      });

      if (result.status === "approved") {
        sendJson(request, response, 200, result);
        return;
      }

      if (result.status === "pending") {
        sendJson(request, response, 202, result);
        return;
      }

      if (result.status === "forbidden") {
        sendJson(request, response, 403, result);
        return;
      }

      sendJson(request, response, 410, result);
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : "Invalid pairing claim payload." });
    }
    return;
  }

  const pairingApproveMatch = url.pathname.match(/^\/api\/gateway\/pairing-sessions\/([^/]+)\/approve$/);
  if (pairingApproveMatch && request.method === "POST") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const result = approveGatewayPairing({
      pairingId: decodeURIComponent(pairingApproveMatch[1]),
      userId: session.user_id,
    });

    if (result.error === "PAIRING_NOT_FOUND") {
      sendJson(request, response, 404, { error: "Pairing request not found." });
      return;
    }
    if (result.error === "PAIRING_EXPIRED") {
      sendJson(request, response, 410, { error: "Pairing request expired." });
      return;
    }
    if (result.error === "PAIRING_CONSUMED") {
      sendJson(request, response, 409, { error: "Pairing request already used." });
      return;
    }
    if (result.error === "ACCOUNT_NOT_FOUND") {
      sendJson(request, response, 404, { error: "No account found for this Discord user." });
      return;
    }

    sendJson(request, response, 200, result);
    return;
  }

  if (url.pathname === "/api/gateway/disconnect" && request.method === "POST") {
    const tokenRow = validateGatewayToken(bearerToken(request));
    if (!tokenRow) {
      sendJson(request, response, 401, { error: "Valid gateway token required." });
      return;
    }

    try {
      const payload = JSON.parse(await readBody(request));
      const clientId = String(payload.clientId ?? "gateway");
      revokeGatewayToken(tokenRow.id, tokenRow.account_id);
      removeGatewayClient(tokenRow.account_id, clientId);
      deleteSessionsForAccount(tokenRow.account_id);
      sendJson(request, response, 200, { ok: true });
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : "Invalid disconnect payload." });
    }
    return;
  }

  const tokenMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/gateway-tokens$/);
  if (tokenMatch && request.method === "GET") {
    const accountId = decodeURIComponent(tokenMatch[1]);
    const session = requireAccountAccess(request, response, accountId);
    if (!session) {
      return;
    }
    sendJson(request, response, 200, {
      accountId,
      tokens: listGatewayTokens(accountId),
    });
    return;
  }

  if (tokenMatch && request.method === "POST") {
    const accountId = decodeURIComponent(tokenMatch[1]);
    const session = requireAccountAccess(request, response, accountId);
    if (!session) {
      return;
    }

    try {
      const payload = JSON.parse(await readBody(request));
      const created = createGatewayToken({
        accountId,
        label: String(payload.label ?? "Gateway Client").trim() || "Gateway Client",
        createdByUserId: session.user_id,
      });
      sendJson(request, response, 200, created);
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : "Invalid token payload." });
    }
    return;
  }

  const revokeMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/gateway-tokens\/([^/]+)\/revoke$/);
  if (revokeMatch && request.method === "POST") {
    const accountId = decodeURIComponent(revokeMatch[1]);
    const tokenId = decodeURIComponent(revokeMatch[2]);
    const session = requireAccountAccess(request, response, accountId);
    if (!session) {
      return;
    }
    revokeGatewayToken(tokenId, accountId);
    sendJson(request, response, 200, { ok: true });
    return;
  }

  const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/(latest|history|clients)$/);
  if (accountMatch && request.method === "GET") {
    const [, rawAccountId, resource] = accountMatch;
    const accountId = decodeURIComponent(rawAccountId);
    const session = requireAccountAccess(request, response, accountId);
    if (!session) {
      return;
    }

    if (resource === "latest") {
      const latest = readAccountLatest(accountId);
      sendJson(request, response, 200, {
        accountId,
        report: latest?.report ?? null,
        parsedSaveData: latest?.parsedSaveData ?? null,
        clientId: latest?.clientId ?? null,
        receivedAt: latest?.receivedAt ?? null,
        lastSuccessfulAccountUpdateAt: latest?.receivedAt ?? null,
      });
      return;
    }

    if (resource === "history") {
      sendJson(request, response, 200, {
        accountId,
        history: readAccountHistory(accountId),
      });
      return;
    }

    if (resource === "clients") {
      sendJson(request, response, 200, {
        accountId,
        clients: readAccountClients(accountId),
      });
      return;
    }
  }

  sendJson(request, response, 404, { error: "Not found." });
});

export const startBackendServer = (options = {}) => {
  const server = createBackendServer();
  const host = options.host ?? HOST;
  const port = options.port ?? PORT;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
};

const isMainModule = (() => {
  if (!process.argv[1]) {
    return false;
  }

  // Deployments invoke the service through a symlinked "current" path.
  // Resolve both paths so direct and symlinked execution are treated the same.
  const modulePath = fileURLToPath(import.meta.url);
  const entryPath = process.argv[1];

  try {
    return fs.realpathSync(modulePath) === fs.realpathSync(entryPath);
  } catch {
    return path.resolve(modulePath) === path.resolve(entryPath);
  }
})();

if (isMainModule) {
  const server = await startBackendServer();
  const address = server.address();
  const activeHost = typeof address === "object" && address ? address.address : HOST;
  const activePort = typeof address === "object" && address ? address.port : PORT;
  console.log(`D2 backend listening on http://${activeHost}:${activePort}`);
}
