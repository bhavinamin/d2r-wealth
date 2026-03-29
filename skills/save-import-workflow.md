# Save Import Workflow

## Goal
Import Diablo 2: Resurrected character and stash files, extract all value-bearing items, and create a wealth snapshot.

## Steps
1. Load the character save and stash files through the gateway-side parser.
2. Separate equipped items, inventory items, cube items, personal stash items, shared stash page items, and stackable material items.
3. Parse D2R v105 stackable stash sectors for rune/material ownership before falling back to chronicle data.
4. Apply known mod aliases for item names that differ from workbook labels, such as essence and key variants.
5. Match each item against the normalized market index.
5. Include equipped gear in the account total exactly once.
6. Rank personal stash, carried inventory, and shared stash items by HR value in separate result buckets.
7. Append a timestamped snapshot for the wealth history chart.
8. When a sync token is present, publish the resulting report upstream under the account associated with that token.
9. Authenticate dashboard access through Discord-backed backend sessions and keep gateway publish access on a separate sync token.

## Rules
- Treat unknown items as unresolved rather than zero value.
- Preserve socketed items and nested rune values.
- Keep per-character totals independent, then roll them up to the account total.
- Store enough raw metadata to explain each valuation later.
- Do not count zero-quantity stackable placeholders as owned runes.
- Prefer server-side gateway reports over browser-side raw parsing for watched save folders.
- Suppress obviously corrupted shared-stash page items from ranked views when the parse shape is not trustworthy.
- Keep gateway client identity stable so backend history can distinguish uploads from multiple machines.
- Do not use browser sessions as gateway credentials; gateway publish access should stay token-based.
- Do not treat the tray app's own event subscription as a real dashboard viewer when surfacing gateway connected state.
- For any gateway MSI release, always build the installer locally first and then run the GitHub release workflow so the local artifact and published artifact stay in sync.
- Track substantial workflow changes in GitHub issues, implement them on dedicated branches, and open PRs instead of landing direct `master` edits.
- Run relevant local verification before pushing, favoring focused tests where the repo provides them and falling back to the existing build/smoke path when it does not.

## Outputs
- Character wealth snapshot.
- Account wealth snapshot.
- Character ruleset labels (`Classic`, `LoD`, `ROTW`) for the overview roster.
- Ranked highest-value items for personal stash, carried inventory, and shared stash.
- Time-series point for the chart.
- Backend account latest/history documents when sync is enabled.
