Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Cx004SchemaVersion = 'cx004-q0s-v1'
$script:Cx004Scope = 'runner-readiness-only'
$script:Cx004TeardownLevel = 'sandbox-session-stopped'
$script:Cx004ExpectedOriginUrl = 'https://github.com/emersonmccuin-pixel/pc-sdk-next.git'
$script:Cx004ExpectedSandboxPackageFullName = 'MicrosoftWindows.WindowsSandbox_0.5.3.0_x64__cw5n1h2txyewy'
$script:Cx004ExpectedSandboxPackageFamilyName = 'MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy'
$script:Cx004ExpectedSandboxPublisher = 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
$script:Cx004ExpectedSandboxPublisherId = 'cw5n1h2txyewy'
$script:Cx004ExpectedSandboxVersion = '0.5.3.0'
$script:Cx004ExpectedAppExecLinkSha256 = '5509514b83bc86ecdf56618f2ee62f3f94d796d271a7c4bc2e287fcc5f152064'
$script:Cx004ExpectedGitPath = 'C:\Program Files\Git\mingw64\bin\git.exe'
$script:Cx004ExpectedGitSha256 = 'e996432581a70df2e7aaac5db71e3811ec0daa7f93a8ba73fe6db6f9941f4bf9'
$script:Cx004ExpectedGitLength = 4284816L
$script:Cx004ExpectedGitVersion = '2.51.0.windows.2'
$script:Cx004ExpectedGitSignerSubject = 'CN=Johannes Schindelin, O=Johannes Schindelin, S=Nordrhein-Westfalen, C=DE'
$script:Cx004ExpectedGitSignerThumbprint = '3EB14A3AEF84B7153E139397F0A49E2FAC662B0E'
$script:Cx004ExpectedPackageHashes = [ordered]@{
    'AppxManifest.xml' = '8baa08775a90a8eaa4366b7625cf93bc6a9847147a5069efca887bc7c1038c6b'
    'AppxBlockMap.xml' = 'ebb578486a9fc159730a2ff4a95e24d05be0656cf8a140a756f1a761aa716e5b'
    'AppxSignature.p7x' = 'fa1d9f23273031a294a751a4371119468f61cbc5d41fba8c77015f455e8c880e'
    'wsb.exe' = '81cd6f7bf5e377364ff9e72a23c9a78c607954906bb55f3a1948435b45aa6eab'
    'wsb.dll' = '7326fc0c64bdedcaa01ae3d63165f51b8ec35769aee84c9a9e2b1d4ead0c2a90'
    'WindowsSandboxServer.exe' = '945dd1caa8aa6d594e1ab73cf774bf5b76d6d890cd7f222593705ddf6acd2729'
    'WindowsSandboxRemoteSession.exe' = '9d955cbcc3db3584e2b35bfcd74969d98b78ac32ba57753e27a62acea7d18e61'
    'WindowsSandboxRemoteSession.dll' = '5f8982c27861e12914b0b4bb4fa0d9cdd866d302a131cefbe0a97329b517bfe9'
}
$script:Cx004ExpectedRoslynClosure = [ordered]@{
    'csc.exe' = [ordered]@{ sha256 = '7788f58659ac4c1a35ccd80e36ea4b3eeb51836678d0ffa3d55c2d9521f5ae49'; length = 60184L }
    'csc.exe.config' = [ordered]@{ sha256 = '1c4a8f9b24b63981d350ab6e884ff42c638c57ec65169f95985d7198cb0fef3a'; length = 5003L }
    'Microsoft.CodeAnalysis.dll' = [ordered]@{ sha256 = '73487aea724fe76ddc9c04b5d8106573b73311744ef8f81a4b82824eb99f7bd7'; length = 5049640L }
    'Microsoft.CodeAnalysis.CSharp.dll' = [ordered]@{ sha256 = '21148d813f3a734e8fb45438fcf4f5f8fc527d5bed69d52e7ac7d19d4c70e044'; length = 7085864L }
    'Microsoft.CodeAnalysis.ExternalAccess.RazorCompiler.dll' = [ordered]@{ sha256 = '0c8ecfd9c64b6f41a154e105c210118854a8d018830fbb0feb7dc1a36305e5b6'; length = 21808L }
    'System.Buffers.dll' = [ordered]@{ sha256 = 'accccfbe45d9f08ffeed9916e37b33e98c65be012cfff6e7fa7b67210ce1fefb'; length = 20856L }
    'System.Collections.Immutable.dll' = [ordered]@{ sha256 = 'd5ec0837bb176abf13dcd52c658c4e84c5264f67065b9c19679b6643f7d21564'; length = 252696L }
    'System.Memory.dll' = [ordered]@{ sha256 = 'bf3fb84664f4097f1a8a9bc71a51dcf8cf1a905d4080a4d290da1730866e856f'; length = 142240L }
    'System.Numerics.Vectors.dll' = [ordered]@{ sha256 = '1d3ef8698281e7cf7371d1554afef5872b39f96c26da772210a33da041ba1183'; length = 115856L }
    'System.Reflection.Metadata.dll' = [ordered]@{ sha256 = 'f79ea5e38af769cbde5d7f5e873564708941a148bb461472019e10373ea4c780'; length = 487696L }
    'System.Runtime.CompilerServices.Unsafe.dll' = [ordered]@{ sha256 = '37768488e8ef45729bc7d9a2677633c6450042975bb96516e186da6cb9cd0dcf'; length = 18024L }
    'System.Text.Encoding.CodePages.dll' = [ordered]@{ sha256 = '67d868132552144c49ad929af33b774b371e3d1e5cb6ad2b67523bcd08351553'; length = 764560L }
    'System.Threading.Tasks.Extensions.dll' = [ordered]@{ sha256 = '4f81ffd0dc7204db75afc35ea4291769b07c440592f28894260eea76626a23c6'; length = 25984L }
}
$script:Cx004KnownLocalAppData = [System.IO.Path]::GetFullPath(
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
).TrimEnd('\')
$script:Cx004RunsRoot = Join-Path $script:Cx004KnownLocalAppData 'PC-SDK-Next\cx-004-runs'
$script:Cx004GuestInput = 'C:\CX004\input'
$script:Cx004GuestOutput = 'C:\CX004\output'
$script:Cx004InputNames = @(
    'guest-bootstrap.ps1',
    'guest-probe.ps1',
    'stable-manifest.json',
    'run-manifest.json'
)
$script:Cx004SuccessOutputNames = @('guest-evidence.json', 'result-manifest.json')
$script:Cx004AllOutputNames = @('guest-evidence.json', 'result-manifest.json', 'guest-failure.json')
$script:Cx004MaxJsonBytes = 1MB
$script:Cx004MaxOutputBytes = 2MB
$script:Cx004SessionTimeoutSeconds = 240
$script:Cx004NativeTimeoutSeconds = 30

if (-not ('Cx004BoundedProcess' -as [type])) {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class Cx004BoundedProcessResult
{
    public int ProcessId { get; set; }
    public int ExitCode { get; set; }
    public string Stdout { get; set; } = "";
    public string Stderr { get; set; } = "";
    public long StdoutBytes { get; set; }
    public long StderrBytes { get; set; }
    public bool TimedOut { get; set; }
    public bool OutputExceeded { get; set; }
    public bool KillAttempted { get; set; }
    public bool KillSucceeded { get; set; }
    public bool ProcessExited { get; set; }
    public bool CaptureCompleted { get; set; }
    public bool CaptureReadersSettled { get; set; }
    public bool CaptureDiscarded { get; set; }
    public bool CaptureFaulted { get; set; }
    public bool CaptureCloseFaulted { get; set; }
    public bool CaptureByteCountsAvailable { get; set; }
    public long ElapsedMilliseconds { get; set; }
}

public static class Cx004BoundedProcess
{
    private sealed class Capture
    {
        internal readonly MemoryStream Bytes = new MemoryStream();
        internal long Total;
        internal volatile bool Exceeded;
    }

    private static async Task CaptureAsync(
        Stream stream,
        Capture capture,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        try
        {
            byte[] buffer = new byte[4096];
            while (true)
            {
                int read = await stream.ReadAsync(
                    buffer,
                    0,
                    buffer.Length,
                    cancellationToken).ConfigureAwait(false);
                if (read == 0) return;
                long prior = Interlocked.Add(ref capture.Total, read) - read;
                if (prior < maximumBytes)
                {
                    int keep = (int)Math.Min((long)read, maximumBytes - prior);
                    if (keep > 0) capture.Bytes.Write(buffer, 0, keep);
                }
                if (prior + read > maximumBytes) capture.Exceeded = true;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested) { }
        catch (IOException) when (cancellationToken.IsCancellationRequested) { }
    }

    private static bool WaitForCaptureTasks(Task stdoutTask, Task stderrTask, int timeoutMilliseconds)
    {
        try
        {
            return Task.WaitAll(new[] { stdoutTask, stderrTask }, timeoutMilliseconds);
        }
        catch (AggregateException)
        {
            if (stdoutTask.IsFaulted) { var ignored = stdoutTask.Exception; }
            if (stderrTask.IsFaulted) { var ignored = stderrTask.Exception; }
            return stdoutTask.IsCompleted && stderrTask.IsCompleted;
        }
    }

    public static Cx004BoundedProcessResult Run(
        string executablePath,
        string[] arguments,
        string workingDirectory,
        int timeoutMilliseconds,
        int maximumStdoutBytes,
        int maximumStderrBytes,
        bool scrubEnvironment)
    {
        var result = new Cx004BoundedProcessResult();
        var start = new ProcessStartInfo
        {
            FileName = executablePath,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (string argument in arguments) start.ArgumentList.Add(argument);
        if (scrubEnvironment)
        {
            string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            start.Environment.Clear();
            string systemDirectory = Environment.SystemDirectory;
            string windowsDirectory = Directory.GetParent(systemDirectory).FullName;
            start.Environment["SystemRoot"] = windowsDirectory;
            start.Environment["WINDIR"] = windowsDirectory;
            start.Environment["COMSPEC"] = Path.Combine(systemDirectory, "cmd.exe");
            start.Environment["TEMP"] = workingDirectory;
            start.Environment["TMP"] = workingDirectory;
            start.Environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
            start.Environment["ProgramData"] = programData;
            start.Environment["VSLANG"] = "1033";
        }
        else
        {
            start.Environment.Remove("ANTHROPIC_API_KEY");
            start.Environment.Remove("ANTHROPIC_AUTH_TOKEN");
            start.Environment.Remove("OPENAI_API_KEY");
            start.Environment.Remove("CODEX_HOME");
            start.Environment.Remove("CLAUDE_CONFIG_DIR");
            start.Environment.Remove("PC_DATA_DIR");
        }

        using (var captureCancellation = new CancellationTokenSource())
        using (var process = new Process { StartInfo = start, EnableRaisingEvents = true })
        {
            var stdout = new Capture();
            var stderr = new Capture();
            var stopwatch = Stopwatch.StartNew();
            if (!process.Start()) throw new InvalidOperationException("The retained native process did not start.");
            result.ProcessId = process.Id;
            Task stdoutTask = CaptureAsync(
                process.StandardOutput.BaseStream,
                stdout,
                maximumStdoutBytes,
                captureCancellation.Token);
            Task stderrTask = CaptureAsync(
                process.StandardError.BaseStream,
                stderr,
                maximumStderrBytes,
                captureCancellation.Token);

            while (!process.WaitForExit(20))
            {
                if (stopwatch.ElapsedMilliseconds >= timeoutMilliseconds || stdout.Exceeded || stderr.Exceeded)
                {
                    result.TimedOut = stopwatch.ElapsedMilliseconds >= timeoutMilliseconds;
                    result.OutputExceeded = stdout.Exceeded || stderr.Exceeded;
                    result.KillAttempted = true;
                    try
                    {
                        process.Kill(false);
                        result.KillSucceeded = true;
                    }
                    catch (InvalidOperationException)
                    {
                        result.KillSucceeded = process.HasExited;
                    }
                    break;
                }
            }

            result.ProcessExited = process.WaitForExit(5000);
            if (result.ProcessExited)
            {
                result.ExitCode = process.ExitCode;
            }
            else
            {
                result.ExitCode = -1;
            }
            bool initialCaptureWait = WaitForCaptureTasks(stdoutTask, stderrTask, 5000);
            result.CaptureReadersSettled = stdoutTask.IsCompleted && stderrTask.IsCompleted;
            result.CaptureFaulted = stdoutTask.IsFaulted || stderrTask.IsFaulted;
            result.CaptureCompleted = initialCaptureWait &&
                result.CaptureReadersSettled &&
                !result.CaptureFaulted &&
                stdoutTask.Status == TaskStatus.RanToCompletion &&
                stderrTask.Status == TaskStatus.RanToCompletion;

            if (!result.CaptureReadersSettled)
            {
                result.CaptureDiscarded = true;
                captureCancellation.Cancel();
                try { process.StandardOutput.Close(); }
                catch { result.CaptureCloseFaulted = true; }
                try { process.StandardError.Close(); }
                catch { result.CaptureCloseFaulted = true; }
                WaitForCaptureTasks(stdoutTask, stderrTask, 5000);
                result.CaptureReadersSettled = stdoutTask.IsCompleted && stderrTask.IsCompleted;
                result.CaptureFaulted = stdoutTask.IsFaulted || stderrTask.IsFaulted;
            }

            stopwatch.Stop();
            result.ElapsedMilliseconds = stopwatch.ElapsedMilliseconds;
            result.CaptureByteCountsAvailable = result.CaptureReadersSettled;
            if (result.CaptureByteCountsAvailable)
            {
                result.StdoutBytes = Interlocked.Read(ref stdout.Total);
                result.StderrBytes = Interlocked.Read(ref stderr.Total);
                result.OutputExceeded = result.OutputExceeded || stdout.Exceeded || stderr.Exceeded;
                if (result.CaptureCompleted)
                {
                    var utf8 = new UTF8Encoding(false, true);
                    result.Stdout = utf8.GetString(stdout.Bytes.ToArray());
                    result.Stderr = utf8.GetString(stderr.Bytes.ToArray());
                }
            }
            else
            {
                result.StdoutBytes = -1;
                result.StderrBytes = -1;
                result.OutputExceeded = result.OutputExceeded || stdout.Exceeded || stderr.Exceeded;
            }
            return result;
        }
    }
}
'@
}

function Throw-Cx004 {
    param(
        [Parameter(Mandatory)] [string] $Code,
        [Parameter(Mandatory)] [string] $Message
    )

    throw "CX004[$Code] $Message"
}

function Test-Cx004PositiveIntegrityError {
    param([Parameter(Mandatory)] [string] $Message)

    return $Message -match '^CX004\[(stage-source-seal-drift|rendered-config-mutated|input-mutated|unexpected-directory-surface|missing-fixed-input|staged-source-mismatch|template-source-mismatch|unexpected-harness-source|dirty-source-tree|source-index-flags|source-seal-mismatch|source-seal-manifest-missing|source-seal-manifest-untracked|source-seal-manifest-invalid|source-worktree-byte-mismatch|source-eol-policy-mismatch|source-blob-mismatch|host-smoke-source-missing|host-smoke-staged-source-mismatch)\]'
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

function Test-Cx004GuestIdentityFacts {
    param([Parameter(Mandatory)] [System.Text.Json.JsonElement] $Guest)

    return (Get-Cx004JsonString -Object $Guest -Name 'productName') -ceq 'Windows 10 Enterprise' -and
        (Get-Cx004JsonString -Object $Guest -Name 'displayVersion') -ceq '24H2' -and
        (Get-Cx004JsonString -Object $Guest -Name 'editionId') -ceq 'Enterprise' -and
        (Get-Cx004JsonString -Object $Guest -Name 'installationType') -ceq 'Client' -and
        (Get-Cx004JsonInt64 -Object $Guest -Name 'productType') -eq 1 -and
        (Get-Cx004JsonString -Object $Guest -Name 'version') -ceq '10.0.26100' -and
        (Get-Cx004JsonString -Object $Guest -Name 'buildNumber') -ceq '26100' -and
        (Get-Cx004JsonInt64 -Object $Guest -Name 'ubr') -eq 8655 -and
        (Get-Cx004JsonString -Object $Guest -Name 'fullBuild') -ceq '26100.8655' -and
        (Get-Cx004JsonString -Object $Guest -Name 'architecture') -ceq 'AMD64' -and
        (Get-Cx004JsonString -Object $Guest -Name 'processArchitecture') -ceq 'AMD64'
}

function Assert-Cx004FreshSessionIds {
    param(
        [Parameter(Mandatory)] [string] $FirstSessionId,
        [Parameter(Mandatory)] [string] $SecondSessionId
    )

    $firstGuid = [guid]::Empty
    $secondGuid = [guid]::Empty
    if (-not [guid]::TryParseExact($FirstSessionId, 'D', [ref] $firstGuid) -or
        -not [guid]::TryParseExact($SecondSessionId, 'D', [ref] $secondGuid) -or
        $firstGuid.ToString('D') -cne $FirstSessionId -or
        $secondGuid.ToString('D') -cne $SecondSessionId -or
        $FirstSessionId -ceq $SecondSessionId) {
        Throw-Cx004 'nonfresh-second-session' 'The clean-relaunch session did not return a distinct canonical Sandbox session id.'
    }
}

function Invoke-Cx004BoundedNative {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $ExecutablePath,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [string[]] $Arguments,
        [Parameter(Mandatory)] [string] $WorkingDirectory,
        [ValidateRange(1, 600)] [int] $TimeoutSeconds = $script:Cx004NativeTimeoutSeconds,
        [ValidateRange(1, 4194304)] [int] $MaxStdoutBytes = $script:Cx004MaxJsonBytes,
        [ValidateRange(1, 4194304)] [int] $MaxStderrBytes = $script:Cx004MaxJsonBytes,
        [switch] $ScrubEnvironment
    )

    $fullExecutable = [System.IO.Path]::GetFullPath($ExecutablePath)
    $fullWorkingDirectory = [System.IO.Path]::GetFullPath($WorkingDirectory)
    if (-not [System.IO.Path]::IsPathFullyQualified($ExecutablePath) -or
        -not (Test-Path -LiteralPath $fullExecutable -PathType Leaf) -or
        -not (Test-Path -LiteralPath $fullWorkingDirectory -PathType Container)) {
        Throw-Cx004 'invalid-native-launch' 'Bounded native execution requires existing absolute executable and working-directory paths.'
    }
    foreach ($argument in $Arguments) {
        if ($null -eq $argument -or $argument.IndexOf([char]0) -ge 0) {
            Throw-Cx004 'invalid-native-argument' 'A native argument was null or contained NUL.'
        }
    }

    try {
        return [Cx004BoundedProcess]::Run(
            $fullExecutable,
            [string[]] $Arguments,
            $fullWorkingDirectory,
            $TimeoutSeconds * 1000,
            $MaxStdoutBytes,
            $MaxStderrBytes,
            [bool] $ScrubEnvironment
        )
    }
    catch {
        Throw-Cx004 'native-launch-failed' $_.Exception.Message
    }
}

function Get-Cx004Sha256 {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        Throw-Cx004 'missing-file' "Required file is absent: $LiteralPath"
    }

    return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function ConvertTo-Cx004CanonicalJson {
    param(
        [Parameter(Mandatory)] [AllowNull()] [object] $InputObject,
        [int] $Depth = 16
    )

    return ($InputObject | ConvertTo-Json -Depth $Depth -Compress)
}

function Write-Cx004JsonFile {
    param(
        [Parameter(Mandatory)] [string] $LiteralPath,
        [Parameter(Mandatory)] [AllowNull()] [object] $InputObject,
        [int] $Depth = 16
    )

    $json = ConvertTo-Cx004CanonicalJson -InputObject $InputObject -Depth $Depth
    [System.IO.File]::WriteAllText(
        $LiteralPath,
        $json + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Get-Cx004JsonDocument {
    param([Parameter(Mandatory)] [string] $RawJson)

    if ([string]::IsNullOrWhiteSpace($RawJson)) {
        Throw-Cx004 'empty-json' 'Expected a JSON object but received an empty payload.'
    }

    if ([System.Text.Encoding]::UTF8.GetByteCount($RawJson) -gt $script:Cx004MaxJsonBytes) {
        Throw-Cx004 'oversized-json' 'JSON payload exceeded the one MiB contract cap.'
    }

    try {
        return [System.Text.Json.JsonDocument]::Parse(
            $RawJson,
            [System.Text.Json.JsonDocumentOptions]@{
                AllowTrailingCommas = $false
                CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
                MaxDepth = 16
            }
        )
    }
    catch {
        Throw-Cx004 'invalid-json' $_.Exception.Message
    }
}

function Assert-Cx004JsonObjectKeys {
    param(
        [Parameter(Mandatory)] [System.Text.Json.JsonElement] $Element,
        [Parameter(Mandatory)] [string[]] $ExpectedKeys,
        [Parameter(Mandatory)] [string] $Context
    )

    if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
        Throw-Cx004 'invalid-json-shape' "$Context must be a JSON object."
    }

    $actual = @($Element.EnumerateObject() | ForEach-Object Name)
    if ($actual.Count -ne $ExpectedKeys.Count) {
        Throw-Cx004 'unknown-json-shape' "$Context has an unexpected property count."
    }

    for ($index = 0; $index -lt $ExpectedKeys.Count; $index++) {
        if ($actual[$index] -cne $ExpectedKeys[$index]) {
            Throw-Cx004 'unknown-json-shape' "$Context properties or casing differ from the sealed schema."
        }
    }
}

function ConvertFrom-Cx004WsbListRaw {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $RawJson)

    $document = Get-Cx004JsonDocument -RawJson $RawJson
    try {
        $root = $document.RootElement
        Assert-Cx004JsonObjectKeys -Element $root -ExpectedKeys @('WindowsSandboxEnvironments') -Context 'wsb list --raw'
        $environments = $root.GetProperty('WindowsSandboxEnvironments')
        if ($environments.ValueKind -ne [System.Text.Json.JsonValueKind]::Array) {
            Throw-Cx004 'unknown-json-shape' 'WindowsSandboxEnvironments must be an array.'
        }

        $ids = [System.Collections.Generic.List[string]]::new()
        $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($environment in $environments.EnumerateArray()) {
            if ($ids.Count -ge 16) {
                Throw-Cx004 'oversized-session-list' 'The CLI returned more than 16 running session identities.'
            }

            Assert-Cx004JsonObjectKeys -Element $environment -ExpectedKeys @('Id') -Context 'wsb list environment'
            $idElement = $environment.GetProperty('Id')
            if ($idElement.ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
                Throw-Cx004 'invalid-session-id' 'A running session ID was not a string.'
            }

            $idText = $idElement.GetString()
            $guid = [guid]::Empty
            if (-not [guid]::TryParseExact($idText, 'D', [ref] $guid)) {
                Throw-Cx004 'invalid-session-id' 'A running session ID was not a canonical GUID.'
            }

            $canonical = $guid.ToString('D')
            if (-not $seen.Add($canonical)) {
                Throw-Cx004 'duplicate-session-id' 'The CLI returned a duplicate session ID.'
            }
            $ids.Add($canonical)
        }

        return [string[]] $ids.ToArray()
    }
    finally {
        $document.Dispose()
    }
}

function ConvertFrom-Cx004WsbStartRaw {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $RawJson)

    $document = Get-Cx004JsonDocument -RawJson $RawJson
    try {
        $root = $document.RootElement
        Assert-Cx004JsonObjectKeys -Element $root -ExpectedKeys @('Id') -Context 'wsb start --raw'
        $idElement = $root.GetProperty('Id')
        if ($idElement.ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
            Throw-Cx004 'invalid-session-id' 'The start receipt ID was not a string.'
        }

        $guid = [guid]::Empty
        if (-not [guid]::TryParseExact($idElement.GetString(), 'D', [ref] $guid)) {
            Throw-Cx004 'invalid-session-id' 'The start receipt ID was not a canonical GUID.'
        }
        return $guid.ToString('D')
    }
    finally {
        $document.Dispose()
    }
}

function ConvertFrom-Cx004WsbStopRaw {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string] $RawOutput)

    if ($RawOutput.Length -ne 0) {
        Throw-Cx004 'unknown-stop-shape' 'Successful wsb stop --raw stdout must be exactly empty.'
    }
    return $true
}

function Assert-Cx004NoRunningSessions {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $RawJson)

    $ids = @(ConvertFrom-Cx004WsbListRaw -RawJson $RawJson)
    if ($ids.Count -ne 0) {
        Throw-Cx004 'preexisting-running-session' 'Q0S refuses to run while any Windows Sandbox session already exists.'
    }
    return $true
}

