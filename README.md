# D2 Wealth

Lightweight Diablo 2: Resurrected offline wealth tracker focused on SSF and D2RMM-style modded saves.

It reads character saves and shared stash files, prices runes in `HR`, values equipped gear, ranks stash items, and keeps a local wealth timeline in the browser.

## Current Architecture

- Frontend: React + Vite dashboard
- Gateway: local Node watcher plus Windows tray shell for the D2R save directory
- Backend: account-oriented sync service for multi-client snapshot ingest and history reads
- Auth: Discord-only passwordless auth on the backend with browser sessions and gateway sync tokens
- Pricing:
  - runes use a curated live-normalized rune table with `Ber = 1.0 HR`
  - gear pricing falls back to `data/market.xlsx`
- Parsing:
  - character gear and personal stash come from `.d2s`
  - shared stash items come from `.d2i`
  - material/rune inventory is read from the D2R v105 stackable stash sector, not from the old chronicle fallback
- UI:
  - `Overview` page focuses on connection state, quick account totals, history, and character roster
  - `Loot Ledger` page isolates highest-value character stash items, carried inventory items, shared stash items, and rune inventory into a dedicated loot view

## What Works

- Local gateway watching a live D2R save folder
- Tray-hosted Windows gateway with a simplified settings UI for `saveDir`, `syncToken`, and auto-start
- Dashboard/backend-first flow with Discord sign-in and no browser-side localhost connect step
- Multi-client backend ingest keyed by gateway sync tokens rather than browser sessions
- SQLite-backed backend storage for users, sessions, accounts, gateway tokens, snapshots, and market tables
- Shared stash material parsing for runes and stackable items
- Shared stash valuation for keys, essences, gems, and worldstone shards
- Equipped gear valuation, including runeword recipe fallback like `Enigma`
- Ranked character stash and shared stash value tables
- Separate carried inventory view so identified loot in inventory does not masquerade as stash value
- Wealth history chart served from synced account history
- Rune inventory with exact trade-equivalent breakdown tags
- Character roster tags for `Classic`, `LoD`, or `ROTW`
- Windows MSI packaging for the tray gateway

## Known Limits

- Personal stash parsing for heavily modded `.d2s` item records is still conservative
- Live character parses can degrade in-session on some modded saves; the app guards against suspicious equipped-value dips until a clean save lands on disk
- Rare, crafted, jewel, charm, and affix-sensitive item pricing is still shallow
- Some low-confidence shared-stash page parses are intentionally suppressed from top-value views unless they price cleanly
- Discord OAuth credentials must be configured before backend auth works
- Gateway backend sync now requires a backend-issued sync token

## Run Locally

```powershell
npm install
npm run backend
npm run dev -- --host 127.0.0.1
npm run gateway:tray
```

App:

- `http://127.0.0.1:5173`

Gateway:

- `http://127.0.0.1:3187`

Backend:

- `http://127.0.0.1:3197`

Backend env vars:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` optional override
- `D2_APP_REDIRECT_URI` optional dashboard return URL
- `D2_BACKEND_DATA_DIR` optional SQLite data dir override
- `D2_BACKEND_DB_PATH` optional direct SQLite path override
- `D2_COOKIE_SECURE` set `true` when served over HTTPS

CLI fallback:

```powershell
npm run gateway
```

Gateway settings live in the user-scoped tray config when packaged, and in:

- [gateway/settings.json](C:\Users\Bhavin\Documents\dev\d2-wealth\gateway\settings.json)

## Save Inputs

Expected inputs include:

- `*.d2s`
- `*.d2i`
- `*.sss`
- `*.cst`

The gateway is intended to point at a live D2R save directory such as:

- `C:\Users\Bhavin\Saved Games\Diablo II Resurrected`

## Windows Gateway Flow

Production-safe desktop use is:

1. Install the current `D2-Wealth-Gateway-Setup.msi` on the Windows PC that owns the save folder.
2. Launch `D2 Wealth Gateway` from the Start menu so the tray app starts and opens the settings window.
3. Confirm the save folder points at the live D2R save directory and save the settings before attempting pairing.
4. Click `Sign in with Discord`, finish browser auth, and approve pairing for that PC.
5. Wait for the tray window to show `Paired` and then `Synced`, then leave the gateway running in the tray for background uploads.

Operational notes:

- The packaged tray app stores settings in `%APPDATA%\\D2 Wealth Gateway\\settings.json`.
- The packaged gateway defaults to the production backend and dashboard at `https://d2r.bjav.io`.
- Pairing only succeeds after save validation passes. If the selected folder does not exist or has no parseable `.d2s`, pairing stays blocked.
- The first successful upload happens after pairing completes or after the app starts with a valid saved token.
- Quitting the tray app marks the gateway offline for the backend, but it does not clear the saved sync token.

