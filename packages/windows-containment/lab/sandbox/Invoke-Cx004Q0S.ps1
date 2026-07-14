[CmdletBinding()]
param(
    [ValidateSet('Doctor', 'Run')]
    [string] $Mode = 'Doctor',

    [ValidatePattern('^[0-9a-f]{40}$')]
    [string] $ExpectedS0Commit,

    [ValidatePattern('^[0-9a-f]{40}$')]
    [string] $ExpectedS0Tree
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    throw 'CX-004 Q0S requires Windows.'
}

$modulePath = Join-Path $PSScriptRoot 'Cx004Sandbox.psm1'
Import-Module $modulePath -Force -DisableNameChecking

switch ($Mode) {
    'Doctor' {
        $doctor = Get-Cx004HostDoctor
        $list = Get-Cx004WsbListReceipt -WsbPath $doctor.command.source
        Assert-Cx004NoRunningSessions -RawJson $list.Raw | Out-Null
        [ordered]@{
            outcome = 'ready'
            scope = 'host-only-doctor'
            host = $doctor
            runningSessionCount = 0
        } | ConvertTo-Json -Depth 16
    }
    'Run' {
        if ([string]::IsNullOrWhiteSpace($ExpectedS0Commit) -or [string]::IsNullOrWhiteSpace($ExpectedS0Tree)) {
            throw 'Run mode requires caller-pinned -ExpectedS0Commit and -ExpectedS0Tree values.'
        }
        Invoke-Cx004Q0S -ExpectedS0Commit $ExpectedS0Commit -ExpectedS0Tree $ExpectedS0Tree |
            ConvertTo-Json -Depth 32
    }
}
