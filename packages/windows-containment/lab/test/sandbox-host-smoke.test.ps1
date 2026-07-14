[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows) {
    throw 'sandbox-host-smoke.test.ps1 requires Windows.'
}

function Invoke-BoundedNativeProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $FilePath,

        [Parameter(Mandatory)]
        [string[]] $Arguments,

        [Parameter(Mandatory)]
        [string] $WorkingDirectory,

        [Parameter(Mandatory)]
        [hashtable] $Environment,

        [Parameter(Mandatory)]
        [ValidateRange(1, 300000)]
        [int] $TimeoutMilliseconds,

        [Parameter(Mandatory)]
        [ValidateRange(1, 4194304)]
        [int] $MaximumStandardOutputCharacters,

        [Parameter(Mandatory)]
        [ValidateRange(1, 4194304)]
        [int] $MaximumStandardErrorCharacters
    )

    $canonicalFilePath = [System.IO.Path]::GetFullPath($FilePath)
    if (-not (Test-Path -LiteralPath $canonicalFilePath -PathType Leaf)) {
        throw "Native executable is unavailable: $canonicalFilePath"
    }
    $canonicalWorkingDirectory = [System.IO.Path]::GetFullPath($WorkingDirectory)
    if (-not (Test-Path -LiteralPath $canonicalWorkingDirectory -PathType Container)) {
        throw "Native working directory is unavailable: $canonicalWorkingDirectory"
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $canonicalFilePath
    $startInfo.WorkingDirectory = $canonicalWorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # Replacement fallback keeps malformed native bytes inside the same bounded
    # collector; downstream schema checks still reject them without stranding
    # a live child on a decoder exception.
    $utf8 = [System.Text.UTF8Encoding]::new($false, $false)
    $startInfo.StandardOutputEncoding = $utf8
    $startInfo.StandardErrorEncoding = $utf8

    foreach ($argument in $Arguments) {
        if ($null -eq $argument -or $argument.Contains([char]0)) {
            throw 'Native process arguments must be non-null and NUL-free.'
        }
        [void] $startInfo.ArgumentList.Add($argument)
    }

    $startInfo.Environment.Clear()
    foreach ($entry in $Environment.GetEnumerator()) {
        $name = [string] $entry.Key
        $value = [string] $entry.Value
        if (
            [string]::IsNullOrWhiteSpace($name) -or
            $name.Contains('=') -or
            $name.Contains([char]0) -or
            $value.Contains([char]0)
        ) {
            throw "Native process environment entry is unsafe: $name"
        }
        $startInfo.Environment.Add($name, $value)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $started = $false
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) {
            throw "Native process did not start: $canonicalFilePath"
        }
        $started = $true

        $standardOutputBuilder = [System.Text.StringBuilder]::new(
            [Math]::Min($MaximumStandardOutputCharacters, 4096))
        $standardErrorBuilder = [System.Text.StringBuilder]::new(
            [Math]::Min($MaximumStandardErrorCharacters, 4096))
        $standardOutputBuffer = [char[]]::new(4096)
        $standardErrorBuffer = [char[]]::new(4096)
        $standardOutputTask = $process.StandardOutput.ReadAsync(
            $standardOutputBuffer,
            0,
            $standardOutputBuffer.Length)
        $standardErrorTask = $process.StandardError.ReadAsync(
            $standardErrorBuffer,
            0,
            $standardErrorBuffer.Length)
        $standardOutputClosed = $false
        $standardErrorClosed = $false
        $timedOut = $false
        $outputLimitExceeded = $false
        $limitStream = ''

        while ($true) {
            if (-not $standardOutputClosed -and $standardOutputTask.IsCompleted) {
                $count = $standardOutputTask.GetAwaiter().GetResult()
                if ($count -eq 0) {
                    $standardOutputClosed = $true
                }
                elseif ($count -gt ($MaximumStandardOutputCharacters - $standardOutputBuilder.Length)) {
                    $outputLimitExceeded = $true
                    $limitStream = 'stdout'
                }
                else {
                    [void] $standardOutputBuilder.Append($standardOutputBuffer, 0, $count)
                    $standardOutputTask = $process.StandardOutput.ReadAsync(
                        $standardOutputBuffer,
                        0,
                        $standardOutputBuffer.Length)
                }
            }

            if (-not $standardErrorClosed -and $standardErrorTask.IsCompleted) {
                $count = $standardErrorTask.GetAwaiter().GetResult()
                if ($count -eq 0) {
                    $standardErrorClosed = $true
                }
                elseif ($count -gt ($MaximumStandardErrorCharacters - $standardErrorBuilder.Length)) {
                    $outputLimitExceeded = $true
                    if ([string]::IsNullOrEmpty($limitStream)) {
                        $limitStream = 'stderr'
                    }
                }
                else {
                    [void] $standardErrorBuilder.Append($standardErrorBuffer, 0, $count)
                    $standardErrorTask = $process.StandardError.ReadAsync(
                        $standardErrorBuffer,
                        0,
                        $standardErrorBuffer.Length)
                }
            }

            if ($outputLimitExceeded) {
                break
            }
            if ($process.HasExited -and $standardOutputClosed -and $standardErrorClosed) {
                break
            }
            if ($stopwatch.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
                $timedOut = $true
                break
            }
            Start-Sleep -Milliseconds 5
        }

        if ($timedOut -or $outputLimitExceeded) {
            if (-not $process.HasExited) {
                # This is the retained process only. For the controller, process exit
                # closes its sole Job Object handle and the OS enforces kill-on-close.
                $process.Kill()
            }
            if (-not $process.WaitForExit(5000)) {
                throw "Retained native process did not exit after bounded termination: $canonicalFilePath"
            }
        }
        elseif (-not $process.WaitForExit(5000)) {
            throw "Exited native process did not yield a positive wait receipt: $canonicalFilePath"
        }

        [pscustomobject]@{
            FilePath = $canonicalFilePath
            Arguments = [string[]] $Arguments.Clone()
            ExitCode = [int] $process.ExitCode
            StandardOutput = $standardOutputBuilder.ToString()
            StandardError = $standardErrorBuilder.ToString()
            TimedOut = [bool] $timedOut
            OutputLimitExceeded = [bool] $outputLimitExceeded
            LimitStream = [string] $limitStream
            ElapsedMilliseconds = [long] $stopwatch.ElapsedMilliseconds
        }
    }
    finally {
        $stopwatch.Stop()
        if ($started) {
            $process.StandardOutput.Dispose()
            $process.StandardError.Dispose()
        }
        $process.Dispose()
    }
}

