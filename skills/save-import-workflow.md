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

## Rules
- Treat unknown items as unresolved rather than zero value.
- Preserve socketed items and nested rune values.
- Keep per-character totals independent, then roll them up to the account total.
- Store enough raw metadata to explain each valuation later.
- Do not count zero-quantity stackable placeholders as owned runes.
- Prefer server-side gateway reports over browser-side raw parsing for watched save folders.
- Suppress obviously corrupted shared-stash page items from ranked views when the parse shape is not trustworthy.

## Outputs
- Character wealth snapshot.
- Account wealth snapshot.
- Character ruleset labels (`Classic`, `LoD`, `ROTW`) for the overview roster.
- Ranked highest-value items for personal stash, carried inventory, and shared stash.
- Time-series point for the chart.
