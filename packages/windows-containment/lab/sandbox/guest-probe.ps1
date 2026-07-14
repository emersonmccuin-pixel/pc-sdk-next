[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$script:Cx004SchemaVersion = 'cx004-q0s-v1'
$script:Cx004InputRoot = 'C:\CX004\input'
$script:Cx004OutputRoot = 'C:\CX004\output'
$script:Cx004ScratchRoot = 'C:\CX004\scratch'
$script:Cx004PersistenceCanary = 'C:\CX004\q0s-persistence-canary.json'
$script:Cx004StableFiles = @('guest-bootstrap.ps1', 'guest-probe.ps1')
$script:Cx004Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$script:Cx004MaxManifestBytes = 64KB
$script:Cx004MaxScriptBytes = 16MB
$script:Cx004MaxEvidenceBytes = 1MB

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

function ConvertTo-Cx004IntegrityAlias {
    param([Parameter(Mandatory = $true)]$Sid)

    if ($Sid -isnot [string]) {
        throw 'The integrity SID must be a string.'
    }

    switch -CaseSensitive ($Sid) {
        'S-1-16-4096' { return 'low' }
        'S-1-16-8192' { return 'medium' }
        'S-1-16-8448' { return 'medium-plus' }
        'S-1-16-12288' { return 'high' }
        'S-1-16-16384' { return 'system' }
        'S-1-16-20480' { return 'protected-process' }
        default { throw "The integrity SID '$Sid' is outside the closed well-known set." }
    }
}

function Test-Cx004FileAccessDeniedFacts {
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $ErrorType,
        [Parameter(Mandatory)] [long] $ErrorHResult,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $ErrorInnerType,
        [Parameter(Mandatory)] [long] $ErrorInnerHResult,
        [Parameter(Mandatory)] [bool] $ErrorInnerHasInnerException
    )

    return $ErrorType -ceq 'System.Management.Automation.MethodInvocationException' -and
        $ErrorHResult -eq -2146233087 -and
        $ErrorInnerType -ceq 'System.UnauthorizedAccessException' -and
        $ErrorInnerHResult -eq -2147024891 -and
        (-not $ErrorInnerHasInnerException)
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

function Write-Cx004AtomicJson {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$FinalName,
        [Parameter(Mandatory = $true)][string]$Challenge,
        [Parameter(Mandatory = $true)][long]$MaximumBytes
    )

    if ($FinalName -cnotmatch '^[a-z][a-z0-9-]*\.json$') {
        throw 'The output file name is outside the closed allowlist shape.'
    }
    $json = ($Value | ConvertTo-Json -Depth 12 -Compress) + "`n"
    $bytes = $script:Cx004Utf8.GetBytes($json)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $MaximumBytes) {
        throw "Output '$FinalName' is outside its byte bound."
    }

    $temporaryPath = [System.IO.Path]::Combine(
        $script:Cx004OutputRoot,
        '.' + $FinalName + '-' + $Challenge + '.tmp')
    $finalPath = [System.IO.Path]::Combine($script:Cx004OutputRoot, $FinalName)
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

function Invoke-Cx004FixedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$Arguments,
        [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FileName
    $startInfo.Arguments = $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw 'A fixed identity probe did not start.'
        }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch { }
            $process.WaitForExit()
            throw 'A fixed identity probe exceeded its deadline.'
        }
        if ($process.ExitCode -ne 0) {
            throw 'A fixed identity probe returned a failure status.'
        }
        $output = $stdout.GetAwaiter().GetResult()
        $errorText = $stderr.GetAwaiter().GetResult()
        if (-not [string]::IsNullOrWhiteSpace($errorText)) {
            throw 'A fixed identity probe wrote to stderr.'
        }
        return $output
    }
    finally {
        $process.Dispose()
    }
}

function Test-Cx004RoutableAddress {
    param([Parameter(Mandatory = $true)][System.Net.IPAddress]$Address)

    if ([System.Net.IPAddress]::IsLoopback($Address) -or
        $Address.Equals([System.Net.IPAddress]::Any) -or
        $Address.Equals([System.Net.IPAddress]::IPv6Any) -or
        $Address.Equals([System.Net.IPAddress]::None) -or
        $Address.Equals([System.Net.IPAddress]::IPv6None) -or
        $Address.IsIPv6LinkLocal -or
        $Address.IsIPv6Multicast) {
        return $false
    }
    if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        $octets = $Address.GetAddressBytes()
        if ($octets[0] -eq 169 -and $octets[1] -eq 254) {
            return $false
        }
        if ($octets[0] -ge 224) {
            return $false
        }
    }
    return $true
}

