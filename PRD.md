# D2 Wealth PRD

## End State

A user can run the Windows gateway against local D2R offline saves and trust the web app's reported account worth because parsing, valuation, and sync are accurate and transparent.

## Core Tasks

- [ ] Make save parsing deterministic across character save, shared stash, and stackable materials with fixture tests.
- [ ] Make account valuation trustworthy by reconciling totals to item-level values with no double counting.
- [ ] Make gateway-to-backend sync reliable (pairing, ingest, latest/history reads, disconnect, retry) with integration tests.
- [ ] Make the dashboard trustworthy by showing valuation provenance, sync freshness, and unresolved-item warnings.
- [ ] Enforce quality gates so CI and deploy smoke checks fail fast on regressions and backend health issues.
