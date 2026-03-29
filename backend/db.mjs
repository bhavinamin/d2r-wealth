import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const CONFIGURED_DATA_DIR = process.env.D2_BACKEND_DATA_DIR;
const CONFIGURED_DB_PATH = process.env.D2_BACKEND_DB_PATH;
const DATA_DIR = CONFIGURED_DB_PATH
  ? path.dirname(path.resolve(CONFIGURED_DB_PATH))
  : path.resolve(CONFIGURED_DATA_DIR ?? path.join(process.cwd(), "backend", "data"));
const DB_PATH = path.resolve(CONFIGURED_DB_PATH ?? path.join(DATA_DIR, "d2-wealth.sqlite"));

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_identities (
  discord_user_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  global_name TEXT,
  avatar TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  save_set_id TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS account_memberships (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS gateway_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS gateway_pairings (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  pairing_secret_hash TEXT NOT NULL UNIQUE,
  pairing_secret_prefix TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  account_id TEXT,
  gateway_token_id TEXT,
  gateway_token_value TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (gateway_token_id) REFERENCES gateway_tokens(id)
);

CREATE TABLE IF NOT EXISTS account_latest (
  account_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  save_set_id TEXT,
  report_json TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS account_history (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  save_set_id TEXT,
  total_hr REAL NOT NULL,
  snapshot_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS gateway_clients (
  account_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  total_hr REAL NOT NULL,
  PRIMARY KEY (account_id, client_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS account_parsed_characters (
  account_id TEXT NOT NULL,
  save_set_id TEXT,
  file_name TEXT NOT NULL,
  name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  level INTEGER NOT NULL,
  equipped_items_json TEXT NOT NULL,
  inventory_items_json TEXT NOT NULL,
  cube_items_json TEXT NOT NULL,
  stash_items_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, file_name),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS account_parsed_stashes (
  account_id TEXT NOT NULL,
  save_set_id TEXT,
  file_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  pages_json TEXT NOT NULL,
  material_items_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, file_name),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS market_rune_values (
  rune_name TEXT PRIMARY KEY,
  value_hr REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_token_values (
  normalized_name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  value_hr REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_exact_values (
  normalized_name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  basis TEXT NOT NULL,
  trade_label TEXT,
  value_hr REAL NOT NULL,
  updated_at TEXT NOT NULL
);
`);

try {
  db.exec("ALTER TABLE account_latest ADD COLUMN save_set_id TEXT");
} catch {
}

try {
  db.exec("ALTER TABLE account_history ADD COLUMN save_set_id TEXT");
} catch {
}

try {
  db.exec("ALTER TABLE accounts ADD COLUMN save_set_id TEXT");
} catch {
}

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_owner_save_set
ON accounts(owner_user_id, save_set_id)
WHERE save_set_id IS NOT NULL;
`);

const nowIso = () => new Date().toISOString();
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const countRows = (sql, ...params) => Number(db.prepare(sql).get(...params)?.count ?? 0);
const nearlyEqual = (left, right, epsilon = 1e-6) =>
  typeof left === "number"
  && Number.isFinite(left)
  && typeof right === "number"
  && Number.isFinite(right)
  && Math.abs(left - right) <= epsilon;

export const getDatabase = () => db;

const defaultAccountName = (username) => `${username}'s Account`;

const insertAccountMembership = ({ accountId, userId, role = "owner", createdAt }) => {
  db.prepare("INSERT OR IGNORE INTO account_memberships (account_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(
    accountId,
    userId,
    role,
    createdAt,
  );
};

const readAccountRow = (accountId) => db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId);

const createOwnedAccount = ({ userId, name, saveSetId = null, createdAt = nowIso() }) => {
  const accountId = randomId("acct");
  db.prepare("INSERT INTO accounts (id, owner_user_id, save_set_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    accountId,
    userId,
    saveSetId,
    name,
    createdAt,
    createdAt,
  );
  insertAccountMembership({ accountId, userId, createdAt });
  return readAccountRow(accountId);
};

const deriveAccountName = ({ report, parsedSaveData, saveSetId }) => {
  const parsedCharacters = Array.isArray(parsedSaveData?.characters) ? parsedSaveData.characters : [];
  const reportCharacters = Array.isArray(report?.characters) ? report.characters : [];
  const primaryCharacter = parsedCharacters[0] ?? reportCharacters[0] ?? null;

  if (primaryCharacter?.name && parsedCharacters.length <= 1 && reportCharacters.length <= 1) {
    return `${primaryCharacter.name}`;
  }

  if (primaryCharacter?.name) {
    const extraCount = Math.max(parsedCharacters.length, reportCharacters.length, 1) - 1;
    return extraCount > 0 ? `${primaryCharacter.name} +${extraCount}` : `${primaryCharacter.name}`;
  }

  return saveSetId ? `Save ${saveSetId.slice(0, 8)}` : "Synced Save";
};

const readOwnedAccountBySaveSet = (userId, saveSetId) =>
  db
    .prepare("SELECT * FROM accounts WHERE owner_user_id = ? AND save_set_id = ?")
    .get(userId, saveSetId);

const readAccountParsedData = (accountId) => ({
  characters: db
    .prepare(
      `SELECT file_name, name, class_name, level, equipped_items_json, inventory_items_json, cube_items_json, stash_items_json
       FROM account_parsed_characters
       WHERE account_id = ?
       ORDER BY file_name ASC`,
    )
    .all(accountId)
    .map((row) => ({
      fileName: row.file_name,
      name: row.name,
      className: row.class_name,
      level: row.level,
      equippedItems: JSON.parse(row.equipped_items_json),
      inventoryItems: JSON.parse(row.inventory_items_json),
      cubeItems: JSON.parse(row.cube_items_json),
      stashItems: JSON.parse(row.stash_items_json),
    })),
  stashes: db
    .prepare(
      `SELECT file_name, kind, pages_json, material_items_json
       FROM account_parsed_stashes
       WHERE account_id = ?
       ORDER BY file_name ASC`,
    )
    .all(accountId)
    .map((row) => ({
      fileName: row.file_name,
      kind: row.kind,
      pages: JSON.parse(row.pages_json),
      materialItems: JSON.parse(row.material_items_json),
    })),
});

const replaceAccountParsedData = ({ accountId, saveSetId, parsedSaveData, updatedAt }) => {
  db.prepare("DELETE FROM account_parsed_characters WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM account_parsed_stashes WHERE account_id = ?").run(accountId);

  if (!parsedSaveData) {
    return;
  }

  const insertCharacter = db.prepare(
    `INSERT INTO account_parsed_characters (
      account_id, save_set_id, file_name, name, class_name, level,
      equipped_items_json, inventory_items_json, cube_items_json, stash_items_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertStash = db.prepare(
    `INSERT INTO account_parsed_stashes (
      account_id, save_set_id, file_name, kind, pages_json, material_items_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const character of parsedSaveData.characters ?? []) {
    insertCharacter.run(
      accountId,
      saveSetId,
      character.fileName,
      character.name,
      character.className,
      character.level,
      JSON.stringify(character.equippedItems ?? []),
      JSON.stringify(character.inventoryItems ?? []),
      JSON.stringify(character.cubeItems ?? []),
      JSON.stringify(character.stashItems ?? []),
      updatedAt,
    );
  }

  for (const stash of parsedSaveData.stashes ?? []) {
    insertStash.run(
      accountId,
      saveSetId,
      stash.fileName,
      stash.kind,
      JSON.stringify(stash.pages ?? []),
      JSON.stringify(stash.materialItems ?? []),
      updatedAt,
    );
  }
};

const resolveIngestAccount = ({ accountId, gatewayTokenId, report, parsedSaveData, receivedAt }) => {
  const saveSetId = String(report?.saveSetId ?? "").trim() || null;
  const tokenAccount = readAccountRow(accountId);
  if (!tokenAccount || !saveSetId) {
    return { accountId, saveSetId };
  }

  const nextName = deriveAccountName({ report, parsedSaveData, saveSetId });
  if (!tokenAccount.save_set_id || tokenAccount.save_set_id === saveSetId) {
    db.prepare("UPDATE accounts SET save_set_id = ?, name = ?, updated_at = ? WHERE id = ?").run(
      saveSetId,
      nextName,
      receivedAt,
      tokenAccount.id,
    );
    return { accountId: tokenAccount.id, saveSetId };
  }

  const existingAccount = readOwnedAccountBySaveSet(tokenAccount.owner_user_id, saveSetId);
  const targetAccount = existingAccount
    ?? createOwnedAccount({
      userId: tokenAccount.owner_user_id,
      name: nextName,
      saveSetId,
      createdAt: receivedAt,
    });

  db.prepare("UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?").run(nextName, receivedAt, targetAccount.id);
  db.prepare("UPDATE gateway_tokens SET account_id = ? WHERE id = ?").run(targetAccount.id, gatewayTokenId);
  db.prepare("UPDATE gateway_pairings SET account_id = ? WHERE gateway_token_id = ?").run(targetAccount.id, gatewayTokenId);
  return { accountId: targetAccount.id, saveSetId };
};

export const upsertDiscordUser = (discordProfile) => {
  const existing = db
    .prepare("SELECT users.* FROM discord_identities JOIN users ON users.id = discord_identities.user_id WHERE discord_user_id = ?")
    .get(discordProfile.id);

  const timestamp = nowIso();
  const username = discordProfile.global_name || discordProfile.username;
  const avatarUrl = discordProfile.avatar
    ? `https://cdn.discordapp.com/avatars/${discordProfile.id}/${discordProfile.avatar}.png`
    : null;

  if (existing) {
    db.prepare("UPDATE users SET username = ?, avatar_url = ?, updated_at = ? WHERE id = ?").run(
      username,
      avatarUrl,
      timestamp,
      existing.id,
    );
    db.prepare(
      "UPDATE discord_identities SET username = ?, global_name = ?, avatar = ?, updated_at = ? WHERE discord_user_id = ?",
    ).run(discordProfile.username, discordProfile.global_name ?? null, discordProfile.avatar ?? null, timestamp, discordProfile.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
  }

  const userId = randomId("usr");
  db.prepare("INSERT INTO users (id, username, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    username,
    avatarUrl,
    timestamp,
    timestamp,
  );
  db.prepare(
    "INSERT INTO discord_identities (discord_user_id, user_id, username, global_name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(discordProfile.id, userId, discordProfile.username, discordProfile.global_name ?? null, discordProfile.avatar ?? null, timestamp, timestamp);

  createOwnedAccount({
    userId,
    name: defaultAccountName(username),
    createdAt: timestamp,
  });

  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
};

export const createSession = (userId) => {
  const id = randomId("sess");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(id, userId, expiresAt, createdAt);
  return { id, userId, expiresAt };
};

export const getSession = (sessionId) => {
  const row = db
    .prepare(
      `SELECT sessions.id, sessions.user_id, sessions.expires_at, users.username, users.avatar_url
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ?`,
    )
    .get(sessionId);

  if (!row) {
    return null;
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    return null;
  }

  return row;
};

export const deleteSession = (sessionId) => {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
};

export const listAccountsForUser = (userId) =>
  db
    .prepare(
      `SELECT accounts.id, accounts.name, accounts.save_set_id, account_memberships.role
       FROM account_memberships
       JOIN accounts ON accounts.id = account_memberships.account_id
       WHERE account_memberships.user_id = ?
       ORDER BY accounts.updated_at DESC, accounts.created_at ASC`,
    )
    .all(userId);

export const userCanAccessAccount = (userId, accountId) =>
  Boolean(
    db
      .prepare("SELECT 1 FROM account_memberships WHERE user_id = ? AND account_id = ?")
      .get(userId, accountId),
  );

export const createGatewayToken = ({ accountId, label, createdByUserId }) => {
  const rawToken = `d2w_${crypto.randomBytes(24).toString("hex")}`;
  const id = randomId("gwt");
  const createdAt = nowIso();
  db.prepare(
    "INSERT INTO gateway_tokens (id, account_id, label, token_hash, token_prefix, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, accountId, label, tokenHash(rawToken), rawToken.slice(0, 10), createdByUserId, createdAt);
  return {
    id,
    accountId,
    label,
    token: rawToken,
    tokenPrefix: rawToken.slice(0, 10),
    createdAt,
  };
};

export const createGatewayPairing = ({ clientId, expiresInMinutes = 10 }) => {
  const rawSecret = `pair_${crypto.randomBytes(24).toString("hex")}`;
  const id = randomId("pair");
  const requestedAt = nowIso();
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO gateway_pairings (
      id, client_id, pairing_secret_hash, pairing_secret_prefix, requested_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, clientId, tokenHash(rawSecret), rawSecret.slice(0, 12), requestedAt, expiresAt);
  return {
    id,
    clientId,
    pairingSecret: rawSecret,
    pairingSecretPrefix: rawSecret.slice(0, 12),
    requestedAt,
    expiresAt,
  };
};

export const approveGatewayPairing = ({ pairingId, userId }) => {
  const pairing = db
    .prepare(
      `SELECT id, client_id, requested_at, expires_at, approved_at, consumed_at
       FROM gateway_pairings
       WHERE id = ?`,
    )
    .get(pairingId);

  if (!pairing) {
    return { error: "PAIRING_NOT_FOUND" };
  }

  if (pairing.consumed_at) {
    return { error: "PAIRING_CONSUMED" };
  }

  if (new Date(pairing.expires_at).getTime() < Date.now()) {
    return { error: "PAIRING_EXPIRED" };
  }

  const account = listAccountsForUser(userId)[0];
  if (!account) {
    return { error: "ACCOUNT_NOT_FOUND" };
  }

  if (pairing.approved_at) {
    return { ok: true, accountId: account.id };
  }

  const created = createGatewayToken({
    accountId: account.id,
    label: `Paired Gateway (${pairing.client_id})`,
    createdByUserId: userId,
  });

  db.prepare(
    `UPDATE gateway_pairings
     SET approved_at = ?, account_id = ?, gateway_token_id = ?, gateway_token_value = ?
     WHERE id = ?`,
  ).run(nowIso(), account.id, created.id, created.token, pairingId);

  return {
    ok: true,
    accountId: account.id,
    clientId: pairing.client_id,
  };
};

export const claimGatewayPairing = ({ pairingId, pairingSecret }) => {
  const pairing = db
    .prepare(
      `SELECT id, client_id, pairing_secret_hash, expires_at, approved_at, consumed_at, gateway_token_id, gateway_token_value
       FROM gateway_pairings
       WHERE id = ?`,
    )
    .get(pairingId);

  if (!pairing) {
    return { status: "missing" };
  }

  if (pairing.pairing_secret_hash !== tokenHash(pairingSecret)) {
    return { status: "forbidden" };
  }

  if (pairing.consumed_at) {
    return { status: "consumed" };
  }

  if (new Date(pairing.expires_at).getTime() < Date.now()) {
    return { status: "expired" };
  }

  if (!pairing.approved_at || !pairing.gateway_token_value || !pairing.gateway_token_id) {
    return { status: "pending" };
  }

  db.prepare("UPDATE gateway_pairings SET consumed_at = ?, gateway_token_value = NULL WHERE id = ?").run(nowIso(), pairingId);
  return {
    status: "approved",
    clientId: pairing.client_id,
    gatewayToken: pairing.gateway_token_value,
    gatewayTokenId: pairing.gateway_token_id,
  };
};

export const listGatewayTokens = (accountId) =>
  db
    .prepare(
      `SELECT id, account_id, label, token_prefix, created_by_user_id, created_at, revoked_at, last_used_at
       FROM gateway_tokens
       WHERE account_id = ?
       ORDER BY created_at DESC`,
    )
    .all(accountId);

export const revokeGatewayToken = (tokenId, accountId) => {
  db.prepare("UPDATE gateway_tokens SET revoked_at = ? WHERE id = ? AND account_id = ?").run(nowIso(), tokenId, accountId);
};

export const removeGatewayClient = (accountId, clientId) => {
  db.prepare("DELETE FROM gateway_clients WHERE account_id = ? AND client_id = ?").run(accountId, clientId);
};

export const deleteSessionsForAccount = (accountId) => {
  db.prepare(
    `DELETE FROM sessions
     WHERE user_id IN (
       SELECT user_id FROM account_memberships WHERE account_id = ?
     )`,
  ).run(accountId);
};

export const validateGatewayToken = (rawToken) => {
  if (!rawToken) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT id, account_id, label, revoked_at
       FROM gateway_tokens
       WHERE token_hash = ?`,
    )
    .get(tokenHash(rawToken));

  if (!row || row.revoked_at) {
    return null;
  }

  db.prepare("UPDATE gateway_tokens SET last_used_at = ? WHERE id = ?").run(nowIso(), row.id);
  return row;
};

export const ingestAccountReport = ({ accountId, gatewayTokenId, clientId, report, parsedSaveData, receivedAt }) => {
  const timestamp = receivedAt ?? nowIso();
  const historyId = randomId("hist");
  let latestAccountId = accountId;
  const transaction = db.transaction(() => {
    const resolved = resolveIngestAccount({
      accountId,
      gatewayTokenId,
      report,
      parsedSaveData,
      receivedAt: timestamp,
    });
    const saveSetId = resolved.saveSetId;
    latestAccountId = resolved.accountId;

    const existingLatest = db.prepare("SELECT save_set_id FROM account_latest WHERE account_id = ?").get(latestAccountId);
    const saveSetChanged =
      Boolean(saveSetId) &&
      Boolean(existingLatest) &&
      String(existingLatest.save_set_id ?? "") !== saveSetId;

    if (saveSetChanged) {
      db.prepare("DELETE FROM account_history WHERE account_id = ?").run(latestAccountId);
    }

    db.prepare(
      "INSERT OR REPLACE INTO account_latest (account_id, client_id, received_at, save_set_id, report_json) VALUES (?, ?, ?, ?, ?)",
    ).run(latestAccountId, clientId, timestamp, saveSetId, JSON.stringify(report));

    db.prepare(
      "INSERT INTO account_history (id, account_id, client_id, received_at, imported_at, save_set_id, total_hr, snapshot_json, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      historyId,
      latestAccountId,
      clientId,
      timestamp,
      report.importedAt,
      saveSetId,
      report.totalHr,
      JSON.stringify(report.snapshot),
      JSON.stringify(report),
    );

    if (latestAccountId !== accountId) {
      db.prepare("DELETE FROM gateway_clients WHERE account_id = ? AND client_id = ?").run(accountId, clientId);
    }

    db.prepare(
      "INSERT OR REPLACE INTO gateway_clients (account_id, client_id, received_at, imported_at, total_hr) VALUES (?, ?, ?, ?, ?)",
    ).run(latestAccountId, clientId, timestamp, report.importedAt, report.totalHr);

    replaceAccountParsedData({
      accountId: latestAccountId,
      saveSetId,
      parsedSaveData,
      updatedAt: timestamp,
    });
  });

  transaction();
  return readAccountLatest(latestAccountId);
};

export const readAccountLatest = (accountId) => {
  const row = db
    .prepare("SELECT account_id, client_id, received_at, save_set_id, report_json FROM account_latest WHERE account_id = ?")
    .get(accountId);
  if (!row) {
    return null;
  }
  return {
    accountId: row.account_id,
    clientId: row.client_id,
    receivedAt: row.received_at,
    saveSetId: row.save_set_id ?? null,
    report: JSON.parse(row.report_json),
    parsedSaveData: readAccountParsedData(accountId),
  };
};

export const readLatestAccountParsedData = (accountId) => readAccountParsedData(accountId);

export const readAccountHistory = (accountId) =>
  db
    .prepare(
      "SELECT client_id, received_at, imported_at, save_set_id, total_hr, snapshot_json FROM account_history WHERE account_id = ? ORDER BY received_at ASC",
    )
    .all(accountId)
    .map((row) => ({
      clientId: row.client_id,
      receivedAt: row.received_at,
      saveSetId: row.save_set_id ?? null,
      ...JSON.parse(row.snapshot_json),
      totalHr: row.total_hr,
      importedAt: row.imported_at,
    }));

export const readAccountClients = (accountId) =>
  db
    .prepare("SELECT account_id, client_id, received_at, imported_at, total_hr FROM gateway_clients WHERE account_id = ? ORDER BY client_id ASC")
    .all(accountId)
    .map((row) => ({
      accountId: row.account_id,
      clientId: row.client_id,
      receivedAt: row.received_at,
      importedAt: row.imported_at,
      totalHr: row.total_hr,
    }));

export const readBackendHealth = ({ staleAfterMs = Number(process.env.D2_HEALTH_STALE_AFTER_MS ?? 1000 * 60 * 15) } = {}) => {
  const checkedAt = nowIso();
  const counts = {
    users: countRows("SELECT COUNT(*) AS count FROM users"),
    accounts: countRows("SELECT COUNT(*) AS count FROM accounts"),
    latestSnapshots: countRows("SELECT COUNT(*) AS count FROM account_latest"),
    snapshotHistory: countRows("SELECT COUNT(*) AS count FROM account_history"),
    activeGatewayClients: countRows("SELECT COUNT(*) AS count FROM gateway_clients"),
    activeGatewayTokens: countRows("SELECT COUNT(*) AS count FROM gateway_tokens WHERE revoked_at IS NULL"),
  };

  const latestRow = db
    .prepare(
      `SELECT
         account_latest.account_id,
         account_latest.client_id,
         account_latest.received_at,
         account_latest.save_set_id,
         account_latest.report_json,
         accounts.name AS account_name
       FROM account_latest
       JOIN accounts ON accounts.id = account_latest.account_id
       ORDER BY account_latest.received_at DESC
       LIMIT 1`,
    )
    .get();

  const checks = {
    database: {
      status: "pass",
      detail: `SQLite ready at ${DB_PATH}.`,
      counts,
    },
    freshness: {
      status: "warn",
      detail: "No synced account snapshot has been recorded yet.",
      staleAfterMs,
    },
    accuracy: {
      status: "warn",
      detail: "No synced account snapshot is available yet, so pricing accuracy has not been observed.",
      unresolvedCount: 0,
      ambiguousCount: 0,
      totalWarnings: 0,
    },
    validity: {
      status: "warn",
      detail: "No synced account snapshot is available yet, so report validity checks are waiting for the first upload.",
      issues: [],
      warnings: [],
    },
  };

  let latestSnapshot = null;
  if (latestRow) {
    const report = JSON.parse(latestRow.report_json);
    const parsedSaveData = readAccountParsedData(latestRow.account_id);
    const reportCharacters = Array.isArray(report?.characters) ? report.characters : [];
    const snapshot = report?.snapshot ?? {};
    const valuationWarnings = report?.valuationWarnings ?? {};
    const unresolvedCount = Number(valuationWarnings.unresolvedCount ?? 0);
    const ambiguousCount = Number(valuationWarnings.ambiguousCount ?? 0);
    const totalWarnings = Number(valuationWarnings.totalCount ?? unresolvedCount + ambiguousCount);
    const parsedCharacterCount = Array.isArray(parsedSaveData.characters) ? parsedSaveData.characters.length : 0;
    const parsedStashCount = Array.isArray(parsedSaveData.stashes) ? parsedSaveData.stashes.length : 0;
    const parsedDataAvailable = parsedCharacterCount > 0 || parsedStashCount > 0;
    const ageMs = Math.max(0, Date.now() - new Date(latestRow.received_at).getTime());

    latestSnapshot = {
      accountId: latestRow.account_id,
      accountName: latestRow.account_name,
      clientId: latestRow.client_id,
      receivedAt: latestRow.received_at,
      importedAt: report?.importedAt ?? null,
      saveSetId: latestRow.save_set_id ?? null,
      totalHr: typeof report?.totalHr === "number" ? report.totalHr : null,
      characterCount: reportCharacters.length,
      parsedCharacterCount,
      parsedStashCount,
      unresolvedCount,
      ambiguousCount,
      totalWarnings,
      ageMs,
    };

    checks.freshness = ageMs > staleAfterMs
      ? {
          status: "warn",
          detail: `Latest account snapshot is stale at ${latestRow.received_at}.`,
          latestReceivedAt: latestRow.received_at,
          ageMs,
          staleAfterMs,
        }
      : {
          status: "pass",
          detail: `Latest account snapshot was recorded at ${latestRow.received_at}.`,
          latestReceivedAt: latestRow.received_at,
          ageMs,
          staleAfterMs,
        };

    checks.accuracy = totalWarnings > 0
      ? {
          status: "warn",
          detail: `Latest account snapshot surfaced ${totalWarnings} pricing warning(s).`,
          unresolvedCount,
          ambiguousCount,
          totalWarnings,
        }
      : {
          status: "pass",
          detail: "Latest account snapshot has no unresolved or ambiguous pricing warnings.",
          unresolvedCount,
          ambiguousCount,
          totalWarnings,
        };

    const issues = [];
    const warnings = [];

    if (
      typeof report?.totalHr === "number"
      && typeof snapshot?.totalHr === "number"
      && !nearlyEqual(report.totalHr, snapshot.totalHr)
    ) {
      issues.push("snapshot_total_mismatch");
    }

    if (
      typeof snapshot?.characterCount === "number"
      && snapshot.characterCount !== reportCharacters.length
    ) {
      issues.push("snapshot_character_count_mismatch");
    }

    if (
      latestRow.save_set_id
      && report?.saveSetId
      && String(latestRow.save_set_id) !== String(report.saveSetId)
    ) {
      issues.push("save_set_id_mismatch");
    }

    if (parsedDataAvailable && parsedCharacterCount !== reportCharacters.length) {
      issues.push("parsed_character_count_mismatch");
    }

    if (!parsedDataAvailable) {
      warnings.push("missing_parsed_save_data");
    }

    if (!reportCharacters.length) {
      warnings.push("empty_character_report");
    }

    checks.validity = issues.length
      ? {
          status: "fail",
          detail: `Latest account snapshot failed ${issues.length} validity check(s).`,
          issues,
          warnings,
        }
      : warnings.length
        ? {
            status: "warn",
            detail: `Latest account snapshot passed strict validity checks with ${warnings.length} warning(s).`,
            issues,
            warnings,
          }
        : {
            status: "pass",
            detail: "Latest account snapshot passed report validity checks.",
            issues,
            warnings,
          };
  }

  const overallStatus = Object.values(checks).some((check) => check.status === "fail")
    ? "fail"
    : Object.values(checks).some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  return {
    ok: overallStatus !== "fail",
    status: overallStatus,
    checkedAt,
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    checks,
    latestSnapshot,
  };
};

export const resetMarketTables = () => {
  db.exec(`
    DELETE FROM market_rune_values;
    DELETE FROM market_token_values;
    DELETE FROM market_exact_values;
  `);
};

export const seedMarketTables = ({ runeValues, tokenValues, exactValues }) => {
  const timestamp = nowIso();
  const insertRune = db.prepare("INSERT INTO market_rune_values (rune_name, value_hr, updated_at) VALUES (?, ?, ?)");
  const insertToken = db.prepare(
    "INSERT INTO market_token_values (normalized_name, display_name, kind, value_hr, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertExact = db.prepare(
    "INSERT INTO market_exact_values (normalized_name, display_name, sheet_name, basis, trade_label, value_hr, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  const transaction = db.transaction(() => {
    resetMarketTables();

    for (const [name, valueHr] of Object.entries(runeValues)) {
      insertRune.run(name, valueHr, timestamp);
    }

    for (const [normalizedName, token] of Object.entries(tokenValues)) {
      insertToken.run(normalizedName, token.name, token.kind, token.valueHr, timestamp);
    }

    for (const [normalizedName, exact] of Object.entries(exactValues)) {
      insertExact.run(normalizedName, exact.name, exact.sheet, exact.basis, exact.tradeLabel ?? null, exact.valueHr, timestamp);
    }
  });

  transaction();
};
