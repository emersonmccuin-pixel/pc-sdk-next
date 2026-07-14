[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$script:Cx004SchemaVersion = 'cx004-q0s-v1'
$script:Cx004InputRoot = 'C:\CX004\input'
$script:Cx004OutputRoot = 'C:\CX004\output'
$script:Cx004ScratchRoot = 'C:\CX004\scratch'
$script:Cx004StableFiles = @('guest-bootstrap.ps1', 'guest-probe.ps1')
$script:Cx004InputFiles = @(
    'guest-bootstrap.ps1',
    'guest-probe.ps1',
    'run-manifest.json',
    'stable-manifest.json'
)
$script:Cx004Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$script:Cx004MaxScriptBytes = 16MB
$script:Cx004MaxManifestBytes = 64KB

function Assert-Cx004ExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($null -eq $Value -or $Value -is [System.Array]) {
        throw "$Context must be one JSON object."
    }

    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Expected.Count) {
        throw "$Context has an unexpected property count."
    }
    foreach ($name in $Expected) {
        if (-not ($actual -ccontains $name)) {
            throw "$Context is missing property '$name'."
        }
    }
}

function Assert-Cx004LowerHex {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][int]$Length,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($Value.Length -ne $Length -or $Value -cnotmatch ('^[0-9a-f]{' + $Length + '}$')) {
        throw "$Context must be exactly $Length lowercase hexadecimal characters."
    }
}

function Assert-Cx004HostCanaryEndpoint {
    param(
        [Parameter(Mandatory = $true)]$Address,
        [Parameter(Mandatory = $true)]$Port,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($Address -isnot [string] -or
        $Address.Length -le 0 -or
        $Address.Length -gt 15) {
        throw "$Context address must be a bounded canonical IPv4 string."
    }

    $parsedAddress = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsedAddress) -or
        $parsedAddress.AddressFamily -ne
            [System.Net.Sockets.AddressFamily]::InterNetwork -or
        $parsedAddress.ToString() -cne $Address -or
        [System.Net.IPAddress]::IsLoopback($parsedAddress) -or
        $parsedAddress.Equals([System.Net.IPAddress]::Any) -or
        $parsedAddress.Equals([System.Net.IPAddress]::None)) {
        throw "$Context address must be one canonical non-loopback IPv4 address."
    }

    $octets = $parsedAddress.GetAddressBytes()
    if ($octets[0] -eq 0 -or
        ($octets[0] -eq 169 -and $octets[1] -eq 254) -or
        $octets[0] -ge 224) {
        throw "$Context address must be a unicast host IPv4 address."
    }

    if ((($Port -isnot [int]) -and ($Port -isnot [long])) -or
        [long]$Port -lt 1 -or
        [long]$Port -gt 65535) {
        throw "$Context port must be an integer from 1 through 65535."
    }
}

function Get-Cx004FileSha256 {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $stream = [System.IO.File]::Open(
        $LiteralPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read)
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            $digest = $algorithm.ComputeHash($stream)
        }
        finally {
            $algorithm.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }

    return (($digest | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Read-Cx004JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][long]$MaximumBytes,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $file = New-Object System.IO.FileInfo($LiteralPath)
    if (-not $file.Exists -or $file.Length -le 0 -or $file.Length -gt $MaximumBytes) {
        throw "$Context has an invalid byte length."
    }

    $bytes = [System.IO.File]::ReadAllBytes($LiteralPath)
    if ($bytes.Length -ge 3 -and
        $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw "$Context must be UTF-8 without a byte-order mark."
    }
    $text = $script:Cx004Utf8.GetString($bytes)
    if ($text.IndexOf([char]0) -ge 0) {
        throw "$Context contains a NUL character."
    }
    try {
        return ($text | ConvertFrom-Json)
    }
    catch {
        throw "$Context is not valid JSON."
    }
}

function Assert-Cx004RegularFile {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][long]$MaximumBytes,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $file = New-Object System.IO.FileInfo($LiteralPath)
    if (-not $file.Exists -or $file.Length -le 0 -or $file.Length -gt $MaximumBytes) {
        throw "$Context is missing or has an invalid byte length."
    }
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Context must not be a reparse point."
    }
}