function Test-Cx004TcpCanary {
    param(
        [Parameter(Mandatory = $true)][string]$Address,
        [Parameter(Mandatory = $true)][int]$Port
    )

    $client = New-Object System.Net.Sockets.TcpClient
    $waitHandle = $null
    try {
        $pending = $client.BeginConnect($Address, $Port, $null, $null)
        $waitHandle = $pending.AsyncWaitHandle
        if (-not $waitHandle.WaitOne(1500)) {
            return [pscustomobject][ordered]@{
                succeeded = $false
                disposition = 'timeout'
            }
        }
        try {
            $client.EndConnect($pending)
            if ($client.Connected) {
                return [pscustomobject][ordered]@{
                    succeeded = $true
                    disposition = 'connected'
                }
            }
            return [pscustomobject][ordered]@{
                succeeded = $false
                disposition = 'probe-error'
            }
        }
        catch {
            $failureDisposition = Get-Cx004NetworkFailureDisposition `
                -Exception $_.Exception `
                -ProbeKind 'Tcp'
            return [pscustomobject][ordered]@{
                succeeded = $false
                disposition = $failureDisposition
            }
        }
    }
    catch {
        $failureDisposition = Get-Cx004NetworkFailureDisposition `
            -Exception $_.Exception `
            -ProbeKind 'Tcp'
        return [pscustomobject][ordered]@{
            succeeded = $false
            disposition = $failureDisposition
        }
    }
    finally {
        if ($null -ne $waitHandle) {
            $waitHandle.Dispose()
        }
        $client.Dispose()
    }
}

function Get-Cx004NetworkFailureDisposition {
    param(
        [Parameter(Mandatory = $true)][System.Exception]$Exception,
        [Parameter(Mandatory = $true)]
        [ValidateSet('Tcp', 'Dns')]
        [string]$ProbeKind
    )

    $cursor = $Exception
    $socketException = $null
    for ($depth = 0; $depth -lt 8 -and $null -ne $cursor; $depth++) {
        if ($cursor -is [System.Net.Sockets.SocketException]) {
            $socketException = $cursor
            break
        }
        if ($cursor -is [System.AggregateException]) {
            $flattened = $cursor.Flatten().InnerExceptions
            if ($flattened.Count -ne 1) {
                return 'probe-error'
            }
            $cursor = $flattened[0]
            continue
        }
        $cursor = $cursor.InnerException
    }
    if ($null -eq $socketException) {
        return 'probe-error'
    }

    $socketError = $socketException.SocketErrorCode
    if ($socketError -eq [System.Net.Sockets.SocketError]::TimedOut) {
        return 'timeout'
    }
    $isIsolationFailure = @(
        [System.Net.Sockets.SocketError]::AccessDenied,
        [System.Net.Sockets.SocketError]::AddressNotAvailable,
        [System.Net.Sockets.SocketError]::HostDown,
        [System.Net.Sockets.SocketError]::HostUnreachable,
        [System.Net.Sockets.SocketError]::NetworkDown,
        [System.Net.Sockets.SocketError]::NetworkUnreachable
    ) -contains $socketError
    if ($isIsolationFailure) {
        return $(if ($ProbeKind -ceq 'Dns') { 'resolution-failed' } else { 'connection-failed' })
    }
    if ($ProbeKind -ceq 'Dns' -and @(
        [System.Net.Sockets.SocketError]::HostNotFound,
        [System.Net.Sockets.SocketError]::NoData
    ) -contains $socketError) {
        return 'resolution-failed'
    }
    if ($ProbeKind -ceq 'Tcp' -and @(
        [System.Net.Sockets.SocketError]::ConnectionRefused,
        [System.Net.Sockets.SocketError]::ConnectionReset
    ) -contains $socketError) {
        return 'peer-rejected'
    }
    return 'probe-error'
}