function Get-Cx004FullPath {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    return [System.IO.Path]::GetFullPath($LiteralPath).TrimEnd('\')
}

function Test-Cx004PathDescendant {
    param(
        [Parameter(Mandatory)] [string] $Candidate,
        [Parameter(Mandatory)] [string] $Root
    )

    $candidatePath = Get-Cx004FullPath -LiteralPath $Candidate
    $rootPath = Get-Cx004FullPath -LiteralPath $Root
    return $candidatePath.StartsWith($rootPath + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-Cx004PathOverlap {
    param(
        [Parameter(Mandatory)] [string] $Left,
        [Parameter(Mandatory)] [string] $Right
    )

    $leftPath = Resolve-Cx004PhysicalPath -LiteralPath $Left
    $rightPath = Resolve-Cx004PhysicalPath -LiteralPath $Right
    return $leftPath.Equals($rightPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Test-Cx004PathDescendant -Candidate $leftPath -Root $rightPath) -or
        (Test-Cx004PathDescendant -Candidate $rightPath -Root $leftPath)
}

function Resolve-Cx004PhysicalPath {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    $fullPath = Get-Cx004FullPath -LiteralPath $LiteralPath
    $missingLeaves = [System.Collections.Generic.List[string]]::new()
    $cursor = $fullPath
    while (-not (Test-Path -LiteralPath $cursor)) {
        $leaf = [System.IO.Path]::GetFileName($cursor)
        $parent = [System.IO.Path]::GetDirectoryName($cursor)
        if ([string]::IsNullOrWhiteSpace($leaf) -or [string]::IsNullOrWhiteSpace($parent) -or $parent -ceq $cursor) {
            Throw-Cx004 'physical-path-unresolvable' "No existing ancestor could resolve the protected path: $LiteralPath"
        }
        $missingLeaves.Insert(0, $leaf)
        $cursor = $parent
    }
    Initialize-Cx004NativeFileInfo
    $resolved = [Cx004NativeFileInfo]::ResolveFinalPath($cursor).TrimEnd('\')
    foreach ($leaf in $missingLeaves) {
        $resolved = [System.IO.Path]::Combine($resolved, $leaf)
    }
    return (Get-Cx004FullPath -LiteralPath $resolved)
}

function Get-Cx004ProtectedRoots {
    $repoRoot = Get-Cx004FullPath -LiteralPath (Join-Path $PSScriptRoot '..\..\..\..')
    $userProfile = [System.IO.Path]::GetFullPath(
        [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile)
    ).TrimEnd('\')
    $roots = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
        $repoRoot,
        (Join-Path $repoRoot 'data'),
        (Join-Path $userProfile '.codex'),
        (Join-Path $userProfile '.claude'),
        $env:PC_DATA_DIR,
        $env:CODEX_HOME,
        $env:CLAUDE_CONFIG_DIR
    )) {
        if (-not [string]::IsNullOrWhiteSpace([string] $candidate)) {
            try {
                $roots.Add((Resolve-Cx004PhysicalPath -LiteralPath ([string] $candidate)))
            }
            catch {
                Throw-Cx004 'protected-root-invalid' "A repository, app-data, or provider-home root could not be physically resolved: $candidate"
            }
        }
    }
    return [string[]] @($roots | Sort-Object -Unique)
}

function Assert-Cx004QualificationRootSafety {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    $candidate = Get-Cx004FullPath -LiteralPath $LiteralPath
    if (-not (Test-Cx004PathDescendant -Candidate $candidate -Root $script:Cx004RunsRoot)) {
        Throw-Cx004 'unsafe-qualification-root' 'The qualification bundle must be beneath the OS-known LocalApplicationData evidence root.'
    }
    foreach ($protectedRoot in Get-Cx004ProtectedRoots) {
        if (Test-Cx004PathOverlap -Left $candidate -Right $protectedRoot) {
            Throw-Cx004 'qualification-root-overlap' "The qualification bundle overlaps a repository, app-data, or provider-home boundary: $protectedRoot"
        }
    }
    Assert-Cx004NoReparsePath -LiteralPath $candidate
}

function Set-Cx004PrivateDirectoryAcl {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowedSids = @(
        $currentSid,
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    )
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($currentSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in $allowedSids) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void] $security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $LiteralPath -AclObject $security

    $verified = Get-Acl -LiteralPath $LiteralPath
    if (-not $verified.AreAccessRulesProtected -or
        $verified.Owner -cne $currentSid.Translate([System.Security.Principal.NTAccount]).Value) {
        Throw-Cx004 'private-acl-unproven' 'The qualification root owner or protected ACL was not positively applied.'
    }
    $rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) {
        Throw-Cx004 'private-acl-unproven' 'The qualification root ACL does not contain exactly three explicit allow entries.'
    }
    foreach ($sid in $allowedSids) {
        $matches = @($rules | Where-Object {
            $_.IdentityReference.Value -ceq $sid.Value -and
            $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            -not $_.IsInherited -and
            ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
            $_.InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -and
            $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None
        })
        if ($matches.Count -ne 1) {
            Throw-Cx004 'private-acl-unproven' "The qualification root ACL is missing the exact full-control rule for $($sid.Value)."
        }
    }
    return [ordered]@{
        ownerSid = $currentSid.Value
        protected = $true
        allowedFullControlSids = @($allowedSids | ForEach-Object Value)
        sddl = $verified.Sddl
    }
}

function New-Cx004QualificationBundleRoot {
    [CmdletBinding()]
    param()

    if ([string]::IsNullOrWhiteSpace($script:Cx004KnownLocalAppData)) {
        Throw-Cx004 'known-folder-unavailable' 'The OS LocalApplicationData known folder is unavailable.'
    }
    if (Test-Cx004PathOverlap -Left $script:Cx004RunsRoot -Right (Join-Path (Get-Cx004FullPath -LiteralPath (Join-Path $PSScriptRoot '..\..\..\..')) 'data')) {
        Throw-Cx004 'unsafe-runs-root' 'The evidence root overlaps repository data.'
    }
    [System.IO.Directory]::CreateDirectory($script:Cx004RunsRoot) | Out-Null
    Assert-Cx004NoReparsePath -LiteralPath $script:Cx004RunsRoot

    $qualificationId = [guid]::NewGuid().ToString('N')
    $qualificationRoot = Join-Path $script:Cx004RunsRoot $qualificationId
    if (Test-Path -LiteralPath $qualificationRoot) {
        Throw-Cx004 'qualification-root-collision' 'The fresh qualification root already exists.'
    }
    [System.IO.Directory]::CreateDirectory($qualificationRoot) | Out-Null
    Assert-Cx004QualificationRootSafety -LiteralPath $qualificationRoot
    $acl = Set-Cx004PrivateDirectoryAcl -LiteralPath $qualificationRoot
    $hostRoot = Join-Path $qualificationRoot 'host'
    [System.IO.Directory]::CreateDirectory($hostRoot) | Out-Null
    Assert-Cx004QualificationRootSafety -LiteralPath $hostRoot
    return [pscustomobject]@{
        QualificationId = $qualificationId
        Root = $qualificationRoot
        HostRoot = $hostRoot
        Acl = $acl
    }
}

function Assert-Cx004NoReparsePath {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    $fullPath = Get-Cx004FullPath -LiteralPath $LiteralPath
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    $relative = $fullPath.Substring($root.Length)
    $cursor = $root
    foreach ($part in ($relative -split '\\')) {
        if ([string]::IsNullOrWhiteSpace($part)) { continue }
        $cursor = [System.IO.Path]::Combine($cursor, $part)
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-Cx004 'reparse-path' "A Q0S path component is a reparse point: $cursor"
            }
        }
    }
}

function Assert-Cx004RunDirectory {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    if (-not (Test-Cx004PathDescendant -Candidate $LiteralPath -Root $script:Cx004RunsRoot)) {
        Throw-Cx004 'unsafe-run-path' 'Run paths must be descendants of the dedicated CX-004 local evidence root.'
    }
    Assert-Cx004NoReparsePath -LiteralPath $LiteralPath
}

function Get-Cx004BoundedDirectoryItems {
    param(
        [Parameter(Mandatory)] [string] $LiteralPath,
        [ValidateRange(1, 4096)] [int] $MaximumEntries,
        [datetime] $DeadlineUtc = [datetime]::MaxValue
    )

    $items = [System.Collections.Generic.List[System.IO.FileSystemInfo]]::new()
    $enumerator = [System.IO.Directory]::EnumerateFileSystemEntries($LiteralPath).GetEnumerator()
    try {
        while ($enumerator.MoveNext()) {
            if ([DateTime]::UtcNow -gt $DeadlineUtc) {
                Throw-Cx004 'directory-enumeration-timeout' 'Bounded directory enumeration exceeded its finite deadline.'
            }
            if ($items.Count -ge $MaximumEntries) {
                Throw-Cx004 'directory-entry-overflow' "A bounded directory contained more than $MaximumEntries entries."
            }
            $items.Add((Get-Item -LiteralPath ([string] $enumerator.Current) -Force))
        }
    }
    finally {
        if ($enumerator -is [System.IDisposable]) { $enumerator.Dispose() }
    }
    $items.ToArray()
}

function Render-Cx004SandboxConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $TemplatePath,
        [Parameter(Mandatory)] [string] $InputHostPath,
        [Parameter(Mandatory)] [string] $OutputHostPath,
        [Parameter(Mandatory)] [string] $DestinationPath
    )

    foreach ($path in @($InputHostPath, $OutputHostPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            Throw-Cx004 'missing-mapping-path' "Mapped directory is absent: $path"
        }
        Assert-Cx004RunDirectory -LiteralPath $path
    }

    $inputParent = Get-Cx004FullPath -LiteralPath ([System.IO.Path]::GetDirectoryName($InputHostPath))
    $outputParent = Get-Cx004FullPath -LiteralPath ([System.IO.Path]::GetDirectoryName($OutputHostPath))
    $destinationParent = Get-Cx004FullPath -LiteralPath ([System.IO.Path]::GetDirectoryName($DestinationPath))
    if ([System.IO.Path]::GetFileName($InputHostPath) -cne 'input' -or [System.IO.Path]::GetFileName($OutputHostPath) -cne 'output') {
        Throw-Cx004 'unsafe-mapping-leaf' 'Mapped directory leaves must be exactly input and output.'
    }
    if ((Get-Cx004FullPath -LiteralPath $InputHostPath) -ceq (Get-Cx004FullPath -LiteralPath $OutputHostPath)) {
        Throw-Cx004 'duplicate-mapping-path' 'Input and output mappings must be distinct directories.'
    }
    if ($inputParent -cne $outputParent -or $inputParent -cne $destinationParent) {
        Throw-Cx004 'unsafe-render-destination' 'Both mappings and the rendered XML must share one fresh run root.'
    }
    if ([System.IO.Path]::GetFileName($DestinationPath) -cne 'sandbox.wsb') {
        Throw-Cx004 'unsafe-render-destination' 'The rendered XML leaf must be exactly sandbox.wsb.'
    }
    if (Test-Path -LiteralPath $DestinationPath) {
        Throw-Cx004 'existing-render-destination' 'The rendered XML destination must not already exist.'
    }
    if ((Get-Cx004FullPath -LiteralPath $DestinationPath) -ceq (Get-Cx004FullPath -LiteralPath $TemplatePath)) {
        Throw-Cx004 'template-overwrite' 'The rendered XML destination cannot be the stable template.'
    }
    Assert-Cx004RunDirectory -LiteralPath $destinationParent

    if (@(Get-ChildItem -LiteralPath $OutputHostPath -Force).Count -ne 0) {
        Throw-Cx004 'nonempty-output' 'The writable output mapping must be newly created and empty.'
    }

    $template = [System.IO.File]::ReadAllText($TemplatePath, [System.Text.Encoding]::UTF8)
    $inputToken = '{{INPUT_HOST_PATH}}'
    $outputToken = '{{OUTPUT_HOST_PATH}}'
    if (($template.Split($inputToken).Count - 1) -ne 1 -or ($template.Split($outputToken).Count - 1) -ne 1) {
        Throw-Cx004 'template-token-count' 'The stable template must contain each declared mapping token exactly once.'
    }

    $escapedInput = [System.Security.SecurityElement]::Escape((Get-Cx004FullPath -LiteralPath $InputHostPath))
    $escapedOutput = [System.Security.SecurityElement]::Escape((Get-Cx004FullPath -LiteralPath $OutputHostPath))
    $rendered = $template.Replace($inputToken, $escapedInput).Replace($outputToken, $escapedOutput)
    if ($rendered.Contains('{{')) {
        Throw-Cx004 'unresolved-template-token' 'The rendered Sandbox configuration contains an unresolved token.'
    }

    $xml = [System.Xml.XmlDocument]::new()
    $xml.PreserveWhitespace = $true
    try { $xml.LoadXml($rendered) } catch { Throw-Cx004 'invalid-rendered-xml' $_.Exception.Message }
    [System.IO.File]::WriteAllText($DestinationPath, $rendered, [System.Text.UTF8Encoding]::new($false))
    return $rendered
}

function Get-Cx004AuthenticodeFact {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    $signature = Get-AuthenticodeSignature -LiteralPath $LiteralPath
    return [ordered]@{
        status = [string] $signature.Status
        signerSubject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
        signerThumbprint = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    }
}

function Assert-Cx004MicrosoftAuthenticode {
    param(
        [Parameter(Mandatory)] [string] $LiteralPath,
        [Parameter(Mandatory)] [string] $Role
    )

    $fact = Get-Cx004AuthenticodeFact -LiteralPath $LiteralPath
    if ($fact.status -cne 'Valid' -or
        [string]::IsNullOrWhiteSpace([string] $fact.signerSubject) -or
        $fact.signerSubject -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
        Throw-Cx004 'microsoft-signature-unproven' "$Role is not covered by a valid Microsoft Authenticode signature."
    }
    return $fact
}

function Get-Cx004WsbAliasBinding {
    param([Parameter(Mandatory)] [string] $WsbPath)

    $expectedAlias = Join-Path $script:Cx004KnownLocalAppData 'Microsoft\WindowsApps\wsb.exe'
    if ((Get-Cx004FullPath -LiteralPath $WsbPath) -cne (Get-Cx004FullPath -LiteralPath $expectedAlias)) {
        Throw-Cx004 'unexpected-wsb-alias' 'Native Sandbox execution was not directed to the canonical AppExecutionAlias.'
    }
    $aliasItem = Get-Item -LiteralPath $expectedAlias -Force
    if (($aliasItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -or $aliasItem.Length -ne 0) {
        Throw-Cx004 'unexpected-wsb-alias' 'The canonical wsb.exe path is no longer one zero-length AppExecutionAlias reparse point.'
    }

    $packages = @(Get-AppxPackage -Name MicrosoftWindows.WindowsSandbox -ErrorAction Stop)
    if ($packages.Count -ne 1) {
        Throw-Cx004 'sandbox-package-identity-mismatch' 'Exactly one registered Sandbox package was not available at native use time.'
    }
    $package = $packages[0]
    if ([string] $package.Status -cne 'Ok' -or [string] $package.SignatureKind -cne 'Store' -or
        [string] $package.PackageFullName -cne $script:Cx004ExpectedSandboxPackageFullName -or
        [string] $package.PackageFamilyName -cne $script:Cx004ExpectedSandboxPackageFamilyName -or
        [string] $package.Publisher -cne $script:Cx004ExpectedSandboxPublisher -or
        [string] $package.PublisherId -cne $script:Cx004ExpectedSandboxPublisherId -or
        [string] $package.Version -cne $script:Cx004ExpectedSandboxVersion -or
        [string] $package.Architecture -cne 'X64') {
        Throw-Cx004 'sandbox-package-identity-mismatch' 'The Sandbox package registration changed from the sealed Microsoft Store identity.'
    }
    $installLocation = Get-Cx004FullPath -LiteralPath ([string] $package.InstallLocation)
    $expectedInstallLocation = Get-Cx004FullPath -LiteralPath (Join-Path `
        ([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles)) `
        "WindowsApps\$($script:Cx004ExpectedSandboxPackageFullName)")
    if ($installLocation -cne $expectedInstallLocation) {
        Throw-Cx004 'sandbox-package-location-mismatch' 'The Sandbox package registration no longer resolves to the exact reviewed WindowsApps identity path.'
    }
    $expectedTarget = Join-Path $installLocation 'wsb.exe'
    Initialize-Cx004NativeFileInfo
    $link = [Cx004NativeFileInfo]::ReadAppExecLink($expectedAlias)
    $expectedStrings = @(
        $script:Cx004ExpectedSandboxPackageFamilyName,
        "$($script:Cx004ExpectedSandboxPackageFamilyName)!AppCli",
        $expectedTarget,
        '0'
    )
    if ($link.ReparseTag -cne '8000001b' -or $link.Version -ne 3 -or
        $link.RawSha256 -cne $script:Cx004ExpectedAppExecLinkSha256 -or
        $link.Strings.Count -ne $expectedStrings.Count -or
        (($link.Strings -join "`n") -cne ($expectedStrings -join "`n"))) {
        Throw-Cx004 'wsb-appexeclink-mismatch' 'The canonical execution alias payload does not bind the exact Sandbox PFN, AppCli identity, and reviewed package target.'
    }
    Assert-Cx004NoReparsePath -LiteralPath $installLocation
    $roleFacts = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $script:Cx004ExpectedPackageHashes.GetEnumerator()) {
        $path = Join-Path $installLocation $entry.Key
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-Cx004Sha256 -LiteralPath $path) -cne $entry.Value) {
            Throw-Cx004 'sandbox-package-hash-mismatch' "Sandbox package role changed at native use time: $($entry.Key)"
        }
        $roleFacts.Add([ordered]@{
            role = $entry.Key
            sha256 = $entry.Value
            length = [long] (Get-Item -LiteralPath $path).Length
        })
    }
    $appxSignature = Assert-Cx004MicrosoftAuthenticode -LiteralPath (Join-Path $installLocation 'AppxSignature.p7x') -Role 'AppxSignature.p7x'
    if ($appxSignature.signerSubject -cne $script:Cx004ExpectedSandboxPublisher) {
        Throw-Cx004 'sandbox-package-signature-mismatch' 'The AppX signature subject changed at native use time.'
    }
    return [ordered]@{
        aliasPath = $expectedAlias
        aliasAttributes = [string] $aliasItem.Attributes
        aliasLength = [long] $aliasItem.Length
        appExecLink = [ordered]@{
            reparseTag = $link.ReparseTag
            dataLength = [long] $link.DataLength
            version = [long] $link.Version
            strings = @($link.Strings)
            rawSha256 = $link.RawSha256
        }
        packageFullName = [string] $package.PackageFullName
        packageFamilyName = [string] $package.PackageFamilyName
        installLocation = $installLocation
        roleFacts = @($roleFacts)
        appxSignature = $appxSignature
    }
}

function Get-Cx004HostDoctor {
    [CmdletBinding()]
    param([string] $EvidenceRoot)

    if (-not [System.Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -cne 'AMD64') {
        Throw-Cx004 'unsupported-architecture' 'Q0S requires an AMD64 Windows host.'
    }

    $os = Get-CimInstance Win32_OperatingSystem
    $currentVersion = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $fullBuild = "{0}.{1}" -f $currentVersion.CurrentBuildNumber, $currentVersion.UBR
    if ($fullBuild -cne '26200.8655' -or $currentVersion.EditionID -cne 'Professional' -or $currentVersion.InstallationType -cne 'Client') {
        Throw-Cx004 'unsupported-host' "Q0S is pinned to Windows 11 Pro client 10.0.26200.8655; observed $fullBuild/$($currentVersion.EditionID)/$($currentVersion.InstallationType)."
    }

    $feature = Get-CimInstance Win32_OptionalFeature -Filter "Name='Containers-DisposableClientVM'"
    if ($null -eq $feature -or [int] $feature.InstallState -ne 1) {
        Throw-Cx004 'sandbox-feature-disabled' 'Containers-DisposableClientVM is not enabled.'
    }

    $pendingRestart = @(@(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
    ) | Where-Object { Test-Path -LiteralPath $_ })
    if ($pendingRestart.Count -ne 0) {
        Throw-Cx004 'pending-feature-restart' 'A Windows servicing restart is still pending.'
    }

    $packages = @(Get-AppxPackage -Name MicrosoftWindows.WindowsSandbox -ErrorAction SilentlyContinue)
    if ($packages.Count -ne 1) {
        Throw-Cx004 'modern-sandbox-package-missing' 'The modern Store-delivered Windows Sandbox package is unavailable.'
    }
    $package = $packages[0]
    if ([string] $package.Status -cne 'Ok' -or
        [string] $package.SignatureKind -cne 'Store' -or
        [string] $package.Name -cne 'MicrosoftWindows.WindowsSandbox' -or
        [string] $package.PackageFullName -cne $script:Cx004ExpectedSandboxPackageFullName -or
        [string] $package.PackageFamilyName -cne $script:Cx004ExpectedSandboxPackageFamilyName -or
        [string] $package.Publisher -cne $script:Cx004ExpectedSandboxPublisher -or
        [string] $package.PublisherId -cne $script:Cx004ExpectedSandboxPublisherId -or
        [string] $package.Version -cne $script:Cx004ExpectedSandboxVersion -or
        [string] $package.Architecture -cne 'X64') {
        Throw-Cx004 'sandbox-package-identity-mismatch' 'The registered Sandbox package differs from the sealed Microsoft Store identity.'
    }
    $installLocation = Get-Cx004FullPath -LiteralPath ([string] $package.InstallLocation)
    $windowsAppsRoot = Join-Path ([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles)) 'WindowsApps'
    if (-not (Test-Cx004PathDescendant -Candidate $installLocation -Root $windowsAppsRoot) -or
        [System.IO.Path]::GetFileName($installLocation) -cne $script:Cx004ExpectedSandboxPackageFullName) {
        Throw-Cx004 'sandbox-package-location-mismatch' 'The Sandbox package is not installed at its exact WindowsApps identity path.'
    }
    Assert-Cx004NoReparsePath -LiteralPath $installLocation

    $expectedAlias = Join-Path $script:Cx004KnownLocalAppData 'Microsoft\WindowsApps\wsb.exe'
    $commands = @(Get-Command wsb.exe -All -CommandType Application -ErrorAction SilentlyContinue)
    if ($commands.Count -ne 1) {
        Throw-Cx004 'modern-sandbox-cli-missing' 'The modern wsb CLI execution alias is unavailable.'
    }
    $command = $commands[0]
    if ((Get-Cx004FullPath -LiteralPath $command.Source) -cne (Get-Cx004FullPath -LiteralPath $expectedAlias)) {
        Throw-Cx004 'unexpected-wsb-alias' 'The only resolved wsb command is not the canonical per-user AppExecutionAlias.'
    }
    $aliasItem = Get-Item -LiteralPath $expectedAlias -Force
    if (($aliasItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -or $aliasItem.Length -ne 0) {
        Throw-Cx004 'unexpected-wsb-alias' 'The resolved wsb command is not the expected packaged execution alias.'
    }
    $aliasBinding = Get-Cx004WsbAliasBinding -WsbPath $expectedAlias

    $manifestPath = Join-Path $installLocation 'AppxManifest.xml'
    $blockMapPath = Join-Path $installLocation 'AppxBlockMap.xml'
    $signaturePath = Join-Path $installLocation 'AppxSignature.p7x'
    foreach ($required in @($manifestPath, $blockMapPath, $signaturePath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            Throw-Cx004 'sandbox-package-surface-missing' "Required package role is absent: $required"
        }
    }
    [xml] $manifestXml = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
    $wsbAliases = @($manifestXml.SelectNodes("//*[local-name()='Extension' and @Category='windows.appExecutionAlias' and @Executable='wsb.exe']//*[local-name()='ExecutionAlias' and @Alias='wsb.exe']"))
    if ($wsbAliases.Count -ne 1) {
        Throw-Cx004 'sandbox-alias-manifest-mismatch' 'The package manifest does not declare exactly one wsb.exe AppExecutionAlias bound to wsb.exe.'
    }

    foreach ($entry in $script:Cx004ExpectedPackageHashes.GetEnumerator()) {
        $path = Join-Path $installLocation $entry.Key
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-Cx004Sha256 -LiteralPath $path) -cne $entry.Value) {
            Throw-Cx004 'sandbox-package-hash-mismatch' "Sandbox package role differs from the reviewed S0 identity: $($entry.Key)"
        }
    }
    $appxSignature = Assert-Cx004MicrosoftAuthenticode -LiteralPath $signaturePath -Role 'AppxSignature.p7x'
    if ($appxSignature.signerSubject -cne $script:Cx004ExpectedSandboxPublisher) {
        Throw-Cx004 'sandbox-package-signature-mismatch' 'The valid AppX signature subject differs from the registered Microsoft publisher.'
    }

    [xml] $blockMapXml = [System.IO.File]::ReadAllText($blockMapPath, [System.Text.Encoding]::UTF8)
    $packagedRoles = @(
        'wsb.exe',
        'wsb.dll',
        'WindowsSandboxServer.exe',
        'WindowsSandboxRemoteSession.exe',
        'WindowsSandboxRemoteSession.dll'
    )
    $launchers = [System.Collections.Generic.List[object]]::new()
    foreach ($role in $packagedRoles) {
        $blockEntries = @($blockMapXml.BlockMap.File | Where-Object { [string] $_.Name -ceq $role })
        $rolePath = Join-Path $installLocation $role
        $item = Get-Item -LiteralPath $rolePath
        if ($blockEntries.Count -ne 1 -or [long] $blockEntries[0].Size -ne [long] $item.Length) {
            Throw-Cx004 'sandbox-blockmap-mismatch' "Package role is absent or size-mismatched in AppxBlockMap.xml: $role"
        }
        $roleSignature = Get-Cx004AuthenticodeFact -LiteralPath $rolePath
        if ($roleSignature.status -cne 'NotSigned') {
            Throw-Cx004 'sandbox-role-signature-disposition' "Packaged role no longer has the reviewed AppX-only signature disposition: $role"
        }
        $launchers.Add([ordered]@{
            role = $role
            version = $item.VersionInfo.FileVersion
            length = [long] $item.Length
            sha256 = Get-Cx004Sha256 -LiteralPath $rolePath
            signature = $roleSignature
            blockMapDeclared = $true
            disposition = 'package-bound-by-valid-appx-signature-and-blockmap'
        })
    }

    $systemLauncherPath = Join-Path `
        ([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Windows)) `
        'System32\WindowsSandbox.exe'
    if (-not (Test-Path -LiteralPath $systemLauncherPath -PathType Leaf) -or
        (Get-Cx004Sha256 -LiteralPath $systemLauncherPath) -cne '725dc7be3297e5b57fb93fdafa249b94a1cccdccc78ccdbed69df61b907f715e') {
        Throw-Cx004 'system-sandbox-launcher-mismatch' 'System32 WindowsSandbox.exe differs from the reviewed host-build identity.'
    }
    $systemLauncherSignature = Assert-Cx004MicrosoftAuthenticode -LiteralPath $systemLauncherPath -Role 'System32 WindowsSandbox.exe'
    $systemLauncherItem = Get-Item -LiteralPath $systemLauncherPath
    $launchers.Insert(0, [ordered]@{
        role = 'System32/WindowsSandbox.exe'
        version = $systemLauncherItem.VersionInfo.FileVersion
        length = [long] $systemLauncherItem.Length
        sha256 = Get-Cx004Sha256 -LiteralPath $systemLauncherPath
        signature = $systemLauncherSignature
        blockMapDeclared = $false
        disposition = 'valid-microsoft-authenticode'
    })

    $versionReceipt = Invoke-Cx004WsbNative -WsbPath $expectedAlias -Arguments @('--version') -TimeoutSeconds 30
    if (-not [string]::IsNullOrWhiteSpace($EvidenceRoot)) {
        Assert-Cx004QualificationRootSafety -LiteralPath $EvidenceRoot
        Write-Cx004JsonFile -LiteralPath (Join-Path $EvidenceRoot 'host-doctor-version-native.json') -InputObject $versionReceipt -Depth 32
    }
    Assert-Cx004WsbNativeComplete -Receipt $versionReceipt
    if ($versionReceipt.ExitCode -ne 0 -or $versionReceipt.Stderr.Length -ne 0 -or
        $versionReceipt.Raw -cnotmatch '^0\.5\.3\.0(?:\r?\n)?$') {
        Throw-Cx004 'wsb-version-mismatch' 'The CLI version does not equal the registered package version.'
    }

    return [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        host = [ordered]@{
            osCaption = $os.Caption
            fullBuild = $fullBuild
            editionId = $currentVersion.EditionID
            installationType = $currentVersion.InstallationType
            architecture = $env:PROCESSOR_ARCHITECTURE
        }
        feature = [ordered]@{
            name = $feature.Name
            installState = [int] $feature.InstallState
            pendingRestart = $false
        }
        package = [ordered]@{
            name = $package.Name
            packageFullName = $package.PackageFullName
            packageFamilyName = $package.PackageFamilyName
            version = [string] $package.Version
            publisher = $package.Publisher
            publisherId = $package.PublisherId
            architecture = [string] $package.Architecture
            signatureKind = [string] $package.SignatureKind
            status = [string] $package.Status
            installLocation = $installLocation
            manifestSha256 = Get-Cx004Sha256 -LiteralPath $manifestPath
            blockMapSha256 = Get-Cx004Sha256 -LiteralPath $blockMapPath
            appxSignatureSha256 = Get-Cx004Sha256 -LiteralPath $signaturePath
            appxSignature = $appxSignature
        }
        command = [ordered]@{
            name = $command.Name
            source = $expectedAlias
            aliasLength = $aliasItem.Length
            aliasAttributes = [string] $aliasItem.Attributes
            aliasBinding = $aliasBinding
            manifestAliasExecutable = 'wsb.exe'
            version = $script:Cx004ExpectedSandboxVersion
            versionNativeReceipt = $versionReceipt
        }
        launchers = @($launchers)
    }
}

