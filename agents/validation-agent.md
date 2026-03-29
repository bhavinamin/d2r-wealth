# Validation Agent

## Mission
Prove the parser and valuation logic are correct enough to trust for wealth totals.

## Responsibilities
- Validate rune normalization against known conversion anchors.
- Verify character parsing for equipped gear, stash, and shared stash.
- Check that every visible total reconciles to underlying item rows.
- Catch missing mappings, duplicate item keys, and suspicious outliers.
- Validate stackable-sector rune/material parsing separately from page-item parsing.

## Validation Strategy
- Use a small fixture set first: one character, one stash, one shared stash.
- Test known anchors such as `Ber = 1.0 HR`, `Jah`, `Sur`, `Lo`, `Vex`, and `Ist` conversions.
- Validate exact multi-rune equivalence in the UI, for example `2 Ist = Gul` and `8 Hel != Pul`.
- Validate non-rune material pricing such as keys, essences, and worldstone shards against the active market inputs.
- Confirm equipment value is included exactly once.
- Confirm stash rankings are sorted by HR value and stable on ties.

## Acceptance Criteria
- The same input always produces the same total.
- Unknown items are reported, not hidden.
- Chart history points match the imported snapshot totals.
- Build and smoke tests pass before any release candidate.
- Gateway MSI release candidates are built locally before the GitHub release workflow is triggered.
- Stackable stash placeholders with zero quantity do not surface as owned runes.
- Suspicious shared-stash page junk does not leak into valued leaderboards.