function Test-Cx004DnsCanary {
    param([Parameter(Mandatory = $true)][string]$Name)

    try {
        $task = [System.Net.Dns]::GetHostAddressesAsync($Name)
        if (-not $task.Wait(1500)) {
            return [pscustomobject][ordered]@{
                succeeded = $false
                disposition = 'timeout'
            }
        }
        $addresses = @($task.GetAwaiter().GetResult())
        if ($addresses.Count -gt 0) {
            return [pscustomobject][ordered]@{
                succeeded = $true
                disposition = 'resolved'
            }
        }
        return [pscustomobject][ordered]@{
            succeeded = $false
            disposition = 'resolution-failed'
        }
    }
    catch {
        $failureDisposition = Get-Cx004NetworkFailureDisposition `
            -Exception $_.Exception `
            -ProbeKind 'Dns'
        return [pscustomobject][ordered]@{
            succeeded = $false
            disposition = $failureDisposition
        }
    }
}

$stableManifestPath = [System.IO.Path]::Combine(
    $script:Cx004ScratchRoot,
    'stable-manifest.json')
$runManifestPath = [System.IO.Path]::Combine(
    $script:Cx004ScratchRoot,
    'run-manifest.json')
$stableManifest = Read-Cx004JsonFile `
    -LiteralPath $stableManifestPath `
    -MaximumBytes $script:Cx004MaxManifestBytes `
    -Context 'copied stable-manifest.json'
$runManifest = Read-Cx004JsonFile `
    -LiteralPath $runManifestPath `
    -MaximumBytes $script:Cx004MaxManifestBytes `
    -Context 'copied run-manifest.json'
Assert-Cx004ExactProperties `
    -Value $stableManifest `
    -Expected @('schemaVersion', 'files') `
    -Context 'copied stable-manifest.json'
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
    -Context 'copied run-manifest.json'
if ($stableManifest.schemaVersion -cne $script:Cx004SchemaVersion -or
    $runManifest.schemaVersion -cne $script:Cx004SchemaVersion) {
    throw 'A copied manifest has an unsupported schema version.'
}
if ($runManifest.runId -isnot [string] -or
    $runManifest.runId -cnotmatch '^[0-9a-f]{32}$') {
    throw 'The copied run manifest has an invalid run id.'
}
foreach ($field in @('challenge', 'stableManifestSha256', 'renderedConfigSha256')) {
    if ($runManifest.$field -isnot [string]) {
        throw "The copied run manifest field '$field' must be a string."
    }
    Assert-Cx004LowerHex -Value $runManifest.$field -Length 64 -Context $field
}
Assert-Cx004HostCanaryEndpoint `
    -Address $runManifest.hostCanaryAddress `
    -Port $runManifest.hostCanaryPort `
    -Context 'host canary'
if ((Get-Cx004FileSha256 -LiteralPath $stableManifestPath) -cne
    $runManifest.stableManifestSha256) {
    throw 'The copied stable manifest no longer matches its run-bound digest.'
}

$stableFiles = @($stableManifest.files)
if ($stableFiles.Count -ne $script:Cx004StableFiles.Count) {
    throw 'The copied stable manifest has an unexpected file count.'
}
$verifiedStableFiles = @()
for ($index = 0; $index -lt $script:Cx004StableFiles.Count; $index++) {
    $entry = $stableFiles[$index]
    Assert-Cx004ExactProperties `
        -Value $entry `
        -Expected @('relativePath', 'sha256', 'length') `
        -Context "copied stable-manifest.json files[$index]"
    if ($entry.relativePath -isnot [string] -or
        $entry.relativePath -cne $script:Cx004StableFiles[$index] -or
        $entry.sha256 -isnot [string]) {
        throw 'The copied stable manifest does not use the closed file order.'
    }
    Assert-Cx004LowerHex `
        -Value $entry.sha256 `
        -Length 64 `
        -Context "copied stable-manifest.json files[$index].sha256"
    if (($entry.length -isnot [int]) -and ($entry.length -isnot [long])) {
        throw 'A copied stable file length is not an integer.'
    }
    if ($entry.length -le 0 -or $entry.length -gt $script:Cx004MaxScriptBytes) {
        throw 'A copied stable file length is outside its bound.'
    }
    $path = [System.IO.Path]::Combine($script:Cx004ScratchRoot, $entry.relativePath)
    $file = New-Object System.IO.FileInfo($path)
    if (-not $file.Exists -or $file.Length -ne $entry.length -or
        (Get-Cx004FileSha256 -LiteralPath $path) -cne $entry.sha256) {
        throw "Copied stable input '$($entry.relativePath)' failed probe re-verification."
    }
    $verifiedStableFiles += [ordered]@{
        relativePath = $entry.relativePath
        sha256 = $entry.sha256
        length = [long]$entry.length
    }
}

