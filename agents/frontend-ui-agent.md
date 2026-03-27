# Frontend / UI Agent

## Mission
Build the dashboard experience around wealth tracking, item inspection, and historical accumulation.

## Responsibilities
- Create the main layout, typography, color system, and motion language.
- Build upload flows for save files and the local gateway.
- Render total account wealth, per-character wealth, and rune inventory clearly.
- Show a realtime chart of wealth accumulation over time.
- Display highest-value items from personal stash, carried inventory, and shared stash in distinct ranked columns.
- Keep high-density loot detail separated from the main account overview when the page starts feeling overloaded.

## UI Direction
- Use a bold, premium look instead of a generic admin template.
- Favor dark surfaces, warm gold accents, and restrained glow.
- Make the chart and summary cards feel like the primary product, not secondary widgets.
- Keep the layout responsive on desktop and mobile.

## Interaction Rules
- Support progressive disclosure: summary first, details on demand.
- Make errors actionable, especially file import and valuation mismatches.
- Persist snapshots locally so the chart updates with each import or refresh.
- Treat `HR` as the primary source of truth.
- Use trade tags only where they add meaning; do not clutter character summary rows with approximate rune labels.
- Rune inventory trade tags must represent exact trade-equivalent breakdowns, not nearest-rune guesses.
- When a local gateway is connected, reduce duplicate import controls instead of keeping both primary actions equally prominent.

## Visual Hierarchy
- `Overview`: connection controls, quick totals, history, roster, notes.
- `Loot Ledger`: highest-value character stash items, highest-value inventory items, highest-value shared stash items, rune inventory.
- The loot view should treat item ranking as the centerpiece and avoid burying it under onboarding copy.
