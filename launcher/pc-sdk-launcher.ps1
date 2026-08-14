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

function Get-HeadCommit {
    try {
        $head = git -C $RepoRoot rev-parse HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $head) { return $head.Trim() }
    } catch {}
    return $null
}

# ── 0. Freshness gate ────────────────────────────────────────────────────────
# The UI is a static build (apps/web/dist) the server reads from disk on every
# request. Agents land code without rebuilding it, so the launcher rebuilds
# whenever dist is older than the code — otherwise a stale UI runs against a
# newer server and misbehaves in confusing ways (2026-08-13: sends silently
# bounced). Runs even when the server is already up: a rebuild takes effect on
# the next page refresh, no restart needed.
$WebDistIndex = Join-Path $RepoRoot 'apps\web\dist\index.html'
$BuildStamp   = Join-Path $RepoRoot 'apps\web\dist\.build-commit'
$ServerStamp  = Join-Path $LogDir 'server.commit'
$BuildLog     = Join-Path $LogDir 'web-build.log'

function Test-WebDistStale {
    if (-not (Test-Path $WebDistIndex)) { return $true }
    $head = Get-HeadCommit
    if ($head) {
        if (-not (Test-Path $BuildStamp)) { return $true }
        if ((Get-Content $BuildStamp -Raw).Trim() -ne $head) { return $true }
    }
    # Uncommitted edits: any web/shared source newer than the built index.
    $distTime = (Get-Item $WebDistIndex).LastWriteTimeUtc
    $srcRoots = @((Join-Path $RepoRoot 'apps\web\src'), (Join-Path $RepoRoot 'packages'))
    foreach ($root in $srcRoots) {
        if (-not (Test-Path $root)) { continue }
        $newer = Get-ChildItem $root -Recurse -File |
            Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\\.turbo\\|\\coverage\\' } |
            Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
            Select-Object -First 1
        if ($newer) { return $true }
    }
    return $false
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (Test-WebDistStale) {
    $build = Start-Process -FilePath $env:ComSpec `
        -ArgumentList @("/c", "pnpm", "--filter", "@pc-sdk/web", "build") `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $BuildLog `
        -RedirectStandardError "$BuildLog.err" `
        -PassThru -Wait
    if ($build.ExitCode -ne 0) {
        Show-FatalError "The PC-SDK Next app UI is out of date and rebuilding it failed (exit $($build.ExitCode)).`n`nBuild log:`n$BuildLog.err"
    }
    $head = Get-HeadCommit
    if ($head) { Set-Content -Path $BuildStamp -Value $head }
}

# 1. Is the server already up?
if (Test-Health) {
    # Running server loads its code once at boot — if the repo has moved on
    # since (launcher stamps the commit it started from), offer a clean
    # restart via the server's own restart endpoint. Open app windows poll
    # /health and reload themselves afterwards.
    $head = Get-HeadCommit
    if ($head -and (Test-Path $ServerStamp) -and ((Get-Content $ServerStamp -Raw).Trim() -ne $head)) {
        Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
        $choice = [System.Windows.MessageBox]::Show(
            "The PC-SDK Next server is running older code than what's in the repo.`n`nRestart it now to pick up the new code? (Open app windows reload themselves.)",
            "PC-SDK Next Launcher", 'YesNo', 'Question')
        if ($choice -eq 'Yes') {
            try {
                Invoke-RestMethod -Method Post -Uri "http://localhost:$Port/api/admin/restart" -TimeoutSec 5 -ErrorAction Stop | Out-Null
            } catch {
                Show-FatalError "Asked the server to restart but the request failed.`n`n$($_.Exception.Message)"
            }
            # Wait for the NEW process: healthy again with a fresh uptime.
            $restarted = $false
            foreach ($i in 1..30) {
                Start-Sleep -Seconds 1
                try {
                    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 -ErrorAction Stop
                    if ($health.ok -eq $true -and $health.instanceId -eq $InstanceId -and $health.uptimeMs -lt 30000) {
                        $restarted = $true; break
                    }
                } catch {}
            }
            if (-not $restarted) {
                Show-FatalError "The server did not come back healthy within 30 seconds of restarting.`n`nCheck the log:`n$LogFile"
            }
            Set-Content -Path $ServerStamp -Value $head
        }
    }
} else {
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

    $head = Get-HeadCommit
    if ($head) { Set-Content -Path $ServerStamp -Value $head }
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