function Initialize-Cx004NativeFileInfo {
    if ($null -ne ([System.Management.Automation.PSTypeName] 'Cx004NativeFileInfo').Type) {
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class Cx004FileIdentity
{
    public string VolumeSerial { get; set; }
    public string FileId { get; set; }
    public uint LinkCount { get; set; }
}

public sealed class Cx004AppExecLinkIdentity
{
    public string ReparseTag { get; set; }
    public ushort DataLength { get; set; }
    public uint Version { get; set; }
    public string[] Strings { get; set; }
    public string RawSha256 { get; set; }
}

public sealed class Cx004BoundedFileRead
{
    public byte[] Bytes { get; set; }
    public string Sha256 { get; set; }
    public string FinalPath { get; set; }
    public string VolumeSerial { get; set; }
    public string FileId { get; set; }
    public uint LinkCount { get; set; }
}

public static class Cx004NativeFileInfo
{
    private const uint FILE_READ_ATTRIBUTES = 0x80;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint FILE_SHARE_DELETE = 0x4;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
    private const uint FSCTL_GET_REPARSE_POINT = 0x000900A8;
    private const uint IO_REPARSE_TAG_APPEXECLINK = 0x8000001B;

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(
        SafeFileHandle device,
        uint controlCode,
        IntPtr inputBuffer,
        uint inputBufferSize,
        byte[] outputBuffer,
        uint outputBufferSize,
        out uint bytesReturned,
        IntPtr overlapped);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle file,
        StringBuilder path,
        uint pathLength,
        uint flags);

    public static Cx004FileIdentity Read(string path)
    {
        using (SafeFileHandle handle = CreateFileW(
            path,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            IntPtr.Zero))
        {
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW failed for identity query.");
            }

            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileInformationByHandle failed.");
            }

            ulong fileId = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
            return new Cx004FileIdentity
            {
                VolumeSerial = information.VolumeSerialNumber.ToString("x8"),
                FileId = fileId.ToString("x16"),
                LinkCount = information.NumberOfLinks
            };
        }
    }

    private static string ReadFinalPath(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFinalPathNameByHandleW failed.");
        }
        string value = buffer.ToString();
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            return @"\\" + value.Substring(8);
        if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
            return value.Substring(4);
        return value;
    }

    public static Cx004BoundedFileRead ReadBoundedRegularFile(string path, int maximumBytes)
    {
        if (maximumBytes < 1) throw new ArgumentOutOfRangeException("maximumBytes");
        string requestedPath = Path.GetFullPath(path).TrimEnd('\\');
        using (SafeFileHandle handle = CreateFileW(
            requestedPath,
            GENERIC_READ | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
            IntPtr.Zero))
        {
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW failed for bounded regular-file read.");
            }
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileInformationByHandle failed for bounded regular-file read.");
            }
            if ((information.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
                information.NumberOfLinks != 1)
            {
                throw new InvalidOperationException("The bounded input is not one regular, non-reparse, single-link file.");
            }
            string finalPath = ReadFinalPath(handle).TrimEnd('\\');
            if (!String.Equals(finalPath, requestedPath, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("The bounded input resolved through an unexpected physical path.");
            }
            ulong length = ((ulong)information.FileSizeHigh << 32) | information.FileSizeLow;
            if (length > (ulong)maximumBytes)
            {
                throw new InvalidOperationException("The bounded input exceeded its byte cap.");
            }
            byte[] bytes = new byte[(int)length];
            using (var stream = new FileStream(handle, FileAccess.Read, 4096, false))
            {
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int count = stream.Read(bytes, offset, bytes.Length - offset);
                    if (count <= 0) throw new EndOfStreamException("The bounded input ended before its retained length.");
                    offset += count;
                }
                if (stream.ReadByte() != -1 || stream.Length != (long)length)
                {
                    throw new IOException("The bounded input length changed during its retained read.");
                }
            }
            byte[] digest;
            using (SHA256 sha = SHA256.Create()) digest = sha.ComputeHash(bytes);
            var hex = new StringBuilder(64);
            foreach (byte value in digest) hex.Append(value.ToString("x2"));
            ulong fileId = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
            return new Cx004BoundedFileRead
            {
                Bytes = bytes,
                Sha256 = hex.ToString(),
                FinalPath = finalPath,
                VolumeSerial = information.VolumeSerialNumber.ToString("x8"),
                FileId = fileId.ToString("x16"),
                LinkCount = information.NumberOfLinks
            };
        }
    }


    public static Cx004AppExecLinkIdentity ReadAppExecLink(string path)
    {
        using (SafeFileHandle handle = CreateFileW(
            path,
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            IntPtr.Zero))
        {
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW failed for AppExecLink query.");
            }
            byte[] buffer = new byte[16 * 1024];
            uint bytesReturned;
            if (!DeviceIoControl(
                handle,
                FSCTL_GET_REPARSE_POINT,
                IntPtr.Zero,
                0,
                buffer,
                (uint)buffer.Length,
                out bytesReturned,
                IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "FSCTL_GET_REPARSE_POINT failed.");
            }
            if (bytesReturned < 12)
            {
                throw new InvalidOperationException("The AppExecLink reparse buffer was truncated.");
            }
            uint tag = BitConverter.ToUInt32(buffer, 0);
            ushort dataLength = BitConverter.ToUInt16(buffer, 4);
            if (tag != IO_REPARSE_TAG_APPEXECLINK || dataLength < 4 || 8 + dataLength != bytesReturned)
            {
                throw new InvalidOperationException("The reparse buffer is not one exact AppExecLink payload.");
            }
            uint version = BitConverter.ToUInt32(buffer, 8);
            int stringByteLength = dataLength - 4;
            if ((stringByteLength & 1) != 0)
            {
                throw new InvalidOperationException("The AppExecLink string payload is not UTF-16 aligned.");
            }
            string decoded = Encoding.Unicode.GetString(buffer, 12, stringByteLength);
            string[] split = decoded.Split(new[] { '\0' }, StringSplitOptions.None);
            var strings = new List<string>();
            foreach (string value in split)
            {
                if (value.Length != 0) strings.Add(value);
            }
            byte[] exact = new byte[bytesReturned];
            Buffer.BlockCopy(buffer, 0, exact, 0, (int)bytesReturned);
            byte[] digest;
            using (SHA256 sha = SHA256.Create()) digest = sha.ComputeHash(exact);
            var hex = new StringBuilder(64);
            foreach (byte value in digest) hex.Append(value.ToString("x2"));
            return new Cx004AppExecLinkIdentity
            {
                ReparseTag = tag.ToString("x8"),
                DataLength = dataLength,
                Version = version,
                Strings = strings.ToArray(),
                RawSha256 = hex.ToString()
            };
        }
    }

    public static string ResolveFinalPath(string path)
    {
        using (SafeFileHandle handle = CreateFileW(
            path,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            IntPtr.Zero))
        {
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW failed for final-path query.");
            }
            return ReadFinalPath(handle);
        }
    }
}
'@
}

function Get-Cx004PathFact {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    Initialize-Cx004NativeFileInfo
    Assert-Cx004NoReparsePath -LiteralPath $LiteralPath
    $item = Get-Item -LiteralPath $LiteralPath -Force
    $identity = [Cx004NativeFileInfo]::Read($item.FullName)
    $acl = Get-Acl -LiteralPath $item.FullName
    $fact = [ordered]@{
        leaf = $item.Name
        kind = if ($item.PSIsContainer) { 'directory' } else { 'file' }
        volumeSerial = $identity.VolumeSerial
        fileId = $identity.FileId
        linkCount = [uint32] $identity.LinkCount
        attributes = [string] $item.Attributes
        owner = $acl.Owner
        sddl = $acl.Sddl
    }

    if (-not $item.PSIsContainer) {
        if ([uint32] $identity.LinkCount -ne 1) {
            Throw-Cx004 'unexpected-hardlink' "A staged file does not have exactly one link: $($item.Name)"
        }
        $streams = @(Get-Item -LiteralPath $item.FullName -Stream *)
        if ($streams.Count -ne 1 -or $streams[0].Stream -cne ':$DATA') {
            Throw-Cx004 'unexpected-alternate-stream' "A staged file has an alternate data stream: $($item.Name)"
        }
        $fact.length = [long] $item.Length
        $fact.sha256 = Get-Cx004Sha256 -LiteralPath $item.FullName
        $fact.streams = @([ordered]@{ name = $streams[0].Stream; length = [long] $streams[0].Length })
    }

    return $fact
}

function Get-Cx004DirectorySnapshot {
    param(
        [Parameter(Mandatory)] [string] $LiteralPath,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [string[]] $ExpectedLeafNames
    )

    Assert-Cx004RunDirectory -LiteralPath $LiteralPath
    $items = @(Get-Cx004BoundedDirectoryItems `
        -LiteralPath $LiteralPath `
        -MaximumEntries ([Math]::Max(1, $ExpectedLeafNames.Count + 1)) |
        Sort-Object -Property Name)
    $actualNames = @($items | ForEach-Object Name)
    $expectedNames = @($ExpectedLeafNames | Sort-Object)
    if (($actualNames -join "`n") -cne ($expectedNames -join "`n")) {
        Throw-Cx004 'unexpected-directory-surface' "Directory contents differ from the closed allowlist: $LiteralPath"
    }

    return [ordered]@{
        directory = Get-Cx004PathFact -LiteralPath $LiteralPath
        entries = @($items | ForEach-Object { Get-Cx004PathFact -LiteralPath $_.FullName })
    }
}

function New-Cx004Challenge {
    $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

function Get-Cx004DefaultRouteAddress {
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
        Where-Object { $_.State -eq 'Alive' } |
        Sort-Object -Property RouteMetric, InterfaceMetric, InterfaceIndex)
    foreach ($route in $routes) {
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction Stop |
            Where-Object { $_.AddressState -eq 'Preferred' } |
            Sort-Object -Property IPAddress)
        foreach ($entry in $addresses) {
            $parsed = $null
            if ([System.Net.IPAddress]::TryParse([string] $entry.IPAddress, [ref] $parsed) -and
                $parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                -not [System.Net.IPAddress]::IsLoopback($parsed) -and
                -not ([string] $parsed).StartsWith('169.254.', [System.StringComparison]::Ordinal)) {
                return [string] $parsed
            }
        }
    }
    Throw-Cx004 'host-canary-address-unavailable' 'No preferred non-loopback IPv4 address on an alive default-route interface was available.'
}

function New-Cx004HostCanary {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Challenge)

    $address = Get-Cx004DefaultRouteAddress
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($address), 0)
    try {
        $listener.Start(2)
        $endpoint = [System.Net.IPEndPoint] $listener.LocalEndpoint
        $port = [int] $endpoint.Port

        $selfAccept = $listener.AcceptTcpClientAsync()
        $selfClient = [System.Net.Sockets.TcpClient]::new([System.Net.Sockets.AddressFamily]::InterNetwork)
        try {
            $connectTask = $selfClient.ConnectAsync($address, $port)
            if (-not $connectTask.Wait(3000) -or -not $selfAccept.Wait(3000)) {
                Throw-Cx004 'host-canary-self-probe-timeout' 'The synthetic host canary did not complete its bounded loopback-through-interface self-probe.'
            }
            $accepted = $selfAccept.Result
            try {
                if (-not $selfClient.Connected -or -not $accepted.Connected) {
                    Throw-Cx004 'host-canary-self-probe-failed' 'The synthetic host canary did not positively accept its self-probe.'
                }
            }
            finally { $accepted.Dispose() }
        }
        finally { $selfClient.Dispose() }

        $guestAccept = $listener.AcceptTcpClientAsync()
        return [pscustomobject]@{
            Address = $address
            Port = $port
            Challenge = $Challenge
            Listener = $listener
            GuestAcceptTask = $guestAccept
            SelfProbe = [ordered]@{
                address = $address
                port = [long] $port
                connected = $true
                accepted = $true
                timeoutMilliseconds = [long] 3000
            }
        }
    }
    catch {
        $listener.Stop()
        throw
    }
}

function Complete-Cx004HostCanary {
    param([Parameter(Mandatory)] [object] $Canary)

    $connected = $false
    $acceptedClient = $null
    $task = $Canary.GuestAcceptTask
    $statusBeforeFence = $task.Status
    $wasPending = -not $task.IsCompleted
    try {
        $Canary.Listener.Stop()
    }
    catch {
        Throw-Cx004 'host-canary-listener-close-failed' 'The retained host canary listener did not positively close after exact Sandbox teardown.'
    }
    try {
        $waitIndex = [System.Threading.Tasks.Task]::WaitAny(
            [System.Threading.Tasks.Task[]] @($task),
            3000
        )
        if ($waitIndex -ne 0) {
            Throw-Cx004 'host-canary-observation-uncertain' 'The host canary accept task did not settle after the listener-close fence.'
        }
        if ($task.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
            $acceptedClient = $task.Result
            if ($null -eq $acceptedClient) {
                Throw-Cx004 'host-canary-observation-uncertain' 'The completed host canary accept task returned no client.'
            }
            $connected = $true
        }
        elseif ($wasPending -and $task.Status -eq [System.Threading.Tasks.TaskStatus]::Faulted) {
            $flattened = $task.Exception.Flatten().InnerExceptions
            if ($flattened.Count -ne 1 -or
                $flattened[0] -isnot [System.Net.Sockets.SocketException] -or
                $flattened[0].SocketErrorCode -ne [System.Net.Sockets.SocketError]::OperationAborted -or
                $flattened[0].NativeErrorCode -ne 995) {
                Throw-Cx004 'host-canary-observation-uncertain' 'The listener-close fence produced an unexpected accept-task fault.'
            }
            $connected = $false
        }
        else {
            Throw-Cx004 'host-canary-observation-uncertain' 'The host canary accept task faulted before the listener-close absence fence.'
        }
    }
    finally {
        if ($null -ne $acceptedClient) { $acceptedClient.Dispose() }
    }
    return [ordered]@{
        address = $Canary.Address
        port = [long] $Canary.Port
        challenge = $Canary.Challenge
        selfProbe = $Canary.SelfProbe
        guestConnectionObserved = [bool] $connected
        listenerClosed = $true
        acceptStatusBeforeFence = [string] $statusBeforeFence
        acceptStatusAfterFence = [string] $task.Status
        observation = if ($connected) { 'connection-observed' } else { 'no-connection-before-listener-close-fence' }
    }
}

function Close-Cx004HostCanaryUnproven {
    param([Parameter(Mandatory)] [object] $Canary)

    $closed = $false
    $closeError = $null
    try {
        $Canary.Listener.Stop()
        $closed = $true
    }
    catch {
        $closeError = [ordered]@{ type = $_.Exception.GetType().FullName; message = $_.Exception.Message }
    }
    return [ordered]@{
        address = $Canary.Address
        port = [long] $Canary.Port
        challenge = $Canary.Challenge
        selfProbe = $Canary.SelfProbe
        guestConnectionObserved = $null
        listenerClosed = $closed
        closeError = $closeError
        observation = 'unproven-because-exact-session-teardown-was-not-proved'
    }
}

function New-Cx004RunStage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $TemplatePath,
        [Parameter(Mandatory)] [string] $QualificationRoot,
        [Parameter(Mandatory)] [ValidateSet('session1', 'session2')] [string] $SessionName,
        [Parameter(Mandatory)] [object] $HostCanary,
        [Parameter(Mandatory)] [System.Collections.IDictionary] $SourceSeal
    )

    Assert-Cx004QualificationRootSafety -LiteralPath $QualificationRoot
    $runId = [guid]::NewGuid().ToString('N')
    $challenge = [string] $HostCanary.Challenge
    if ($challenge -cnotmatch '^[0-9a-f]{64}$') {
        Throw-Cx004 'invalid-host-canary-challenge' 'The staged host-canary challenge is not a fresh 256-bit lowercase value.'
    }
    $runRoot = Join-Path $QualificationRoot $SessionName
    $inputPath = Join-Path $runRoot 'input'
    $outputPath = Join-Path $runRoot 'output'
    $renderedConfigPath = Join-Path $runRoot 'sandbox.wsb'
    if (Test-Path -LiteralPath $runRoot) {
        Throw-Cx004 'run-root-collision' 'The fresh run root already exists.'
    }

    [System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($inputPath) | Out-Null
    [System.IO.Directory]::CreateDirectory($outputPath) | Out-Null
    foreach ($path in @($runRoot, $inputPath, $outputPath)) {
        Assert-Cx004RunDirectory -LiteralPath $path
        if (-not (Test-Cx004PathDescendant -Candidate $path -Root $QualificationRoot)) {
            Throw-Cx004 'stage-outside-qualification-root' 'Every staged session path must remain inside the one private qualification bundle.'
        }
    }

    $repoRoot = [string] $SourceSeal.repoRoot
    $fixedNames = @('guest-bootstrap.ps1', 'guest-probe.ps1')
    foreach ($name in $fixedNames) {
        $source = Join-Path $PSScriptRoot $name
        $relativeSource = "packages/windows-containment/lab/sandbox/$name"
        $sealedEntries = @($SourceSeal.files | Where-Object { [string] $_.relativePath -ceq $relativeSource })
        if ($sealedEntries.Count -ne 1 -or -not (Test-Path -LiteralPath $source -PathType Leaf) -or
            (Get-Cx004Sha256 -LiteralPath $source) -cne [string] $sealedEntries[0].sha256 -or
            [long] (Get-Item -LiteralPath $source).Length -ne [long] $sealedEntries[0].length) {
            Throw-Cx004 'missing-fixed-input' "Fixed guest input is absent: $name"
        }
        $stagedPath = Join-Path $inputPath $name
        [System.IO.File]::Copy($source, $stagedPath, $false)
        if ((Get-Cx004Sha256 -LiteralPath $stagedPath) -cne [string] $sealedEntries[0].sha256 -or
            [long] (Get-Item -LiteralPath $stagedPath).Length -ne [long] $sealedEntries[0].length) {
            Throw-Cx004 'staged-source-mismatch' "Staged guest input differs from the sealed source bytes: $name"
        }
    }

    $stableFiles = @($fixedNames | Sort-Object | ForEach-Object {
        $path = Join-Path $inputPath $_
        [ordered]@{
            relativePath = $_
            sha256 = Get-Cx004Sha256 -LiteralPath $path
            length = [long] (Get-Item -LiteralPath $path).Length
        }
    })
    $stableManifestPath = Join-Path $inputPath 'stable-manifest.json'
    $stableManifest = [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        files = $stableFiles
    }
    Write-Cx004JsonFile -LiteralPath $stableManifestPath -InputObject $stableManifest
    $stableManifestSha256 = Get-Cx004Sha256 -LiteralPath $stableManifestPath

    $templateRelativePath = 'packages/windows-containment/lab/sandbox/sandbox.template.wsb'
    $sealedTemplates = @($SourceSeal.files | Where-Object { [string] $_.relativePath -ceq $templateRelativePath })
    if ($sealedTemplates.Count -ne 1 -or
        (Get-Cx004Sha256 -LiteralPath $TemplatePath) -cne [string] $sealedTemplates[0].sha256 -or
        [long] (Get-Item -LiteralPath $TemplatePath).Length -ne [long] $sealedTemplates[0].length) {
        Throw-Cx004 'template-source-mismatch' 'The Sandbox template differs from the sealed S0 source bytes.'
    }
    $renderedConfig = Render-Cx004SandboxConfig `
        -TemplatePath $TemplatePath `
        -InputHostPath $inputPath `
        -OutputHostPath $outputPath `
        -DestinationPath $renderedConfigPath
    $renderedConfigSha256 = Get-Cx004Sha256 -LiteralPath $renderedConfigPath

    $runManifestPath = Join-Path $inputPath 'run-manifest.json'
    $runManifest = [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        runId = $runId
        challenge = $challenge
        stableManifestSha256 = $stableManifestSha256
        renderedConfigSha256 = $renderedConfigSha256
        hostCanaryAddress = [string] $HostCanary.Address
        hostCanaryPort = [long] $HostCanary.Port
    }
    Write-Cx004JsonFile -LiteralPath $runManifestPath -InputObject $runManifest

    $inputSnapshot = Get-Cx004DirectorySnapshot -LiteralPath $inputPath -ExpectedLeafNames $script:Cx004InputNames
    $stageManifestPath = Join-Path $runRoot 'host-stage.json'
    $stageManifest = [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        runId = $runId
        challenge = $challenge
        qualificationRoot = $QualificationRoot
        sessionName = $SessionName
        runRoot = $runRoot
        inputPath = $inputPath
        outputPath = $outputPath
        renderedConfigPath = $renderedConfigPath
        renderedConfigSha256 = $renderedConfigSha256
        stableManifestSha256 = $stableManifestSha256
        templateSha256 = Get-Cx004Sha256 -LiteralPath $TemplatePath
        sourceHead = [string] $SourceSeal.head
        sourceTree = [string] $SourceSeal.tree
        hostCanary = [ordered]@{
            address = [string] $HostCanary.Address
            port = [long] $HostCanary.Port
            challenge = $challenge
            selfProbe = $HostCanary.SelfProbe
        }
        inputSnapshot = $inputSnapshot
        outputSnapshot = Get-Cx004DirectorySnapshot -LiteralPath $outputPath -ExpectedLeafNames @()
    }
    Write-Cx004JsonFile -LiteralPath $stageManifestPath -InputObject $stageManifest -Depth 32

    return [pscustomobject]@{
        RunId = $runId
        Challenge = $challenge
        QualificationRoot = $QualificationRoot
        SessionName = $SessionName
        RunRoot = $runRoot
        InputPath = $inputPath
        OutputPath = $outputPath
        RenderedConfigPath = $renderedConfigPath
        RenderedConfig = $renderedConfig
        RenderedConfigSha256 = $renderedConfigSha256
        StableManifestSha256 = $stableManifestSha256
        TemplateSha256 = $stageManifest.templateSha256
        InitialInputSnapshot = $inputSnapshot
        StageManifestPath = $stageManifestPath
        SourceHead = [string] $SourceSeal.head
        SourceTree = [string] $SourceSeal.tree
        HostCanaryAddress = [string] $HostCanary.Address
        HostCanaryPort = [int] $HostCanary.Port
    }
}

