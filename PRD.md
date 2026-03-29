# D2 Wealth PRD

## Product Goal

Build a reliable Diablo II: Resurrected wealth tracker where a Windows desktop gateway reads local save files, syncs canonical account snapshots to a backend, and presents an authenticated web dashboard with live account value, history, and item ledger views driven by local parsing plus market pricing data.

## Current State

- The repo already has a Windows tray gateway, backend ingest APIs, Discord-backed auth, snapshot history, and a React dashboard.
- Gateway pairing and sync token flows exist.
- Rune normalization and workbook-backed item pricing exist.
- The dashboard can already show overview totals, a history chart, and loot ledger tables.
- CI currently only covers build validation.
- The largest remaining risk is not missing scaffolding. It is proving the desktop-to-backend sync path is trustworthy, stable, and observable enough to use as the primary workflow.

## Success Criteria

- A Windows user can install the gateway, point it at a D2R save directory, pair it to their account, and see backend-served account data update after local file changes.
- Snapshot totals, history, and top-item ledgers reconcile to the parsed item rows.
- Market pricing sources are explicit enough that users can understand where values came from.
- The sync path is covered by local verification and CI checks instead of depending on manual testing alone.
- Each major flow has issue-backed work, reviewable PRs, and enough operational visibility to debug failures.
- PRs are not merged until GitHub code review findings are addressed or explicitly resolved.

## Non-Goals

- Real-money trading features.
- Full online Battle.net support.
- A generic admin console for arbitrary users beyond the D2 Wealth account portal.
- Perfect valuation for every rare, crafted, or affix-sensitive item before the end-to-end sync flow is reliable.

## Milestones

### Milestone 1: Prove End-to-End Sync Reliability

- [ ] Add automated backend and gateway integration tests that cover pairing, token-based ingest, latest snapshot reads, history reads, and disconnect behavior.
- [ ] Add fixture-driven parser validation for at least one character save, one shared stash, and one stackable-material input that produce a deterministic account report.
- [ ] Add reconciliation tests that prove account totals equal the sum of equipped, stash, shared stash, and rune-derived values without double counting.
- [ ] Add a CI workflow step that runs the new automated test suite in addition to the existing build.
- [ ] Add structured sync logging for gateway ingest attempts, backend accept/reject outcomes, and last successful account update timestamps.

### Milestone 2: Harden Desktop Gateway Pairing and Background Sync

- [ ] Validate and improve the Windows gateway pairing UX so first-run install, Discord authorization, backend pairing approval, and save-folder selection form one coherent path.
- [ ] Make gateway status reporting explicit for save validation, pairing state, sync state, and last error so users can tell why the dashboard is stale.
- [ ] Ensure the gateway performs an initial sync on startup, a debounced sync on relevant file changes, and a safe retry path after transient backend failures.
- [ ] Add regression coverage for tray-specific behaviors, especially ignoring the tray's own event subscription when reporting connected viewers.
- [ ] Document the production-safe Windows gateway install, pairing, update, and disconnect flow in the README and release process notes.

### Milestone 3: Make Market Pricing Explainable and Trustworthy

- [ ] Formalize the market pricing contract so rune values, workbook values, derived recipe values, and unresolved items are all surfaced with an explicit source label.
- [ ] Add validation coverage for key rune conversion anchors such as `Ber = 1.0 HR`, `Jah`, `Sur`, `Lo`, `Vex`, `Gul`, and `Ist`.
- [ ] Improve unresolved and ambiguous item reporting so unmatched or low-confidence values are visible in the account report instead of silently disappearing from trust-critical totals.
- [ ] Add tests around mod alias handling for items such as essences, keys, gems, and worldstone shards that are known to differ from workbook labels.
- [ ] Define a refresh workflow for local workbook pricing and remote rune calibration so market data changes are reproducible and reviewable.

### Milestone 4: Ship a Credible Account Dashboard

- [ ] Add a clear backend-driven account health panel in the web app that shows sync freshness, connected gateway clients, and the last successful upload time.
- [ ] Expose valuation provenance in the dashboard so users can inspect why a high-value item or total received its HR amount.
- [ ] Add a visible unresolved-items or warnings panel so parse gaps and suppressed stash data are obvious from the main account view.
- [ ] Tighten the loot ledger so personal stash, carried inventory, shared stash, and rune inventory remain distinct and sortable without conflating their sources.
- [ ] Add an authenticated empty-state flow that clearly guides users when they are signed in but have not yet paired a gateway or uploaded any snapshots.

### Milestone 5: Productionize Delivery and Operations

- [ ] Add a PR template and issue template that reflect the repo's issue-backed, branch-based, test-before-push workflow.
- [ ] Add CI checks for backend buildability and any gateway packaging smoke path that can run safely in GitHub Actions.
- [ ] Add a documented deployment checklist for backend auth config, database persistence, and Discord OAuth production setup.
- [ ] Add release bookkeeping for the Windows MSI so local artifacts, GitHub releases, and release notes stay aligned.
- [ ] Define a minimum observability baseline for production backend health, ingest failures, and account history integrity checks.

## Suggested First Task

- Start with the automated integration and parser validation work in Milestone 1. The repo already has the core product loop. The next bottleneck is trust, not more surface area.