if (-not [System.IO.Directory]::Exists($script:Cx004OutputRoot)) {
    throw 'The fixed output mapping is unavailable.'
}
$outputWasEmpty = @(
    [System.IO.Directory]::EnumerateFileSystemEntries($script:Cx004OutputRoot)
).Count -eq 0
if (-not $outputWasEmpty) {
    throw 'The evidence output mapping was not empty at probe start.'
}

$registryPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$windows = Get-ItemProperty -LiteralPath $registryPath
$operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
$buildNumber = [string]$windows.CurrentBuildNumber
$ubr = [int]$windows.UBR
$fullBuild = '{0}.{1}' -f $buildNumber, $ubr
if (
    $buildNumber -cnotmatch '^[0-9]+$' -or
    -not [System.Environment]::Is64BitOperatingSystem -or
    -not [System.Environment]::Is64BitProcess -or
    [string]$env:PROCESSOR_ARCHITECTURE -cne 'AMD64'
) {
    throw 'The guest OS/process architecture or build identity is unsupported.'
}
$guestArchitecture = 'AMD64'
$windowsIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$windowsPrincipal = New-Object System.Security.Principal.WindowsPrincipal($windowsIdentity)

$whoamiPath = [System.IO.Path]::Combine($env:SystemRoot, 'System32\whoami.exe')
$groupCsv = Invoke-Cx004FixedProcess `
    -FileName $whoamiPath `
    -Arguments '/groups /fo csv /nh' `
    -TimeoutMilliseconds 5000
$privilegeCsv = Invoke-Cx004FixedProcess `
    -FileName $whoamiPath `
    -Arguments '/priv /fo csv /nh' `
    -TimeoutMilliseconds 5000
$groups = @(
    $groupCsv | ConvertFrom-Csv -Header @('name', 'type', 'sid', 'attributes') |
        Sort-Object -Property sid |
        ForEach-Object {
            [ordered]@{
                sid = $_.sid
                name = $_.name
                type = $_.type
                attributes = $_.attributes
            }
        }
)
$privileges = @(
    $privilegeCsv | ConvertFrom-Csv -Header @('name', 'description', 'state') |
        Sort-Object -Property name |
        ForEach-Object {
            [ordered]@{
                name = $_.name
                description = $_.description
                state = $_.state
            }
        }
)
if ($groups.Count -le 0 -or $groups.Count -gt 4096 -or
    $privileges.Count -gt 4096) {
    throw 'The token vector is outside the closed collection bound.'
}
$integrityGroups = @($groups | Where-Object { $_.sid -clike 'S-1-16-*' })
if ($integrityGroups.Count -ne 1) {
    throw 'The token did not expose exactly one integrity label.'
}
$integrityAlias = ConvertTo-Cx004IntegrityAlias -Sid $integrityGroups[0].sid

$inputWritePath = [System.IO.Path]::Combine(
    $script:Cx004InputRoot,
    '.cx004-write-probe-' + $runManifest.challenge + '.tmp')