function Invoke-Cx004WsbNative {
    param(
        [Parameter(Mandatory)] [string] $WsbPath,
        [Parameter(Mandatory)] [string[]] $Arguments,
        [ValidateRange(1, 180)] [int] $TimeoutSeconds = 30
    )

    $bindingBefore = Get-Cx004WsbAliasBinding -WsbPath $WsbPath
    $native = Invoke-Cx004BoundedNative `
        -ExecutablePath $WsbPath `
        -Arguments $Arguments `
        -WorkingDirectory $script:Cx004KnownLocalAppData `
        -TimeoutSeconds $TimeoutSeconds `
        -MaxStdoutBytes $script:Cx004MaxJsonBytes `
        -MaxStderrBytes $script:Cx004MaxJsonBytes `
        -ScrubEnvironment
    $bindingAfter = $null
    $bindingAfterError = $null
    try {
        $bindingAfter = Get-Cx004WsbAliasBinding -WsbPath $WsbPath
    }
    catch {
        $bindingAfterError = [ordered]@{
            type = $_.Exception.GetType().FullName
            message = $_.Exception.Message
        }
    }
    $bindingStable = $null -eq $bindingAfterError -and
        (ConvertTo-Cx004CanonicalJson -InputObject $bindingBefore -Depth 16) -ceq
        (ConvertTo-Cx004CanonicalJson -InputObject $bindingAfter -Depth 16)
    return [pscustomobject]@{
        ExitCode = [int] $native.ExitCode
        Raw = [string] $native.Stdout
        Stderr = [string] $native.Stderr
        ProcessId = [int] $native.ProcessId
        StdoutBytes = [long] $native.StdoutBytes
        StderrBytes = [long] $native.StderrBytes
        ElapsedMilliseconds = [long] $native.ElapsedMilliseconds
        TimedOut = [bool] $native.TimedOut
        OutputExceeded = [bool] $native.OutputExceeded
        KillAttempted = [bool] $native.KillAttempted
        KillSucceeded = [bool] $native.KillSucceeded
        ProcessExited = [bool] $native.ProcessExited
        CaptureCompleted = [bool] $native.CaptureCompleted
        CaptureReadersSettled = [bool] $native.CaptureReadersSettled
        CaptureDiscarded = [bool] $native.CaptureDiscarded
        CaptureFaulted = [bool] $native.CaptureFaulted
        CaptureCloseFaulted = [bool] $native.CaptureCloseFaulted
        CaptureByteCountsAvailable = [bool] $native.CaptureByteCountsAvailable
        BindingStable = [bool] $bindingStable
        BindingBefore = $bindingBefore
        BindingAfter = $bindingAfter
        BindingAfterError = $bindingAfterError
    }
}

function Assert-Cx004WsbNativeEnvelope {
    param([Parameter(Mandatory)] [object] $Receipt)

    if ($Receipt.TimedOut) {
        Throw-Cx004 'native-process-timeout' 'The retained wsb CLI process exceeded its finite deadline and was killed without inferring operation success.'
    }
    if (-not $Receipt.CaptureReadersSettled) {
        Throw-Cx004 'native-capture-unproven' 'The retained wsb CLI output collectors did not settle after bounded EOF or explicit cancellation and reader closure.'
    }
    if (-not $Receipt.CaptureByteCountsAvailable) {
        Throw-Cx004 'native-capture-unproven' 'The retained wsb CLI output byte counts are unavailable because its collectors did not settle.'
    }
    if ($Receipt.OutputExceeded -and
        $Receipt.StdoutBytes -le $script:Cx004MaxJsonBytes -and
        $Receipt.StderrBytes -le $script:Cx004MaxJsonBytes) {
        Throw-Cx004 'native-output-overflow' 'The retained wsb CLI exceeded a bounded output cap without a trustworthy stream attribution.'
    }
    if ($Receipt.StdoutBytes -gt $script:Cx004MaxJsonBytes) {
        Throw-Cx004 'native-stdout-overflow' 'The retained wsb CLI process exceeded the stdout cap and was killed without inferring operation success.'
    }
    if ($Receipt.StderrBytes -gt $script:Cx004MaxJsonBytes) {
        Throw-Cx004 'native-stderr-overflow' 'The retained wsb CLI process exceeded the stderr cap and was killed without inferring operation success.'
    }
    if (-not $Receipt.ProcessExited) {
        Throw-Cx004 'native-process-unproven' 'The retained wsb CLI process did not positively exit after bounded handling.'
    }
    if ($Receipt.ProcessId -le 0 -or $Receipt.KillAttempted -or
        ($Receipt.KillSucceeded -and -not $Receipt.KillAttempted)) {
        Throw-Cx004 'native-process-unproven' 'The retained wsb CLI receipt lacks one positive, naturally exited launcher process.'
    }
    if ($Receipt.CaptureCloseFaulted -or $Receipt.CaptureFaulted) {
        Throw-Cx004 'native-capture-unproven' 'The retained wsb CLI output collectors faulted or could not close cleanly during bounded handling.'
    }
    if (-not $Receipt.BindingStable) {
        Throw-Cx004 'wsb-alias-binding-drift' 'The wsb AppExecLink/package identity changed across native execution.'
    }
}

function Assert-Cx004WsbNativeComplete {
    param([Parameter(Mandatory)] [object] $Receipt)

    Assert-Cx004WsbNativeEnvelope -Receipt $Receipt
    if (-not $Receipt.CaptureCompleted -or $Receipt.CaptureDiscarded) {
        Throw-Cx004 'native-capture-unproven' 'The retained wsb CLI output collectors did not positively reach EOF without discarding output.'
    }
}

function Assert-Cx004WsbConnectNativeComplete {
    param([Parameter(Mandatory)] [object] $Receipt)

    Assert-Cx004WsbNativeEnvelope -Receipt $Receipt
    $captureDispositionValid =
        ($Receipt.CaptureCompleted -and -not $Receipt.CaptureDiscarded) -or
        (-not $Receipt.CaptureCompleted -and $Receipt.CaptureDiscarded)
    if (-not $captureDispositionValid) {
        Throw-Cx004 'native-capture-unproven' 'Exact-ID connect lacks exactly one complete-EOF or settled-discard capture disposition.'
    }
    if ($Receipt.CaptureDiscarded -and
        ($Receipt.Raw.Length -ne 0 -or $Receipt.Stderr.Length -ne 0)) {
        Throw-Cx004 'native-capture-unproven' 'Discarded exact-ID connect output was incorrectly retained as interpretable text.'
    }
    if ($Receipt.ExitCode -ne 0) {
        Throw-Cx004 'unknown-connect-result' "Exact-ID wsb connect returned nonzero exit $($Receipt.ExitCode)."
    }
    if ($Receipt.StderrBytes -ne 0) {
        Throw-Cx004 'unknown-connect-result' 'Exact-ID wsb connect produced observed stderr bytes; its opaque result is not accepted.'
    }
}

function Get-Cx004WsbListReceipt {
    param(
        [Parameter(Mandatory)] [string] $WsbPath,
        [string] $NativeReceiptPath
    )

    $receipt = Invoke-Cx004WsbNative -WsbPath $WsbPath -Arguments @('list', '--raw') -TimeoutSeconds 30
    if (-not [string]::IsNullOrWhiteSpace($NativeReceiptPath)) {
        Write-Cx004JsonFile -LiteralPath $NativeReceiptPath -InputObject $receipt -Depth 32
    }
    Assert-Cx004WsbNativeComplete -Receipt $receipt
    if ($receipt.ExitCode -ne 0) {
        Throw-Cx004 'wsb-list-failed' "wsb list --raw exited $($receipt.ExitCode)."
    }
    if ($receipt.Stderr.Length -ne 0) {
        Throw-Cx004 'unexpected-cli-stderr' 'Successful wsb list --raw emitted stderr.'
    }
    $ids = @(ConvertFrom-Cx004WsbListRaw -RawJson $receipt.Raw)
    return [pscustomobject]@{
        Raw = $receipt.Raw
        Ids = [string[]] $ids
        Native = $receipt
    }
}

function Wait-Cx004SessionListState {
    param(
        [Parameter(Mandatory)] [string] $WsbPath,
        [Parameter(Mandatory)] [string] $SessionId,
        [Parameter(Mandatory)] [bool] $ExpectedRunning,
        [Parameter(Mandatory)] [string] $NativeReceiptPath,
        [int] $TimeoutSeconds = 30
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastReceipt = $null
    do {
        $lastReceipt = Get-Cx004WsbListReceipt -WsbPath $WsbPath -NativeReceiptPath $NativeReceiptPath
        $ids = @($lastReceipt.Ids)
        if ($ExpectedRunning) {
            if ($ids.Count -eq 1 -and $ids[0] -ceq $SessionId) {
                return $lastReceipt
            }
            if ($ids.Count -gt 0 -and -not ($ids.Count -eq 1 -and $ids[0] -ceq $SessionId)) {
                Throw-Cx004 'foreign-running-session' 'A running Sandbox identity differs from the retained Q0S session.'
            }
        }
        else {
            if ($ids.Count -eq 0) {
                return $lastReceipt
            }
            if ($ids -notcontains $SessionId) {
                Throw-Cx004 'foreign-running-session' 'The retained session disappeared while another Sandbox remains running.'
            }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)

    $expectation = if ($ExpectedRunning) { 'running as the sole identity' } else { 'absent after exact-ID stop' }
    Throw-Cx004 'session-state-timeout' "The retained session was not positively observed $expectation."
}

function Wait-Cx004GuestTerminalFiles {
    param(
        [Parameter(Mandatory)] [string] $OutputPath,
        [Parameter(Mandatory)] [string] $Challenge,
        [int] $TimeoutSeconds = $script:Cx004SessionTimeoutSeconds
    )

    $temporaryNames = @(
        ".guest-evidence.json-$Challenge.tmp",
        ".result-manifest.json-$Challenge.tmp",
        ".guest-failure-$Challenge.tmp"
    )
    $pollNames = @($script:Cx004AllOutputNames + $temporaryNames)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $items = @(Get-Cx004BoundedDirectoryItems `
            -LiteralPath $OutputPath `
            -MaximumEntries $pollNames.Count `
            -DeadlineUtc $deadline)
        foreach ($item in $items) {
            if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-Cx004 'unexpected-output-object' 'The guest output contains a directory or reparse point.'
            }
            if ($pollNames -cnotcontains $item.Name) {
                Throw-Cx004 'unexpected-output-file' "The guest output contains an undeclared file: $($item.Name)"
            }
            if ($item.Length -gt $script:Cx004MaxJsonBytes) {
                Throw-Cx004 'oversized-output-file' "A guest output exceeded one MiB: $($item.Name)"
            }
        }

        if (Test-Path -LiteralPath (Join-Path $OutputPath 'guest-failure.json')) {
            return [pscustomobject]@{ Kind = 'failure'; Names = @($items.Name | Sort-Object) }
        }
        if (Test-Path -LiteralPath (Join-Path $OutputPath 'result-manifest.json')) {
            $names = @($items.Name | Sort-Object)
            if (($names -join "`n") -cne (($script:Cx004SuccessOutputNames | Sort-Object) -join "`n")) {
                Throw-Cx004 'incomplete-terminal-output' 'A terminal manifest appeared without the exact success output surface.'
            }
            return [pscustomobject]@{ Kind = 'success'; Names = $names }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)

    Throw-Cx004 'guest-terminal-timeout' 'No positive guest terminal receipt appeared before the deadline.'
}

function Assert-Cx004InputSnapshotUnchanged {
    param(
        [Parameter(Mandatory)] [object] $Before,
        [Parameter(Mandatory)] [object] $After
    )

    $beforeJson = ConvertTo-Cx004CanonicalJson -InputObject $Before -Depth 32
    $afterJson = ConvertTo-Cx004CanonicalJson -InputObject $After -Depth 32
    if ($beforeJson -cne $afterJson) {
        Throw-Cx004 'input-mutated' 'The read-only mapped input identity, ACL, stream, size, or hash changed.'
    }
}

function Test-Cx004MappingRelease {
    param(
        [Parameter(Mandatory)] [string] $InputPath,
        [Parameter(Mandatory)] [string] $OutputPath
    )

    foreach ($file in Get-ChildItem -LiteralPath $InputPath -File -Force) {
        $stream = $null
        try {
            $stream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        }
        finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }

    $releasePath = $OutputPath + '.release-check'
    if (Test-Path -LiteralPath $releasePath) {
        Throw-Cx004 'mapping-release-collision' 'The output release-check path already exists.'
    }
    [System.IO.Directory]::Move($OutputPath, $releasePath)
    [System.IO.Directory]::Move($releasePath, $OutputPath)
    return [ordered]@{ exclusiveInputOpen = $true; outputRenameAndBack = $true }
}

function Get-Cx004JsonString {
    param(
        [Parameter(Mandatory)] [System.Text.Json.JsonElement] $Object,
        [Parameter(Mandatory)] [string] $Name,
        [int] $MaximumLength = 4096
    )

    $value = $Object.GetProperty($Name)
    if ($value.ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
        Throw-Cx004 'invalid-guest-schema' "$Name must be a JSON string."
    }
    $text = $value.GetString()
    if ($null -eq $text -or $text.Length -gt $MaximumLength) {
        Throw-Cx004 'invalid-guest-schema' "$Name exceeds its string bound."
    }
    return $text
}

function Get-Cx004JsonBoolean {
    param(
        [Parameter(Mandatory)] [System.Text.Json.JsonElement] $Object,
        [Parameter(Mandatory)] [string] $Name
    )

    $value = $Object.GetProperty($Name)
    if ($value.ValueKind -ne [System.Text.Json.JsonValueKind]::True -and $value.ValueKind -ne [System.Text.Json.JsonValueKind]::False) {
        Throw-Cx004 'invalid-guest-schema' "$Name must be a JSON boolean."
    }
    return $value.GetBoolean()
}

function Get-Cx004JsonInt64 {
    param(
        [Parameter(Mandatory)] [System.Text.Json.JsonElement] $Object,
        [Parameter(Mandatory)] [string] $Name
    )

    $value = $Object.GetProperty($Name)
    $number = [long] 0
    if ($value.ValueKind -ne [System.Text.Json.JsonValueKind]::Number -or -not $value.TryGetInt64([ref] $number)) {
        Throw-Cx004 'invalid-guest-schema' "$Name must be a bounded JSON integer."
    }
    return $number
}

function Assert-Cx004JsonBinding {
    param(
        [Parameter(Mandatory)] [System.Text.Json.JsonElement] $Root,
        [Parameter(Mandatory)] [object] $Stage
    )

    $bindings = [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        runId = $Stage.RunId
        challenge = $Stage.Challenge
        stableManifestSha256 = $Stage.StableManifestSha256
        renderedConfigSha256 = $Stage.RenderedConfigSha256
    }
    foreach ($entry in $bindings.GetEnumerator()) {
        if ((Get-Cx004JsonString -Object $Root -Name $entry.Key -MaximumLength 128) -cne [string] $entry.Value) {
            Throw-Cx004 'guest-binding-mismatch' "Guest field $($entry.Key) does not bind the staged run."
        }
    }
}

function ConvertTo-Cx004IntegrityAlias {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Sid)

    switch -CaseSensitive ($Sid) {
        'S-1-16-4096' { return 'low' }
        'S-1-16-8192' { return 'medium' }
        'S-1-16-8448' { return 'medium-plus' }
        'S-1-16-12288' { return 'high' }
        'S-1-16-16384' { return 'system' }
        'S-1-16-20480' { return 'protected-process' }
        default { Throw-Cx004 'unknown-integrity-sid' 'The integrity SID is outside the closed well-known set.' }
    }
}

function Assert-Cx004IdentityEntry {
    param(
        [Parameter(Mandatory)] [System.Text.Json.JsonElement] $Entry,
        [Parameter(Mandatory)] [string] $Context
    )

    Assert-Cx004JsonObjectKeys -Element $Entry -ExpectedKeys @('sid', 'name', 'type', 'attributes') -Context $Context
    foreach ($name in @('sid', 'name', 'type', 'attributes')) {
        [void] (Get-Cx004JsonString -Object $Entry -Name $name)
    }
}

function Assert-Cx004Canary {
    param(
        [Parameter(Mandatory)] [System.Text.Json.JsonElement] $Entry,
        [Parameter(Mandatory)] [string] $Context,
        [Parameter(Mandatory)] [string] $ExpectedAddress,
        [Parameter(Mandatory)] [int] $ExpectedPort,
        [Parameter(Mandatory)] [string[]] $AllowedDispositions,
        [string] $ExpectedChallenge
    )

    $expectedKeys = if ($PSBoundParameters.ContainsKey('ExpectedChallenge')) {
        @('address', 'port', 'challenge', 'succeeded', 'disposition')
    }
    else {
        @('address', 'port', 'succeeded', 'disposition')
    }
    Assert-Cx004JsonObjectKeys -Element $Entry -ExpectedKeys $expectedKeys -Context $Context
    $disposition = Get-Cx004JsonString -Object $Entry -Name 'disposition' -MaximumLength 64
    if ((Get-Cx004JsonString -Object $Entry -Name 'address') -cne $ExpectedAddress -or
        (Get-Cx004JsonInt64 -Object $Entry -Name 'port') -ne $ExpectedPort -or
        $AllowedDispositions -cnotcontains $disposition -or
        ($PSBoundParameters.ContainsKey('ExpectedChallenge') -and
            (Get-Cx004JsonString -Object $Entry -Name 'challenge' -MaximumLength 64) -cne $ExpectedChallenge)) {
        Throw-Cx004 'network-canary-schema' "$Context did not bind the expected endpoint and closed disposition set."
    }
}

function Read-Cx004BoundedUtf8File {
    param(
        [Parameter(Mandatory)] [string] $LiteralPath,
        [Parameter(Mandatory)] [ValidateRange(1, 4194304)] [int] $MaximumBytes
    )

    Initialize-Cx004NativeFileInfo
    try {
        $read = [Cx004NativeFileInfo]::ReadBoundedRegularFile(
            (Get-Cx004FullPath -LiteralPath $LiteralPath),
            $MaximumBytes
        )
    }
    catch {
        Throw-Cx004 'bounded-output-read-unproven' "A declared guest output could not be retained as one bounded regular file: $($_.Exception.Message)"
    }
    [byte[]] $bytes = $read.Bytes
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) {
        Throw-Cx004 'output-utf8-bom' 'A declared guest output used a forbidden UTF-8 BOM.'
    }
    foreach ($value in $bytes) {
        if ($value -eq 0) { Throw-Cx004 'output-nul-byte' 'A declared guest output contained NUL.' }
    }
    try {
        $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    }
    catch {
        Throw-Cx004 'invalid-output-utf8' 'A declared guest output was not strict UTF-8.'
    }
    $item = Get-Item -LiteralPath $LiteralPath -Force
    $streams = @(Get-Item -LiteralPath $LiteralPath -Stream *)
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $streams.Count -ne 1 -or $streams[0].Stream -cne ':$DATA' -or
        [long] $streams[0].Length -ne [long] $bytes.Length) {
        Throw-Cx004 'bounded-output-read-unproven' 'A declared guest output changed surface or stream identity after its retained read.'
    }
    $acl = Get-Acl -LiteralPath $LiteralPath
    return [pscustomobject]@{
        Text = $text
        Fact = [ordered]@{
            leaf = $item.Name
            finalPath = [string] $read.FinalPath
            volumeSerial = [string] $read.VolumeSerial
            fileId = [string] $read.FileId
            linkCount = [long] $read.LinkCount
            attributes = [string] $item.Attributes
            owner = $acl.Owner
            sddl = $acl.Sddl
            length = [long] $bytes.Length
            sha256 = [string] $read.Sha256
            streams = @([ordered]@{ name = ':$DATA'; length = [long] $bytes.Length })
        }
    }
}

function Read-Cx004BoundedOutputSet {
    param(
        [Parameter(Mandatory)] [string] $OutputPath,
        [Parameter(Mandatory)] [string[]] $ExpectedLeafNames
    )

    Assert-Cx004RunDirectory -LiteralPath $OutputPath
    $expected = @($ExpectedLeafNames | Sort-Object)
    $texts = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
    $facts = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::Ordinal)
    foreach ($phase in @('before', 'after')) {
        $items = @(Get-Cx004BoundedDirectoryItems `
            -LiteralPath $OutputPath `
            -MaximumEntries ([Math]::Max(1, $expected.Count + 1)) |
            Sort-Object -Property Name)
        $names = @($items | ForEach-Object Name)
        if (($names -join "`n") -cne ($expected -join "`n")) {
            Throw-Cx004 'unexpected-output-file' "The post-stop guest output surface differed from its exact allowlist during $phase-read validation."
        }
        foreach ($item in $items) {
            if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-Cx004 'unexpected-output-object' 'A declared post-stop guest output was a directory or reparse point.'
            }
            if ([long] $item.Length -gt $script:Cx004MaxJsonBytes) {
                Throw-Cx004 'oversized-output-file' 'A declared post-stop guest output exceeded one MiB.'
            }
        }
        if ($phase -ceq 'before') {
            foreach ($name in $expected) {
                $read = Read-Cx004BoundedUtf8File -LiteralPath (Join-Path $OutputPath $name) -MaximumBytes $script:Cx004MaxJsonBytes
                $texts.Add($name, [string] $read.Text)
                $facts.Add($name, $read.Fact)
            }
        }
    }
    return [pscustomobject]@{
        Texts = $texts
        Facts = $facts
        Snapshot = [ordered]@{
            directory = Get-Cx004PathFact -LiteralPath $OutputPath
            entries = @($expected | ForEach-Object { $facts[$_] })
        }
    }
}

