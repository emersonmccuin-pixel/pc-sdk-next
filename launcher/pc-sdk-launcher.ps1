#requires -version 7
# One-click PC-SDK Next launcher: ensure its isolated server is up, then open
# the app window. Defaults intentionally differ from the working PC-SDK install.
# Never fails silently — any fatal problem shows a popup.

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $env:PC_PORT) { $env:PC_PORT = '5124' }
if (-not $env:PC_DATA_DIR) { $env:PC_DATA_DIR = Join-Path $RepoRoot 'data' }
if (-not $env:PC_LOG_DIR) { $env:PC_LOG_DIR = Join-Path $env:LOCALAPPDATA 'PC-SDK-Next\logs' }
if (-not $env:PC_INSTANCE_ID) { $env:PC_INSTANCE_ID = 'pc-sdk-next' }

$Port       = $env:PC_PORT
$InstanceId = $env:PC_INSTANCE_ID
$HealthUrl  = "http://localhost:$Port/health"
$AppUrl     = "http://localhost:$Port"
$LogDir     = $env:PC_LOG_DIR
$LogFile    = Join-Path $LogDir "server.log"
$ErrFile    = Join-Path $LogDir "server.err.log"

function Show-FatalError([string]$Message) {
    Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
    try {
        [System.Windows.MessageBox]::Show($Message, "PC-SDK Next Launcher", 'OK', 'Error') | Out-Null
    } catch {
        # Fallback if WPF isn't available for some reason — still don't fail silently.
        msg.exe * $Message 2>$null
    }
    exit 1
}

function Test-Health {
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 -ErrorAction Stop
        return $health.ok -eq $true -and $health.instanceId -eq $InstanceId
    } catch {
        return $false
    }
}

# 1. Is the server already up?
if (-not (Test-Health)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

    # pnpm is a .cmd — CreateProcess (used when redirecting) can't exec it directly.
    $exe        = $env:ComSpec
    $serverArgs = @("/c", "pnpm", "--filter", "@pc-sdk/server", "start")

    try {
        $ServerProcess = Start-Process -FilePath $exe `
            -ArgumentList $serverArgs `
            -WorkingDirectory $RepoRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $LogFile `
            -RedirectStandardError $ErrFile `
            -PassThru
    } catch {
        Show-FatalError "PC-SDK Next server failed to start.`n`n$($_.Exception.Message)"
    }

    # 2. Wait for health, with a hard timeout.
    $timeoutSec = 20
    $elapsed = 0
    $healthy = $false
    while ($elapsed -lt $timeoutSec) {
        if (Test-Health) { $healthy = $true; break }
        if ($ServerProcess.HasExited) {
            if ($ServerProcess.ExitCode -eq 73) {
                Show-FatalError "Another process currently prevents exclusive ownership of this data directory:`n$env:PC_DATA_DIR`n`nNo app database was opened by this launch.`n`nError log:`n$ErrFile"
            }
            if ($ServerProcess.ExitCode -eq 74) {
                Show-FatalError "PC-SDK Next could not prove exclusive ownership of this data directory:`n$env:PC_DATA_DIR`n`nStartup stopped before opening the app database.`n`nError log:`n$ErrFile"
            }
            Show-FatalError "PC-SDK Next server exited before becoming healthy (exit $($ServerProcess.ExitCode)).`n`nError log:`n$ErrFile"
        }
        Start-Sleep -Seconds 1
        $elapsed += 1
    }

    if (-not $healthy) {
        Show-FatalError "PC-SDK Next server did not become healthy within $timeoutSec seconds.`n`nCheck the log:`n$LogFile"
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
        Show-FatalError "Could not launch a browser for PC-SDK Next.`n`n$($_.Exception.Message)"
    }
}
