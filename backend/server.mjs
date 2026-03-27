import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import {
  createGatewayToken,
  createSession,
  deleteSession,
  getSession,
  ingestAccountReport,
  listAccountsForUser,
  listGatewayTokens,
  readAccountClients,
  readAccountHistory,
  readAccountLatest,
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
        <p>Sign in with Discord to manage your account and gateway sync tokens.</p>
        <button class="primary" id="login">Sign in with Discord</button>
      </section>
      <section id="app" class="hidden">
        <div id="me"></div>
        <div class="row">
          <label>Account
            <select id="account"></select>
          </label>
          <label>New Gateway Token Label
            <input id="tokenLabel" value="Primary Gateway" />
          </label>
          <button class="primary" id="createToken">Create Gateway Token</button>
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
        newToken.textContent = 'Copy this token into the gateway app now: ' + payload.token;
        await loadTokens();
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
  `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;

const clearSessionCookie = () => `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;

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

const server = http.createServer(async (request, response) => {
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
    sendJson(request, response, 200, {
      ok: true,
      host: HOST,
      port: PORT,
      discordConfigured: Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET),
      checkedAt: new Date().toISOString(),
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
    const tokenRow = validateGatewayToken(bearerToken(request));
    if (!tokenRow) {
      sendJson(request, response, 401, { error: "Valid gateway token required." });
      return;
    }

    try {
      const payload = JSON.parse(await readBody(request));
      if (!payload.report) {
        sendJson(request, response, 400, { error: "Missing report." });
        return;
      }

      const accountId = String(payload.accountId ?? tokenRow.account_id);
      if (accountId !== tokenRow.account_id) {
        sendJson(request, response, 403, { error: "Gateway token does not match target account." });
        return;
      }

      const clientId = String(payload.clientId ?? "gateway");
      const latest = ingestAccountReport({
        accountId,
        clientId,
        report: payload.report,
        receivedAt: new Date().toISOString(),
      });

      sendJson(request, response, 200, { ok: true, latest });
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : "Invalid ingest payload." });
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
      if (!latest) {
        sendJson(request, response, 404, { error: "Account not found." });
        return;
      }
      sendJson(request, response, 200, latest);
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

server.listen(PORT, HOST, () => {
  console.log(`D2 backend listening on http://${HOST}:${PORT}`);
});