function Test-Cx004GuestOutput {
    param([Parameter(Mandatory)] [object] $Stage)

    $failurePath = Join-Path $Stage.OutputPath 'guest-failure.json'
    if (Test-Path -LiteralPath $failurePath) {
        $failureOutput = Read-Cx004BoundedOutputSet -OutputPath $Stage.OutputPath -ExpectedLeafNames @('guest-failure.json')
        $failureRaw = $failureOutput.Texts['guest-failure.json']
        $failureDocument = Get-Cx004JsonDocument -RawJson $failureRaw
        try {
            $root = $failureDocument.RootElement
            Assert-Cx004JsonObjectKeys -Element $root -ExpectedKeys @('schemaVersion', 'runId', 'challenge', 'stage', 'code') -Context 'guest failure'
            foreach ($binding in ([ordered]@{
                schemaVersion = $script:Cx004SchemaVersion
                runId = $Stage.RunId
                challenge = $Stage.Challenge
            }).GetEnumerator()) {
                if ((Get-Cx004JsonString -Object $root -Name $binding.Key -MaximumLength 128) -cne [string] $binding.Value) {
                    Throw-Cx004 'guest-binding-mismatch' "Guest failure field $($binding.Key) does not bind the staged run."
                }
            }
            $failureStage = Get-Cx004JsonString -Object $root -Name 'stage' -MaximumLength 64
            $failureCode = Get-Cx004JsonString -Object $root -Name 'code' -MaximumLength 128
        }
        finally { $failureDocument.Dispose() }
        return [ordered]@{
            outcome = 'inconclusive'
            guestFailure = [ordered]@{
                stage = $failureStage
                code = $failureCode
                disposition = 'guest-execution-uncertain'
            }
            guestEvidence = $null
            outputSnapshot = $failureOutput.Snapshot
        }
    }

    $evidencePath = Join-Path $Stage.OutputPath 'guest-evidence.json'
    $resultPath = Join-Path $Stage.OutputPath 'result-manifest.json'
    $successOutput = Read-Cx004BoundedOutputSet -OutputPath $Stage.OutputPath -ExpectedLeafNames $script:Cx004SuccessOutputNames
    $evidenceRaw = $successOutput.Texts['guest-evidence.json']
    $resultRaw = $successOutput.Texts['result-manifest.json']
    $evidenceFact = $successOutput.Facts['guest-evidence.json']
    $totalBytes = [long] $evidenceFact.length + [long] $successOutput.Facts['result-manifest.json'].length
    if ($totalBytes -gt $script:Cx004MaxOutputBytes) {
        Throw-Cx004 'oversized-output' 'The accepted guest output exceeded two MiB.'
    }

    $stableManifest = Get-Content -LiteralPath (Join-Path $Stage.InputPath 'stable-manifest.json') -Raw | ConvertFrom-Json
    $expectedStable = @($stableManifest.files)
    $evidenceDocument = Get-Cx004JsonDocument -RawJson $evidenceRaw
    try {
        $root = $evidenceDocument.RootElement
        Assert-Cx004JsonObjectKeys -Element $root -ExpectedKeys @(
            'schemaVersion', 'runId', 'challenge', 'stableManifestSha256', 'renderedConfigSha256',
            'outcome', 'outputWasEmpty', 'stableInputs', 'guest', 'probes'
        ) -Context 'guest evidence'
        Assert-Cx004JsonBinding -Root $root -Stage $Stage
        $guestOutcome = Get-Cx004JsonString -Object $root -Name 'outcome' -MaximumLength 32
        if (@('passed', 'failed', 'inconclusive') -cnotcontains $guestOutcome) {
            Throw-Cx004 'invalid-guest-outcome' 'Guest evidence outcome is outside passed, failed, or inconclusive.'
        }
        $outputWasEmpty = Get-Cx004JsonBoolean -Object $root -Name 'outputWasEmpty'

        $stableInputs = $root.GetProperty('stableInputs')
        if ($stableInputs.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or $stableInputs.GetArrayLength() -ne 2) {
            Throw-Cx004 'invalid-stable-input-list' 'Guest stableInputs must contain exactly two entries.'
        }
        for ($index = 0; $index -lt 2; $index++) {
            $entry = $stableInputs[$index]
            Assert-Cx004JsonObjectKeys -Element $entry -ExpectedKeys @('relativePath', 'sha256', 'length') -Context 'guest stable input'
            if ((Get-Cx004JsonString -Object $entry -Name 'relativePath') -cne [string] $expectedStable[$index].relativePath -or
                (Get-Cx004JsonString -Object $entry -Name 'sha256' -MaximumLength 64) -cne [string] $expectedStable[$index].sha256 -or
                (Get-Cx004JsonInt64 -Object $entry -Name 'length') -ne [long] $expectedStable[$index].length) {
                Throw-Cx004 'stable-input-mismatch' 'The guest did not independently reproduce a fixed input fact.'
            }
        }

        $guest = $root.GetProperty('guest')
        Assert-Cx004JsonObjectKeys -Element $guest -ExpectedKeys @(
            'productName', 'displayVersion', 'editionId', 'installationType', 'productType', 'version',
            'buildNumber', 'ubr', 'fullBuild', 'architecture', 'processArchitecture', 'machineName',
            'accountName', 'userSid', 'authenticationType', 'impersonationLevel', 'isAuthenticated',
            'isAnonymous', 'isGuest', 'isSystem', 'isAdministrator', 'integrity', 'groups', 'privileges',
            'bootTimeUtc'
        ) -Context 'guest identity'
        foreach ($name in @(
            'productName', 'displayVersion', 'editionId', 'installationType', 'version', 'buildNumber',
            'fullBuild', 'architecture', 'processArchitecture', 'machineName', 'accountName', 'userSid',
            'authenticationType', 'impersonationLevel', 'bootTimeUtc'
        )) { [void] (Get-Cx004JsonString -Object $guest -Name $name) }
        foreach ($name in @('productType', 'ubr')) { [void] (Get-Cx004JsonInt64 -Object $guest -Name $name) }
        foreach ($name in @('isAuthenticated', 'isAnonymous', 'isGuest', 'isSystem', 'isAdministrator')) {
            [void] (Get-Cx004JsonBoolean -Object $guest -Name $name)
        }
        if (-not (Test-Cx004GuestIdentityFacts -Guest $guest)) {
            Throw-Cx004 'unsupported-guest' 'The guest is not the exact discovered Windows 11 24H2 Enterprise AMD64 build 26100.8655 tuple (whose raw registry ProductName is Windows 10 Enterprise).'
        }
        Assert-Cx004IdentityEntry -Entry $guest.GetProperty('integrity') -Context 'guest integrity'
        $groups = $guest.GetProperty('groups')
        if ($groups.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or $groups.GetArrayLength() -gt 128) {
            Throw-Cx004 'invalid-groups' 'Guest groups are not a bounded array.'
        }
        foreach ($entry in $groups.EnumerateArray()) { Assert-Cx004IdentityEntry -Entry $entry -Context 'guest group' }
        $privileges = $guest.GetProperty('privileges')
        if ($privileges.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or $privileges.GetArrayLength() -gt 128) {
            Throw-Cx004 'invalid-privileges' 'Guest privileges are not a bounded array.'
        }
        foreach ($entry in $privileges.EnumerateArray()) {
            Assert-Cx004JsonObjectKeys -Element $entry -ExpectedKeys @('name', 'description', 'state') -Context 'guest privilege'
            foreach ($name in @('name', 'description', 'state')) { [void] (Get-Cx004JsonString -Object $entry -Name $name) }
        }

        $probes = $root.GetProperty('probes')
        Assert-Cx004JsonObjectKeys -Element $probes -ExpectedKeys @('inputMapping', 'network', 'persistence') -Context 'guest probes'
        $inputMapping = $probes.GetProperty('inputMapping')
        Assert-Cx004JsonObjectKeys -Element $inputMapping -ExpectedKeys @(
            'writeAttempted', 'writeSucceeded', 'artifactPresent', 'errorType', 'errorHResult',
            'errorInnerType', 'errorInnerHResult', 'errorInnerHasInnerException',
            'existingFileRelativePath', 'existingFileWriteOpenAttempted', 'existingFileWriteOpenSucceeded',
            'existingFileWriteOpenErrorType', 'existingFileWriteOpenErrorHResult',
            'existingFileWriteOpenErrorInnerType', 'existingFileWriteOpenErrorInnerHResult',
            'existingFileWriteOpenErrorInnerHasInnerException',
            'existingFileSha256Before', 'existingFileSha256After',
            'existingFileUnmodified', 'readOnly'
        ) -Context 'input mapping probe'
        $writeAttempted = Get-Cx004JsonBoolean -Object $inputMapping -Name 'writeAttempted'
        $writeSucceeded = Get-Cx004JsonBoolean -Object $inputMapping -Name 'writeSucceeded'
        $artifactPresent = Get-Cx004JsonBoolean -Object $inputMapping -Name 'artifactPresent'
        $createErrorType = Get-Cx004JsonString -Object $inputMapping -Name 'errorType' -MaximumLength 256
        $createErrorHResult = Get-Cx004JsonInt64 -Object $inputMapping -Name 'errorHResult'
        $createErrorInnerType = Get-Cx004JsonString -Object $inputMapping -Name 'errorInnerType' -MaximumLength 256
        $createErrorInnerHResult = Get-Cx004JsonInt64 -Object $inputMapping -Name 'errorInnerHResult'
        $createErrorInnerHasInnerException = Get-Cx004JsonBoolean -Object $inputMapping -Name 'errorInnerHasInnerException'
        $existingRelative = Get-Cx004JsonString -Object $inputMapping -Name 'existingFileRelativePath' -MaximumLength 64
        $existingAttempted = Get-Cx004JsonBoolean -Object $inputMapping -Name 'existingFileWriteOpenAttempted'
        $existingSucceeded = Get-Cx004JsonBoolean -Object $inputMapping -Name 'existingFileWriteOpenSucceeded'
        $existingErrorType = Get-Cx004JsonString -Object $inputMapping -Name 'existingFileWriteOpenErrorType' -MaximumLength 256
        $existingErrorHResult = Get-Cx004JsonInt64 -Object $inputMapping -Name 'existingFileWriteOpenErrorHResult'
        $existingErrorInnerType = Get-Cx004JsonString -Object $inputMapping -Name 'existingFileWriteOpenErrorInnerType' -MaximumLength 256
        $existingErrorInnerHResult = Get-Cx004JsonInt64 -Object $inputMapping -Name 'existingFileWriteOpenErrorInnerHResult'
        $existingErrorInnerHasInnerException = Get-Cx004JsonBoolean -Object $inputMapping -Name 'existingFileWriteOpenErrorInnerHasInnerException'
        $existingBefore = Get-Cx004JsonString -Object $inputMapping -Name 'existingFileSha256Before' -MaximumLength 64
        $existingAfter = Get-Cx004JsonString -Object $inputMapping -Name 'existingFileSha256After' -MaximumLength 64
        $existingUnmodified = Get-Cx004JsonBoolean -Object $inputMapping -Name 'existingFileUnmodified'
        $reportedReadOnly = Get-Cx004JsonBoolean -Object $inputMapping -Name 'readOnly'
        $expectedGuestProbe = @($expectedStable | Where-Object { [string] $_.relativePath -ceq 'guest-probe.ps1' })
        if ($expectedGuestProbe.Count -ne 1 -or $existingRelative -cne 'guest-probe.ps1' -or
            $existingBefore -cnotmatch '^[0-9a-f]{64}$' -or $existingAfter -cnotmatch '^[0-9a-f]{64}$') {
            Throw-Cx004 'input-mapping-schema' 'The existing-file mapping probe is not bound to the sealed guest-probe.ps1 input.'
        }
        $createDenied = Test-Cx004FileAccessDeniedFacts `
            -ErrorType $createErrorType `
            -ErrorHResult $createErrorHResult `
            -ErrorInnerType $createErrorInnerType `
            -ErrorInnerHResult $createErrorInnerHResult `
            -ErrorInnerHasInnerException $createErrorInnerHasInnerException
        $existingDenied = Test-Cx004FileAccessDeniedFacts `
            -ErrorType $existingErrorType `
            -ErrorHResult $existingErrorHResult `
            -ErrorInnerType $existingErrorInnerType `
            -ErrorInnerHResult $existingErrorInnerHResult `
            -ErrorInnerHasInnerException $existingErrorInnerHasInnerException
        $inputMappingReadOnlyDerived = $writeAttempted -and (-not $writeSucceeded) -and (-not $artifactPresent) -and
            $createDenied -and $existingAttempted -and (-not $existingSucceeded) -and
            $existingDenied -and
            $existingBefore -ceq [string] $expectedGuestProbe[0].sha256 -and
            $existingAfter -ceq $existingBefore -and $existingUnmodified
        $inputMappingViolation = $writeSucceeded -or $artifactPresent -or $existingSucceeded -or (-not $existingUnmodified)
        $inputMappingInconclusive = (-not $inputMappingViolation) -and (-not $inputMappingReadOnlyDerived)
        if ($reportedReadOnly -ne $inputMappingReadOnlyDerived) {
            Throw-Cx004 'input-mapping-semantic-mismatch' 'The reported input read-only result differs from the exact create/open/hash evidence.'
        }

        $network = $probes.GetProperty('network')
        Assert-Cx004JsonObjectKeys -Element $network -ExpectedKeys @(
            'observationAvailable', 'observationCode', 'routableAddresses', 'defaultRoutes',
            'dnsCanary', 'hostCanary', 'rawIpCanary', 'isolated'
        ) -Context 'network probe'
        $networkObservationAvailable = Get-Cx004JsonBoolean -Object $network -Name 'observationAvailable'
        $networkObservationCode = Get-Cx004JsonString -Object $network -Name 'observationCode' -MaximumLength 128
        if (($networkObservationAvailable -and $networkObservationCode -cne '') -or
            (-not $networkObservationAvailable -and $networkObservationCode -cne 'nettcpip-observation-unavailable')) {
            Throw-Cx004 'network-observation-schema' 'Network observation availability and its typed code disagree.'
        }
        $networkArrayCounts = [ordered]@{}
        foreach ($arrayName in @('routableAddresses', 'defaultRoutes')) {
            $array = $network.GetProperty($arrayName)
            if ($array.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or $array.GetArrayLength() -gt 64) {
                Throw-Cx004 'network-observation-schema' "$arrayName is not a bounded array."
            }
            foreach ($entry in $array.EnumerateArray()) {
                if ($arrayName -ceq 'routableAddresses') {
                    Assert-Cx004JsonObjectKeys -Element $entry -ExpectedKeys @('address', 'addressFamily', 'interfaceIndex', 'interfaceAlias') -Context 'routable address'
                    foreach ($name in @('address', 'addressFamily', 'interfaceAlias')) { [void] (Get-Cx004JsonString -Object $entry -Name $name -MaximumLength 256) }
                    [void] (Get-Cx004JsonInt64 -Object $entry -Name 'interfaceIndex')
                }
                else {
                    Assert-Cx004JsonObjectKeys -Element $entry -ExpectedKeys @('destinationPrefix', 'nextHop', 'interfaceIndex', 'interfaceAlias', 'state') -Context 'default route'
                    foreach ($name in @('destinationPrefix', 'nextHop', 'interfaceAlias', 'state')) { [void] (Get-Cx004JsonString -Object $entry -Name $name -MaximumLength 256) }
                    [void] (Get-Cx004JsonInt64 -Object $entry -Name 'interfaceIndex')
                }
            }
            $networkArrayCounts[$arrayName] = [long] $array.GetArrayLength()
        }
        $dnsCanary = $network.GetProperty('dnsCanary')
        Assert-Cx004JsonObjectKeys -Element $dnsCanary -ExpectedKeys @('name', 'succeeded', 'disposition') -Context 'DNS canary'
        $dnsSucceeded = Get-Cx004JsonBoolean -Object $dnsCanary -Name 'succeeded'
        $dnsDisposition = Get-Cx004JsonString -Object $dnsCanary -Name 'disposition' -MaximumLength 64
        if ((Get-Cx004JsonString -Object $dnsCanary -Name 'name') -cne 'example.com' -or
            @('resolution-failed', 'timeout', 'probe-error', 'resolved') -cnotcontains $dnsDisposition -or
            $dnsSucceeded -ne ($dnsDisposition -ceq 'resolved')) {
            Throw-Cx004 'network-canary-schema' 'The DNS canary result differs from its closed disposition semantics.'
        }
        $hostCanary = $network.GetProperty('hostCanary')
        Assert-Cx004Canary -Entry $hostCanary -Context 'host canary' -ExpectedAddress $Stage.HostCanaryAddress -ExpectedPort $Stage.HostCanaryPort -AllowedDispositions @('connection-failed', 'peer-rejected', 'timeout', 'probe-error', 'connected') -ExpectedChallenge $Stage.Challenge
        $rawIpCanary = $network.GetProperty('rawIpCanary')
        Assert-Cx004Canary -Entry $rawIpCanary -Context 'raw IP canary' -ExpectedAddress '1.1.1.1' -ExpectedPort 443 -AllowedDispositions @('connection-failed', 'peer-rejected', 'timeout', 'probe-error', 'connected')
        $hostSucceeded = Get-Cx004JsonBoolean -Object $hostCanary -Name 'succeeded'
        $hostDisposition = Get-Cx004JsonString -Object $hostCanary -Name 'disposition' -MaximumLength 64
        $rawSucceeded = Get-Cx004JsonBoolean -Object $rawIpCanary -Name 'succeeded'
        $rawDisposition = Get-Cx004JsonString -Object $rawIpCanary -Name 'disposition' -MaximumLength 64
        if ($hostSucceeded -ne ($hostDisposition -ceq 'connected') -or
            $rawSucceeded -ne ($rawDisposition -ceq 'connected')) {
            Throw-Cx004 'network-canary-schema' 'A TCP canary success flag differs from its closed disposition semantics.'
        }
        $reportedNetworkIsolation = Get-Cx004JsonBoolean -Object $network -Name 'isolated'
        $networkIsolationDerived = $networkObservationAvailable -and
            $networkArrayCounts.routableAddresses -eq 0 -and $networkArrayCounts.defaultRoutes -eq 0 -and
            (-not $dnsSucceeded) -and (-not $hostSucceeded) -and (-not $rawSucceeded) -and
            $dnsDisposition -ceq 'resolution-failed' -and $hostDisposition -ceq 'connection-failed' -and
            $rawDisposition -ceq 'connection-failed'
        if ($reportedNetworkIsolation -ne $networkIsolationDerived) {
            Throw-Cx004 'network-isolation-semantic-mismatch' 'Reported network isolation differs from the bounded observations and canaries.'
        }

        $persistence = $probes.GetProperty('persistence')
        Assert-Cx004JsonObjectKeys -Element $persistence -ExpectedKeys @('presentBefore', 'created', 'challengeVerified', 'passed') -Context 'persistence probe'
        $persistencePresentBefore = Get-Cx004JsonBoolean -Object $persistence -Name 'presentBefore'
        $persistenceCreated = Get-Cx004JsonBoolean -Object $persistence -Name 'created'
        $persistenceChallengeVerified = Get-Cx004JsonBoolean -Object $persistence -Name 'challengeVerified'
        $persistencePassed = Get-Cx004JsonBoolean -Object $persistence -Name 'passed'
        $persistenceDerived = (-not $persistencePresentBefore) -and $persistenceCreated -and $persistenceChallengeVerified
        if ($persistencePassed -ne $persistenceDerived) {
            Throw-Cx004 'persistence-semantic-mismatch' 'Reported persistence outcome differs from the exact canary observations.'
        }

        $networkViolation = $networkArrayCounts.routableAddresses -gt 0 -or
            $networkArrayCounts.defaultRoutes -gt 0 -or
            $dnsSucceeded -or $hostSucceeded -or $rawSucceeded -or
            $hostDisposition -ceq 'peer-rejected' -or $rawDisposition -ceq 'peer-rejected'
        $networkTimedOut = $dnsDisposition -ceq 'timeout' -or $hostDisposition -ceq 'timeout' -or $rawDisposition -ceq 'timeout'
        $networkProbeError = $dnsDisposition -ceq 'probe-error' -or $hostDisposition -ceq 'probe-error' -or $rawDisposition -ceq 'probe-error'
        $probeFailed = $inputMappingViolation -or $networkViolation
        $probeInconclusive = (-not $networkObservationAvailable) -or $networkTimedOut -or $networkProbeError -or
            (-not $outputWasEmpty) -or $inputMappingInconclusive -or
            (-not $persistenceDerived) -or
            (($networkObservationAvailable -and (-not $networkViolation)) -and (-not $networkIsolationDerived))
        $derivedProbeOutcome = if ($probeFailed) { 'failed' } elseif ($probeInconclusive) { 'inconclusive' } else { 'passed' }
        if ($guestOutcome -cne $derivedProbeOutcome) {
            Throw-Cx004 'guest-outcome-semantic-mismatch' 'Guest outcome differs from the exact probe-derived state.'
        }

        $evidenceObject = $evidenceRaw | ConvertFrom-Json -AsHashtable -Depth 32
    }
    finally { $evidenceDocument.Dispose() }

    $resultDocument = Get-Cx004JsonDocument -RawJson $resultRaw
    try {
        $root = $resultDocument.RootElement
        Assert-Cx004JsonObjectKeys -Element $root -ExpectedKeys @(
            'schemaVersion', 'runId', 'challenge', 'stableManifestSha256', 'renderedConfigSha256',
            'outcome', 'guestIdentity', 'probeResults', 'files'
        ) -Context 'guest result manifest'
        Assert-Cx004JsonBinding -Root $root -Stage $Stage
        $resultOutcome = Get-Cx004JsonString -Object $root -Name 'outcome' -MaximumLength 32
        if (@('passed', 'failed', 'inconclusive') -cnotcontains $resultOutcome -or $resultOutcome -cne $guestOutcome) {
            Throw-Cx004 'terminal-outcome-mismatch' 'The terminal outcome is invalid or differs from guest evidence.'
        }

        $identity = $root.GetProperty('guestIdentity')
        Assert-Cx004JsonObjectKeys -Element $identity -ExpectedKeys @(
            'productName', 'displayVersion', 'editionId', 'installationType', 'productType', 'buildNumber',
            'ubr', 'fullBuild', 'architecture', 'userSid', 'integrityLevel', 'groupCount', 'privilegeCount'
        ) -Context 'terminal guest identity'
        foreach ($name in @('productName', 'displayVersion', 'editionId', 'installationType', 'buildNumber', 'fullBuild', 'architecture', 'userSid', 'integrityLevel')) {
            [void] (Get-Cx004JsonString -Object $identity -Name $name)
        }
        foreach ($name in @('productType', 'ubr', 'groupCount', 'privilegeCount')) { [void] (Get-Cx004JsonInt64 -Object $identity -Name $name) }
        $identityPairs = [ordered]@{
            productName = $evidenceObject.guest.productName
            displayVersion = $evidenceObject.guest.displayVersion
            editionId = $evidenceObject.guest.editionId
            installationType = $evidenceObject.guest.installationType
            productType = $evidenceObject.guest.productType
            buildNumber = $evidenceObject.guest.buildNumber
            ubr = $evidenceObject.guest.ubr
            fullBuild = $evidenceObject.guest.fullBuild
            architecture = $evidenceObject.guest.architecture
            userSid = $evidenceObject.guest.userSid
            integrityLevel = ConvertTo-Cx004IntegrityAlias -Sid ([string] $evidenceObject.guest.integrity.sid)
            groupCount = @($evidenceObject.guest.groups).Count
            privilegeCount = @($evidenceObject.guest.privileges).Count
        }
        foreach ($entry in $identityPairs.GetEnumerator()) {
            $actual = if ($entry.Value -is [ValueType]) { Get-Cx004JsonInt64 -Object $identity -Name $entry.Key } else { Get-Cx004JsonString -Object $identity -Name $entry.Key }
            if ([string] $actual -cne [string] $entry.Value) {
                Throw-Cx004 'terminal-evidence-mismatch' "Terminal identity field $($entry.Key) differs from guest evidence."
            }
        }

        $probeResults = $root.GetProperty('probeResults')
        $probeNames = @(
            'stableInputsVerified', 'outputWasEmpty', 'inputMappingReadOnly',
            'inputMappingExistingFileWriteOpenDenied', 'inputMappingExistingFileUnmodified',
            'networkObservationAvailable', 'networkIsolation', 'hostCanaryChallengeBound',
            'hostCanaryConnectionBlocked', 'persistenceCanaryAbsentAtStart',
            'persistenceCanaryCreated', 'persistenceCanaryChallengeVerified'
        )
        Assert-Cx004JsonObjectKeys -Element $probeResults -ExpectedKeys $probeNames -Context 'terminal probe results'
        $expectedProbeResults = [ordered]@{
            stableInputsVerified = $true
            outputWasEmpty = [bool] $outputWasEmpty
            inputMappingReadOnly = [bool] $inputMappingReadOnlyDerived
            inputMappingExistingFileWriteOpenDenied = [bool] ($existingAttempted -and (-not $existingSucceeded) -and $existingDenied)
            inputMappingExistingFileUnmodified = [bool] $existingUnmodified
            networkObservationAvailable = [bool] $networkObservationAvailable
            networkIsolation = [bool] $networkIsolationDerived
            hostCanaryChallengeBound = $true
            hostCanaryConnectionBlocked = [bool] ((-not $hostSucceeded) -and $hostDisposition -ceq 'connection-failed')
            persistenceCanaryAbsentAtStart = [bool] (-not $persistencePresentBefore)
            persistenceCanaryCreated = [bool] $persistenceCreated
            persistenceCanaryChallengeVerified = [bool] $persistenceChallengeVerified
        }
        foreach ($entry in $expectedProbeResults.GetEnumerator()) {
            if ((Get-Cx004JsonBoolean -Object $probeResults -Name $entry.Key) -ne $entry.Value) {
                Throw-Cx004 'terminal-probe-mismatch' "Terminal probe $($entry.Key) differs from guest evidence."
            }
        }

        $files = $root.GetProperty('files')
        if ($files.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or $files.GetArrayLength() -ne 1) {
            Throw-Cx004 'invalid-result-file-list' 'The terminal file list must contain exactly guest-evidence.json.'
        }
        $file = $files[0]
        Assert-Cx004JsonObjectKeys -Element $file -ExpectedKeys @('relativePath', 'sha256', 'length') -Context 'terminal file fact'
        if ((Get-Cx004JsonString -Object $file -Name 'relativePath') -cne 'guest-evidence.json' -or
            (Get-Cx004JsonString -Object $file -Name 'sha256' -MaximumLength 64) -cne [string] $evidenceFact.sha256 -or
            (Get-Cx004JsonInt64 -Object $file -Name 'length') -ne [long] $evidenceFact.length) {
            Throw-Cx004 'result-file-mismatch' 'The terminal file fact does not match guest-evidence.json.'
        }
        $resultObject = $resultRaw | ConvertFrom-Json -AsHashtable -Depth 32
    }
    finally { $resultDocument.Dispose() }

    return [ordered]@{
        outcome = $guestOutcome
        guestEvidence = $evidenceObject
        resultManifest = $resultObject
        outputSnapshot = $successOutput.Snapshot
    }
}