$inputWriteSucceeded = $false
$inputWriteErrorType = ''
$inputWriteErrorHResult = [long] 0
$inputWriteErrorInnerType = ''
$inputWriteErrorInnerHResult = [long] 0
$inputWriteErrorInnerHasInnerException = $false
try {
    $probeBytes = $script:Cx004Utf8.GetBytes($runManifest.challenge + "`n")
    $stream = New-Object System.IO.FileStream(
        $inputWritePath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None)
    try {
        $stream.Write($probeBytes, 0, $probeBytes.Length)
        $stream.Flush($true)
        $inputWriteSucceeded = $true
    }
    finally {
        $stream.Dispose()
    }
}
catch {
    $inputWriteErrorType = $_.Exception.GetType().FullName
    $inputWriteErrorHResult = [long] $_.Exception.HResult
    if ($null -ne $_.Exception.InnerException) {
        $inputWriteErrorInnerType = $_.Exception.InnerException.GetType().FullName
        $inputWriteErrorInnerHResult = [long] $_.Exception.InnerException.HResult
        $inputWriteErrorInnerHasInnerException = $null -ne $_.Exception.InnerException.InnerException
    }
}
$inputWriteArtifactPresent = [System.IO.File]::Exists($inputWritePath)
$inputNewFileCreateDenied =
    (-not $inputWriteSucceeded) -and
    (-not $inputWriteArtifactPresent) -and
    (Test-Cx004FileAccessDeniedFacts `
        -ErrorType $inputWriteErrorType `
        -ErrorHResult $inputWriteErrorHResult `
        -ErrorInnerType $inputWriteErrorInnerType `
        -ErrorInnerHResult $inputWriteErrorInnerHResult `
        -ErrorInnerHasInnerException $inputWriteErrorInnerHasInnerException)

$existingInputRelativePath = 'guest-probe.ps1'
$existingInputPath = [System.IO.Path]::Combine(
    $script:Cx004InputRoot,
    $existingInputRelativePath)
$existingInputSha256Before = Get-Cx004FileSha256 -LiteralPath $existingInputPath
$existingInputWriteOpenSucceeded = $false
$existingInputWriteOpenErrorType = ''
$existingInputWriteOpenErrorHResult = [long] 0
$existingInputWriteOpenErrorInnerType = ''
$existingInputWriteOpenErrorInnerHResult = [long] 0
$existingInputWriteOpenErrorInnerHasInnerException = $false
try {
    $stream = New-Object System.IO.FileStream(
        $existingInputPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::Read)
    try {
        $existingInputWriteOpenSucceeded = $true
    }
    finally {
        $stream.Dispose()
    }
}
catch {
    $existingInputWriteOpenErrorType = $_.Exception.GetType().FullName
    $existingInputWriteOpenErrorHResult = [long] $_.Exception.HResult
    if ($null -ne $_.Exception.InnerException) {
        $existingInputWriteOpenErrorInnerType = $_.Exception.InnerException.GetType().FullName
        $existingInputWriteOpenErrorInnerHResult = [long] $_.Exception.InnerException.HResult
        $existingInputWriteOpenErrorInnerHasInnerException = $null -ne $_.Exception.InnerException.InnerException
    }
}
$existingInputSha256After = Get-Cx004FileSha256 -LiteralPath $existingInputPath
$existingInputWriteOpenDenied =
    (-not $existingInputWriteOpenSucceeded) -and
    (Test-Cx004FileAccessDeniedFacts `
        -ErrorType $existingInputWriteOpenErrorType `
        -ErrorHResult $existingInputWriteOpenErrorHResult `
        -ErrorInnerType $existingInputWriteOpenErrorInnerType `
        -ErrorInnerHResult $existingInputWriteOpenErrorInnerHResult `
        -ErrorInnerHasInnerException $existingInputWriteOpenErrorInnerHasInnerException)
$existingInputUnmodified =
    $existingInputSha256Before -ceq $existingInputSha256After -and
    $existingInputSha256After -ceq [string]$stableFiles[1].sha256
$inputMappingReadOnly =
    $inputNewFileCreateDenied -and
    $existingInputWriteOpenDenied -and
    $existingInputUnmodified
$inputMappingViolation =
    $inputWriteSucceeded -or
    $inputWriteArtifactPresent -or
    $existingInputWriteOpenSucceeded -or
    (-not $existingInputUnmodified)
$inputMappingProbeInconclusive =
    (-not $inputMappingViolation) -and
    (-not $inputMappingReadOnly)

