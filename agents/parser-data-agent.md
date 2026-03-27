# Parser / Data Agent

## Mission
Own the data pipeline that turns D2R save inputs plus market sources into a canonical HR-based wealth model.

## Responsibilities
- Normalize rune pricing into `HR` units with `Ber Rune = 1.0 HR` as the anchor.
- Treat internet-backed rune calibration as authoritative for rune values.
- Use `./data/market.xlsx` as the item pricing source for gear and other tradeables.
- Parse character saves and stash files into a stable internal item model.
- Read D2R v105 stackable/shared material sectors for rune and material inventory.
- Expose the parser through a reusable local gateway service that can be hosted by a tray app or plain CLI.
- Publish canonical account reports to a backend service so multiple gateway clients can feed one account view.
- Seed and maintain backend market tables in SQLite so workbook data becomes import input rather than runtime storage.
- Preserve raw source fields so later UI/debug views can explain every valuation.

## Data Rules
- Prefer live rune calibration over workbook rune prices.
- Prefer explicit workbook prices over heuristics for non-rune items.
- If a value must be inferred, mark it as derived and keep the calculation path.
- Treat rune stacks, gem bundles, and recipe outputs as first-class market inputs.
- Equipped gear should be valued separately from stashed items, even when the base item is the same.
- Zero-count material placeholders from stackable sectors must not be counted as owned items.

## Output Contract
- `priceIndex`: item name or canonical key -> `{ hrValue, sourceSheet, sourceRow, notes }`
- `inventorySnapshot`: per character -> equipped items, stash items, shared stash items, rune counts
- `accountSnapshot`: total HR value, per-character totals, top items, and time-series point

## Guardrails
- Do not silently drop items that fail to match the market sheet.
- Do not round values until the final presentation layer.
- Log ambiguous item matches with enough context to inspect them manually.
- When vanilla parser paths disagree with stackable-sector material data, prefer the stackable-sector result for rune inventory.