function Get-ValidatedMicrosoftFileProvenance {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $Role
    )

    $canonicalPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
        throw "$Role is unavailable: $canonicalPath"
    }
    $attributes = [System.IO.File]::GetAttributes($canonicalPath)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Role must not be a reparse point: $canonicalPath"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $canonicalPath
    if (
        $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)'
    ) {
        throw "$Role did not have a valid Microsoft Authenticode signature: $canonicalPath"
    }

    $item = Get-Item -LiteralPath $canonicalPath
    $hash = (Get-FileHash -LiteralPath $canonicalPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -notmatch '\A[0-9a-f]{64}\z' -or $item.Length -le 0) {
        throw "$Role did not yield a closed SHA-256/length receipt: $canonicalPath"
    }

    [pscustomobject]@{
        Role = $Role
        Path = $canonicalPath
        Length = [long] $item.Length
        Sha256 = $hash
        SignatureStatus = $signature.Status.ToString()
        SignerSubject = $signature.SignerCertificate.Subject
    }
}

function Assert-ProvenanceUnchanged {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject] $Before
    )

    $after = Get-ValidatedMicrosoftFileProvenance -Path $Before.Path -Role $Before.Role
    if (
        $after.Path -cne $Before.Path -or
        $after.Length -ne $Before.Length -or
        $after.Sha256 -cne $Before.Sha256 -or
        $after.SignatureStatus -cne $Before.SignatureStatus -or
        $after.SignerSubject -cne $Before.SignerSubject
    ) {
        throw "$($Before.Role) identity changed during the standalone smoke test."
    }
}

