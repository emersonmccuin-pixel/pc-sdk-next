#requires -version 7
# Creates a Start-Menu shortcut for PC-SDK that runs the launcher with no console flash.
# Right-click the created shortcut -> Pin to taskbar.

$ErrorActionPreference = 'Stop'

$RepoRoot     = Split-Path -Parent $PSScriptRoot
$LauncherPs1  = Join-Path $PSScriptRoot "pc-sdk-launcher.ps1"
$StartMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$ShortcutPath = Join-Path $StartMenuDir "PC-SDK.lnk"

if (-not (Test-Path $LauncherPs1)) {
    throw "Launcher script not found at $LauncherPs1"
}

$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue)
if (-not $pwsh) { $pwsh = Get-Command powershell.exe }

# -WindowStyle Hidden on pwsh still flashes a console briefly; wrap via wscript for a truly
# invisible launch (0 = hidden window, no wait).
$wrapperVbs = Join-Path $PSScriptRoot "pc-sdk-launcher.vbs"
$vbsContent = @"
Set shell = CreateObject("WScript.Shell")
cmd = """$($pwsh.Source)"" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$LauncherPs1"""
shell.Run cmd, 0, False
"@
Set-Content -Path $wrapperVbs -Value $vbsContent -Encoding ASCII

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments  = "//B `"$wrapperVbs`""
$Shortcut.WorkingDirectory = $RepoRoot
$Shortcut.IconLocation = "$($pwsh.Source),0"
$Shortcut.Description = "Launch PC-SDK"
$Shortcut.Save()

Write-Host "Shortcut created: $ShortcutPath"
Write-Host "Open the Start Menu, find PC-SDK, right-click -> Pin to taskbar."