function Invoke-Cx004SandboxSession {
    param(
        [Parameter(Mandatory)] [object] $Stage,
        [Parameter(Mandatory)] [string] $WsbPath,
        [Parameter(Mandatory)] [object] $HostCanary,
        [Parameter(Mandatory)] [ValidatePattern('^[0-9a-f]{40}$')] [string] $ExpectedS0Commit,
        [Parameter(Mandatory)] [ValidatePattern('^[0-9a-f]{40}$')] [string] $ExpectedS0Tree
    )

    if ((Get-Cx004Sha256 -LiteralPath $Stage.RenderedConfigPath) -cne $Stage.RenderedConfigSha256) {
        Throw-Cx004 'rendered-config-mutated' 'The rendered configuration changed after staging.'
    }
    $currentInput = Get-Cx004DirectorySnapshot -LiteralPath $Stage.InputPath -ExpectedLeafNames $script:Cx004InputNames
    Assert-Cx004InputSnapshotUnchanged -Before $Stage.InitialInputSnapshot -After $currentInput

    $preList = Get-Cx004WsbListReceipt `
        -WsbPath $WsbPath `
        -NativeReceiptPath (Join-Path $Stage.RunRoot 'cli-pre-list-native.json')
    Assert-Cx004NoRunningSessions -RawJson $preList.Raw | Out-Null
    Write-Cx004JsonFile -LiteralPath (Join-Path $Stage.RunRoot 'cli-pre-list.json') -InputObject $preList.Native -Depth 8

    $sessionId = $null
    $startReceipt = $null
    $runningList = $null
    $connectReceipt = $null
    $terminal = $null
    $guestValidation = $null
    $stopReceipt = $null
    $stoppedList = $null
    $mappingRelease = $null
    $hostCanaryReceipt = $null
    $postInput = $null
    $postValidationOutput = $null
    $sourceSealBeforeStart = $null
    $sourceSealAfterStop = $null
    $runError = $null
    $teardownError = $null
    $validationError = $null
    $validationUncertain = $false
    $positiveBoundaryFailure = $false
    $operationUncertain = $false
    $teardownUncertain = $false
    $exactStopProved = $false

    try {
        $sourceSealBeforeStart = Get-Cx004SourceSeal -ExpectedS0Commit $ExpectedS0Commit -ExpectedS0Tree $ExpectedS0Tree
        Write-Cx004JsonFile -LiteralPath (Join-Path $Stage.RunRoot 'source-seal-before-start.json') -InputObject $sourceSealBeforeStart -Depth 32
        if ([string] $sourceSealBeforeStart.head -cne [string] $Stage.SourceHead -or
            [string] $sourceSealBeforeStart.tree -cne [string] $Stage.SourceTree) {
            Throw-Cx004 'stage-source-seal-drift' 'The caller-pinned source seal changed after staging and before Sandbox start.'
        }
        $immediateInput = Get-Cx004DirectorySnapshot -LiteralPath $Stage.InputPath -ExpectedLeafNames $script:Cx004InputNames
        Assert-Cx004InputSnapshotUnchanged -Before $Stage.InitialInputSnapshot -After $immediateInput
        if ((Get-Cx004Sha256 -LiteralPath $Stage.RenderedConfigPath) -cne $Stage.RenderedConfigSha256) {
            Throw-Cx004 'rendered-config-mutated' 'The rendered configuration changed immediately before Sandbox start.'
        }
        [byte[]] $renderedConfigArgumentBytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes(
            [string] $Stage.RenderedConfig
        )
        $renderedConfigArgumentSha256 = [System.Convert]::ToHexString(
            [System.Security.Cryptography.SHA256]::HashData($renderedConfigArgumentBytes)
        ).ToLowerInvariant()
        if ($renderedConfigArgumentSha256 -cne $Stage.RenderedConfigSha256 -or
            [long] $renderedConfigArgumentBytes.LongLength -ne [long] (Get-Item -LiteralPath $Stage.RenderedConfigPath).Length) {
            Throw-Cx004 'rendered-config-mutated' 'The exact XML argument differs from the sealed rendered configuration bytes.'
        }
        Write-Cx004JsonFile -LiteralPath (Join-Path $Stage.RunRoot 'input-snapshot-immediately-before-start.json') -InputObject $immediateInput -Depth 32
        $startReceipt = Invoke-Cx004WsbNative -WsbPath $WsbPath -Arguments @('start', '--config', $Stage.RenderedConfig, '--raw') -TimeoutSeconds 120
        Write-Cx004JsonFile -LiteralPath (Join-Path $Stage.RunRoot 'cli-start.json') -InputObject $startReceipt -Depth 8
        Assert-Cx004WsbNativeComplete -Receipt $startReceipt
        if ($startReceipt.ExitCode -ne 0) {
            $operationUncertain = $true
            Throw-Cx004 'unknown-start-shape' "wsb start returned nonzero exit $($startReceipt.ExitCode); session creation is not inferred."
        }
        if ($startReceipt.Stderr.Length -ne 0) {
            $operationUncertain = $true
            Throw-Cx004 'unknown-start-shape' 'Successful wsb start emitted stderr.'
        }
        try {
            $sessionId = ConvertFrom-Cx004WsbStartRaw -RawJson $startReceipt.Raw
        }
        catch {
            $operationUncertain = $true
            Throw-Cx004 'unknown-start-shape' 'Successful wsb start did not return the exact retained session-ID schema.'
        }
        $runningList = Wait-Cx004SessionListState `
            -WsbPath $WsbPath `
            -SessionId $sessionId `
            -ExpectedRunning $true `
            -NativeReceiptPath (Join-Path $Stage.RunRoot 'cli-running-list-last-native.json')
        Write-Cx004JsonFile -LiteralPath (Join-Path $Stage.RunRoot 'cli-running-list.json') -InputObject $runningList.Native -Depth 8
        $connectReceipt = Invoke-Cx004WsbNative -WsbPath $WsbPath -Arguments @('connect', '--id', $sessionId, '--raw') -TimeoutSeconds 120
        Write-Cx004JsonFile -LiteralPath (Join-Path $Stage.RunRoot 'cli-connect-native.json') -InputObject $connectReceipt -Depth 8
        Assert-Cx004WsbConnectNativeComplete -Receipt $connectReceipt
        $terminal = Wait-Cx004GuestTerminalFiles -OutputPath $Stage.OutputPath -Challenge $Stage.Challenge
    }
    catch {
        $runError = $_
        $operationUncertain = $true
        if (Test-Cx004PositiveIntegrityError -Message $_.Exception.Message) {
            $positiveBoundaryFailure = $true
        }
    }

    if ($null -ne $sessionId) {
        try {
            $stopReceipt = Invoke-Cx004WsbNative -WsbPath $WsbPath -Arguments @('stop', '--id', $sessionId, '--raw') -TimeoutSeconds 60
            Write-Cx004JsonFile -LiteralPath (Join-Path $Stage.RunRoot 'cli-stop.json') -InputObject $stopReceipt -Depth 8
            Assert-Cx004WsbNativeComplete -Receipt $stopReceipt
            if ($stopReceipt.ExitCode -ne 0) {
                $teardownUncertain = $true
                Throw-Cx004 'unknown-stop-shape' "Exact-ID wsb stop returned nonzero exit $($stopReceipt.ExitCode)."
            }
            if ($stopReceipt.Stderr.Length -ne 0) {
                $teardownUncertain = $true
                Throw-Cx004 'unknown-stop-shape' 'Successful exact-ID wsb stop emitted stderr.'
            }
            [void] (ConvertFrom-Cx004WsbStopRaw -RawOutput $stopReceipt.Raw)
            $stoppedList = Wait-Cx004SessionListState `
                -WsbPath $WsbPath `
                -SessionId $sessionId `
                -ExpectedRunning $false `
                -NativeReceiptPath (Join-Path $Stage.RunRoot 'cli-stopped-list-last-native.json')
            Write-Cx004JsonFile -LiteralPath (Join-Path $Stage.RunRoot 'cli-stopped-list.json') -InputObject $stoppedList.Native -Depth 8
            $mappingRelease = Test-Cx004MappingRelease -InputPath $Stage.InputPath -OutputPath $Stage.OutputPath
            try {
                $postInput = Get-Cx004DirectorySnapshot -LiteralPath $Stage.InputPath -ExpectedLeafNames $script:Cx004InputNames
                Assert-Cx004InputSnapshotUnchanged -Before $Stage.InitialInputSnapshot -After $postInput
            }
            catch {
                if ($_.Exception.Message -match 'CX004\[(unexpected-directory-surface|input-mutated)\]') {
                    $positiveBoundaryFailure = $true
                }
                throw
            }
            $hostCanaryReceipt = Complete-Cx004HostCanary -Canary $HostCanary
            $exactStopProved = $true
            $sourceSealAfterStop = Get-Cx004SourceSeal -ExpectedS0Commit $ExpectedS0Commit -ExpectedS0Tree $ExpectedS0Tree
            Write-Cx004JsonFile -LiteralPath (Join-Path $Stage.RunRoot 'source-seal-after-stop.json') -InputObject $sourceSealAfterStop -Depth 32

            if ($null -ne $terminal -and $terminal.Kind -ceq 'success') {
                $guestValidation = Test-Cx004GuestOutput -Stage $Stage
                $postValidationOutput = (Read-Cx004BoundedOutputSet -OutputPath $Stage.OutputPath -ExpectedLeafNames $script:Cx004SuccessOutputNames).Snapshot
                if ((ConvertTo-Cx004CanonicalJson -InputObject $guestValidation.outputSnapshot -Depth 32) -cne
                    (ConvertTo-Cx004CanonicalJson -InputObject $postValidationOutput -Depth 32)) {
                    Throw-Cx004 'late-output-mutation' 'Final guest output bytes or identity changed during post-stop validation.'
                }
            }
            elseif ($null -ne $terminal -and $terminal.Kind -ceq 'failure') {
                $guestValidation = Test-Cx004GuestOutput -Stage $Stage
                $postValidationOutput = (Read-Cx004BoundedOutputSet -OutputPath $Stage.OutputPath -ExpectedLeafNames @('guest-failure.json')).Snapshot
                if ((ConvertTo-Cx004CanonicalJson -InputObject $guestValidation.outputSnapshot -Depth 32) -cne
                    (ConvertTo-Cx004CanonicalJson -InputObject $postValidationOutput -Depth 32)) {
                    Throw-Cx004 'late-output-mutation' 'Final guest failure bytes or identity changed during post-stop validation.'
                }
            }
        }
        catch {
            if (Test-Cx004PositiveIntegrityError -Message $_.Exception.Message) {
                $positiveBoundaryFailure = $true
            }
            $uncertainTeardownError = -not $exactStopProved -or
                $_.Exception.Message -match 'CX004\[(native-launch-failed|native-process-timeout|native-output-overflow|native-stdout-overflow|native-stderr-overflow|native-process-unproven|native-capture-unproven|wsb-alias-binding-drift|unknown-stop-shape|session-state-timeout|mapping-release|host-canary-observation-uncertain)\]'
            if ($uncertainTeardownError) {
                $teardownError = $_
                $teardownUncertain = $true
            }
            else {
                $validationError = $_
                $validationUncertain = $true
            }
        }
    }
    else {
        $teardownUncertain = $true
    }

    if ($null -eq $hostCanaryReceipt) {
        $hostCanaryReceipt = Close-Cx004HostCanaryUnproven -Canary $HostCanary
    }

    $hostCanaryFailed = $hostCanaryReceipt.guestConnectionObserved -eq $true
    $guestOutcome = if ($null -ne $guestValidation) { [string] $guestValidation.outcome } else { $null }
    $outcome = if ($hostCanaryFailed -or $positiveBoundaryFailure -or $guestOutcome -ceq 'failed') {
        'failed'
    }
    elseif ($operationUncertain -or $teardownUncertain -or $validationUncertain) {
        'inconclusive'
    }
    elseif ($guestOutcome -ceq 'inconclusive') {
        'inconclusive'
    }
    elseif ($guestOutcome -ceq 'passed' -and $exactStopProved) {
        'passed'
    }
    else {
        'inconclusive'
    }
    $sessionReceipt = [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        scope = $script:Cx004Scope
        runId = $Stage.RunId
        challenge = $Stage.Challenge
        sessionId = $sessionId
        outcome = $outcome
        teardownLevel = if ($exactStopProved -and -not $teardownUncertain) { $script:Cx004TeardownLevel } else { 'unproven' }
        operationUncertain = [bool] $operationUncertain
        teardownUncertain = [bool] $teardownUncertain
        validationUncertain = [bool] $validationUncertain
        positiveBoundaryFailure = [bool] $positiveBoundaryFailure
        cli = [ordered]@{
            preListRaw = $preList.Raw
            startExitCode = if ($null -ne $startReceipt) { $startReceipt.ExitCode } else { $null }
            startRaw = if ($null -ne $startReceipt) { $startReceipt.Raw } else { $null }
            runningListRaw = if ($null -ne $runningList) { $runningList.Raw } else { $null }
            connectExitCode = if ($null -ne $connectReceipt) { $connectReceipt.ExitCode } else { $null }
            connectOutputDisposition = if ($null -ne $connectReceipt) { 'opaque-non-evidence' } else { $null }
            connectCaptureCompleted = if ($null -ne $connectReceipt) { $connectReceipt.CaptureCompleted } else { $null }
            connectCaptureReadersSettled = if ($null -ne $connectReceipt) { $connectReceipt.CaptureReadersSettled } else { $null }
            connectCaptureDiscarded = if ($null -ne $connectReceipt) { $connectReceipt.CaptureDiscarded } else { $null }
            connectObservedStdoutBytes = if ($null -ne $connectReceipt) { $connectReceipt.StdoutBytes } else { $null }
            connectObservedStderrBytes = if ($null -ne $connectReceipt) { $connectReceipt.StderrBytes } else { $null }
            stopExitCode = if ($null -ne $stopReceipt) { $stopReceipt.ExitCode } else { $null }
            stopRaw = if ($null -ne $stopReceipt) { $stopReceipt.Raw } else { $null }
            stoppedListRaw = if ($null -ne $stoppedList) { $stoppedList.Raw } else { $null }
        }
        terminal = if ($null -ne $terminal) { [ordered]@{ kind = $terminal.Kind; names = @($terminal.Names) } } else { $null }
        guestValidation = $guestValidation
        mappingRelease = $mappingRelease
        hostCanary = $hostCanaryReceipt
        postInputSnapshot = $postInput
        postValidationOutputSnapshot = $postValidationOutput
        sourceSealBeforeStart = $sourceSealBeforeStart
        sourceSealAfterStop = $sourceSealAfterStop
        runError = if ($null -ne $runError) { [ordered]@{ type = $runError.Exception.GetType().FullName; message = $runError.Exception.Message } } else { $null }
        teardownError = if ($null -ne $teardownError) { [ordered]@{ type = $teardownError.Exception.GetType().FullName; message = $teardownError.Exception.Message } } else { $null }
        validationError = if ($null -ne $validationError) { [ordered]@{ type = $validationError.Exception.GetType().FullName; message = $validationError.Exception.Message } } else { $null }
    }
    $sessionReceiptPath = Join-Path $Stage.RunRoot 'host-session-receipt.json'
    Write-Cx004JsonFile -LiteralPath $sessionReceiptPath -InputObject $sessionReceipt -Depth 64

    return $sessionReceipt
}

function Test-Cx004IntegralPrimitive {
    param([Parameter(Mandatory)] [AllowNull()] [object] $Value)

    if ($null -eq $Value -or $Value -is [bool] -or $Value.GetType().IsEnum) { return $false }
    return $Value -is [byte] -or $Value -is [sbyte] -or
        $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64]
}

function New-Cx004TrackedReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $LocalEvidenceBundleSha256,
        [Parameter(Mandatory)] [System.Collections.IDictionary] $SemanticFacts
    )

    if ($LocalEvidenceBundleSha256 -cnotmatch '^[0-9a-f]{64}$') {
        Throw-Cx004 'invalid-bundle-hash' 'The local evidence bundle hash must be 64 lowercase hexadecimal characters.'
    }

    $allowedKeys = @(
        'hostFullBuild', 'hostEditionId', 'hostInstallationType', 'hostArchitecture',
        'sandboxPackageFullName', 'sandboxPackageVersion', 'cliVersion',
        'guestFullBuild', 'guestDisplayVersion', 'guestEditionId', 'guestInstallationType',
        'guestProductType', 'guestArchitecture', 'guestProcessArchitecture', 'guestIntegrityLevel',
        'guestGroupCount', 'guestPrivilegeCount', 'templateSha256', 'stableManifestSha256',
        'sessionRuns', 'networkIsolation', 'inputMappingReadOnly', 'persistenceReset',
        'hostSmokeOutcome', 'requestedNetworking', 'requestedVGpu', 'requestedClipboard',
        'requestedAudioInput', 'requestedVideoInput', 'requestedPrinter', 'requestedProtectedClient',
        'requestedMemoryMiB'
    )
    $actualKeys = @($SemanticFacts.Keys | ForEach-Object { [string] $_ })
    if ($actualKeys.Count -ne $allowedKeys.Count) {
        Throw-Cx004 'incomplete-tracked-facts' 'Tracked semantic facts do not have the exact closed property count.'
    }
    foreach ($key in $actualKeys) {
        if ($allowedKeys -cnotcontains $key -or $key -match '(?i)machineName|userName|userSid|profilePath|challenge|sessionId|boot(Time|Timestamp)') {
            Throw-Cx004 'unsafe-tracked-field' "Semantic fact is not in the redacted tracked allowlist: $key"
        }
    }

    $safeFacts = [ordered]@{}
    foreach ($key in $allowedKeys) {
        if (-not $SemanticFacts.Contains($key)) {
            Throw-Cx004 'incomplete-tracked-facts' "Tracked semantic fact is absent: $key"
        }
        $value = $SemanticFacts[$key]
        if ($null -eq $value -or $value -is [System.Collections.IDictionary] -or
            ($value -is [System.Collections.IEnumerable] -and $value -isnot [string])) {
            Throw-Cx004 'unsafe-tracked-value' "Tracked semantic fact must be a non-null scalar: $key"
        }

        switch ($key) {
            { $_ -in @('templateSha256', 'stableManifestSha256') } {
                if ($value -isnot [string] -or [string] $value -cnotmatch '^[0-9a-f]{64}$') {
                    Throw-Cx004 'invalid-tracked-value' "$key must be a lowercase SHA-256."
                }
            }
            'hostFullBuild' { if ([string] $value -cne '26200.8655') { Throw-Cx004 'invalid-tracked-value' 'hostFullBuild is outside the Q0S pin.' } }
            'hostEditionId' { if ([string] $value -cne 'Professional') { Throw-Cx004 'invalid-tracked-value' 'hostEditionId is outside the Q0S pin.' } }
            'hostInstallationType' { if ([string] $value -cne 'Client') { Throw-Cx004 'invalid-tracked-value' 'hostInstallationType is outside the Q0S pin.' } }
            'hostArchitecture' { if ([string] $value -cne 'AMD64') { Throw-Cx004 'invalid-tracked-value' 'hostArchitecture is outside the Q0S pin.' } }
            'sandboxPackageFullName' {
                if ($value -isnot [string] -or [string] $value -cnotmatch '^MicrosoftWindows\.WindowsSandbox_[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+_x64__cw5n1h2txyewy$') {
                    Throw-Cx004 'invalid-tracked-value' 'sandboxPackageFullName is not the sealed Microsoft system component identity.'
                }
            }
            { $_ -in @('sandboxPackageVersion', 'cliVersion') } {
                if ($value -isnot [string] -or [string] $value -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$') {
                    Throw-Cx004 'invalid-tracked-value' "$key is not a four-part version."
                }
            }
            'guestFullBuild' { if ([string] $value -cne '26100.8655') { Throw-Cx004 'invalid-tracked-value' 'guestFullBuild is outside the exact discovered Sandbox pin.' } }
            'guestDisplayVersion' { if ([string] $value -cne '24H2') { Throw-Cx004 'invalid-tracked-value' 'guestDisplayVersion is outside the exact discovered Sandbox pin.' } }
            'guestInstallationType' { if ([string] $value -cne 'Client') { Throw-Cx004 'invalid-tracked-value' 'guestInstallationType is outside the Q0S pin.' } }
            { $_ -in @('guestArchitecture', 'guestProcessArchitecture') } { if ([string] $value -cne 'AMD64') { Throw-Cx004 'invalid-tracked-value' "$key must be AMD64." } }
            'guestEditionId' {
                if ([string] $value -cne 'Enterprise') {
                    Throw-Cx004 'invalid-tracked-value' 'guestEditionId is outside the exact discovered Sandbox pin.'
                }
            }
            'guestIntegrityLevel' {
                if ($value -isnot [string] -or [string] $value -cnotmatch '^(low|medium|medium-plus|high|system|protected-process)$') {
                    Throw-Cx004 'invalid-tracked-value' 'guestIntegrityLevel must be one closed well-known integrity alias.'
                }
            }
            'guestProductType' {
                if (-not (Test-Cx004IntegralPrimitive -Value $value) -or [long] $value -ne 1) {
                    Throw-Cx004 'invalid-tracked-value' 'guestProductType must be the integral workstation value.'
                }
            }
            { $_ -in @('guestGroupCount', 'guestPrivilegeCount') } {
                if (-not (Test-Cx004IntegralPrimitive -Value $value) -or [long] $value -lt 0 -or [long] $value -gt 128) {
                    Throw-Cx004 'invalid-tracked-value' "$key is outside its bounded count."
                }
            }
            'sessionRuns' { if (-not (Test-Cx004IntegralPrimitive -Value $value) -or [long] $value -ne 2) { Throw-Cx004 'invalid-tracked-value' 'sessionRuns must be the scalar integer 2.' } }
            { $_ -in @('networkIsolation', 'inputMappingReadOnly', 'persistenceReset') } { if ($value -isnot [bool] -or -not $value) { Throw-Cx004 'invalid-tracked-value' "$key must be true." } }
            'hostSmokeOutcome' { if ([string] $value -cne 'passed') { Throw-Cx004 'invalid-tracked-value' 'hostSmokeOutcome must be passed.' } }
            { $_ -in @('requestedNetworking', 'requestedVGpu', 'requestedClipboard', 'requestedAudioInput', 'requestedVideoInput', 'requestedPrinter') } {
                if ([string] $value -cne 'disabled') { Throw-Cx004 'invalid-tracked-value' "$key must be disabled." }
            }
            'requestedProtectedClient' { if ([string] $value -cne 'enabled') { Throw-Cx004 'invalid-tracked-value' 'requestedProtectedClient must be enabled.' } }
            'requestedMemoryMiB' { if (-not (Test-Cx004IntegralPrimitive -Value $value) -or [long] $value -ne 4096) { Throw-Cx004 'invalid-tracked-value' 'requestedMemoryMiB must be 4096.' } }
        }
        $safeFacts[$key] = $value
    }

    if ([string] $safeFacts.sandboxPackageVersion -cne [string] $safeFacts.cliVersion) {
        Throw-Cx004 'invalid-tracked-value' 'The Sandbox package and CLI versions must match.'
    }

    return [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        scope = $script:Cx004Scope
        hostSmokeScope = 'host-smoke-only'
        outcome = 'passed'
        teardownLevel = $script:Cx004TeardownLevel
        localEvidenceBundleSha256 = $LocalEvidenceBundleSha256
        semanticFacts = $safeFacts
    }
}

function Get-Cx004NamedFileSetSnapshot {
    param([Parameter(Mandatory)] [System.Collections.IDictionary] $Files)

    $facts = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $Files.GetEnumerator()) {
        $path = Get-Cx004FullPath -LiteralPath ([string] $entry.Value)
        $facts.Add([ordered]@{
            role = [string] $entry.Key
            path = $path
            identity = Get-Cx004PathFact -LiteralPath $path
        })
    }
    return @($facts)
}

function Get-Cx004RoslynClosureSnapshot {
    param([Parameter(Mandatory)] [string] $RoslynRoot)

    $expectedRoot = Get-Cx004FullPath -LiteralPath (Join-Path `
        ([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86)) `
        'Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn')
    $root = Get-Cx004FullPath -LiteralPath $RoslynRoot
    if ($root -cne $expectedRoot -or -not (Test-Path -LiteralPath $root -PathType Container)) {
        Throw-Cx004 'host-smoke-toolchain-missing' 'The Roslyn closure root differs from the reviewed Build Tools location.'
    }
    Assert-Cx004NoReparsePath -LiteralPath $root
    $facts = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $script:Cx004ExpectedRoslynClosure.GetEnumerator()) {
        $path = Join-Path $root $entry.Key
        $fact = Get-Cx004PathFact -LiteralPath $path
        if ($fact.kind -cne 'file' -or $fact.sha256 -cne [string] $entry.Value.sha256 -or
            [long] $fact.length -ne [long] $entry.Value.length) {
            Throw-Cx004 'host-smoke-toolchain-missing' "A reviewed Roslyn compiler-closure file differs: $($entry.Key)"
        }
        $facts.Add([ordered]@{
            relativePath = [string] $entry.Key
            sha256 = $fact.sha256
            length = [long] $fact.length
            volumeSerial = $fact.volumeSerial
            fileId = $fact.fileId
            owner = $fact.owner
            sddl = $fact.sddl
        })
    }
    return [ordered]@{
        root = $root
        files = @($facts)
    }
}

function Assert-Cx004SnapshotUnchanged {
    param(
        [Parameter(Mandatory)] [object] $Before,
        [Parameter(Mandatory)] [object] $After,
        [Parameter(Mandatory)] [string] $Context
    )

    if ((ConvertTo-Cx004CanonicalJson -InputObject $Before -Depth 32) -cne
        (ConvertTo-Cx004CanonicalJson -InputObject $After -Depth 32)) {
        Throw-Cx004 'host-smoke-toolchain-drift' "$Context changed across bounded native execution."
    }
}