function Get-OrderedArgumentSha256 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string[]] $Arguments
    )

    $canonical = [System.Text.StringBuilder]::new()
    foreach ($argument in $Arguments) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($argument)
        [void] $canonical.Append($bytes.Length.ToString([System.Globalization.CultureInfo]::InvariantCulture))
        [void] $canonical.Append(':')
        [void] $canonical.Append($argument)
        [void] $canonical.Append(';')
    }
    $canonicalBytes = [System.Text.Encoding]::UTF8.GetBytes($canonical.ToString())
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        ([System.BitConverter]::ToString($sha256.ComputeHash($canonicalBytes)) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Assert-ExactPropertySchema {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [psobject] $Object,

        [Parameter(Mandatory)]
        [System.Collections.Specialized.OrderedDictionary] $Schema,

        [Parameter(Mandatory)]
        [string] $Label
    )

    $actualNames = @($Object.PSObject.Properties.Name)
    $expectedNames = @($Schema.Keys)
    if (($actualNames -join [char]0) -cne ($expectedNames -join [char]0)) {
        throw "$Label property schema was '$($actualNames -join ',')'; expected '$($expectedNames -join ',')'."
    }

    foreach ($propertyName in $expectedNames) {
        $value = $Object.$propertyName
        $expectedType = [type] $Schema[$propertyName]
        if ($null -eq $value -or $value.GetType() -ne $expectedType) {
            $actualType = if ($null -eq $value) { '<null>' } else { $value.GetType().FullName }
            throw "$Label property '$propertyName' had type '$actualType'; expected '$($expectedType.FullName)'."
        }
    }
}

$sourcePath = Join-Path $PSScriptRoot '..\sandbox\host-job-smoke.cs'
$sourcePath = [System.IO.Path]::GetFullPath($sourcePath)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Host smoke source is missing: $sourcePath"
}