$networkObservationAvailable = $true
$networkObservationCode = ''
$routableAddresses = @()
$defaultRoutes = @()
try {
    $ipAddresses = @(
        Get-NetIPAddress -ErrorAction Stop |
            Sort-Object -Property IPAddress, InterfaceIndex
    )
    foreach ($item in $ipAddresses) {
        $address = $null
        if ([System.Net.IPAddress]::TryParse($item.IPAddress, [ref]$address) -and
            (Test-Cx004RoutableAddress -Address $address)) {
            $routableAddresses += [ordered]@{
                address = $address.ToString()
                addressFamily = $address.AddressFamily.ToString()
                interfaceIndex = [int]$item.InterfaceIndex
                interfaceAlias = [string]$item.InterfaceAlias
            }
        }
    }
    $defaultRoutes = @(
        Get-NetRoute -ErrorAction Stop |
            Where-Object {
                $_.DestinationPrefix -ceq '0.0.0.0/0' -or
                $_.DestinationPrefix -ceq '::/0'
            } |
            Sort-Object -Property DestinationPrefix, NextHop, InterfaceIndex |
            ForEach-Object {
                [ordered]@{
                    destinationPrefix = [string]$_.DestinationPrefix
                    nextHop = [string]$_.NextHop
                    interfaceIndex = [int]$_.InterfaceIndex
                    interfaceAlias = [string]$_.InterfaceAlias
                    state = [string]$_.State
                }
            }
    )
}
catch {
    $networkObservationAvailable = $false
    $networkObservationCode = 'nettcpip-observation-unavailable'
}

$dnsCanary = Test-Cx004DnsCanary -Name 'example.com'
$hostCanary = Test-Cx004TcpCanary `
    -Address $runManifest.hostCanaryAddress `
    -Port ([int]$runManifest.hostCanaryPort)
$rawIpCanary = Test-Cx004TcpCanary -Address '1.1.1.1' -Port 443
$hostCanaryChallengeBound =
    $runManifest.hostCanaryAddress -is [string] -and
    (($runManifest.hostCanaryPort -is [int]) -or
        ($runManifest.hostCanaryPort -is [long])) -and
    $runManifest.challenge -is [string] -and
    $runManifest.challenge -cmatch '^[0-9a-f]{64}$'
$hostCanaryConnectionBlocked =
    (-not $hostCanary.succeeded) -and
    $hostCanary.disposition -ceq 'connection-failed'
$networkCanaryTimedOut =
    $dnsCanary.disposition -ceq 'timeout' -or
    $hostCanary.disposition -ceq 'timeout' -or
    $rawIpCanary.disposition -ceq 'timeout'
$networkCanaryProbeError =
    $dnsCanary.disposition -ceq 'probe-error' -or
    $hostCanary.disposition -ceq 'probe-error' -or
    $rawIpCanary.disposition -ceq 'probe-error'
$networkViolation =
    $routableAddresses.Count -gt 0 -or
    $defaultRoutes.Count -gt 0 -or
    $dnsCanary.succeeded -or
    $hostCanary.succeeded -or
    $rawIpCanary.succeeded -or
    $hostCanary.disposition -ceq 'peer-rejected' -or
    $rawIpCanary.disposition -ceq 'peer-rejected'
$networkIsolation = $networkObservationAvailable -and
    $routableAddresses.Count -eq 0 -and
    $defaultRoutes.Count -eq 0 -and
    (-not $dnsCanary.succeeded) -and
    (-not $hostCanary.succeeded) -and
    (-not $rawIpCanary.succeeded) -and
    $dnsCanary.disposition -ceq 'resolution-failed' -and
    $hostCanary.disposition -ceq 'connection-failed' -and
    $rawIpCanary.disposition -ceq 'connection-failed'

$persistencePresentBefore = [System.IO.File]::Exists($script:Cx004PersistenceCanary)
$persistenceCreated = $false
$persistenceChallengeVerified = $false
if (-not $persistencePresentBefore) {
    $canary = [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        runId = $runManifest.runId
        challenge = $runManifest.challenge
        purpose = 'sandbox-clean-relaunch-non-persistence'
    }
    $canaryJson = ($canary | ConvertTo-Json -Depth 4 -Compress) + "`n"
    $canaryBytes = $script:Cx004Utf8.GetBytes($canaryJson)
    $stream = New-Object System.IO.FileStream(
        $script:Cx004PersistenceCanary,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None)
    try {
        $stream.Write($canaryBytes, 0, $canaryBytes.Length)
        $stream.Flush($true)
    }
    finally {
        $stream.Dispose()
    }
    $persistenceCreated = [System.IO.File]::Exists($script:Cx004PersistenceCanary)
    if ($persistenceCreated) {
        $readBack = Read-Cx004JsonFile `
            -LiteralPath $script:Cx004PersistenceCanary `
            -MaximumBytes 4096 `
            -Context 'guest-local persistence canary'
        Assert-Cx004ExactProperties `
            -Value $readBack `
            -Expected @('schemaVersion', 'runId', 'challenge', 'purpose') `
            -Context 'guest-local persistence canary'
        $persistenceChallengeVerified =
            $readBack.schemaVersion -ceq $script:Cx004SchemaVersion -and
            $readBack.runId -ceq $runManifest.runId -and
            $readBack.challenge -ceq $runManifest.challenge -and
            $readBack.purpose -ceq 'sandbox-clean-relaunch-non-persistence'
    }
}
$persistenceProbePassed = (-not $persistencePresentBefore) -and
    $persistenceCreated -and
    $persistenceChallengeVerified