function Invoke-Cx004HostSmoke {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $HostEvidenceRoot,
        [Parameter(Mandatory)] [ValidatePattern('^[0-9a-f]{40}$')] [string] $ExpectedS0Commit,
        [Parameter(Mandatory)] [ValidatePattern('^[0-9a-f]{40}$')] [string] $ExpectedS0Tree
    )

    Assert-Cx004QualificationRootSafety -LiteralPath $HostEvidenceRoot
    $beforeCompileSeal = Get-Cx004SourceSeal -ExpectedS0Commit $ExpectedS0Commit -ExpectedS0Tree $ExpectedS0Tree
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'source-seal-before-host-compile.json') -InputObject $beforeCompileSeal -Depth 32

    $sourcePath = Join-Path $PSScriptRoot 'host-job-smoke.cs'
    $sourceRelativePath = 'packages/windows-containment/lab/sandbox/host-job-smoke.cs'
    $sealedSource = @($beforeCompileSeal.files | Where-Object { [string] $_.relativePath -ceq $sourceRelativePath })
    if ($sealedSource.Count -ne 1 -or
        (Get-Cx004Sha256 -LiteralPath $sourcePath) -cne [string] $sealedSource[0].sha256 -or
        [long] (Get-Item -LiteralPath $sourcePath).Length -ne [long] $sealedSource[0].length) {
        Throw-Cx004 'host-smoke-source-missing' 'The fixed host Job Object smoke source differs from the caller-pinned S0 bytes.'
    }

    $programFilesX86 = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86)
    $vswherePath = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf) -or
        (Get-Cx004Sha256 -LiteralPath $vswherePath) -cne 'c54f3b7c9164ea9a0db8641e81ecdda80c2664ef5a47c4191406f848cc07c662') {
        Throw-Cx004 'host-smoke-toolchain-missing' 'Visual Studio Installer discovery differs from the reviewed S0 identity.'
    }
    $vswhereSignature = Assert-Cx004MicrosoftAuthenticode -LiteralPath $vswherePath -Role 'vswhere.exe'
    $vswhereFiles = [ordered]@{ vswhere = $vswherePath }
    $vswhereIdentityBefore = Get-Cx004NamedFileSetSnapshot -Files $vswhereFiles
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-vswhere-identity-before.json') -InputObject $vswhereIdentityBefore -Depth 24
    $vswhereArguments = @(
        '-latest',
        '-products', 'Microsoft.VisualStudio.Product.BuildTools',
        '-requires', 'Microsoft.Component.MSBuild',
        '-find', 'MSBuild\Current\Bin\Roslyn\csc.exe'
    )
    $vswhereReceipt = Invoke-Cx004BoundedNative `
        -ExecutablePath $vswherePath `
        -Arguments $vswhereArguments `
        -WorkingDirectory $HostEvidenceRoot `
        -TimeoutSeconds 15 `
        -MaxStdoutBytes 65536 `
        -MaxStderrBytes 65536 `
        -ScrubEnvironment
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-vswhere-native.json') -InputObject $vswhereReceipt -Depth 16
    $vswhereIdentityAfter = Get-Cx004NamedFileSetSnapshot -Files $vswhereFiles
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-vswhere-identity-after.json') -InputObject $vswhereIdentityAfter -Depth 24
    Assert-Cx004SnapshotUnchanged -Before $vswhereIdentityBefore -After $vswhereIdentityAfter -Context 'The reviewed vswhere executable'
    if ($vswhereReceipt.TimedOut) { Throw-Cx004 'native-process-timeout' 'Bounded vswhere discovery timed out.' }
    if ($vswhereReceipt.StdoutBytes -gt 65536) { Throw-Cx004 'native-stdout-overflow' 'Bounded vswhere stdout exceeded its cap.' }
    if ($vswhereReceipt.StderrBytes -gt 65536) { Throw-Cx004 'native-stderr-overflow' 'Bounded vswhere stderr exceeded its cap.' }
    if (-not $vswhereReceipt.ProcessExited -or -not $vswhereReceipt.CaptureCompleted -or
        $vswhereReceipt.ExitCode -ne 0 -or $vswhereReceipt.Stderr.Length -ne 0) {
        Throw-Cx004 'host-smoke-toolchain-ambiguous' 'Bounded vswhere discovery did not return one clean compiler path.'
    }
    $cscPath = Get-Cx004FullPath -LiteralPath (Get-Cx004SingleLine -Text $vswhereReceipt.Stdout -Context 'Roslyn compiler discovery')
    $expectedCscPath = Join-Path $programFilesX86 'Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe'
    if ($cscPath -cne (Get-Cx004FullPath -LiteralPath $expectedCscPath) -or
        -not (Test-Path -LiteralPath $cscPath -PathType Leaf) -or
        (Get-Cx004Sha256 -LiteralPath $cscPath) -cne '7788f58659ac4c1a35ccd80e36ea4b3eeb51836678d0ffa3d55c2d9521f5ae49') {
        Throw-Cx004 'host-smoke-toolchain-missing' 'The discovered Roslyn compiler differs from the reviewed Build Tools identity.'
    }
    $cscSignature = Assert-Cx004MicrosoftAuthenticode -LiteralPath $cscPath -Role 'Roslyn csc.exe'

    $referenceRoot = Join-Path $programFilesX86 'Reference Assemblies\Microsoft\Framework\.NETFramework\v4.7.2'
    $expectedReferences = [ordered]@{
        'mscorlib.dll' = 'a69849cf0b433664b14dbaeb82385ec043449f71f7c69559cba4be0dd3e8be8d'
        'System.dll' = '541c6067cc69a43660d06a4f0f6eab0febcd33df9089f209d99b7ea36682a0a5'
        'System.Core.dll' = 'f9c65f2d44f244e1195802a68f5d8f3457caeef2e385cf28c534218749adbe7f'
    }
    $referenceFacts = [System.Collections.Generic.List[object]]::new()
    $referencePaths = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $expectedReferences.GetEnumerator()) {
        $path = Join-Path $referenceRoot $entry.Key
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-Cx004Sha256 -LiteralPath $path) -cne $entry.Value) {
            Throw-Cx004 'host-smoke-reference-mismatch' "The exact .NET Framework v4.7.2 reference differs from S0: $($entry.Key)"
        }
        $referencePaths.Add($path)
        $item = Get-Item -LiteralPath $path
        $referenceFacts.Add([ordered]@{
            role = $entry.Key
            path = $path
            sha256 = $entry.Value
            length = [long] $item.Length
            version = $item.VersionInfo.FileVersion
            signature = Assert-Cx004MicrosoftAuthenticode -LiteralPath $path -Role $entry.Key
        })
    }

    $buildRoot = Join-Path $HostEvidenceRoot 'host-smoke-build'
    if (Test-Path -LiteralPath $buildRoot) {
        Throw-Cx004 'host-smoke-build-collision' 'The private host-smoke evidence directory already exists.'
    }
    [System.IO.Directory]::CreateDirectory($buildRoot) | Out-Null
    Assert-Cx004QualificationRootSafety -LiteralPath $buildRoot
    $stagedSourcePath = Join-Path $buildRoot 'host-job-smoke.cs'
    [System.IO.File]::Copy($sourcePath, $stagedSourcePath, $false)
    if ((Get-Cx004Sha256 -LiteralPath $stagedSourcePath) -cne [string] $sealedSource[0].sha256) {
        Throw-Cx004 'host-smoke-staged-source-mismatch' 'The staged host smoke source differs from the S0 worktree bytes.'
    }

    $assemblyPath = Join-Path $buildRoot 'host-job-smoke.exe'
    $compilerArguments = @(
        '/noconfig', '/shared:false', '/nostdlib+', '/nologo', '/target:exe', '/platform:x64', '/optimize+',
        '/checked+', '/warnaserror+', '/nullable:enable', '/deterministic+', '/utf8output',
        "/reference:$($referencePaths[0])", "/reference:$($referencePaths[1])", "/reference:$($referencePaths[2])",
        "/out:$assemblyPath", $stagedSourcePath
    )
    $compilerFilePaths = [ordered]@{
        vswhere = $vswherePath
        csc = $cscPath
        referenceMscorlib = $referencePaths[0]
        referenceSystem = $referencePaths[1]
        referenceSystemCore = $referencePaths[2]
        stagedSource = $stagedSourcePath
    }
    $compilerFilesBefore = Get-Cx004NamedFileSetSnapshot -Files $compilerFilePaths
    $roslynRoot = [System.IO.Path]::GetDirectoryName($cscPath)
    $roslynClosureBefore = Get-Cx004RoslynClosureSnapshot -RoslynRoot $roslynRoot
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-compiler-files-before.json') -InputObject $compilerFilesBefore -Depth 32
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-roslyn-closure-before.json') -InputObject $roslynClosureBefore -Depth 32
    $compilerInputsPath = Join-Path $HostEvidenceRoot 'host-smoke-compiler-inputs.json'
    $compilerInputs = [ordered]@{
        vswhere = [ordered]@{
            path = $vswherePath
            sha256 = Get-Cx004Sha256 -LiteralPath $vswherePath
            length = [long] (Get-Item -LiteralPath $vswherePath).Length
            version = (Get-Item -LiteralPath $vswherePath).VersionInfo.FileVersion
            signature = $vswhereSignature
            arguments = $vswhereArguments
            receipt = $vswhereReceipt
        }
        compiler = [ordered]@{
            path = $cscPath
            sha256 = Get-Cx004Sha256 -LiteralPath $cscPath
            length = [long] (Get-Item -LiteralPath $cscPath).Length
            version = (Get-Item -LiteralPath $cscPath).VersionInfo.FileVersion
            signature = $cscSignature
        }
        references = @($referenceFacts)
        compilerFilesBefore = $compilerFilesBefore
        roslynClosureBefore = $roslynClosureBefore
        source = [ordered]@{
            relativePath = $sourceRelativePath
            stagedPath = $stagedSourcePath
            sha256 = Get-Cx004Sha256 -LiteralPath $stagedSourcePath
            length = [long] (Get-Item -LiteralPath $stagedSourcePath).Length
        }
        orderedArguments = $compilerArguments
    }
    Write-Cx004JsonFile -LiteralPath $compilerInputsPath -InputObject $compilerInputs -Depth 32

    $compileReceipt = Invoke-Cx004BoundedNative `
        -ExecutablePath $cscPath `
        -Arguments $compilerArguments `
        -WorkingDirectory $buildRoot `
        -TimeoutSeconds 60 `
        -MaxStdoutBytes 524288 `
        -MaxStderrBytes 524288 `
        -ScrubEnvironment
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-compiler-native.json') -InputObject $compileReceipt -Depth 16
    $compilerFilesAfterCompile = Get-Cx004NamedFileSetSnapshot -Files $compilerFilePaths
    $roslynClosureAfterCompile = Get-Cx004RoslynClosureSnapshot -RoslynRoot $roslynRoot
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-compiler-files-after-compile.json') -InputObject $compilerFilesAfterCompile -Depth 32
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-roslyn-closure-after-compile.json') -InputObject $roslynClosureAfterCompile -Depth 32
    Assert-Cx004SnapshotUnchanged -Before $compilerFilesBefore -After $compilerFilesAfterCompile -Context 'The compiler, references, and staged source'
    Assert-Cx004SnapshotUnchanged -Before $roslynClosureBefore -After $roslynClosureAfterCompile -Context 'The reviewed Roslyn compiler closure'
    if ($compileReceipt.TimedOut) { Throw-Cx004 'native-process-timeout' 'Bounded Roslyn compilation timed out.' }
    if ($compileReceipt.StdoutBytes -gt 524288) { Throw-Cx004 'native-stdout-overflow' 'Bounded Roslyn stdout exceeded its cap.' }
    if ($compileReceipt.StderrBytes -gt 524288) { Throw-Cx004 'native-stderr-overflow' 'Bounded Roslyn stderr exceeded its cap.' }
    if (-not $compileReceipt.ProcessExited -or -not $compileReceipt.CaptureCompleted -or $compileReceipt.ExitCode -ne 0 -or
        $compileReceipt.Stdout.Length -ne 0 -or $compileReceipt.Stderr.Length -ne 0 -or
        -not (Test-Path -LiteralPath $assemblyPath -PathType Leaf)) {
        Throw-Cx004 'host-smoke-compile-failed' 'The exact bounded host smoke compilation did not produce one clean executable.'
    }
    $assemblyBefore = Get-Cx004PathFact -LiteralPath $assemblyPath
    $afterCompileSeal = Get-Cx004SourceSeal -ExpectedS0Commit $ExpectedS0Commit -ExpectedS0Tree $ExpectedS0Tree
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'source-seal-after-host-compile.json') -InputObject $afterCompileSeal -Depth 32
    $assemblyImmediatelyBeforeController = Get-Cx004PathFact -LiteralPath $assemblyPath
    Assert-Cx004SnapshotUnchanged -Before $assemblyBefore -After $assemblyImmediatelyBeforeController -Context 'The compiled host-smoke executable before controller launch'
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-assembly-immediately-before-controller.json') -InputObject $assemblyImmediatelyBeforeController -Depth 24

    $controllerReceipt = Invoke-Cx004BoundedNative `
        -ExecutablePath $assemblyPath `
        -Arguments @('--host-smoke') `
        -WorkingDirectory $buildRoot `
        -TimeoutSeconds 35 `
        -MaxStdoutBytes $script:Cx004MaxJsonBytes `
        -MaxStderrBytes 65536 `
        -ScrubEnvironment
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-controller-native.json') -InputObject $controllerReceipt -Depth 16
    [System.IO.File]::WriteAllText((Join-Path $HostEvidenceRoot 'host-smoke-stdout.txt'), $controllerReceipt.Stdout, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $HostEvidenceRoot 'host-smoke-stderr.txt'), $controllerReceipt.Stderr, [System.Text.UTF8Encoding]::new($false))
    $compilerFilesAfterController = Get-Cx004NamedFileSetSnapshot -Files $compilerFilePaths
    $roslynClosureAfterController = Get-Cx004RoslynClosureSnapshot -RoslynRoot $roslynRoot
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-compiler-files-after-controller.json') -InputObject $compilerFilesAfterController -Depth 32
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-roslyn-closure-after-controller.json') -InputObject $roslynClosureAfterController -Depth 32
    Assert-Cx004SnapshotUnchanged -Before $compilerFilesBefore -After $compilerFilesAfterController -Context 'The compiler, references, and staged source through controller completion'
    Assert-Cx004SnapshotUnchanged -Before $roslynClosureBefore -After $roslynClosureAfterController -Context 'The reviewed Roslyn compiler closure through controller completion'
    if ($controllerReceipt.TimedOut) {
        if (-not $controllerReceipt.ProcessExited -or -not $controllerReceipt.CaptureCompleted -or
            -not $controllerReceipt.KillAttempted -or -not $controllerReceipt.KillSucceeded) {
            Throw-Cx004 'host-smoke-teardown-unproven' 'The timed-out retained controller did not positively exit after exact-process kill.'
        }
        Throw-Cx004 'native-process-timeout' 'The retained host-smoke controller timed out; Job-handle close followed controller exit, so the run is inconclusive.'
    }
    if ($controllerReceipt.StdoutBytes -gt $script:Cx004MaxJsonBytes) { Throw-Cx004 'native-stdout-overflow' 'Bounded host-smoke stdout exceeded its cap.' }
    if ($controllerReceipt.StderrBytes -gt 65536) { Throw-Cx004 'native-stderr-overflow' 'Bounded host-smoke stderr exceeded its cap.' }
    if (-not $controllerReceipt.ProcessExited -or -not $controllerReceipt.CaptureCompleted -or $controllerReceipt.Stderr.Length -ne 0) {
        Throw-Cx004 'host-smoke-failed' 'The bounded host-smoke controller did not exit cleanly.'
    }
    $raw = $controllerReceipt.Stdout.TrimEnd("`r", "`n")
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw.Contains("`r") -or $raw.Contains("`n")) {
        Throw-Cx004 'host-smoke-output-count' 'Host smoke did not emit exactly one bounded JSON line.'
    }
    $exitCode = [int] $controllerReceipt.ExitCode
    $document = Get-Cx004JsonDocument -RawJson $raw
    try {
            $root = $document.RootElement
            Assert-Cx004JsonObjectKeys -Element $root -ExpectedKeys @(
                'schemaVersion', 'classification', 'result', 'failure', 'fakeChildOnly', 'createSuspended',
                'inheritHandles', 'jobLimitFlags', 'uiRestrictions', 'createdProcessId', 'processHandleId',
                'processIdMatched', 'membershipAssignedCount', 'membershipProcessCount', 'membershipProcessId',
                'membershipPidMatched', 'resumeThreadResult', 'markerProgressObserved', 'childLiveBeforeJobClose',
                'jobClosed', 'childSignaled', 'markerStopped', 'tempRootRenamed', 'tempRootReleased',
                'elapsedMilliseconds', 'handleLedger'
            ) -Context 'host smoke evidence'
            if ($exitCode -ne 0 -or
                (Get-Cx004JsonString -Object $root -Name 'schemaVersion') -cne 'cx-004-host-smoke-v1' -or
                (Get-Cx004JsonString -Object $root -Name 'classification') -cne 'host-smoke-only' -or
                (Get-Cx004JsonString -Object $root -Name 'result') -cne 'passed' -or
                (Get-Cx004JsonString -Object $root -Name 'failure') -cne '') {
                Throw-Cx004 'host-smoke-positive-violation' 'The bounded host smoke returned a valid negative receipt.'
            }

            $expectedBooleans = [ordered]@{
                fakeChildOnly = $true
                createSuspended = $true
                inheritHandles = $false
                processIdMatched = $true
                membershipPidMatched = $true
                markerProgressObserved = $true
                childLiveBeforeJobClose = $true
                jobClosed = $true
                childSignaled = $true
                markerStopped = $true
                tempRootRenamed = $true
                tempRootReleased = $true
            }
            foreach ($entry in $expectedBooleans.GetEnumerator()) {
                if ((Get-Cx004JsonBoolean -Object $root -Name $entry.Key) -ne $entry.Value) {
                    Throw-Cx004 'host-smoke-positive-violation' "Host smoke boolean $($entry.Key) was not the required value."
                }
            }
            $createdPid = Get-Cx004JsonInt64 -Object $root -Name 'createdProcessId'
            if ($createdPid -le 0 -or
                (Get-Cx004JsonInt64 -Object $root -Name 'processHandleId') -ne $createdPid -or
                (Get-Cx004JsonInt64 -Object $root -Name 'membershipProcessId') -ne $createdPid -or
                (Get-Cx004JsonInt64 -Object $root -Name 'membershipAssignedCount') -ne 1 -or
                (Get-Cx004JsonInt64 -Object $root -Name 'membershipProcessCount') -ne 1 -or
                (Get-Cx004JsonInt64 -Object $root -Name 'resumeThreadResult') -ne 1 -or
                (Get-Cx004JsonInt64 -Object $root -Name 'jobLimitFlags') -ne 0x2000 -or
                (Get-Cx004JsonInt64 -Object $root -Name 'uiRestrictions') -ne 0) {
                Throw-Cx004 'host-smoke-positive-violation' 'Host smoke PID membership, resume, or leaf-job limits did not match.'
            }
            $elapsed = Get-Cx004JsonInt64 -Object $root -Name 'elapsedMilliseconds'
            if ($elapsed -lt 0 -or $elapsed -ge 30000) {
                Throw-Cx004 'host-smoke-positive-violation' 'Host smoke positively reported an elapsed time outside its 30-second bound.'
            }
            $ledger = $root.GetProperty('handleLedger')
            if ($ledger.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or $ledger.GetArrayLength() -ne 3) {
                Throw-Cx004 'host-smoke-positive-violation' 'Host smoke returned a handle ledger with the wrong cardinality.'
            }
            $kinds = @('job', 'process', 'thread')
            for ($index = 0; $index -lt 3; $index++) {
                $handle = $ledger[$index]
                Assert-Cx004JsonObjectKeys -Element $handle -ExpectedKeys @('kind', 'acquired', 'closeAttempted', 'closed', 'closeError') -Context 'host smoke handle'
                if ((Get-Cx004JsonString -Object $handle -Name 'kind') -cne $kinds[$index] -or
                    -not (Get-Cx004JsonBoolean -Object $handle -Name 'acquired') -or
                    -not (Get-Cx004JsonBoolean -Object $handle -Name 'closeAttempted') -or
                    -not (Get-Cx004JsonBoolean -Object $handle -Name 'closed') -or
                    (Get-Cx004JsonInt64 -Object $handle -Name 'closeError') -ne 0) {
                    Throw-Cx004 'host-smoke-positive-violation' 'A host smoke handle returned a valid negative close receipt.'
                }
            }
            $evidence = $raw | ConvertFrom-Json -AsHashtable -Depth 16
    }
    finally { $document.Dispose() }

    $assemblyAfter = Get-Cx004PathFact -LiteralPath $assemblyPath
    Assert-Cx004SnapshotUnchanged -Before $assemblyBefore -After $assemblyAfter -Context 'The compiled host-smoke executable during its controller run'
    $receipt = [ordered]@{
        sourceSha256 = Get-Cx004Sha256 -LiteralPath $stagedSourcePath
        compilerInputsManifestSha256 = Get-Cx004Sha256 -LiteralPath $compilerInputsPath
        compiler = $compilerInputs.compiler
        references = @($referenceFacts)
        orderedArguments = $compilerArguments
        compileReceipt = $compileReceipt
        compilerFilesAfterCompile = $compilerFilesAfterCompile
        roslynClosureAfterCompile = $roslynClosureAfterCompile
        assemblyBefore = $assemblyBefore
        assemblyImmediatelyBeforeController = $assemblyImmediatelyBeforeController
        controllerReceipt = $controllerReceipt
        compilerFilesAfterController = $compilerFilesAfterController
        roslynClosureAfterController = $roslynClosureAfterController
        assemblyAfter = $assemblyAfter
        evidence = $evidence
    }
    Write-Cx004JsonFile -LiteralPath (Join-Path $HostEvidenceRoot 'host-smoke-receipt.json') -InputObject $receipt -Depth 48
    return $receipt
}

function Get-Cx004GitIdentity {
    param([Parameter(Mandatory)] [string] $GitPath)

    $resolvedPath = Get-Cx004FullPath -LiteralPath $GitPath
    if ($resolvedPath -cne $script:Cx004ExpectedGitPath -or
        -not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        Throw-Cx004 'git-identity-failed' 'Git execution was not directed to the sealed Git-for-Windows engine path.'
    }
    Assert-Cx004NoReparsePath -LiteralPath $resolvedPath
    $item = Get-Item -LiteralPath $resolvedPath -Force
    $signature = Get-Cx004AuthenticodeFact -LiteralPath $resolvedPath
    $sha256 = Get-Cx004Sha256 -LiteralPath $resolvedPath
    if ([long] $item.Length -ne $script:Cx004ExpectedGitLength -or
        [string] $item.VersionInfo.FileVersion -cne $script:Cx004ExpectedGitVersion -or
        $sha256 -cne $script:Cx004ExpectedGitSha256 -or
        [string] $signature.status -cne 'Valid' -or
        [string] $signature.signerSubject -cne $script:Cx004ExpectedGitSignerSubject -or
        [string] $signature.signerThumbprint -cne $script:Cx004ExpectedGitSignerThumbprint) {
        Throw-Cx004 'git-identity-failed' 'The Git-for-Windows engine bytes, version, length, or signer differ from the reviewed host identity.'
    }
    return [ordered]@{
        path = $resolvedPath
        sha256 = $sha256
        length = [long] $item.Length
        version = [string] $item.VersionInfo.FileVersion
        signature = $signature
    }
}

function Get-Cx004GitPath {
    [void] (Get-Cx004GitIdentity -GitPath $script:Cx004ExpectedGitPath)
    return $script:Cx004ExpectedGitPath
}

function Invoke-Cx004Git {
    param(
        [Parameter(Mandatory)] [string] $GitPath,
        [Parameter(Mandatory)] [string] $RepoRoot,
        [Parameter(Mandatory)] [string[]] $Arguments,
        [int] $MaximumBytes = 1MB
    )

    $identityBefore = Get-Cx004GitIdentity -GitPath $GitPath
    $receipt = Invoke-Cx004BoundedNative `
        -ExecutablePath $GitPath `
        -Arguments (@('-C', $RepoRoot) + $Arguments) `
        -WorkingDirectory $RepoRoot `
        -TimeoutSeconds 30 `
        -MaxStdoutBytes $MaximumBytes `
        -MaxStderrBytes $MaximumBytes `
        -ScrubEnvironment
    $identityAfter = Get-Cx004GitIdentity -GitPath $GitPath
    if ((ConvertTo-Cx004CanonicalJson -InputObject $identityBefore -Depth 8) -cne
        (ConvertTo-Cx004CanonicalJson -InputObject $identityAfter -Depth 8)) {
        Throw-Cx004 'git-identity-failed' 'The sealed Git-for-Windows engine identity changed during a source-seal command.'
    }
    if ($receipt.TimedOut) { Throw-Cx004 'native-process-timeout' 'Bounded git execution timed out.' }
    if ($receipt.StdoutBytes -gt $MaximumBytes) { Throw-Cx004 'native-stdout-overflow' 'Bounded git stdout exceeded its cap.' }
    if ($receipt.StderrBytes -gt $MaximumBytes) { Throw-Cx004 'native-stderr-overflow' 'Bounded git stderr exceeded its cap.' }
    if (-not $receipt.ProcessExited -or -not $receipt.CaptureCompleted -or $receipt.ExitCode -ne 0 -or $receipt.Stderr.Length -ne 0) {
        Throw-Cx004 'git-identity-failed' "Bounded git command failed: $($Arguments -join ' ')"
    }
    return [string] $receipt.Stdout
}

function Get-Cx004SingleLine {
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Text,
        [Parameter(Mandatory)] [string] $Context
    )

    $line = $Text.TrimEnd("`r", "`n")
    if ([string]::IsNullOrWhiteSpace($line) -or $line.Contains("`r") -or $line.Contains("`n")) {
        Throw-Cx004 'git-identity-failed' "$Context did not return exactly one non-empty line."
    }
    return $line
}

function Get-Cx004GitBlobIdFromBytes {
    param(
        [Parameter(Mandatory)] [AllowEmptyCollection()] [byte[]] $Bytes
    )

    [byte[]] $header = [System.Text.Encoding]::ASCII.GetBytes("blob $($Bytes.LongLength)`0")
    $hasher = [System.Security.Cryptography.IncrementalHash]::CreateHash(
        [System.Security.Cryptography.HashAlgorithmName]::SHA1
    )
    try {
        $hasher.AppendData($header)
        $hasher.AppendData($Bytes)
        return [Convert]::ToHexString($hasher.GetHashAndReset()).ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
}

function Get-Cx004SourceSeal {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [ValidatePattern('^[0-9a-f]{40}$')] [string] $ExpectedS0Commit,
        [Parameter(Mandatory)] [ValidatePattern('^[0-9a-f]{40}$')] [string] $ExpectedS0Tree
    )

    $repoRoot = Get-Cx004FullPath -LiteralPath (Join-Path $PSScriptRoot '..\..\..\..')
    $expectedRelativePaths = @(
        'packages/windows-containment/lab/sandbox/Cx004Sandbox.psm1',
        'packages/windows-containment/lab/sandbox/Invoke-Cx004Q0S.ps1',
        'packages/windows-containment/lab/sandbox/guest-bootstrap.ps1',
        'packages/windows-containment/lab/sandbox/guest-probe.ps1',
        'packages/windows-containment/lab/sandbox/host-job-smoke.cs',
        'packages/windows-containment/lab/sandbox/sandbox.template.wsb',
        'packages/windows-containment/lab/test/sandbox-contract.test.ps1',
        'packages/windows-containment/lab/test/sandbox-host-smoke.test.ps1'
    )
    $manifestRelativePath = 'docs/execution/manifests/CX-004-sandbox-runner.json'
    [string[]] $sealedRelativePaths = @($manifestRelativePath) + $expectedRelativePaths
    [Array]::Sort($sealedRelativePaths, [StringComparer]::Ordinal)
    $actualRelativePaths = [System.Collections.Generic.List[string]]::new()
    foreach ($sourceDirectory in @(
        [ordered]@{ path = (Join-Path $repoRoot 'packages\windows-containment\lab\sandbox'); maximumEntries = 7 },
        [ordered]@{ path = (Join-Path $repoRoot 'packages\windows-containment\lab\test'); maximumEntries = 3 }
    )) {
        try {
            $sourceItems = @(Get-Cx004BoundedDirectoryItems `
                -LiteralPath $sourceDirectory.path `
                -MaximumEntries $sourceDirectory.maximumEntries)
        }
        catch {
            Throw-Cx004 'unexpected-harness-source' 'A Q0S harness source directory exceeded its closed, bounded surface.'
        }
        foreach ($item in $sourceItems) {
            if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-Cx004 'unexpected-harness-source' 'The Q0S harness source surface contains a directory or reparse point.'
            }
            $actualRelativePaths.Add([System.IO.Path]::GetRelativePath($repoRoot, $item.FullName).Replace('\', '/'))
        }
    }
    $actualRelativePaths = @($actualRelativePaths | Sort-Object)
    if (($actualRelativePaths -join "`n") -cne (($expectedRelativePaths | Sort-Object) -join "`n")) {
        Throw-Cx004 'unexpected-harness-source' 'The Q0S harness source surface differs from its closed manifest.'
    }

    $gitPath = Get-Cx004GitPath
    $status = Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('status', '--porcelain=v1', '-z', '--untracked-files=all')
    if ($status.Length -ne 0) {
        Throw-Cx004 'dirty-source-tree' 'Q0S requires a clean source worktree.'
    }
    $indexStateRaw = Invoke-Cx004Git `
        -GitPath $gitPath `
        -RepoRoot $repoRoot `
        -Arguments (@('ls-files', '-v', '--') + $sealedRelativePaths)
    $indexStateLines = @($indexStateRaw.TrimEnd("`r", "`n") -split '\r?\n')
    $expectedIndexStateLines = @($sealedRelativePaths | ForEach-Object { "H $_" })
    if (($indexStateLines -join "`n") -cne ($expectedIndexStateLines -join "`n")) {
        Throw-Cx004 'source-index-flags' 'Every sealed S0 path must be one ordinary tracked index entry without assume-unchanged or skip-worktree flags.'
    }
    $branch = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('symbolic-ref', '--short', 'HEAD')) -Context 'source branch'
    $head = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('rev-parse', 'HEAD')) -Context 'source HEAD'
    $tree = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('rev-parse', 'HEAD^{tree}')) -Context 'source tree'
    $localMain = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('rev-parse', 'main')) -Context 'local main'
    $originMain = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('rev-parse', 'origin/main')) -Context 'origin/main'
    $remote = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('remote', 'get-url', 'origin')) -Context 'origin URL'
    if ($branch -cne 'main' -or $head -cne $ExpectedS0Commit -or $localMain -cne $ExpectedS0Commit -or
        $originMain -cne $ExpectedS0Commit -or $tree -cne $ExpectedS0Tree -or
        $remote -cne $script:Cx004ExpectedOriginUrl) {
        Throw-Cx004 'source-seal-mismatch' 'HEAD, local main, re-fetched origin/main, tree, branch, or canonical origin URL differs from the caller-pinned S0 seal.'
    }

    $manifestPath = Join-Path $repoRoot 'docs\execution\manifests\CX-004-sandbox-runner.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        Throw-Cx004 'source-seal-manifest-missing' 'The tracked S0 worktree-byte manifest is absent.'
    }
    $manifestTreeLine = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('ls-tree', 'HEAD', '--', $manifestRelativePath)) -Context 'S0 source manifest blob'
    if ($manifestTreeLine -cnotmatch '^100644 blob ([0-9a-f]{40})\t(.+)$' -or $Matches[2] -cne $manifestRelativePath) {
        Throw-Cx004 'source-seal-manifest-untracked' 'The S0 worktree-byte manifest is not one exact regular Git blob at HEAD.'
    }
    $manifestGitBlob = [string] $Matches[1]
    $manifestAttribute = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('check-attr', 'eol', '--', $manifestRelativePath)) -Context 'S0 source manifest eol attribute'
    if ($manifestAttribute -cne "$manifestRelativePath`: eol: lf") {
        Throw-Cx004 'source-eol-policy-mismatch' 'The tracked S0 source manifest is not pinned to LF checkout bytes.'
    }
    try {
        Initialize-Cx004NativeFileInfo
        $manifestRead = [Cx004NativeFileInfo]::ReadBoundedRegularFile($manifestPath, 1MB)
    }
    catch {
        Throw-Cx004 'source-worktree-byte-mismatch' 'The tracked S0 source manifest could not be retained as one bounded regular file.'
    }
    if ((Get-Cx004GitBlobIdFromBytes -Bytes $manifestRead.Bytes) -cne $manifestGitBlob) {
        Throw-Cx004 'source-blob-mismatch' 'The retained S0 source-manifest bytes differ from its caller-pinned HEAD blob.'
    }
    try {
        [byte[]] $manifestBytes = $manifestRead.Bytes
        if (($manifestBytes.Length -ge 3 -and $manifestBytes[0] -eq 0xef -and
                $manifestBytes[1] -eq 0xbb -and $manifestBytes[2] -eq 0xbf) -or
            [Array]::IndexOf($manifestBytes, [byte] 0) -ge 0) {
            throw 'The source manifest contains a BOM or NUL.'
        }
        $manifestText = [System.Text.UTF8Encoding]::new($false, $true).GetString($manifestBytes)
        $sourceManifest = $manifestText | ConvertFrom-Json -AsHashtable -Depth 16
    }
    catch {
        Throw-Cx004 'source-seal-manifest-invalid' 'The tracked S0 worktree-byte manifest is not strict BOM-free UTF-8 JSON.'
    }
    if (@($sourceManifest.Keys).Count -ne 3 -or
        -not $sourceManifest.Contains('schemaVersion') -or
        -not $sourceManifest.Contains('classification') -or
        -not $sourceManifest.Contains('sourceFiles') -or
        [string] $sourceManifest.schemaVersion -cne 'cx004-s0-source-seal-v1' -or
        [string] $sourceManifest.classification -cne 'tracked-source-seal') {
        Throw-Cx004 'source-seal-manifest-invalid' 'The tracked S0 worktree-byte manifest root differs from its closed schema.'
    }
    $manifestFiles = @($sourceManifest.sourceFiles)
    if ($manifestFiles.Count -ne $expectedRelativePaths.Count) {
        Throw-Cx004 'source-seal-manifest-invalid' 'The tracked S0 worktree-byte manifest has the wrong file count.'
    }

    $files = [System.Collections.Generic.List[object]]::new()
    $sortedExpected = @($expectedRelativePaths | Sort-Object)
    for ($index = 0; $index -lt $sortedExpected.Count; $index++) {
        $relativePath = $sortedExpected[$index]
        $manifestFile = $manifestFiles[$index]
        if (@($manifestFile.Keys).Count -ne 3 -or
            [string] $manifestFile.relativePath -cne $relativePath -or
            [string] $manifestFile.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
            -not (Test-Cx004IntegralPrimitive -Value $manifestFile.length) -or
            [long] $manifestFile.length -lt 1 -or [long] $manifestFile.length -gt 4MB) {
            Throw-Cx004 'source-seal-manifest-invalid' "The tracked S0 source entry is invalid or unsorted: $relativePath"
        }
        $path = Join-Path $repoRoot $relativePath
        try {
            Initialize-Cx004NativeFileInfo
            $sourceRead = [Cx004NativeFileInfo]::ReadBoundedRegularFile($path, [int] $manifestFile.length)
        }
        catch {
            Throw-Cx004 'source-worktree-byte-mismatch' "Executed worktree bytes could not be retained within the tracked S0 length: $relativePath"
        }
        if ([string] $sourceRead.Sha256 -cne [string] $manifestFile.sha256 -or
            [long] $sourceRead.Bytes.Length -ne [long] $manifestFile.length) {
            Throw-Cx004 'source-worktree-byte-mismatch' "Executed worktree bytes differ from the tracked S0 manifest: $relativePath"
        }
        $attribute = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('check-attr', 'eol', '--', $relativePath)) -Context 'Git eol attribute'
        if ($attribute -cne "$relativePath`: eol: lf") {
            Throw-Cx004 'source-eol-policy-mismatch' "Executed source is not pinned to LF checkout bytes: $relativePath"
        }
        $treeLine = Get-Cx004SingleLine -Text (Invoke-Cx004Git -GitPath $gitPath -RepoRoot $repoRoot -Arguments @('ls-tree', 'HEAD', '--', $relativePath)) -Context 'Git source blob'
        if ($treeLine -cnotmatch '^100644 blob ([0-9a-f]{40})\t(.+)$' -or $Matches[2] -cne $relativePath) {
            Throw-Cx004 'source-blob-mismatch' "The S0 source path is not one exact regular Git blob: $relativePath"
        }
        $sourceGitBlob = [string] $Matches[1]
        if ((Get-Cx004GitBlobIdFromBytes -Bytes $sourceRead.Bytes) -cne $sourceGitBlob) {
            Throw-Cx004 'source-blob-mismatch' "Retained worktree bytes differ from the caller-pinned HEAD blob: $relativePath"
        }
        $files.Add([ordered]@{
            relativePath = $relativePath
            sha256 = [string] $manifestFile.sha256
            length = [long] $manifestFile.length
            gitBlob = $sourceGitBlob
        })
    }
    return [ordered]@{
        repoRoot = $repoRoot
        head = $head
        tree = $tree
        localMain = $localMain
        originMain = $originMain
        originUrl = $remote
        git = Get-Cx004GitIdentity -GitPath $gitPath
        sourceManifest = [ordered]@{
            relativePath = $manifestRelativePath
            sha256 = [string] $manifestRead.Sha256
            length = [long] $manifestRead.Bytes.Length
            gitBlob = $manifestGitBlob
        }
        files = @($files)
    }
}