$source = Get-Content -LiteralPath $sourcePath -Raw
$requiredSourceTokens = @(
    'CreateProcessW',
    'CREATE_SUSPENDED',
    'bInheritHandles',
    'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
    'AssignProcessToJobObject',
    'QueryInformationJobObject',
    'ResumeThread',
    'WaitForSingleObject',
    'TerminateProcess',
    'CloseHandle',
    'SmokeTimeoutMilliseconds'
)
foreach ($token in $requiredSourceTokens) {
    if (-not $source.Contains($token, [System.StringComparison]::Ordinal)) {
        throw "Host smoke source is missing required token: $token"
    }
}
$forbiddenSourceTokens = @(
    'Process.Start(',
    '.Kill(',
    'GetProcesses',
    'taskkill',
    'Stop-Process',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'PC_DATA_DIR',
    'pc.sqlite'
)
foreach ($token in $forbiddenSourceTokens) {
    if ($source.Contains($token, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Host smoke source contains forbidden app/provider/tree-cleanup token: $token"
    }
}

$buildRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'pc-sdk-next-cx004-host-smoke-build-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($buildRoot) | Out-Null

try {
    $buildRootAttributes = [System.IO.File]::GetAttributes($buildRoot)
    if (
        ($buildRootAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [System.IO.Directory]::GetFileSystemEntries($buildRoot).Count -ne 0
    ) {
        throw "Dedicated build root was not a fresh non-reparse directory: $buildRoot"
    }

    $windowsRoot = [System.IO.Path]::GetDirectoryName([System.Environment]::SystemDirectory)
    if ([string]::IsNullOrWhiteSpace($windowsRoot)) {
        throw 'The Windows root could not be derived from the runtime system directory.'
    }
    $minimalEnvironment = @{
        SystemRoot = $windowsRoot
        WINDIR = $windowsRoot
        ProgramData = [System.Environment]::GetFolderPath(
            [System.Environment+SpecialFolder]::CommonApplicationData)
        TEMP = $buildRoot
        TMP = $buildRoot
        VSLANG = '1033'
    }

    $programFilesX86 = [System.Environment]::GetFolderPath(
        [System.Environment+SpecialFolder]::ProgramFilesX86)
    $vswherePath = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vswhereProvenance = Get-ValidatedMicrosoftFileProvenance `
        -Path $vswherePath `
        -Role 'Visual Studio Installer discovery tool'
    $vswhereArguments = @(
        '-latest',
        '-products', 'Microsoft.VisualStudio.Product.BuildTools',
        '-requires', 'Microsoft.Component.MSBuild',
        '-find', 'MSBuild\Current\Bin\Roslyn\csc.exe'
    )
    $vswhereResult = Invoke-BoundedNativeProcess `
        -FilePath $vswhereProvenance.Path `
        -Arguments $vswhereArguments `
        -WorkingDirectory $buildRoot `
        -Environment $minimalEnvironment `
        -TimeoutMilliseconds 15000 `
        -MaximumStandardOutputCharacters 65536 `
        -MaximumStandardErrorCharacters 65536
    if (
        $vswhereResult.TimedOut -or
        $vswhereResult.OutputLimitExceeded -or
        $vswhereResult.ExitCode -ne 0 -or
        -not [string]::IsNullOrWhiteSpace($vswhereResult.StandardError)
    ) {
        throw "Bounded Visual Studio compiler discovery failed: $($vswhereResult.StandardError)"
    }
    $cscPathLines = @(
        $vswhereResult.StandardOutput -split '\r?\n' |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($cscPathLines.Count -ne 1) {
        throw (
            "Exactly one latest Visual Studio Build Tools Roslyn compiler was not discovered " +
            "(count=$($cscPathLines.Count); stdout='$($vswhereResult.StandardOutput)'; " +
            "stderr='$($vswhereResult.StandardError)').")
    }
    $cscPath = [System.IO.Path]::GetFullPath($cscPathLines[0].Trim())
    $expectedCscSuffix = '\MSBuild\Current\Bin\Roslyn\csc.exe'
    if (-not $cscPath.EndsWith($expectedCscSuffix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Compiler discovery returned an unexpected role path: $cscPath"
    }
    $cscProvenance = Get-ValidatedMicrosoftFileProvenance `
        -Path $cscPath `
        -Role 'Visual Studio Build Tools Roslyn compiler'

    $referenceRoot = Join-Path $programFilesX86 (
        'Reference Assemblies\Microsoft\Framework\.NETFramework\v4.7.2')
    $referenceProvenance = @(
        Get-ValidatedMicrosoftFileProvenance `
            -Path (Join-Path $referenceRoot 'mscorlib.dll') `
            -Role '.NET Framework 4.7.2 mscorlib reference'
        Get-ValidatedMicrosoftFileProvenance `
            -Path (Join-Path $referenceRoot 'System.dll') `
            -Role '.NET Framework 4.7.2 System reference'
        Get-ValidatedMicrosoftFileProvenance `
            -Path (Join-Path $referenceRoot 'System.Core.dll') `
            -Role '.NET Framework 4.7.2 System.Core reference'
    )

    $sourceHashBefore = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $assemblyPath = Join-Path $buildRoot 'host-job-smoke.exe'
    $compilerArguments = @(
        '/noconfig',
        '/shared:false',
        '/nostdlib+',
        '/nologo',
        '/target:exe',
        '/platform:x64',
        '/optimize+',
        '/checked+',
        '/warnaserror+',
        '/nullable:enable',
        '/deterministic+',
        '/utf8output',
        ('/reference:' + $referenceProvenance[0].Path),
        ('/reference:' + $referenceProvenance[1].Path),
        ('/reference:' + $referenceProvenance[2].Path),
        ('/out:' + $assemblyPath),
        $sourcePath
    )
    $expectedCompilerPrefix = @('/noconfig', '/shared:false', '/nostdlib+', '/nologo')
    if (($compilerArguments[0..3] -join [char]0) -cne ($expectedCompilerPrefix -join [char]0)) {
        throw 'Compiler arguments did not begin with the closed no-config/no-server/no-standard-library contract.'
    }
    $compilerArgumentsSha256 = Get-OrderedArgumentSha256 -Arguments $compilerArguments
    if ($compilerArgumentsSha256 -notmatch '\A[0-9a-f]{64}\z') {
        throw 'Ordered compiler arguments did not yield a closed SHA-256 receipt.'
    }
    $compilerResult = Invoke-BoundedNativeProcess `
        -FilePath $cscProvenance.Path `
        -Arguments $compilerArguments `
        -WorkingDirectory $buildRoot `
        -Environment $minimalEnvironment `
        -TimeoutMilliseconds 60000 `
        -MaximumStandardOutputCharacters 1048576 `
        -MaximumStandardErrorCharacters 1048576
    if (
        $compilerResult.TimedOut -or
        $compilerResult.OutputLimitExceeded -or
        $compilerResult.ExitCode -ne 0
    ) {
        throw (
            "Host smoke compilation failed (exit {0}; timeout={1}; overflow={2}/{3}):`n{4}`n{5}" -f
                $compilerResult.ExitCode,
                $compilerResult.TimedOut,
                $compilerResult.OutputLimitExceeded,
                $compilerResult.LimitStream,
                $compilerResult.StandardOutput,
                $compilerResult.StandardError)
    }
    if (-not (Test-Path -LiteralPath $assemblyPath -PathType Leaf)) {
        throw 'Host smoke compilation did not produce its executable.'
    }
    $assemblyItemBefore = Get-Item -LiteralPath $assemblyPath
    $assemblyHashBefore = (Get-FileHash -LiteralPath $assemblyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($assemblyItemBefore.Length -le 0 -or $assemblyHashBefore -notmatch '\A[0-9a-f]{64}\z') {
        throw 'Compiled host smoke did not yield a closed pre-run SHA-256/length receipt.'
    }

    Assert-ProvenanceUnchanged -Before $vswhereProvenance
    Assert-ProvenanceUnchanged -Before $cscProvenance
    foreach ($reference in $referenceProvenance) {
        Assert-ProvenanceUnchanged -Before $reference
    }
    if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sourceHashBefore) {
        throw 'Host smoke source changed between compiler input capture and execution.'
    }

    $controllerResult = Invoke-BoundedNativeProcess `
        -FilePath $assemblyPath `
        -Arguments @('--host-smoke') `
        -WorkingDirectory $buildRoot `
        -Environment $minimalEnvironment `
        -TimeoutMilliseconds 35000 `
        -MaximumStandardOutputCharacters 1048576 `
        -MaximumStandardErrorCharacters 65536
    if ($controllerResult.TimedOut -or $controllerResult.OutputLimitExceeded) {
        throw (
            "Host smoke controller exceeded its finite process/output bound " +
            "(timeout=$($controllerResult.TimedOut); overflow=$($controllerResult.OutputLimitExceeded)/$($controllerResult.LimitStream)).")
    }
    if (-not [string]::IsNullOrEmpty($controllerResult.StandardError)) {
        throw "Host smoke emitted unexpected stderr: $($controllerResult.StandardError)"
    }
    if ($controllerResult.StandardOutput -notmatch '\A[^\r\n]+\r?\n\z') {
        throw 'Host smoke must emit exactly one newline-terminated JSON line.'
    }
    $jsonLine = $controllerResult.StandardOutput.TrimEnd("`r", "`n")

    try {
        $evidence = $jsonLine | ConvertFrom-Json -Depth 10
    }
    catch {
        throw "Host smoke output was not valid JSON: $jsonLine"
    }

    if ($controllerResult.ExitCode -ne 0) {
        throw "Host smoke exited $($controllerResult.ExitCode)`: $($evidence.failure)"
    }

    $rootSchema = [ordered]@{
        schemaVersion = [string]
        classification = [string]
        result = [string]
        failure = [string]
        fakeChildOnly = [bool]
        createSuspended = [bool]
        inheritHandles = [bool]
        jobLimitFlags = [long]
        uiRestrictions = [long]
        createdProcessId = [long]
        processHandleId = [long]
        processIdMatched = [bool]
        membershipAssignedCount = [long]
        membershipProcessCount = [long]
        membershipProcessId = [long]
        membershipPidMatched = [bool]
        resumeThreadResult = [long]
        markerProgressObserved = [bool]
        childLiveBeforeJobClose = [bool]
        jobClosed = [bool]
        childSignaled = [bool]
        markerStopped = [bool]
        tempRootRenamed = [bool]
        tempRootReleased = [bool]
        elapsedMilliseconds = [long]
        handleLedger = [object[]]
    }
    Assert-ExactPropertySchema -Object $evidence -Schema $rootSchema -Label 'Host smoke receipt root'

    $expected = [ordered]@{
        schemaVersion = 'cx-004-host-smoke-v1'
        classification = 'host-smoke-only'
        result = 'passed'
        failure = ''
        fakeChildOnly = $true
        createSuspended = $true
        inheritHandles = $false
        jobLimitFlags = 0x2000
        uiRestrictions = 0
        processIdMatched = $true
        membershipAssignedCount = 1
        membershipProcessCount = 1
        membershipPidMatched = $true
        resumeThreadResult = 1
        markerProgressObserved = $true
        childLiveBeforeJobClose = $true
        jobClosed = $true
        childSignaled = $true
        markerStopped = $true
        tempRootRenamed = $true
        tempRootReleased = $true
    }
    foreach ($entry in $expected.GetEnumerator()) {
        if ($evidence.($entry.Key) -ne $entry.Value) {
            throw "Evidence field '$($entry.Key)' was '$($evidence.($entry.Key))'; expected '$($entry.Value)'."
        }
    }

    if (
        $evidence.createdProcessId -le 0 -or
        $evidence.processHandleId -ne $evidence.createdProcessId -or
        $evidence.membershipProcessId -ne $evidence.createdProcessId
    ) {
        throw 'Created, process-handle, and queried job-membership PIDs did not match exactly.'
    }

    if ($evidence.elapsedMilliseconds -lt 0 -or $evidence.elapsedMilliseconds -ge 30000) {
        throw "Host smoke exceeded its 30-second bound: $($evidence.elapsedMilliseconds)ms."
    }

    $ledger = @($evidence.handleLedger)
    if ($ledger.Count -ne 3) {
        throw "Expected exactly three owned handles; observed $($ledger.Count)."
    }
    if (($ledger.kind -join ',') -cne 'job,process,thread') {
        throw "Unexpected handle ledger order: $($ledger.kind -join ',')."
    }
    $handleSchema = [ordered]@{
        kind = [string]
        acquired = [bool]
        closeAttempted = [bool]
        closed = [bool]
        closeError = [long]
    }
    foreach ($handle in $ledger) {
        Assert-ExactPropertySchema `
            -Object $handle `
            -Schema $handleSchema `
            -Label "Host smoke '$($handle.kind)' handle receipt"
        if (-not $handle.acquired -or -not $handle.closeAttempted -or -not $handle.closed -or $handle.closeError -ne 0) {
            throw "Handle '$($handle.kind)' did not have a positive exact close receipt."
        }
    }

    $assemblyItemAfter = Get-Item -LiteralPath $assemblyPath
    $assemblyHashAfter = (Get-FileHash -LiteralPath $assemblyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        $assemblyItemAfter.Length -ne $assemblyItemBefore.Length -or
        $assemblyHashAfter -cne $assemblyHashBefore
    ) {
        throw 'Compiled host smoke identity changed during execution.'
    }
    if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sourceHashBefore) {
        throw 'Host smoke source changed during controller execution.'
    }
    Assert-ProvenanceUnchanged -Before $vswhereProvenance
    Assert-ProvenanceUnchanged -Before $cscProvenance
    foreach ($reference in $referenceProvenance) {
        Assert-ProvenanceUnchanged -Before $reference
    }

    Write-Output (
        'sandbox-host-smoke.test.ps1 passed ({0}ms; bounded csc/controller; exact receipt; args {1}; exe {2})' -f
            $evidence.elapsedMilliseconds,
            $compilerArgumentsSha256.Substring(0, 12),
            $assemblyHashAfter.Substring(0, 12))
}
finally {
    if (Test-Path -LiteralPath $buildRoot) {
        $canonicalBuildRoot = [System.IO.Path]::TrimEndingDirectorySeparator(
            [System.IO.Path]::GetFullPath($buildRoot))
        $canonicalTempRoot = [System.IO.Path]::TrimEndingDirectorySeparator(
            [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()))
        if (
            [System.IO.Path]::GetDirectoryName($canonicalBuildRoot) -ne $canonicalTempRoot -or
            -not [System.IO.Path]::GetFileName($canonicalBuildRoot).StartsWith(
                'pc-sdk-next-cx004-host-smoke-build-',
                [System.StringComparison]::Ordinal)
        ) {
            throw "Refusing cleanup outside the dedicated build root: $canonicalBuildRoot"
        }
        $buildRootAttributes = [System.IO.File]::GetAttributes($canonicalBuildRoot)
        if (($buildRootAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing cleanup through a reparse-point build root: $canonicalBuildRoot"
        }
        Remove-Item -LiteralPath $canonicalBuildRoot -Recurse -Force
    }
}
