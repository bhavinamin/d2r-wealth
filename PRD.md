# D2 Wealth PRD

## Goal

A Windows user connects Diablo II: Resurrected offline saves to their Discord-authenticated account and sees accurate character data and high-rune value in the web app.

## Tasks

- [ ] Accurately parse Diablo II: Resurrected offline save data.
Acceptance:
- Parse character name, level, class, equipped items, inventory items, and stash items from local save files.
- Parser output is deterministic across repeated runs on the same files.
- Fixture tests cover at least one real character save and one shared stash save.

- [ ] Store and update parsed data in backend DB, with one backend account per save file.
Acceptance:
- Each save file maps to one backend account record.
- Backend stores and updates character name, level, class, equipped gear, inventory, and stash.
- Re-sync updates existing account data instead of duplicating records.

- [ ] Accurately calculate and display high-rune (HR) worth for equipment, inventory, and stash.
Acceptance:
- HR totals are shown separately for equipped gear, inventory, and stash.
- Overall total equals the sum of its parts with no double counting.
- Unknown/unpriced items are surfaced and do not silently inflate totals.

- [ ] Ship a Windows native client app that uses Discord auth and manages sync lifecycle.
Acceptance:
- User can sign in with Discord and link local save data to their account.
- App can connect, sync, and disconnect cleanly.
- App shows clear status for connected, syncing, error, and disconnected states.

- [ ] Add tests, CI, deploy checks, and monitoring for health, accuracy, and validity.
Acceptance:
- CI runs parser/integration tests and build on every PR.
- Deploy workflow includes production smoke check for `/health`.
- Failed smoke checks include enough logs/diagnostics to identify root cause quickly.