function Write-Cx004Failure {
    param(
        [Parameter(Mandatory = $true)][string]$RunId,
        [Parameter(Mandatory = $true)][string]$Challenge,
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$Code
    )

    if (-not [System.IO.Directory]::Exists($script:Cx004OutputRoot)) {
        return
    }
    if ($Stage -cnotmatch '^[a-z][a-z0-9-]{0,63}$' -or
        $Code -cnotmatch '^[a-z][a-z0-9-]{0,63}$') {
        return
    }

    $failure = [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        runId = $RunId
        challenge = $Challenge
        stage = $Stage
        code = $Code
    }
    $json = ($failure | ConvertTo-Json -Depth 4 -Compress) + "`n"
    $bytes = $script:Cx004Utf8.GetBytes($json)
    if ($bytes.Length -gt 4096) {
        return
    }

    $temporaryPath = [System.IO.Path]::Combine(
        $script:Cx004OutputRoot,
        '.guest-failure-' + $Challenge + '.tmp')
    $finalPath = [System.IO.Path]::Combine($script:Cx004OutputRoot, 'guest-failure.json')
    try {
        $stream = New-Object System.IO.FileStream(
            $temporaryPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
        [System.IO.File]::Move($temporaryPath, $finalPath)
    }
    catch {
        if ([System.IO.File]::Exists($temporaryPath)) {
            try { [System.IO.File]::Delete($temporaryPath) } catch { }
        }
    }
}

$stage = 'input-root-validation'
$runId = $null
$challenge = $null

try {
    if (-not [System.IO.Directory]::Exists($script:Cx004InputRoot)) {
        throw 'The fixed input mapping is unavailable.'
    }
    if (-not [System.IO.Directory]::Exists($script:Cx004OutputRoot)) {
        throw 'The fixed output mapping is unavailable.'
    }
    if (@(
        [System.IO.Directory]::EnumerateFileSystemEntries($script:Cx004OutputRoot)
    ).Count -ne 0) {
        throw 'The fixed output mapping is not empty.'
    }

    $inputEntries = @([System.IO.Directory]::EnumerateFileSystemEntries($script:Cx004InputRoot))
    if ($inputEntries.Count -ne $script:Cx004InputFiles.Count) {
        throw 'The input mapping does not contain the closed file count.'
    }
    $inputNames = @($inputEntries | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    foreach ($name in $script:Cx004InputFiles) {
        if (-not ($inputNames -ccontains $name)) {
            throw "The input mapping is missing '$name'."
        }
    }
    foreach ($entry in $inputEntries) {
        if ([System.IO.Directory]::Exists($entry)) {
            throw 'The input mapping must not contain a directory.'
        }
    }

    $stableManifestPath = [System.IO.Path]::Combine(
        $script:Cx004InputRoot,
        'stable-manifest.json')
    $runManifestPath = [System.IO.Path]::Combine(
        $script:Cx004InputRoot,
        'run-manifest.json')
    Assert-Cx004RegularFile `
        -LiteralPath $stableManifestPath `
        -MaximumBytes $script:Cx004MaxManifestBytes `
        -Context 'stable-manifest.json'
    Assert-Cx004RegularFile `
        -LiteralPath $runManifestPath `
        -MaximumBytes $script:Cx004MaxManifestBytes `
        -Context 'run-manifest.json'

    $stage = 'run-manifest-validation'
    $runManifest = Read-Cx004JsonFile `
        -LiteralPath $runManifestPath `
        -MaximumBytes $script:Cx004MaxManifestBytes `
        -Context 'run-manifest.json'
    $runManifestSha256 = Get-Cx004FileSha256 -LiteralPath $runManifestPath
    Assert-Cx004ExactProperties `
        -Value $runManifest `
        -Expected @(
            'schemaVersion',
            'runId',
            'challenge',
            'stableManifestSha256',
            'renderedConfigSha256',
            'hostCanaryAddress',
            'hostCanaryPort') `
        -Context 'run-manifest.json'
    if ($runManifest.schemaVersion -cne $script:Cx004SchemaVersion) {
        throw 'run-manifest.json has an unsupported schema version.'
    }
    if ($runManifest.runId -isnot [string] -or
        $runManifest.runId -cnotmatch '^[0-9a-f]{32}$') {
        throw 'run-manifest.json has an invalid run id.'
    }
    if ($runManifest.challenge -isnot [string] -or
        $runManifest.stableManifestSha256 -isnot [string] -or
        $runManifest.renderedConfigSha256 -isnot [string]) {
        throw 'run-manifest.json hash fields must be strings.'
    }
    Assert-Cx004LowerHex -Value $runManifest.challenge -Length 64 -Context 'challenge'
    Assert-Cx004LowerHex `
        -Value $runManifest.stableManifestSha256 `
        -Length 64 `
        -Context 'stableManifestSha256'
    Assert-Cx004LowerHex `
        -Value $runManifest.renderedConfigSha256 `
        -Length 64 `
        -Context 'renderedConfigSha256'
    Assert-Cx004HostCanaryEndpoint `
        -Address $runManifest.hostCanaryAddress `
        -Port $runManifest.hostCanaryPort `
        -Context 'host canary'
    $runId = $runManifest.runId
    $challenge = $runManifest.challenge

    $stage = 'stable-manifest-validation'
    $stableManifest = Read-Cx004JsonFile `
        -LiteralPath $stableManifestPath `
        -MaximumBytes $script:Cx004MaxManifestBytes `
        -Context 'stable-manifest.json'
    Assert-Cx004ExactProperties `
        -Value $stableManifest `
        -Expected @('schemaVersion', 'files') `
        -Context 'stable-manifest.json'
    if ($stableManifest.schemaVersion -cne $script:Cx004SchemaVersion) {
        throw 'stable-manifest.json has an unsupported schema version.'
    }
    if ((Get-Cx004FileSha256 -LiteralPath $stableManifestPath) -cne
        $runManifest.stableManifestSha256) {
        throw 'stable-manifest.json does not match its run-bound digest.'
    }

    $stableFiles = @($stableManifest.files)
    if ($stableFiles.Count -ne $script:Cx004StableFiles.Count) {
        throw 'stable-manifest.json has an unexpected file count.'
    }
    for ($index = 0; $index -lt $script:Cx004StableFiles.Count; $index++) {
        $entry = $stableFiles[$index]
        Assert-Cx004ExactProperties `
            -Value $entry `
            -Expected @('relativePath', 'sha256', 'length') `
            -Context "stable-manifest.json files[$index]"
        if ($entry.relativePath -isnot [string] -or
            $entry.relativePath -cne $script:Cx004StableFiles[$index]) {
            throw 'stable-manifest.json files are not in the closed canonical order.'
        }
        if ($entry.sha256 -isnot [string]) {
            throw 'A stable file digest is not a string.'
        }
        Assert-Cx004LowerHex `
            -Value $entry.sha256 `
            -Length 64 `
            -Context "stable-manifest.json files[$index].sha256"
        if (($entry.length -isnot [int]) -and ($entry.length -isnot [long])) {
            throw 'A stable file length is not an integer.'
        }
        if ($entry.length -le 0 -or $entry.length -gt $script:Cx004MaxScriptBytes) {
            throw 'A stable file length is outside the closed bound.'
        }

        $sourcePath = [System.IO.Path]::Combine(
            $script:Cx004InputRoot,
            $entry.relativePath)
        Assert-Cx004RegularFile `
            -LiteralPath $sourcePath `
            -MaximumBytes $script:Cx004MaxScriptBytes `
            -Context $entry.relativePath
        $sourceInfo = New-Object System.IO.FileInfo($sourcePath)
        if ($sourceInfo.Length -ne $entry.length -or
            (Get-Cx004FileSha256 -LiteralPath $sourcePath) -cne $entry.sha256) {
            throw "Stable input '$($entry.relativePath)' does not match its manifest."
        }
    }

    $stage = 'scratch-copy'
    if ([System.IO.Directory]::Exists($script:Cx004ScratchRoot) -or
        [System.IO.File]::Exists($script:Cx004ScratchRoot)) {
        throw 'The guest-local scratch root is not fresh.'
    }
    [System.IO.Directory]::CreateDirectory($script:Cx004ScratchRoot) | Out-Null

    foreach ($name in @('stable-manifest.json', 'run-manifest.json')) {
        [System.IO.File]::Copy(
            [System.IO.Path]::Combine($script:Cx004InputRoot, $name),
            [System.IO.Path]::Combine($script:Cx004ScratchRoot, $name),
            $false)
    }
    foreach ($entry in $stableFiles) {
        [System.IO.File]::Copy(
            [System.IO.Path]::Combine($script:Cx004InputRoot, $entry.relativePath),
            [System.IO.Path]::Combine($script:Cx004ScratchRoot, $entry.relativePath),
            $false)
    }

    $copiedStableManifestPath = [System.IO.Path]::Combine(
        $script:Cx004ScratchRoot,
        'stable-manifest.json')
    $copiedRunManifestPath = [System.IO.Path]::Combine(
        $script:Cx004ScratchRoot,
        'run-manifest.json')
    if ((Get-Cx004FileSha256 -LiteralPath $copiedStableManifestPath) -cne
        $runManifest.stableManifestSha256) {
        throw 'The copied stable manifest failed re-verification.'
    }
    if ((Get-Cx004FileSha256 -LiteralPath $copiedRunManifestPath) -cne
        $runManifestSha256) {
        throw 'The copied run manifest failed byte-for-byte re-verification.'
    }
    foreach ($entry in $stableFiles) {
        $copiedPath = [System.IO.Path]::Combine(
            $script:Cx004ScratchRoot,
            $entry.relativePath)
        $copiedInfo = New-Object System.IO.FileInfo($copiedPath)
        if ($copiedInfo.Length -ne $entry.length -or
            (Get-Cx004FileSha256 -LiteralPath $copiedPath) -cne $entry.sha256) {
            throw "Copied stable input '$($entry.relativePath)' failed re-verification."
        }
    }
    foreach ($name in @(
        'stable-manifest.json',
        'run-manifest.json',
        'guest-bootstrap.ps1',
        'guest-probe.ps1')) {
        $copiedPath = [System.IO.Path]::Combine($script:Cx004ScratchRoot, $name)
        [System.IO.File]::SetAttributes($copiedPath, [System.IO.FileAttributes]::ReadOnly)
    }

    $stage = 'probe-execution'
    $probePath = [System.IO.Path]::Combine($script:Cx004ScratchRoot, 'guest-probe.ps1')
    & $probePath | Out-Null

    $stage = 'terminal-receipt-validation'
    $terminalPath = [System.IO.Path]::Combine(
        $script:Cx004OutputRoot,
        'result-manifest.json')
    if (-not [System.IO.File]::Exists($terminalPath)) {
        throw 'The guest probe returned without a terminal result manifest.'
    }
    if ([System.IO.File]::Exists(
        [System.IO.Path]::Combine($script:Cx004OutputRoot, 'guest-failure.json'))) {
        throw 'A failure receipt exists beside the terminal result manifest.'
    }
    $resultNames = @(
        [System.IO.Directory]::EnumerateFileSystemEntries($script:Cx004OutputRoot) |
            ForEach-Object { [System.IO.Path]::GetFileName($_) }
    )
    if ($resultNames.Count -ne 2 -or
        -not ($resultNames -ccontains 'guest-evidence.json') -or
        -not ($resultNames -ccontains 'result-manifest.json')) {
        throw 'The guest probe returned an unexpected output file set.'
    }
}
catch {
    if ($null -ne $runId -and $null -ne $challenge) {
        Write-Cx004Failure `
            -RunId $runId `
            -Challenge $challenge `
            -Stage $stage `
            -Code 'guest-bootstrap-failed'
    }
    exit 71
}

exit 0