function Get-Cx004BundleInventory {
    param(
        [Parameter(Mandatory)] [string] $BundleRoot,
        [Parameter(Mandatory)] [string[]] $ExcludedRelativePaths
    )

    $directories = [System.Collections.Generic.Queue[string]]::new()
    $directories.Enqueue((Get-Cx004FullPath -LiteralPath $BundleRoot))
    $files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    $objectCount = 0
    [long] $totalBytes = 0
    while ($directories.Count -gt 0) {
        $directory = $directories.Dequeue()
        $items = @(Get-Cx004BoundedDirectoryItems -LiteralPath $directory -MaximumEntries 513)
        foreach ($item in $items) {
            $objectCount += 1
            if ($objectCount -gt 512) {
                Throw-Cx004 'bundle-object-overflow' 'The evidence bundle exceeded its 512-object closure cap.'
            }
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-Cx004 'bundle-reparse-object' 'The evidence bundle contains a file or directory reparse point.'
            }
            $relative = [System.IO.Path]::GetRelativePath($BundleRoot, $item.FullName).Replace('\', '/')
            if ($item.PSIsContainer) {
                if ($ExcludedRelativePaths -ccontains $relative) {
                    Throw-Cx004 'bundle-exclusion-not-file' 'A bundle exclusion path unexpectedly names a directory.'
                }
                $directories.Enqueue($item.FullName)
            }
            elseif ($item -is [System.IO.FileInfo]) {
                if ($ExcludedRelativePaths -ccontains $relative) { continue }
                $files.Add($item)
                $totalBytes += [long] $item.Length
                if ($files.Count -gt 256 -or $totalBytes -gt 64MB) {
                    Throw-Cx004 'bundle-file-overflow' 'The evidence bundle exceeded its 256-file or 64-MiB closure cap.'
                }
            }
            else {
                Throw-Cx004 'bundle-unknown-object' 'The evidence bundle contains an unsupported filesystem object.'
            }
        }
    }

    $relativePaths = [System.Collections.Generic.List[string]]::new()
    $pathMap = @{}
    foreach ($file in $files) {
        if (-not (Test-Cx004PathDescendant -Candidate $file.FullName -Root $BundleRoot)) {
            Throw-Cx004 'bundle-file-outside-root' 'A candidate evidence file resolved outside the private qualification root.'
        }
        $relative = [System.IO.Path]::GetRelativePath($BundleRoot, $file.FullName).Replace('\', '/')
        if ($pathMap.ContainsKey($relative)) { Throw-Cx004 'duplicate-bundle-path' 'The evidence bundle contains a duplicate relative path.' }
        $relativePaths.Add($relative)
        $pathMap[$relative] = $file.FullName
    }
    $relativePaths.Sort([System.StringComparer]::Ordinal)
    $inventory = [System.Collections.Generic.List[object]]::new()
    foreach ($relative in $relativePaths) {
        $fact = Get-Cx004PathFact -LiteralPath $pathMap[$relative]
        $inventory.Add([ordered]@{
            relativePath = $relative
            volumeSerial = $fact.volumeSerial
            fileId = $fact.fileId
            linkCount = [long] $fact.linkCount
            sha256 = $fact.sha256
            length = [long] $fact.length
        })
    }
    return @($inventory)
}

function Close-Cx004EvidenceBundle {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $BundleRoot)

    Assert-Cx004QualificationRootSafety -LiteralPath $BundleRoot
    $manifestPath = Join-Path $BundleRoot 'bundle-manifest.json'
    if (Test-Path -LiteralPath $manifestPath) {
        Throw-Cx004 'bundle-already-closed' 'The private qualification bundle already has a closing manifest.'
    }
    $excludedRelativePaths = @('bundle-manifest.json', 'tracked-receipt.json')
    $firstInventory = @(Get-Cx004BundleInventory -BundleRoot $BundleRoot -ExcludedRelativePaths $excludedRelativePaths)
    $secondInventory = @(Get-Cx004BundleInventory -BundleRoot $BundleRoot -ExcludedRelativePaths $excludedRelativePaths)
    if ((ConvertTo-Cx004CanonicalJson -InputObject $firstInventory -Depth 16) -cne
        (ConvertTo-Cx004CanonicalJson -InputObject $secondInventory -Depth 16)) {
        Throw-Cx004 'bundle-mutated-during-close' 'Evidence identity, contents, or surface changed during bundle closure.'
    }
    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($fact in $secondInventory) {
        $entries.Add([ordered]@{
            relativePath = $fact.relativePath
            sha256 = $fact.sha256
            length = [long] $fact.length
        })
    }
    $manifest = [ordered]@{
        schemaVersion = 'cx004-q0s-bundle-v1'
        classification = 'local-quarantined-evidence-bundle'
        scope = $script:Cx004Scope
        createdUtc = [DateTime]::UtcNow.ToString('O')
        exclusions = $excludedRelativePaths
        files = @($entries)
    }
    Write-Cx004JsonFile -LiteralPath $manifestPath -InputObject $manifest -Depth 32
    $finalInventory = @(Get-Cx004BundleInventory -BundleRoot $BundleRoot -ExcludedRelativePaths $excludedRelativePaths)
    if ((ConvertTo-Cx004CanonicalJson -InputObject $secondInventory -Depth 16) -cne
        (ConvertTo-Cx004CanonicalJson -InputObject $finalInventory -Depth 16)) {
        Throw-Cx004 'bundle-mutated-during-close' 'Evidence identity, contents, or surface changed while writing the closing manifest.'
    }
    $manifestFact = Get-Cx004PathFact -LiteralPath $manifestPath
    return [ordered]@{
        relativePath = 'bundle-manifest.json'
        path = $manifestPath
        sha256 = $manifestFact.sha256
        length = [long] $manifestFact.length
        fileCount = [long] $entries.Count
        exclusions = $excludedRelativePaths
    }
}

function Get-Cx004GuestSemanticVector {
    param([Parameter(Mandatory)] [System.Collections.IDictionary] $GuestEvidence)

    $guest = $GuestEvidence.guest
    return [ordered]@{
        productName = $guest.productName
        displayVersion = $guest.displayVersion
        editionId = $guest.editionId
        installationType = $guest.installationType
        productType = $guest.productType
        version = $guest.version
        buildNumber = $guest.buildNumber
        ubr = $guest.ubr
        fullBuild = $guest.fullBuild
        architecture = $guest.architecture
        processArchitecture = $guest.processArchitecture
        authenticationType = $guest.authenticationType
        impersonationLevel = $guest.impersonationLevel
        isAuthenticated = $guest.isAuthenticated
        isAnonymous = $guest.isAnonymous
        isGuest = $guest.isGuest
        isSystem = $guest.isSystem
        isAdministrator = $guest.isAdministrator
        integrity = [ordered]@{
            sid = $guest.integrity.sid
            level = ConvertTo-Cx004IntegrityAlias -Sid ([string] $guest.integrity.sid)
            type = $guest.integrity.type
            attributes = $guest.integrity.attributes
        }
        groups = @($guest.groups | ForEach-Object {
            [ordered]@{ name = $_.name; type = $_.type; attributes = $_.attributes }
        } | Sort-Object { ConvertTo-Cx004CanonicalJson -InputObject $_ })
        privileges = @($guest.privileges | ForEach-Object {
            [ordered]@{ name = $_.name; description = $_.description; state = $_.state }
        } | Sort-Object { ConvertTo-Cx004CanonicalJson -InputObject $_ })
    }
}

function Invoke-Cx004Q0S {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [ValidatePattern('^[0-9a-f]{40}$')] [string] $ExpectedS0Commit,
        [Parameter(Mandatory)] [ValidatePattern('^[0-9a-f]{40}$')] [string] $ExpectedS0Tree
    )

    $bundleRoot = New-Cx004QualificationBundleRoot
    $doctor = $null
    $initialList = $null
    $finalList = $null
    $sourceSealInitial = $null
    $sourceSealFinal = $null
    $hostSmoke = $null
    $firstStage = $null
    $secondStage = $null
    $firstSession = $null
    $secondSession = $null
    $firstVector = $null
    $secondVector = $null
    $firstCanary = $null
    $secondCanary = $null
    $errorFact = $null
    $outcome = 'inconclusive'
    $templatePath = Join-Path $PSScriptRoot 'sandbox.template.wsb'

    try {
        $sourceSealInitial = Get-Cx004SourceSeal -ExpectedS0Commit $ExpectedS0Commit -ExpectedS0Tree $ExpectedS0Tree
        Write-Cx004JsonFile -LiteralPath (Join-Path $bundleRoot.HostRoot 'source-seal-initial.json') -InputObject $sourceSealInitial -Depth 32

        $doctor = Get-Cx004HostDoctor -EvidenceRoot $bundleRoot.HostRoot
        Write-Cx004JsonFile -LiteralPath (Join-Path $bundleRoot.HostRoot 'host-doctor.json') -InputObject $doctor -Depth 32
        $wsbPath = $doctor.command.source
        $initialList = Get-Cx004WsbListReceipt `
            -WsbPath $wsbPath `
            -NativeReceiptPath (Join-Path $bundleRoot.HostRoot 'cli-initial-list-native.json')
        Assert-Cx004NoRunningSessions -RawJson $initialList.Raw | Out-Null
        Write-Cx004JsonFile -LiteralPath (Join-Path $bundleRoot.HostRoot 'cli-initial-list.json') -InputObject $initialList.Native -Depth 8

        $hostSmoke = Invoke-Cx004HostSmoke `
            -HostEvidenceRoot $bundleRoot.HostRoot `
            -ExpectedS0Commit $ExpectedS0Commit `
            -ExpectedS0Tree $ExpectedS0Tree

        $sourceBeforeFirstStage = Get-Cx004SourceSeal -ExpectedS0Commit $ExpectedS0Commit -ExpectedS0Tree $ExpectedS0Tree
        Write-Cx004JsonFile -LiteralPath (Join-Path $bundleRoot.HostRoot 'source-seal-before-session1-stage.json') -InputObject $sourceBeforeFirstStage -Depth 32
        $firstCanary = New-Cx004HostCanary -Challenge (New-Cx004Challenge)
        try {
            $firstStage = New-Cx004RunStage `
                -TemplatePath $templatePath `
                -QualificationRoot $bundleRoot.Root `
                -SessionName 'session1' `
                -HostCanary $firstCanary `
                -SourceSeal $sourceBeforeFirstStage
            $firstSession = Invoke-Cx004SandboxSession `
                -Stage $firstStage `
                -WsbPath $wsbPath `
                -HostCanary $firstCanary `
                -ExpectedS0Commit $ExpectedS0Commit `
                -ExpectedS0Tree $ExpectedS0Tree
            $firstCanary = $null
        }
        finally {
            if ($null -ne $firstCanary) {
                $abandonedCanary = Close-Cx004HostCanaryUnproven -Canary $firstCanary
                Write-Cx004JsonFile -LiteralPath (Join-Path $bundleRoot.HostRoot 'session1-canary-unproven.json') -InputObject $abandonedCanary -Depth 8
                $firstCanary = $null
            }
        }

        if ($firstSession.outcome -ceq 'passed') {
            $sourceBeforeSecondStage = Get-Cx004SourceSeal -ExpectedS0Commit $ExpectedS0Commit -ExpectedS0Tree $ExpectedS0Tree
            Write-Cx004JsonFile -LiteralPath (Join-Path $bundleRoot.HostRoot 'source-seal-before-session2-stage.json') -InputObject $sourceBeforeSecondStage -Depth 32
            $secondCanary = New-Cx004HostCanary -Challenge (New-Cx004Challenge)
            try {
                $secondStage = New-Cx004RunStage `
                    -TemplatePath $templatePath `
                    -QualificationRoot $bundleRoot.Root `
                    -SessionName 'session2' `
                    -HostCanary $secondCanary `
                    -SourceSeal $sourceBeforeSecondStage
                if ($secondStage.RunId -ceq $firstStage.RunId -or $secondStage.Challenge -ceq $firstStage.Challenge -or
                    $secondStage.RunRoot -ceq $firstStage.RunRoot -or $secondStage.RenderedConfigSha256 -ceq $firstStage.RenderedConfigSha256) {
                    Throw-Cx004 'nonfresh-second-session' 'The clean-relaunch session did not receive fresh dynamic identity/configuration.'
                }
                if ($secondStage.TemplateSha256 -cne $firstStage.TemplateSha256 -or
                    $secondStage.StableManifestSha256 -cne $firstStage.StableManifestSha256) {
                    Throw-Cx004 'stable-input-drift' 'Stable template or fixed guest input changed between fresh sessions.'
                }
                $secondSession = Invoke-Cx004SandboxSession `
                    -Stage $secondStage `
                    -WsbPath $wsbPath `
                    -HostCanary $secondCanary `
                    -ExpectedS0Commit $ExpectedS0Commit `
                    -ExpectedS0Tree $ExpectedS0Tree
                $secondCanary = $null
                Assert-Cx004FreshSessionIds `
                    -FirstSessionId ([string] $firstSession.sessionId) `
                    -SecondSessionId ([string] $secondSession.sessionId)
            }
            finally {
                if ($null -ne $secondCanary) {
                    $abandonedCanary = Close-Cx004HostCanaryUnproven -Canary $secondCanary
                    Write-Cx004JsonFile -LiteralPath (Join-Path $bundleRoot.HostRoot 'session2-canary-unproven.json') -InputObject $abandonedCanary -Depth 8
                    $secondCanary = $null
                }
            }
        }

        if ($firstSession.outcome -ceq 'passed' -and $null -ne $secondSession -and $secondSession.outcome -ceq 'passed') {
            $firstEvidence = $firstSession.guestValidation.guestEvidence
            $secondEvidence = $secondSession.guestValidation.guestEvidence
            $firstVector = Get-Cx004GuestSemanticVector -GuestEvidence $firstEvidence
            $secondVector = Get-Cx004GuestSemanticVector -GuestEvidence $secondEvidence
            if ((ConvertTo-Cx004CanonicalJson -InputObject $firstVector -Depth 32) -cne
                (ConvertTo-Cx004CanonicalJson -InputObject $secondVector -Depth 32)) {
                Throw-Cx004 'guest-semantic-drift' 'The stable guest semantic vector changed across fresh Sandbox sessions.'
            }
        }

        $finalList = Get-Cx004WsbListReceipt `
            -WsbPath $wsbPath `
            -NativeReceiptPath (Join-Path $bundleRoot.HostRoot 'cli-final-list-native.json')
        Assert-Cx004NoRunningSessions -RawJson $finalList.Raw | Out-Null
        Write-Cx004JsonFile -LiteralPath (Join-Path $bundleRoot.HostRoot 'cli-final-list.json') -InputObject $finalList.Native -Depth 8
        $sourceSealFinal = Get-Cx004SourceSeal -ExpectedS0Commit $ExpectedS0Commit -ExpectedS0Tree $ExpectedS0Tree
        Write-Cx004JsonFile -LiteralPath (Join-Path $bundleRoot.HostRoot 'source-seal-final.json') -InputObject $sourceSealFinal -Depth 32

        if ($firstSession.outcome -cne 'passed') {
            $outcome = [string] $firstSession.outcome
        }
        elseif ($null -eq $secondSession) {
            $outcome = 'inconclusive'
        }
        else {
            $outcome = [string] $secondSession.outcome
        }
    }
    catch {
        $errorFact = [ordered]@{
            type = $_.Exception.GetType().FullName
            message = $_.Exception.Message
        }
        $positiveSessionFailure = ($null -ne $firstSession -and $firstSession.outcome -ceq 'failed') -or
            ($null -ne $secondSession -and $secondSession.outcome -ceq 'failed')
        $positiveCaughtFailure = (Test-Cx004PositiveIntegrityError -Message $_.Exception.Message) -or
            $_.Exception.Message -match 'CX004\[(host-smoke-positive-violation|guest-semantic-drift|nonfresh-second-session|stable-input-drift)\]'
        $outcome = if ($positiveSessionFailure -or $positiveCaughtFailure) {
            'failed'
        }
        else {
            'inconclusive'
        }
    }
    finally {
        if ($null -ne $firstCanary) { [void] (Close-Cx004HostCanaryUnproven -Canary $firstCanary) }
        if ($null -ne $secondCanary) { [void] (Close-Cx004HostCanaryUnproven -Canary $secondCanary) }
    }

    $qualificationSummary = [ordered]@{
        schemaVersion = $script:Cx004SchemaVersion
        classification = 'local-quarantined-evidence'
        scope = $script:Cx004Scope
        createdUtc = [DateTime]::UtcNow.ToString('O')
        expectedS0Commit = $ExpectedS0Commit
        expectedS0Tree = $ExpectedS0Tree
        outcome = $outcome
        privateRootAcl = $bundleRoot.Acl
        sourceSealInitial = $sourceSealInitial
        sourceSealFinal = $sourceSealFinal
        hostDoctor = $doctor
        initialListRaw = if ($null -ne $initialList) { $initialList.Raw } else { $null }
        hostSmoke = $hostSmoke
        firstSession = $firstSession
        secondSession = $secondSession
        firstGuestSemanticVector = $firstVector
        secondGuestSemanticVector = $secondVector
        finalListRaw = if ($null -ne $finalList) { $finalList.Raw } else { $null }
        error = $errorFact
    }
    $summaryPath = Join-Path $bundleRoot.Root 'qualification-summary.json'
    Write-Cx004JsonFile -LiteralPath $summaryPath -InputObject $qualificationSummary -Depth 96
    $closedBundle = Close-Cx004EvidenceBundle -BundleRoot $bundleRoot.Root

    $trackedReceipt = $null
    $trackedReceiptPath = $null
    if ($outcome -ceq 'passed') {
        $firstEvidence = $firstSession.guestValidation.guestEvidence
        $semanticFacts = [ordered]@{
            hostFullBuild = $doctor.host.fullBuild
            hostEditionId = $doctor.host.editionId
            hostInstallationType = $doctor.host.installationType
            hostArchitecture = $doctor.host.architecture
            sandboxPackageFullName = $doctor.package.packageFullName
            sandboxPackageVersion = $doctor.package.version
            cliVersion = $doctor.command.version
            guestFullBuild = $firstEvidence.guest.fullBuild
            guestDisplayVersion = $firstEvidence.guest.displayVersion
            guestEditionId = $firstEvidence.guest.editionId
            guestInstallationType = $firstEvidence.guest.installationType
            guestProductType = [long] $firstEvidence.guest.productType
            guestArchitecture = $firstEvidence.guest.architecture
            guestProcessArchitecture = $firstEvidence.guest.processArchitecture
            guestIntegrityLevel = ConvertTo-Cx004IntegrityAlias -Sid ([string] $firstEvidence.guest.integrity.sid)
            guestGroupCount = [long] @($firstEvidence.guest.groups).Count
            guestPrivilegeCount = [long] @($firstEvidence.guest.privileges).Count
            templateSha256 = $firstStage.TemplateSha256
            stableManifestSha256 = $firstStage.StableManifestSha256
            sessionRuns = [long] 2
            networkIsolation = $true
            inputMappingReadOnly = $true
            persistenceReset = $true
            hostSmokeOutcome = 'passed'
            requestedNetworking = 'disabled'
            requestedVGpu = 'disabled'
            requestedClipboard = 'disabled'
            requestedAudioInput = 'disabled'
            requestedVideoInput = 'disabled'
            requestedPrinter = 'disabled'
            requestedProtectedClient = 'enabled'
            requestedMemoryMiB = [long] 4096
        }
        $trackedReceipt = New-Cx004TrackedReceipt -LocalEvidenceBundleSha256 $closedBundle.sha256 -SemanticFacts $semanticFacts
        $trackedReceiptPath = Join-Path $bundleRoot.Root 'tracked-receipt.json'
        Write-Cx004JsonFile -LiteralPath $trackedReceiptPath -InputObject $trackedReceipt -Depth 16
    }

    return [ordered]@{
        outcome = $outcome
        scope = $script:Cx004Scope
        teardownLevel = if ($outcome -ceq 'passed') { $script:Cx004TeardownLevel } else { 'see-local-evidence' }
        localEvidenceBundleRoot = $bundleRoot.Root
        localEvidenceBundleManifestPath = $closedBundle.path
        localEvidenceBundleSha256 = $closedBundle.sha256
        trackedReceiptPath = $trackedReceiptPath
        trackedReceipt = $trackedReceipt
        error = $errorFact
    }
}

Export-ModuleMember -Function @(
    'Assert-Cx004NoRunningSessions',
    'ConvertTo-Cx004IntegrityAlias',
    'ConvertFrom-Cx004WsbListRaw',
    'ConvertFrom-Cx004WsbStartRaw',
    'ConvertFrom-Cx004WsbStopRaw',
    'Get-Cx004HostDoctor',
    'Get-Cx004WsbListReceipt',
    'Invoke-Cx004Q0S',
    'New-Cx004TrackedReceipt',
    'Render-Cx004SandboxConfig'
)
