# PC-SDK Next launcher

One-time setup: `pwsh -File launcher/install-shortcut.ps1` — creates a Start-Menu shortcut named "PC-SDK Next" (pin it to the taskbar from there).

Manual run: `pwsh -File launcher/pc-sdk-launcher.ps1` — checks `http://localhost:5124/health`, starts the server hidden if it's down (waits up to 20s), then opens the app in an Edge/Chrome app window (falls back to default browser). Any failure shows a popup, never silent.

## Freshness (launching IS the refresh flow)

The served UI is a static build (`apps/web/dist`) read from disk per request; agents land code without rebuilding it. Every launch:

- Rebuilds the web UI if `dist` is stale — missing, built from a different commit (`dist/.build-commit`), or older than any file in `apps/web/src` / `packages`. Takes effect on next page refresh even if the server stays up. Build failures pop an error with the log path (`%LOCALAPPDATA%\PC-SDK-Next\logs\web-build.log`).
- If the server is already running but was started from an older commit (stamp: `logs\server.commit`), offers a clean restart via `POST /api/admin/restart`. Open app windows reload themselves.

So after landing changes: just run the launcher (or click the shortcut) again. Nothing else to remember.

The Start-Menu shortcut must point at THIS repo's `pc-sdk-launcher.vbs` — re-run `install-shortcut.ps1` if in doubt. (2026-08-13 incident: a shortcut routed through the stale `PC-SDK-Next-run` worktree while dist sat unbuilt for a month; the UI drifted a month behind the server and sends silently bounced.)

The launcher defaults to a repo-local `data` directory and `%LOCALAPPDATA%\PC-SDK-Next\logs`, so it cannot reuse the working PC-SDK database or logs. It also verifies `PC_INSTANCE_ID=pc-sdk-next` at `/health`, so an unrelated app on the configured port is never mistaken for Next. Overrides remain available through `PC_PORT`, `PC_DATA_DIR`, `PC_LOG_DIR`, and `PC_INSTANCE_ID`.

Backups and logs land under `%LOCALAPPDATA%\PC-SDK-Next`; the database itself defaults to a repo-local `data` directory (override with `PC_DATA_DIR`).

## Backup

`pnpm backup` — copies the live data directory to a timestamped folder under `%LOCALAPPDATA%\PC-SDK-Next\backups`. Safe to run while the server is up.
