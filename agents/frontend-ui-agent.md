# Frontend / UI Agent

## Mission
Build the dashboard experience around wealth tracking, item inspection, and historical accumulation.

## Responsibilities
- Create the main layout, typography, color system, and motion language.
- Build the authenticated dashboard and the unauthenticated getting-started flow.
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
- Make errors actionable, especially auth, gateway setup, sync, and valuation mismatches.
- Treat `HR` as the primary source of truth.
- Use trade tags only where they add meaning; do not clutter character summary rows with approximate rune labels.
- Rune inventory trade tags must represent exact trade-equivalent breakdowns, not nearest-rune guesses.
- Do not expose raw localhost connect controls in the browser once the product is backend-first.
- Keep setup steps explicit for Discord sign-in, token retrieval, and gateway installation.

## Delivery Workflow
- Treat each PRD task as an issue-backed unit of work.
- Make UI changes on a dedicated branch, not on `master`.
- Keep changes scoped so one issue maps cleanly to one draft PR.
- Add or update focused tests when the repo already has a relevant harness; otherwise keep the change buildable and note the verification gap.
- Run local verification before pushing, then use a PR that references and closes the issue on merge.

## Visual Hierarchy
- Signed-out landing: product overview, setup steps, Discord sign-in, gateway setup guidance.
- `Overview`: authenticated quick totals, history, roster, notes.
- `Loot Ledger`: highest-value character stash items, highest-value inventory items, highest-value shared stash items, rune inventory.
- The loot view should treat item ranking as the centerpiece and avoid burying it under onboarding copy.