### Update Flow

Use this path for production-safe upgrades:

1. Right-click the tray icon and quit the running gateway.
2. Install the newer `D2-Wealth-Gateway-Setup.msi`.
3. Launch the gateway again and verify the save folder, `Paired` state, and `Synced` state in the settings window.

The gateway uses a stable user-scoped settings file, so normal MSI upgrades should keep the existing save path, client identity, and pairing state. Re-pair only if the new build shows no saved token or the backend reports an invalid token.

### Disconnect Flow

Use `Disconnect` in the tray settings window when the PC should stop owning its current pairing, such as moving the save folder to another machine or retiring the install.

`Disconnect` is stronger than quitting the app:

- it revokes the current gateway sync token on the backend
- it removes the client from the account's connected gateway list
- it clears the saved sync token locally so future uploads stop until the PC is paired again

After `Disconnect`, the same Windows install must go through the Discord pairing flow again before it can upload account snapshots.

## Repo Notes

- `scripts/generate-market.mjs` builds the runtime market index
- it also applies value aliases for modded item names like essences and key naming differences
- `gateway/report.mjs` is the authoritative gateway-side parser and valuation path
- `gateway/service.mjs` owns the reusable HTTP/SSE gateway service and live watcher
- `gateway/tray.mjs` wraps the gateway in a Windows tray app with a settings window
- `gateway/tray.mjs` ignores its own internal event subscription so tray state only reflects real dashboard viewers
- `backend/server.mjs` accepts gateway snapshot ingest and serves per-account latest/history views
- `backend/db.mjs` owns the SQLite schema for auth, accounts, gateway tokens, snapshots, and market tables
- `http://127.0.0.1:3197/portal` is the current lightweight Discord-authenticated account portal for minting gateway sync tokens
- worldstone shard valuation currently comes from the installed Single Player Trading Market mod recipes
- `src/App.tsx` contains the auth-gated landing page, backend-driven dashboard behavior, and trade-tag UI rules
- `src/App.tsx` separates the product into `Overview` and `Loot Ledger` views once the user is authenticated
- `Loot Ledger` keeps character stash and carried inventory in separate panels

## Deployment

The repo now includes a deployment baseline for `https://d2r.bjav.io`:

- GitHub Actions workflow: [deploy.yml](C:\Users\Bhavin\Documents\dev\d2-wealth\.github\workflows\deploy.yml)
- server deploy script: [deploy.sh](C:\Users\Bhavin\Documents\dev\d2-wealth\deploy\deploy.sh)
- nginx site: [d2r.bjav.io.conf](C:\Users\Bhavin\Documents\dev\d2-wealth\deploy\nginx\d2r.bjav.io.conf)
- systemd unit: [d2-wealth-backend.service](C:\Users\Bhavin\Documents\dev\d2-wealth\deploy\systemd\d2-wealth-backend.service)
- production env template: [d2-wealth.env.example](C:\Users\Bhavin\Documents\dev\d2-wealth\deploy\d2-wealth.env.example)

Expected server layout:

- app root: `/srv/d2-wealth`
- current release: `/srv/d2-wealth/current`
- shared SQLite data: `/srv/d2-wealth/shared/data`
- backend env file: `/etc/d2-wealth/d2-wealth.env`

GitHub secrets expected by the workflow:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PORT` optional

Gateway release rule:

- build the MSI locally first with `npm run dist:gateway`
- then trigger the GitHub `Release Gateway MSI` workflow so the published installer matches the local artifact
- keep the release notes aligned with the install, pairing, update, and disconnect flow in [docs/release-process.md](C:/Users/Bhavin/Documents/dev/d2-wealth/docs/release-process.md)

Before the workflow can go live:

- create a DNS record for `d2r.bjav.io`
- put the repo on GitHub and add a remote
- install the systemd unit and nginx site on the VPS
- add Discord OAuth production credentials for `https://d2r.bjav.io/auth/discord/callback`