$probeResults = [ordered]@{
    stableInputsVerified = $true
    outputWasEmpty = $outputWasEmpty
    inputMappingReadOnly = $inputMappingReadOnly
    inputMappingExistingFileWriteOpenDenied = $existingInputWriteOpenDenied
    inputMappingExistingFileUnmodified = $existingInputUnmodified
    networkObservationAvailable = $networkObservationAvailable
    networkIsolation = $networkIsolation
    hostCanaryChallengeBound = $hostCanaryChallengeBound
    hostCanaryConnectionBlocked = $hostCanaryConnectionBlocked
    persistenceCanaryAbsentAtStart = (-not $persistencePresentBefore)
    persistenceCanaryCreated = $persistenceCreated
    persistenceCanaryChallengeVerified = $persistenceChallengeVerified
}
$failed = $inputMappingViolation -or
    (-not $hostCanaryChallengeBound) -or
    $networkViolation
$inconclusive = (-not $networkObservationAvailable) -or
    (-not $outputWasEmpty) -or
    $inputMappingProbeInconclusive -or
    $networkCanaryTimedOut -or
    $networkCanaryProbeError -or
    (-not $persistenceProbePassed) -or
    (($networkObservationAvailable -and (-not $networkViolation)) -and
        (-not $networkIsolation))
$outcome = if ($failed) {
    'failed'
}
elseif ($inconclusive) {
    'inconclusive'
}
else {
    'passed'
}

$guestIdentitySummary = [ordered]@{
    productName = [string]$windows.ProductName
    displayVersion = [string]$windows.DisplayVersion
    editionId = [string]$windows.EditionID
    installationType = [string]$windows.InstallationType
    productType = [int]$operatingSystem.ProductType
    buildNumber = $buildNumber
    ubr = $ubr
    fullBuild = $fullBuild
    architecture = $guestArchitecture
    userSid = $windowsIdentity.User.Value
    integrityLevel = $integrityAlias
    groupCount = $groups.Count
    privilegeCount = $privileges.Count
}

