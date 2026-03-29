# D2 Wealth PRD

## End State

A user can run the Windows gateway against local D2R offline saves and trust the web app's reported account worth because parsing, valuation, and sync are accurate and transparent.

## Definition of Done

- Save parsing is deterministic and validated by fixtures.
- Account totals reconcile to item-level valuations.
- Gateway sync to backend is reliable and observable.
- Web UI clearly shows value, source, freshness, and unresolved items.
- CI and deploy checks catch regressions before merge.

## Guardrails

- Do not add unrelated platform/process work.
- Do not widen scope beyond offline saves, valuation accuracy, sync reliability, and dashboard trust.
- Prefer small, test-backed changes over broad refactors.

## Roadmap

### 1) Parse and Valuation Accuracy

- [ ] Keep fixture-driven parser tests for character save, shared stash, and stackable materials deterministic.
- [ ] Keep valuation reconciliation tests proving total equals equipped + stash + shared + rune-derived value without double counting.
- [ ] Keep mod alias normalization coverage (keys, essences, gems, worldstone shards) aligned with workbook labels.
- [ ] Keep unresolved and ambiguous item handling explicit instead of silently dropping value.

### 2) Gateway to Backend Reliability

- [ ] Keep end-to-end integration tests for pairing, token ingest, latest/history reads, and disconnect behavior.
- [ ] Keep startup sync, file-change sync, and retry behavior stable and regression-tested.
- [ ] Keep gateway status output explicit for save validation, pairing state, sync state, and last error.
- [ ] Ensure backend `/health` and ingest status remain production-observable and test-covered.

### 3) Web App Trust Surface

- [ ] Keep account value, history, and item ledger views consistent with backend snapshots.
- [ ] Keep valuation provenance visible (rune market, workbook, derived, unresolved).
- [ ] Keep sync freshness and gateway status clearly visible in the dashboard.
- [ ] Keep unresolved/warning panels visible so missing confidence is obvious to users.

### 4) Quality Gates

- [ ] CI must run tests and build for every PR.
- [ ] Deploy workflow must include production smoke check for `https://d2r.bjav.io/health`.
- [ ] Failed deploy smoke checks must emit enough server diagnostics to debug quickly.
