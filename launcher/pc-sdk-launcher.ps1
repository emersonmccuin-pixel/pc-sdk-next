#requires -version 7
# One-click PC-SDK launcher: ensure server is up, then open the app window.
# Never fails silently — any fatal problem shows a popup.

$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$Port       = if ($env:PC_PORT) { $env:PC_PORT } else { 5123 }
$HealthUrl  = "http://localhost:$Port/health"
$AppUrl     = "http://localhost:$Port"
$ServerDist = Join-Path $RepoRoot "apps\server\dist\index.js"
$LogDir     = Join-Path $env:LOCALAPPDATA "PC-SDK\logs"
$LogFile    = Join-Path $LogDir "server.log"

function Show-FatalError([string]$Message) {
    Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
    try {
        [System.Windows.MessageBox]::Show($Message, "PC-SDK Launcher", 'OK', 'Error') | Out-Null
    } catch {
        # Fallback if WPF isn't available for some reason — still don't fail silently.
        msg.exe * $Message 2>$null
    }
    exit 1
}

function Test-Health {
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

# 1. Is the server already up?
if (-not (Test-Health)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

    if (Test-Path $ServerDist) {
        $exe  = "node"
        $args = @($ServerDist)
    } else {
        # Fall back to workspace start script if a build hasn't been produced yet.
        $exe  = "pnpm"
        $args = @("--filter", "@pc-sdk/server", "start")
    }

    try {
        Start-Process -FilePath $exe `
            -ArgumentList $args `
            -WorkingDirectory $RepoRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $LogFile `
            -RedirectStandardError $LogFile `
            | Out-Null
    } catch {
        Show-FatalError "PC-SDK server failed to start.`n`n$($_.Exception.Message)"
    }

    # 2. Wait for health, with a hard timeout.
    $timeoutSec = 20
    $elapsed = 0
    $healthy = $false
    while ($elapsed -lt $timeoutSec) {
        if (Test-Health) { $healthy = $true; break }
        Start-Sleep -Seconds 1
        $elapsed += 1
    }

    if (-not $healthy) {
        Show-FatalError "PC-SDK server did not become healthy within $timeoutSec seconds.`n`nCheck the log:`n$LogFile"
    }
}

# 3. Launch the app window: msedge --app, then chrome, then default browser.
$browserArgs = @("--app=$AppUrl")
$launched = $false

foreach ($candidate in @("msedge.exe", "chrome.exe")) {
    $path = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($path) {
        Start-Process -FilePath $path.Source -ArgumentList $browserArgs
        $launched = $true
        break
    }
}

if (-not $launched) {
    try {
        Start-Process $AppUrl
        $launched = $true
    } catch {
        Show-FatalError "Could not launch a browser for PC-SDK.`n`n$($_.Exception.Message)"
    }
}
