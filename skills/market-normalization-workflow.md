# Market Normalization Workflow

## Goal
Build a single HR-denominated price index the app can use everywhere.

## Steps
1. Establish the rune ladder with `Ber Rune = 1.0 HR`.
2. Apply curated live-normalized rune values for trade accuracy.
3. Fold workbook sheets like gems, uniques, junk, bases, magic, sunders, services, and raw items into the same index.
4. Translate workbook values through the active rune table.
5. Annotate each item with source sheet, source row, and any recipe-specific notes.

## Rules
- Keep raw workbook labels intact for display and debugging.
- Prefer rune-calibrated values over workbook rune prices.
- Prefer exact recipe values over inferred averages.
- Preserve items with no sell value, but flag them as unsellable.
- When multiple rows map to the same item, choose the most specific market entry and record the conflict.

## Outputs
- Canonical item price map in HR.
- Rune conversion table.
- Ranked item-worth list for UI tables and stash leaderboards.
