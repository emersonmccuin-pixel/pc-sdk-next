# PC-SDK Next launcher

One-time setup: `pwsh -File launcher/install-shortcut.ps1` — creates a Start-Menu shortcut named "PC-SDK Next" (pin it to the taskbar from there).

Manual run: `pwsh -File launcher/pc-sdk-launcher.ps1` — checks `http://localhost:5124/health`, starts the server hidden if it's down (waits up to 20s), then opens the app in an Edge/Chrome app window (falls back to default browser). Any failure shows a popup, never silent.

The launcher defaults to a repo-local `data` directory and `%LOCALAPPDATA%\PC-SDK-Next\logs`, so it cannot reuse the working PC-SDK database or logs. It also verifies `PC_INSTANCE_ID=pc-sdk-next` at `/health`, so an unrelated app on the configured port is never mistaken for Next. Overrides remain available through `PC_PORT`, `PC_DATA_DIR`, `PC_LOG_DIR`, and `PC_INSTANCE_ID`.
