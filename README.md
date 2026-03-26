# D2 Wealth

Lightweight Diablo 2: Resurrected offline wealth tracker focused on SSF and D2RMM-style modded saves.

It reads character saves and shared stash files, prices runes in `HR`, values equipped gear, ranks stash items, and keeps a local wealth timeline in the browser.

## Current Architecture

- Frontend: React + Vite dashboard
- Gateway: local Node watcher for the D2R save directory
- Pricing:
  - runes use a curated live-normalized rune table with `Ber = 1.0 HR`
  - gear pricing falls back to `data/market.xlsx`
- Parsing:
  - character gear and personal stash come from `.d2s`
  - shared stash items come from `.d2i`
  - material/rune inventory is read from the D2R v105 stackable stash sector, not from the old chronicle fallback

## What Works

- Local gateway watching a live D2R save folder
- Shared stash material parsing for runes and stackable items
- Shared stash valuation for keys, essences, gems, and worldstone shards
- Equipped gear valuation, including runeword recipe fallback like `Enigma`
- Ranked character stash and shared stash value tables
- Wealth history chart stored locally in the browser
- Rune inventory with exact trade-equivalent breakdown tags

## Known Limits

- Personal stash parsing for heavily modded `.d2s` item records is still conservative
- Rare, crafted, jewel, charm, and affix-sensitive item pricing is still shallow
- Some low-confidence shared-stash page parses are intentionally suppressed from top-value views unless they price cleanly
- The local gateway is HTTP; a remotely hosted HTTPS frontend will need a secure local bridge

## Run Locally

```powershell
npm install
npm run dev -- --host 127.0.0.1
node .\gateway\server.mjs
```

App:

- `http://127.0.0.1:5173`

Gateway:

- `http://127.0.0.1:3187`

## Save Inputs

Expected inputs include:

- `*.d2s`
- `*.d2i`
- `*.sss`
- `*.cst`

The gateway is intended to point at a live D2R save directory such as:

- `C:\Users\Bhavin\Saved Games\Diablo II Resurrected\mods\D2RMM_SOLO`

## Repo Notes

- `scripts/generate-market.mjs` builds the runtime market index
- it also applies value aliases for modded item names like essences and key naming differences
- `gateway/report.mjs` is the authoritative gateway-side parser and valuation path
- worldstone shard valuation currently comes from the installed Single Player Trading Market mod recipes
- `src/App.tsx` contains the current dashboard behavior and trade-tag UI rules
