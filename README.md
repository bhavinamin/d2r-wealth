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