$evidence = [ordered]@{
    schemaVersion = $script:Cx004SchemaVersion
    runId = $runManifest.runId
    challenge = $runManifest.challenge
    stableManifestSha256 = $runManifest.stableManifestSha256
    renderedConfigSha256 = $runManifest.renderedConfigSha256
    outcome = $outcome
    outputWasEmpty = $outputWasEmpty
    stableInputs = $verifiedStableFiles
    guest = [ordered]@{
        productName = [string]$windows.ProductName
        displayVersion = [string]$windows.DisplayVersion
        editionId = [string]$windows.EditionID
        installationType = [string]$windows.InstallationType
        productType = [int]$operatingSystem.ProductType
        version = [string]$operatingSystem.Version
        buildNumber = $buildNumber
        ubr = $ubr
        fullBuild = $fullBuild
        architecture = $guestArchitecture
        processArchitecture = $guestArchitecture
        machineName = [string]$env:COMPUTERNAME
        accountName = $windowsIdentity.Name
        userSid = $windowsIdentity.User.Value
        authenticationType = [string]$windowsIdentity.AuthenticationType
        impersonationLevel = [string]$windowsIdentity.ImpersonationLevel
        isAuthenticated = [bool]$windowsIdentity.IsAuthenticated
        isAnonymous = [bool]$windowsIdentity.IsAnonymous
        isGuest = [bool]$windowsIdentity.IsGuest
        isSystem = [bool]$windowsIdentity.IsSystem
        isAdministrator = [bool]$windowsPrincipal.IsInRole(
            [System.Security.Principal.WindowsBuiltInRole]::Administrator)
        integrity = $integrityGroups[0]
        groups = $groups
        privileges = $privileges
        bootTimeUtc = $operatingSystem.LastBootUpTime.ToUniversalTime().ToString('o')
    }
    probes = [ordered]@{
        inputMapping = [ordered]@{
            writeAttempted = $true
            writeSucceeded = $inputWriteSucceeded
            artifactPresent = $inputWriteArtifactPresent
            errorType = $inputWriteErrorType
            errorHResult = $inputWriteErrorHResult
            errorInnerType = $inputWriteErrorInnerType
            errorInnerHResult = $inputWriteErrorInnerHResult
            errorInnerHasInnerException = $inputWriteErrorInnerHasInnerException
            existingFileRelativePath = $existingInputRelativePath
            existingFileWriteOpenAttempted = $true
            existingFileWriteOpenSucceeded = $existingInputWriteOpenSucceeded
            existingFileWriteOpenErrorType = $existingInputWriteOpenErrorType
            existingFileWriteOpenErrorHResult = $existingInputWriteOpenErrorHResult
            existingFileWriteOpenErrorInnerType = $existingInputWriteOpenErrorInnerType
            existingFileWriteOpenErrorInnerHResult = $existingInputWriteOpenErrorInnerHResult
            existingFileWriteOpenErrorInnerHasInnerException = $existingInputWriteOpenErrorInnerHasInnerException
            existingFileSha256Before = $existingInputSha256Before
            existingFileSha256After = $existingInputSha256After
            existingFileUnmodified = $existingInputUnmodified
            readOnly = $inputMappingReadOnly
        }
        network = [ordered]@{
            observationAvailable = $networkObservationAvailable
            observationCode = $networkObservationCode
            routableAddresses = $routableAddresses
            defaultRoutes = $defaultRoutes
            dnsCanary = [ordered]@{
                name = 'example.com'
                succeeded = [bool]$dnsCanary.succeeded
                disposition = [string]$dnsCanary.disposition
            }
            hostCanary = [ordered]@{
                address = [string]$runManifest.hostCanaryAddress
                port = [int]$runManifest.hostCanaryPort
                challenge = $runManifest.challenge
                succeeded = [bool]$hostCanary.succeeded
                disposition = [string]$hostCanary.disposition
            }
            rawIpCanary = [ordered]@{
                address = '1.1.1.1'
                port = 443
                succeeded = [bool]$rawIpCanary.succeeded
                disposition = [string]$rawIpCanary.disposition
            }
            isolated = $networkIsolation
        }
        persistence = [ordered]@{
            presentBefore = $persistencePresentBefore
            created = $persistenceCreated
            challengeVerified = $persistenceChallengeVerified
            passed = $persistenceProbePassed
        }
    }
}

Write-Cx004AtomicJson `
    -Value $evidence `
    -FinalName 'guest-evidence.json' `
    -Challenge $runManifest.challenge `
    -MaximumBytes $script:Cx004MaxEvidenceBytes
$evidencePath = [System.IO.Path]::Combine(
    $script:Cx004OutputRoot,
    'guest-evidence.json')
$evidenceInfo = New-Object System.IO.FileInfo($evidencePath)

$resultManifest = [ordered]@{
    schemaVersion = $script:Cx004SchemaVersion
    runId = $runManifest.runId
    challenge = $runManifest.challenge
    stableManifestSha256 = $runManifest.stableManifestSha256
    renderedConfigSha256 = $runManifest.renderedConfigSha256
    outcome = $outcome
    guestIdentity = $guestIdentitySummary
    probeResults = $probeResults
    files = @(
        [ordered]@{
            relativePath = 'guest-evidence.json'
            sha256 = Get-Cx004FileSha256 -LiteralPath $evidencePath
            length = [long]$evidenceInfo.Length
        }
    )
}
Write-Cx004AtomicJson `
    -Value $resultManifest `
    -FinalName 'result-manifest.json' `
    -Challenge $runManifest.challenge `
    -MaximumBytes $script:Cx004MaxManifestBytes
