# PC-SDK launcher

One-time setup: `pwsh -File launcher/install-shortcut.ps1` — creates a Start-Menu shortcut named "PC-SDK" (pin it to the taskbar from there).

Manual run: `pwsh -File launcher/pc-sdk-launcher.ps1` — checks `http://localhost:5123/health`, starts the server hidden if it's down (waits up to 20s), then opens the app in an Edge/Chrome app window (falls back to default browser). Any failure shows a popup, never silent.

Server logs: `%LOCALAPPDATA%\PC-SDK\logs\server.log`. Port override: set `PC_PORT` before running.
