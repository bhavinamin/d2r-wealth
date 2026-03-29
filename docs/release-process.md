# Release Process Notes

## Gateway MSI

Use this checklist for every Windows gateway release so the published MSI matches the locally validated artifact and the user-facing notes stay honest.

1. Run `npm install` if dependencies changed.
2. Run `npm run dist:gateway` on Windows to produce the local MSI in `release/`.
3. Confirm the artifact name matches `D2-Wealth-Gateway-<version>.msi`.
4. Install that local MSI on a Windows machine before triggering the GitHub release workflow.
5. Verify the install, pairing, update, and disconnect paths below against the local artifact.
6. Trigger the GitHub `Release Gateway MSI` workflow only after the local artifact passes the manual checks.
7. Confirm the GitHub release uploads `release/D2-Wealth-Gateway-Setup.msi` for the same version.
8. Copy the validated behavior summary into the GitHub release notes.

## Manual Validation

### Install And Pair

1. Start from a machine that is not currently paired, or click `Disconnect` first.
2. Install the MSI and launch `D2 Wealth Gateway`.
3. Confirm the default backend points at `https://d2r.bjav.io`.
4. Point the app at a valid Diablo II save folder and save the setting.
5. Click `Sign in with Discord` and complete pairing in the browser.
6. Verify the tray settings show `Paired`, then `Synced`, after the first successful upload.

### Update

1. Quit the running tray app.
2. Install the newer MSI over the existing per-user install.
3. Launch the gateway again.
4. Verify the previous save folder is still present.
5. Verify the install remains paired and can reach `Synced` without minting a new token.

### Disconnect

1. Click `Disconnect` in the tray settings window.
2. Verify the saved sync token is cleared locally.
3. Verify the backend no longer accepts the old token for ingest.
4. Verify the same install must pair again before it can sync.

## Release Notes Minimum

Each gateway release note should state:

- the gateway version
- whether the MSI was locally validated before the workflow ran
- that install uses the tray app plus Discord pairing
- whether upgrades preserved the previous save folder and pairing
- whether disconnect still revoked the prior token and forced re-pairing
