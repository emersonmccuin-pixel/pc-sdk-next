#requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:AssertionCount = 0

function Assert-Cx004True {
    param(
        [Parameter(Mandatory)]
        [bool]$Condition,

        [Parameter(Mandatory)]
        [string]$Message
    )

    $script:AssertionCount += 1
    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

function Assert-Cx004Equal {
    param(
        [AllowNull()]
        [object]$Actual,

        [AllowNull()]
        [object]$Expected,

        [Parameter(Mandatory)]
        [string]$Message
    )

    Assert-Cx004True -Condition ($Actual -ceq $Expected) `
        -Message "$Message (expected '$Expected', got '$Actual')"
}

function Assert-Cx004Matches {
    param(
        [Parameter(Mandatory)]
        [string]$Actual,

        [Parameter(Mandatory)]
        [string]$Pattern,

        [Parameter(Mandatory)]
        [string]$Message
    )

    Assert-Cx004True -Condition ([regex]::IsMatch($Actual, $Pattern)) -Message $Message
}

function Assert-Cx004NotMatches {
    param(
        [Parameter(Mandatory)]
        [string]$Actual,

        [Parameter(Mandatory)]
        [string]$Pattern,

        [Parameter(Mandatory)]
        [string]$Message
    )

    Assert-Cx004True -Condition (-not [regex]::IsMatch($Actual, $Pattern)) -Message $Message
}

function Assert-Cx004Throws {
    param(
        [Parameter(Mandatory)]
        [scriptblock]$Action,

        [Parameter(Mandatory)]
        [string]$MessagePattern,

        [Parameter(Mandatory)]
        [string]$Message
    )

    $script:AssertionCount += 1
    try {
        $null = & $Action
    }
    catch {
        if ($_.Exception.Message -notmatch $MessagePattern) {
            throw "Assertion failed: $Message (unexpected error '$($_.Exception.Message)')"
        }
        return
    }

    throw "Assertion failed: $Message (no error was raised)"
}

function Get-Cx004RequiredFile {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    Assert-Cx004True -Condition (Test-Path -LiteralPath $Path -PathType Leaf) `
        -Message "required file is missing: $Path"
    return (Get-Item -LiteralPath $Path -Force)
}

function Assert-Cx004PowerShellParses {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(
        $Path,
        [ref]$tokens,
        [ref]$parseErrors
    )

    Assert-Cx004Equal -Actual $parseErrors.Count -Expected 0 `
        -Message "PowerShell parser errors in $Path"
}

function Get-Cx004FunctionSource {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$Name
    )

    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $Path,
        [ref]$tokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -ne 0) {
        throw "Cannot inspect function '$Name' because '$Path' does not parse."
    }

    $matches = @($ast.FindAll({
        param($candidate)
        $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $candidate.Name -ceq $Name
    }, $true))
    Assert-Cx004Equal -Actual $matches.Count -Expected 1 `
        -Message "source must define function $Name exactly once"
    return $matches[0].Extent.Text
}

function Get-Cx004CommandCallFacts {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$CommandName
    )

    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $Path,
        [ref]$tokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -ne 0) {
        throw "Cannot inspect command '$CommandName' because '$Path' does not parse."
    }

    $calls = @($ast.FindAll({
        param($candidate)
        $candidate -is [System.Management.Automation.Language.CommandAst] -and
            $candidate.GetCommandName() -ceq $CommandName
    }, $true))
    foreach ($call in $calls) {
        $owner = $call.Parent
        while ($null -ne $owner -and
            $owner -isnot [System.Management.Automation.Language.FunctionDefinitionAst]) {
            $owner = $owner.Parent
        }
        [pscustomobject]@{
            FunctionName = if ($null -ne $owner) { $owner.Name } else { $null }
            Text = $call.Extent.Text
            NormalizedText = (($call.Extent.Text -replace '(?m)`\r?\n', ' ') -replace '\s+', ' ').Trim()
        }
    }
}

function Invoke-Cx004ExtractedFunction {
    param(
        [Parameter(Mandatory)]
        [string]$FunctionSource,

        [Parameter(Mandatory)]
        [string]$Invocation
    )

    $fixture = [scriptblock]::Create("$FunctionSource`n$Invocation")
    return & $fixture
}

function Invoke-Cx004BoundedTestProcess {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,

        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [int]$TimeoutMilliseconds = 15000,

        [int]$MaximumCharacters = 65536
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "Failed to start bounded test process '$FilePath'."
        }

        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            $process.Kill($true)
            $process.WaitForExit()
            throw "Bounded test process '$FilePath' exceeded its deadline."
        }

        $null = [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 5000)
        $stdout = [string]$stdoutTask.Result
        $stderr = [string]$stderrTask.Result
        if ($stdout.Length -gt $MaximumCharacters -or $stderr.Length -gt $MaximumCharacters) {
            throw "Bounded test process '$FilePath' exceeded its output cap."
        }

        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout
            Stderr = $stderr
        }
    }
    finally {
        $process.Dispose()
    }
}

function Assert-Cx004SourceOrder {
    param(
        [Parameter(Mandatory)]
        [string]$Source,

        [Parameter(Mandatory)]
        [string[]]$Markers,

        [Parameter(Mandatory)]
        [string]$Message
    )

    $cursor = -1
    foreach ($marker in $Markers) {
        $next = $Source.IndexOf($marker, $cursor + 1, [System.StringComparison]::OrdinalIgnoreCase)
        Assert-Cx004True -Condition ($next -gt $cursor) `
            -Message "$Message (missing or out-of-order marker '$marker')"
        $cursor = $next
    }
}

function Get-Cx004PropertyNamesRecursive {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value -or $Value -is [string] -or $Value.GetType().IsValueType) {
        return @()
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $result = @()
        foreach ($key in $Value.Keys) {
            $result += [string]$key
            $result += Get-Cx004PropertyNamesRecursive -Value $Value[$key]
        }
        return $result
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        $result = @()
        foreach ($item in $Value) {
            $result += Get-Cx004PropertyNamesRecursive -Value $item
        }
        return $result
    }

    $result = @()
    foreach ($property in $Value.PSObject.Properties) {
        $result += $property.Name
        $result += Get-Cx004PropertyNamesRecursive -Value $property.Value
    }
    return $result
}

$labRoot = Split-Path -Parent $PSScriptRoot
$sandboxRoot = Join-Path $labRoot 'sandbox'
$templatePath = Join-Path $sandboxRoot 'sandbox.template.wsb'
$modulePath = Join-Path $sandboxRoot 'Cx004Sandbox.psm1'
$entrypointPath = Join-Path $sandboxRoot 'Invoke-Cx004Q0S.ps1'
$bootstrapPath = Join-Path $sandboxRoot 'guest-bootstrap.ps1'
$probePath = Join-Path $sandboxRoot 'guest-probe.ps1'

$requiredFiles = @(
    (Get-Cx004RequiredFile -Path $templatePath),
    (Get-Cx004RequiredFile -Path $modulePath),
    (Get-Cx004RequiredFile -Path $entrypointPath),
    (Get-Cx004RequiredFile -Path $bootstrapPath),
    (Get-Cx004RequiredFile -Path $probePath)
)

foreach ($scriptFile in $requiredFiles | Where-Object Extension -In @('.ps1', '.psm1')) {
    Assert-Cx004PowerShellParses -Path $scriptFile.FullName
}

$templateRaw = Get-Content -LiteralPath $templatePath -Raw
$moduleRaw = Get-Content -LiteralPath $modulePath -Raw
$entrypointRaw = Get-Content -LiteralPath $entrypointPath -Raw
$bootstrapRaw = Get-Content -LiteralPath $bootstrapPath -Raw
$probeRaw = Get-Content -LiteralPath $probePath -Raw
$hostHarnessRaw = "$moduleRaw`n$entrypointRaw"
$guestScriptRaw = "$bootstrapRaw`n$probeRaw"

# The tracked template is stable. Only the two canonical host paths are rendered.
$placeholderMatches = @([regex]::Matches($templateRaw, '\{\{[A-Z0-9_]+\}\}'))
Assert-Cx004Equal -Actual $placeholderMatches.Count -Expected 2 `
    -Message 'the template must contain exactly two substitutions'
Assert-Cx004Equal -Actual $placeholderMatches[0].Value -Expected '{{INPUT_HOST_PATH}}' `
    -Message 'the first template substitution must be the input host path'
Assert-Cx004Equal -Actual $placeholderMatches[1].Value -Expected '{{OUTPUT_HOST_PATH}}' `
    -Message 'the second template substitution must be the output host path'
Assert-Cx004Equal -Actual ([regex]::Matches($templateRaw, '\{\{INPUT_HOST_PATH\}\}').Count) -Expected 1 `
    -Message 'the input host path substitution must occur exactly once'
Assert-Cx004Equal -Actual ([regex]::Matches($templateRaw, '\{\{OUTPUT_HOST_PATH\}\}').Count) -Expected 1 `
    -Message 'the output host path substitution must occur exactly once'
Assert-Cx004NotMatches -Actual $templateRaw -Pattern '(?i)\b(runId|challenge|sessionId)\b' `
    -Message 'dynamic run identity must not be embedded in the stable template'

[xml]$templateXml = $templateRaw
$configuration = $templateXml.SelectSingleNode('/Configuration')
Assert-Cx004True -Condition ($null -ne $configuration) -Message 'template root must be Configuration'
foreach ($element in @($templateXml.SelectNodes('//*'))) {
    Assert-Cx004Equal -Actual $element.Attributes.Count -Expected 0 `
        -Message "template element $($element.Name) must not carry undeclared attributes"
}

$expectedConfigurationElements = @(
    'AudioInput',
    'ClipboardRedirection',
    'LogonCommand',
    'MappedFolders',
    'MemoryInMB',
    'Networking',
    'PrinterRedirection',
    'ProtectedClient',
    'vGPU',
    'VideoInput'
)
$actualConfigurationElements = @(
    $configuration.ChildNodes |
        Where-Object NodeType -EQ ([System.Xml.XmlNodeType]::Element) |
        ForEach-Object Name |
        Sort-Object
)
Assert-Cx004Equal -Actual ($actualConfigurationElements -join ',') `
    -Expected ($expectedConfigurationElements -join ',') `
    -Message 'template must contain only the sealed top-level configuration elements'

$requiredSettings = [ordered]@{
    vGPU = 'Disable'
    Networking = 'Disable'
    AudioInput = 'Disable'
    VideoInput = 'Disable'
    PrinterRedirection = 'Disable'
    ClipboardRedirection = 'Disable'
    ProtectedClient = 'Enable'
    MemoryInMB = '4096'
}
foreach ($setting in $requiredSettings.GetEnumerator()) {
    $nodes = @($templateXml.SelectNodes("/Configuration/$($setting.Key)"))
    Assert-Cx004Equal -Actual $nodes.Count -Expected 1 `
        -Message "template setting $($setting.Key) must occur exactly once"
    Assert-Cx004Equal -Actual $nodes[0].InnerText.Trim() -Expected $setting.Value `
        -Message "template setting $($setting.Key) must use the sealed value"
}

$expectedLogonCommand = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\CX004\input\guest-bootstrap.ps1'
$logonNodes = @($templateXml.SelectNodes('/Configuration/LogonCommand/Command'))
Assert-Cx004Equal -Actual $logonNodes.Count -Expected 1 `
    -Message 'template must contain exactly one LogonCommand Command'
$logonChildren = @(
    $templateXml.SelectSingleNode('/Configuration/LogonCommand').ChildNodes |
        Where-Object NodeType -EQ ([System.Xml.XmlNodeType]::Element)
)
Assert-Cx004Equal -Actual $logonChildren.Count -Expected 1 `
    -Message 'LogonCommand must contain no element except the fixed Command'
Assert-Cx004Equal -Actual $logonNodes[0].InnerText.Trim() -Expected $expectedLogonCommand `
    -Message 'LogonCommand must be the fixed absolute guest bootstrap invocation'

$mappedFolderContainerChildren = @(
    $templateXml.SelectSingleNode('/Configuration/MappedFolders').ChildNodes |
        Where-Object NodeType -EQ ([System.Xml.XmlNodeType]::Element)
)
Assert-Cx004Equal -Actual $mappedFolderContainerChildren.Count -Expected 2 `
    -Message 'MappedFolders must contain exactly two child elements'
Assert-Cx004True -Condition (@($mappedFolderContainerChildren | Where-Object Name -CNE 'MappedFolder').Count -eq 0) `
    -Message 'MappedFolders may contain only MappedFolder elements'
$mappedFolders = @($templateXml.SelectNodes('/Configuration/MappedFolders/MappedFolder'))
Assert-Cx004Equal -Actual $mappedFolders.Count -Expected 2 `
    -Message 'template must contain exactly two mapped folders'

$expectedMappings = @(
    [ordered]@{
        HostFolder = '{{INPUT_HOST_PATH}}'
        SandboxFolder = 'C:\CX004\input'
        ReadOnly = 'true'
    },
    [ordered]@{
        HostFolder = '{{OUTPUT_HOST_PATH}}'
        SandboxFolder = 'C:\CX004\output'
        ReadOnly = 'false'
    }
)

for ($index = 0; $index -lt $mappedFolders.Count; $index += 1) {
    $mapping = $mappedFolders[$index]
    $mappingElements = @(
        $mapping.ChildNodes |
            Where-Object NodeType -EQ ([System.Xml.XmlNodeType]::Element) |
            ForEach-Object Name |
            Sort-Object
    )
    Assert-Cx004Equal -Actual ($mappingElements -join ',') `
        -Expected 'HostFolder,ReadOnly,SandboxFolder' `
        -Message "mapping $index must contain only HostFolder, SandboxFolder, and ReadOnly"

    foreach ($field in @('HostFolder', 'SandboxFolder', 'ReadOnly')) {
        $fieldNodes = @($mapping.SelectNodes($field))
        Assert-Cx004Equal -Actual $fieldNodes.Count -Expected 1 `
            -Message "mapping $index field $field must occur exactly once"
        Assert-Cx004Equal -Actual $fieldNodes[0].InnerText.Trim() `
            -Expected $expectedMappings[$index][$field] `
            -Message "mapping $index field $field must use the sealed value"
    }
}

# Stable guest scripts consume the dynamic run manifest; they are not rendered per run.
foreach ($guestSource in @($bootstrapRaw, $probeRaw)) {
    Assert-Cx004Matches -Actual $guestSource `
        -Pattern '(?m)^\s*\$script:Cx004SchemaVersion\s*=\s*''cx004-q0s-v1''\s*$' `
        -Message 'each fixed guest script must pin the Q0S schema version'
    Assert-Cx004NotMatches -Actual $guestSource -Pattern '\{\{[A-Z0-9_]+\}\}' `
        -Message 'guest script bytes must not contain render-time substitutions'
    Assert-Cx004NotMatches -Actual $guestSource `
        -Pattern '(?i)[A-F0-9]{8}-[A-F0-9]{4}-[1-5][A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}' `
        -Message 'guest script bytes must not pin a per-run GUID'
    Assert-Cx004NotMatches -Actual $guestSource -Pattern '(?i)C:\\Users\\|E:\\Claude Code Projects' `
        -Message 'guest script bytes must not contain a host profile or repository path'
}
Assert-Cx004Matches -Actual $guestScriptRaw -Pattern '(?i)run-manifest\.json' `
    -Message 'fixed guest scripts must consume the separate dynamic run manifest'
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?m)^\$buildNumber\s*=\s*\[string\]\$windows\.CurrentBuildNumber\s*$' `
    -Message 'guest buildNumber must remain a JSON string compatible with the strict host schema'
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?m)^\$guestArchitecture\s*=\s*''AMD64''\s*$' `
    -Message 'guest OS architecture must be normalized to the admitted AMD64 semantic value'
Assert-Cx004NotMatches -Actual $probeRaw -Pattern '\.OSArchitecture' `
    -Message 'localized Win32_OperatingSystem architecture text must not enter the sealed guest schema'
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?m)^\$integrityAlias\s*=\s*ConvertTo-Cx004IntegrityAlias\s+-Sid\s+\$integrityGroups\[0\]\.sid\s*$' `
    -Message 'guest integrity alias must be derived only from the mandatory-label SID'
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?m)^\s*integrityLevel\s*=\s*\$integrityAlias\s*$' `
    -Message 'safe terminal identity must publish only the normalized integrity-level alias'

# The host harness has one CLI path and cannot grow an arbitrary post-start interface.
Assert-Cx004NotMatches -Actual $hostHarnessRaw `
    -Pattern '(?im)(?:Get-Command|Start-Process)\b[^\r\n]{0,160}WindowsSandbox\.exe' `
    -Message 'legacy WindowsSandbox.exe must not be a resolved or launched fallback'
Assert-Cx004NotMatches -Actual $hostHarnessRaw `
    -Pattern '(?im)&\s*(?:\([^\r\n]{0,80})?[^\r\n]{0,80}WindowsSandbox\.exe' `
    -Message 'legacy WindowsSandbox.exe must never be directly invoked'
Assert-Cx004NotMatches -Actual $hostHarnessRaw -Pattern '(?i)[''"](?:exec|share)[''"]' `
    -Message 'the harness must not construct exec or share CLI verbs'
Assert-Cx004NotMatches -Actual $hostHarnessRaw `
    -Pattern '(?im)\bwsb(?:\.exe)?\b[^\r\n]{0,160}\b(?:exec|share)\b' `
    -Message 'the harness must not invoke wsb exec or wsb share'
Assert-Cx004NotMatches -Actual $hostHarnessRaw -Pattern '(?i)Invoke-Expression|ScriptBlock\s*::\s*Create' `
    -Message 'the harness must not expose dynamic command evaluation'

$nativeWsbCalls = @(Get-Cx004CommandCallFacts -Path $modulePath -CommandName 'Invoke-Cx004WsbNative')
Assert-Cx004Equal -Actual $nativeWsbCalls.Count -Expected 5 `
    -Message 'the module AST must contain exactly the five reviewed direct wsb call sites'
$expectedNativeWsbCalls = @(
    [pscustomobject]@{
        FunctionName = 'Get-Cx004HostDoctor'
        Text = 'Invoke-Cx004WsbNative -WsbPath $expectedAlias -Arguments @(''--version'') -TimeoutSeconds 30'
    },
    [pscustomobject]@{
        FunctionName = 'Get-Cx004WsbListReceipt'
        Text = 'Invoke-Cx004WsbNative -WsbPath $WsbPath -Arguments @(''list'', ''--raw'') -TimeoutSeconds 30'
    },
    [pscustomobject]@{
        FunctionName = 'Invoke-Cx004SandboxSession'
        Text = 'Invoke-Cx004WsbNative -WsbPath $WsbPath -Arguments @(''start'', ''--config'', $Stage.RenderedConfig, ''--raw'') -TimeoutSeconds 120'
    },
    [pscustomobject]@{
        FunctionName = 'Invoke-Cx004SandboxSession'
        Text = 'Invoke-Cx004WsbNative -WsbPath $WsbPath -Arguments @(''connect'', ''--id'', $sessionId, ''--raw'') -TimeoutSeconds 120'
    },
    [pscustomobject]@{
        FunctionName = 'Invoke-Cx004SandboxSession'
        Text = 'Invoke-Cx004WsbNative -WsbPath $WsbPath -Arguments @(''stop'', ''--id'', $sessionId, ''--raw'') -TimeoutSeconds 60'
    }
)
foreach ($expectedCall in $expectedNativeWsbCalls) {
    $matches = @($nativeWsbCalls | Where-Object {
        $_.FunctionName -ceq $expectedCall.FunctionName -and
            $_.NormalizedText -ceq $expectedCall.Text
    })
    Assert-Cx004Equal -Actual $matches.Count -Expected 1 `
        -Message "reviewed wsb call must occur exactly once in $($expectedCall.FunctionName): $($expectedCall.Text)"
}
$directBoundedWsbCalls = @(Get-Cx004CommandCallFacts -Path $modulePath -CommandName 'Invoke-Cx004BoundedNative' |
    Where-Object { $_.NormalizedText -match '(?i)-ExecutablePath\s+\$WsbPath(?:\s|$)' })
Assert-Cx004Equal -Actual $directBoundedWsbCalls.Count -Expected 1 `
    -Message 'only one direct bounded-native call may receive the sealed wsb path'
Assert-Cx004Equal -Actual $directBoundedWsbCalls[0].FunctionName -Expected 'Invoke-Cx004WsbNative' `
    -Message 'every wsb process launch must pass through the alias-binding wrapper'
Assert-Cx004NotMatches -Actual $moduleRaw `
    -Pattern '(?m)Invoke-Cx004WsbNative\s+-WsbPath\s+\$WsbPath\s+-Arguments\s+@\(''start'',\s*''--config'',\s*\$Stage\.RenderedConfigPath\b' `
    -Message 'modern wsb start must receive the exact XML argument, never a .wsb filesystem path'
# Every native process, including doctor observations and source-seal Git reads, is
# launched by the one bounded process runner. Bare invocation would reintroduce
# unbounded output allocation and an unbounded wait.
foreach ($bareNativePattern in @(
    '(?im)&\s+\$WsbPath\b',
    '(?im)&\s+\$command\.Source\b',
    '(?im)&\s+\$doctor\.command\.source\b',
    '(?im)&\s+\$vswherePath\b',
    '(?im)&\s+\$cscPath\b',
    '(?im)&\s+\$assemblyPath\b',
    '(?im)&\s+git\b'
)) {
    Assert-Cx004NotMatches -Actual $hostHarnessRaw -Pattern $bareNativePattern `
        -Message 'host harness must not contain a bare native-process invocation'
}
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?:System\.Diagnostics\.)?ProcessStartInfo' `
    -Message 'the host harness must use ProcessStartInfo for bounded native launches'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)\.ArgumentList\.Add\(' `
    -Message 'native arguments must be added without shell parsing'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)RedirectStandardOutput\s*=\s*(?:\$true|true)' `
    -Message 'bounded native launches must capture stdout'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)RedirectStandardError\s*=\s*(?:\$true|true)' `
    -Message 'bounded native launches must capture stderr separately'
Assert-Cx004NotMatches -Actual $moduleRaw -Pattern '(?i)\.ReadToEnd(?:Async)?\(' `
    -Message 'native output must be capped while streaming, before unbounded allocation'
foreach ($nativeFailureMarker in @(
    'native-process-timeout',
    'native-output-overflow',
    'native-stdout-overflow',
    'native-stderr-overflow'
)) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($nativeFailureMarker)) `
        -Message "bounded native runner must retain typed marker $nativeFailureMarker"
}
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)\.Kill\((?:false|\$false)\)' `
    -Message 'timeout or overflow may kill only the one retained native process'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)(?:Timeout(?:Milli)?Seconds|Deadline)' `
    -Message 'each bounded native launch must carry a finite deadline'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)Max(?:imum)?(?:Stdout|Output)Bytes' `
    -Message 'each bounded native launch must carry a stdout byte cap'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)Max(?:imum)?StderrBytes' `
    -Message 'each bounded native launch must carry a stderr byte cap'

# Scrubbed native launches rebuild the minimum environment from OS-known
# folders. User-controlled inherited ProgramData and language values must not
# influence Git, Sandbox, doctor, or compiler observations.
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern '(?is)Environment\.GetFolderPath\(Environment\.SpecialFolder\.CommonApplicationData\).*start\.Environment\.Clear\(\).*start\.Environment\["ProgramData"\]\s*=\s*programData.*start\.Environment\["VSLANG"\]\s*=\s*"1033"' `
    -Message 'scrubbed native launches must rebuild ProgramData from the OS-known CommonApplicationData folder and pin VSLANG 1033'
Assert-Cx004NotMatches -Actual $moduleRaw `
    -Pattern '(?i)(?:\$env:ProgramData|GetEnvironmentVariable\(\s*["'']ProgramData["'']\s*\))' `
    -Message 'scrubbed native launches must not trust inherited ProgramData'

foreach ($requiredConstant in @(
    'cx004-q0s-v1',
    'runner-readiness-only',
    'sandbox-session-stopped',
    'host-smoke-only',
    'localEvidenceBundleSha256',
    'preexisting-running-session'
)) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($requiredConstant)) `
        -Message "module must retain source-visible contract marker $requiredConstant"
}

# The qualification root is derived from the OS known folder, never from a
# mutable environment value, and is created/reproved as one private evidence
# bundle whose children contain both session stages.
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern '(?i)Environment\]::GetFolderPath\([^\r\n]*SpecialFolder\]::LocalApplicationData' `
    -Message 'qualification storage must derive LocalApplicationData from the OS known-folder API'
Assert-Cx004NotMatches -Actual $moduleRaw `
    -Pattern '(?im)(?:RunsRoot|QualificationRoot|BundleRoot)[^\r\n=]*=\s*[^\r\n]*\$env:LOCALAPPDATA' `
    -Message 'a mutable LOCALAPPDATA environment value must not select qualification storage'
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern '(?i)(?:qualification-root-overlap|unsafe-(?:qualification|evidence|bundle)-root-overlap)' `
    -Message 'any qualification-root overlap must fail with one typed marker'
foreach ($overlapBoundary in @(
    'PC_DATA_DIR',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    '.codex',
    '.claude'
)) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($overlapBoundary)) `
        -Message "qualification-root overlap checks must cover $overlapBoundary"
}
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern '(?im)(?:Join-Path[^\r\n]+\$(?:Repo|Repository)Root[^\r\n]+(?:''|")data(?:''|")|repo-data)' `
    -Message 'qualification-root overlap checks must cover the repository data directory'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)SetAccessRuleProtection\(\$true,\s*\$false\)' `
    -Message 'qualification root ACL inheritance must be disabled'
$privateAclPatterns = [ordered]@{
    currentUser = '(?i)(?:WindowsIdentity\]::GetCurrent|currentUser)'
    system = '(?i)(?:S-1-5-18|LocalSystemSid)'
    administrators = '(?i)(?:S-1-5-32-544|BuiltinAdministratorsSid)'
    accessRule = '(?i)FileSystemAccessRule'
    fullControl = '(?i)FullControl'
    reproof = '(?i)Get-Acl'
}
foreach ($privateAclPattern in $privateAclPatterns.GetEnumerator()) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern $privateAclPattern.Value `
        -Message "private qualification root must establish and reprove ACL role $($privateAclPattern.Key)"
}
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)session-?1' `
    -Message 'one evidence bundle must contain a distinct first-session directory'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)session-?2' `
    -Message 'one evidence bundle must contain a distinct second-session directory'

# The modern execution alias is bound to one exact Store package, its manifest,
# block map, and AppX signature. Packaged roles are block-map-bound rather than
# incorrectly required to carry individual Authenticode signatures.
foreach ($identityMarker in @(
    'MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy',
    'MicrosoftWindows.WindowsSandbox',
    'MicrosoftWindows.WindowsSandbox_0.5.3.0_x64__cw5n1h2txyewy',
    'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
    'Microsoft\WindowsApps\wsb.exe',
    'AppExecutionAlias',
    'SignatureKind',
    'Store',
    'Status',
    'Ok',
    'AppxManifest.xml',
    'AppxBlockMap.xml',
    'AppxSignature.p7x',
    'System32\WindowsSandbox.exe',
    'WindowsSandboxServer.exe',
    'WindowsSandboxRemoteSession.exe',
    'WindowsSandboxRemoteSession.dll',
    'wsb.dll'
)) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($identityMarker)) `
        -Message "Sandbox identity proof must retain marker $identityMarker"
}
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern '(?i)(?:sandbox-package-surface-missing|missing-(?:package-|block-map-)?role|(?:package|block-map)-role-missing|required-package-file-missing)' `
    -Message 'an omitted declared package role must fail closed'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)sandbox-blockmap-mismatch' `
    -Message 'a package role absent from or mismatched with the AppX block map must fail closed'
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern ([regex]::Escape('package-bound-by-valid-appx-signature-and-blockmap')) `
    -Message 'packaged executable roles must use the canonical AppX/block-map binding disposition'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)NotSigned' `
    -Message 'packaged roles must explicitly preserve their observed NotSigned Authenticode status'
Assert-Cx004Matches -Actual $moduleRaw -Pattern '(?i)(?:Microsoft Windows|Microsoft Corporation)' `
    -Message 'Sandbox signatures must be pinned to a Microsoft signer identity'
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern '(?im)Get-Command\s+(?:-Name\s+)?(?:''|")?wsb\.exe(?:''|")?[^\r\n]*-All' `
    -Message 'doctor must enumerate every wsb.exe resolution before requiring one canonical alias'
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern '(?i)only resolved wsb command is not the canonical per-user AppExecutionAlias' `
    -Message 'doctor must reject any noncanonical or ambiguous PATH alias result'

# The caller pins the landed S0 commit/tree, and the seal is re-proved around
# every point where newly observed or executable bytes could otherwise drift.
foreach ($pinnedName in @('ExpectedS0Commit', 'ExpectedS0Tree')) {
    Assert-Cx004Matches -Actual $moduleRaw `
        -Pattern ("(?im)\[Parameter\([^\)]*Mandatory[^\)]*\)\][^\r\n]*\[string\]\s*\$" + $pinnedName) `
        -Message "Q0S module must require caller-pinned $pinnedName"
    Assert-Cx004Matches -Actual $entrypointRaw `
        -Pattern ("(?im)\[ValidatePattern\([^\r\n]+\)\]\s*\r?\n\s*\[string\]\s*\$" + $pinnedName) `
        -Message "Q0S entrypoint must type-check caller-pinned $pinnedName"
}
Assert-Cx004Matches -Actual $entrypointRaw `
    -Pattern '(?is)[''"]Run[''"]\s*\{.*IsNullOrWhiteSpace\(\$ExpectedS0Commit\).*IsNullOrWhiteSpace\(\$ExpectedS0Tree\)' `
    -Message 'Run mode must reject omission of either caller-pinned S0 identity'
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern ([regex]::Escape('https://github.com/emersonmccuin-pixel/pc-sdk-next.git')) `
    -Message 'source seal must require the one canonical origin URL'
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern 'docs[\\/]execution[\\/]manifests[\\/]CX-004-sandbox-runner\.json' `
    -Message 'source seal must bind the tracked runner source manifest'
foreach ($sourceSealBinding in @(
    'ExpectedS0Commit',
    'ExpectedS0Tree',
    'origin/main',
    'source-worktree-byte-mismatch',
    'sha256',
    'blob'
)) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($sourceSealBinding)) `
        -Message "source seal must bind $sourceSealBinding"
}

$sessionFunctionRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Invoke-Cx004SandboxSession'
$q0sFunctionRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Invoke-Cx004Q0S'
$guestValidatorRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Test-Cx004GuestOutput'
$stageFunctionRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'New-Cx004RunStage'
$bundleCloserRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Close-Cx004EvidenceBundle'
$bundleInventoryRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004BundleInventory'
$boundedDirectoryItemsRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004BoundedDirectoryItems'
$physicalPathRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Resolve-Cx004PhysicalPath'
$pathOverlapRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Test-Cx004PathOverlap'
$protectedRootsRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004ProtectedRoots'
$wsbAliasBindingRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004WsbAliasBinding'
$wsbNativeRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Invoke-Cx004WsbNative'
$wsbNativeEnvelopeRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Assert-Cx004WsbNativeEnvelope'
$wsbNativeCompleteRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Assert-Cx004WsbNativeComplete'
$wsbConnectNativeCompleteRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Assert-Cx004WsbConnectNativeComplete'
$wsbListReceiptRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004WsbListReceipt'
$sessionListWaitRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Wait-Cx004SessionListState'
$hostCanaryCompleteRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Complete-Cx004HostCanary'
$gitIdentityRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004GitIdentity'
$gitPathRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004GitPath'
$gitInvokeRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Invoke-Cx004Git'
$sourceSealFunctionRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004SourceSeal'
$guestTerminalWaitRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Wait-Cx004GuestTerminalFiles'
$networkFailureDispositionRaw = Get-Cx004FunctionSource -Path $probePath -Name 'Get-Cx004NetworkFailureDisposition'
$boundedUtf8Raw = Get-Cx004FunctionSource -Path $modulePath -Name 'Read-Cx004BoundedUtf8File'
$boundedOutputSetRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Read-Cx004BoundedOutputSet'
$namedFileSetSnapshotRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004NamedFileSetSnapshot'
$roslynClosureSnapshotRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004RoslynClosureSnapshot'
$snapshotUnchangedRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Assert-Cx004SnapshotUnchanged'
$hostSmokeFunctionRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Invoke-Cx004HostSmoke'
$hostDoctorRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Get-Cx004HostDoctor'
$positiveIntegrityRaw = Get-Cx004FunctionSource -Path $modulePath -Name 'Test-Cx004PositiveIntegrityError'

$readFinalPathMatch = [regex]::Match(
    $moduleRaw,
    '(?is)private\s+static\s+string\s+ReadFinalPath\s*\([^)]*\).*?(?=\r?\n\s*public\s+static\s+Cx004BoundedFileRead\s+ReadBoundedRegularFile)'
)
Assert-Cx004True -Condition $readFinalPathMatch.Success `
    -Message 'native helper must define exactly scoped final-path decoding before bounded regular-file reads'
$readFinalPathRaw = $readFinalPathMatch.Value
$boundedNativeReadMatch = [regex]::Match(
    $moduleRaw,
    '(?is)public\s+static\s+Cx004BoundedFileRead\s+ReadBoundedRegularFile\s*\([^)]*\).*?(?=\r?\n\s*public\s+static\s+Cx004AppExecLinkIdentity\s+ReadAppExecLink)'
)
Assert-Cx004True -Condition $boundedNativeReadMatch.Success `
    -Message 'native helper must define one scoped bounded regular-file read primitive'
$boundedNativeReadRaw = $boundedNativeReadMatch.Value
$resolveFinalPathMatch = [regex]::Match(
    $moduleRaw,
    '(?is)public\s+static\s+string\s+ResolveFinalPath\s*\([^)]*\).*?(?=\r?\n\s*}\s*\r?\n''@)'
)
Assert-Cx004True -Condition $resolveFinalPathMatch.Success `
    -Message 'native helper must define one scoped physical final-path resolver'
$resolveFinalPathNativeRaw = $resolveFinalPathMatch.Value

# Qualification-root overlap is a physical-path decision. Resolve the deepest
# existing ancestor through a handle (following junctions), then append only
# the not-yet-existing leaves before comparing both sides.
foreach ($physicalPathMarker in @(
    'missingLeaves',
    'while (-not (Test-Path -LiteralPath $cursor))',
    'ResolveFinalPath',
    'Combine'
)) {
    Assert-Cx004Matches -Actual $physicalPathRaw -Pattern ([regex]::Escape($physicalPathMarker)) `
        -Message "physical path resolution must retain marker $physicalPathMarker"
}
Assert-Cx004Matches -Actual $resolveFinalPathNativeRaw `
    -Pattern '(?is)CreateFileW\s*\(.*?OPEN_EXISTING\s*,\s*FILE_FLAG_BACKUP_SEMANTICS\s*,\s*IntPtr\.Zero\).*?return\s+ReadFinalPath\(handle\)' `
    -Message 'physical-path resolution must follow junctions through a final-path handle rather than open the reparse object itself'
Assert-Cx004NotMatches -Actual $resolveFinalPathNativeRaw `
    -Pattern 'FILE_FLAG_OPEN_REPARSE_POINT' `
    -Message 'physical overlap resolution must follow junctions rather than inspect the junction object'
Assert-Cx004Matches -Actual $readFinalPathRaw `
    -Pattern '(?is)GetFinalPathNameByHandleW\s*\(handle,\s*buffer,.*?length\s*==\s*0.*?length\s*>=\s*buffer\.Capacity' `
    -Message 'physical resolution must decode one bounded final path from the retained handle'
Assert-Cx004Equal -Actual ([regex]::Matches(
    $pathOverlapRaw,
    '(?i)Resolve-Cx004PhysicalPath'
).Count) -Expected 2 -Message 'path overlap must physically resolve both operands exactly once'
Assert-Cx004Matches -Actual $protectedRootsRaw `
    -Pattern '(?is)foreach\s*\(\$candidate.*Resolve-Cx004PhysicalPath\s+-LiteralPath' `
    -Message 'every repository, data, and provider-home protected root must be physically resolved'

# Post-stop JSON is retained through one native handle before allocation. The
# handle denies write/delete sharing, rejects directories/reparse points and
# hard links, binds the physical path, caps length before allocation, and
# proves exact EOF/length before strict UTF-8 decoding.
Assert-Cx004Matches -Actual $boundedNativeReadRaw `
    -Pattern '(?is)CreateFileW\s*\(\s*requestedPath,\s*GENERIC_READ\s*\|\s*FILE_READ_ATTRIBUTES,\s*FILE_SHARE_READ,\s*IntPtr\.Zero,\s*OPEN_EXISTING,\s*FILE_FLAG_OPEN_REPARSE_POINT\s*\|\s*FILE_FLAG_SEQUENTIAL_SCAN' `
    -Message 'bounded output reads must retain one read-only handle with no write/delete sharing and open reparse objects themselves'
Assert-Cx004NotMatches -Actual $boundedNativeReadRaw `
    -Pattern '(?is)CreateFileW\s*\([^;]+FILE_SHARE_(?:WRITE|DELETE)' `
    -Message 'bounded output handles must deny concurrent writes and deletes'
Assert-Cx004Matches -Actual $boundedNativeReadRaw `
    -Pattern '(?is)FileAttributes\s*&\s*\(FILE_ATTRIBUTE_DIRECTORY\s*\|\s*FILE_ATTRIBUTE_REPARSE_POINT\).*NumberOfLinks\s*!=\s*1' `
    -Message 'bounded output reads must require one regular non-reparse single-link file by retained-handle facts'
Assert-Cx004Matches -Actual $boundedNativeReadRaw `
    -Pattern '(?is)finalPath\s*=\s*ReadFinalPath\(handle\).*String\.Equals\(finalPath,\s*requestedPath,\s*StringComparison\.OrdinalIgnoreCase\)' `
    -Message 'bounded output reads must bind the retained handle to the exact requested physical path'
Assert-Cx004SourceOrder -Source $boundedNativeReadRaw -Markers @(
    'ulong length =',
    'length > (ulong)maximumBytes',
    'byte[] bytes = new byte[(int)length]',
    'new FileStream(handle',
    'while (offset < bytes.Length)',
    'EndOfStreamException',
    'stream.ReadByte() != -1',
    'stream.Length != (long)length'
) -Message 'bounded output length must be capped before allocation and fenced through exact EOF on the retained handle'
foreach ($boundedReadReceiptField in @('Bytes', 'Sha256', 'FinalPath', 'VolumeSerial', 'FileId', 'LinkCount')) {
    Assert-Cx004Matches -Actual $boundedNativeReadRaw -Pattern ([regex]::Escape($boundedReadReceiptField + ' =')) `
        -Message "bounded native read receipt must retain $boundedReadReceiptField"
}
Assert-Cx004Matches -Actual $boundedUtf8Raw `
    -Pattern '(?is)ReadBoundedRegularFile\s*\(.*?\$MaximumBytes' `
    -Message 'PowerShell output reader must delegate allocation and file identity to the native bounded-handle primitive'
foreach ($boundedUtf8Marker in @(
    '0xef',
    '0xbb',
    '0xbf',
    'output-utf8-bom',
    'output-nul-byte',
    'UTF8Encoding]::new($false, $true)',
    'invalid-output-utf8',
    'Get-Item -LiteralPath $LiteralPath -Stream *',
    'streams.Count -ne 1',
    ':$DATA',
    'bounded-output-read-unproven'
)) {
    Assert-Cx004Matches -Actual $boundedUtf8Raw -Pattern ([regex]::Escape($boundedUtf8Marker)) `
        -Message "bounded UTF-8 output reader must retain guard $boundedUtf8Marker"
}
Assert-Cx004NotMatches -Actual $boundedUtf8Raw `
    -Pattern '(?i)(?:ReadAllBytes|ReadAllText)' `
    -Message 'PowerShell output validation must not allocate file contents before the native cap'
Assert-Cx004Matches -Actual $boundedOutputSetRaw `
    -Pattern '(?is)foreach\s*\(\$phase\s+in\s+@\(''before'',\s*''after''\)\).*Get-Cx004BoundedDirectoryItems.*MaximumEntries\s*\(\[Math\]::Max\(1,\s*\$expected\.Count\s*\+\s*1\)\).*\(\$names\s+-join\s+"`n"\)\s+-cne\s+\(\$expected\s+-join\s+"`n"\)' `
    -Message 'bounded output-set reads must prove the exact closed directory surface before and after retained reads'
Assert-Cx004Matches -Actual $boundedOutputSetRaw `
    -Pattern '(?is)if\s*\(\$phase\s+-ceq\s+''before''\).*Read-Cx004BoundedUtf8File.*MaximumBytes\s+\$script:Cx004MaxJsonBytes' `
    -Message 'each declared output must use the one-MiB retained bounded read between surface fences'
foreach ($boundedSurfaceCode in @('unexpected-output-file', 'unexpected-output-object', 'oversized-output-file')) {
    Assert-Cx004Matches -Actual $boundedOutputSetRaw -Pattern ([regex]::Escape($boundedSurfaceCode)) `
        -Message "bounded output-set validation must retain typed surface code $boundedSurfaceCode"
}
Assert-Cx004Equal -Actual ([regex]::Matches(
    $guestValidatorRaw,
    '(?i)Read-Cx004BoundedOutputSet\s+-OutputPath'
).Count) -Expected 2 -Message 'guest validator must use bounded output sets for both failure and success surfaces'
Assert-Cx004NotMatches -Actual $guestValidatorRaw `
    -Pattern '(?i)\[System\.IO\.File\]::ReadAllText|\bReadAllText\s*\(' `
    -Message 'guest output validation must never ReadAllText before a byte cap'
Assert-Cx004Equal -Actual ([regex]::Matches(
    $sessionFunctionRaw,
    '(?i)Read-Cx004BoundedOutputSet\s+-OutputPath'
).Count) -Expected 2 -Message 'session must repeat a bounded output snapshot after both success and failure validation'
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?is)Kind\s+-ceq\s+''success''.*?Test-Cx004GuestOutput.*?Read-Cx004BoundedOutputSet.*?late-output-mutation.*?Kind\s+-ceq\s+''failure''.*?Test-Cx004GuestOutput.*?Read-Cx004BoundedOutputSet.*?late-output-mutation' `
    -Message 'success and failure output bytes must each be re-proved after semantic validation'

# The AppExecutionAlias is an executable binding, not merely a doctor-time
# observation. Re-prove its exact AppExecLink/package bytes before and after
# every native list/start/stop invocation and reject any drift.
foreach ($appExecBindingMarker in @(
    'ReadAppExecLink',
    '8000001b',
    'Version -ne 3',
    'Cx004ExpectedAppExecLinkSha256',
    'ExpectedSandboxPackageFamilyName)!AppCli',
    'expectedTarget',
    'ExpectedPackageHashes',
    'AppxSignature.p7x'
)) {
    Assert-Cx004Matches -Actual $wsbAliasBindingRaw -Pattern ([regex]::Escape($appExecBindingMarker)) `
        -Message "use-time AppExecLink proof must retain marker $appExecBindingMarker"
}
Assert-Cx004Matches -Actual $moduleRaw `
    -Pattern '(?m)^\s*\$script:Cx004ExpectedAppExecLinkSha256\s*=\s*''5509514b83bc86ecdf56618f2ee62f3f94d796d271a7c4bc2e287fcc5f152064''\s*$' `
    -Message 'the reviewed AppExecLink payload hash must remain exact'
Assert-Cx004Equal -Actual ([regex]::Matches(
    $wsbNativeRaw,
    '(?i)Get-Cx004WsbAliasBinding\s+-WsbPath'
).Count) -Expected 2 -Message 'every native wsb use must re-prove the alias binding before and after execution'
Assert-Cx004SourceOrder -Source $wsbNativeRaw -Markers @(
    '$bindingBefore = Get-Cx004WsbAliasBinding',
    'Invoke-Cx004BoundedNative',
    '$bindingAfter = Get-Cx004WsbAliasBinding',
    '$bindingStable =',
    'BindingBefore =',
    'BindingAfter ='
) -Message 'native wsb use must retain ordered before/after binding receipts and their equality proof'
Assert-Cx004Matches -Actual $wsbNativeRaw `
    -Pattern '(?is)\$bindingAfter\s*=\s*\$null\s*\r?\n\s*\$bindingAfterError\s*=\s*\$null\s*\r?\n\s*try\s*\{\s*\$bindingAfter\s*=\s*Get-Cx004WsbAliasBinding.*?catch\s*\{\s*\$bindingAfterError\s*=\s*\[ordered\]@\{\s*type\s*=.*?message\s*=.*?\}.*?\$bindingStable\s*=\s*\$null\s+-eq\s+\$bindingAfterError\s+-and.*?BindingAfterError\s*=\s*\$bindingAfterError' `
    -Message 'post-use AppExecLink reproof errors must be captured in the raw native receipt rather than discard PID/output evidence'
Assert-Cx004Matches -Actual $wsbNativeRaw `
    -Pattern '(?is)\$bindingStable\s*=\s*\$null\s+-eq\s+\$bindingAfterError\s+-and\s*\r?\n\s*\(ConvertTo-Cx004CanonicalJson\s+-InputObject\s+\$bindingBefore.*?\)\s+-ceq\s*\r?\n\s*\(ConvertTo-Cx004CanonicalJson\s+-InputObject\s+\$bindingAfter' `
    -Message 'AppExecLink binding stability must require no post-proof error and exact canonical before/after identity'
Assert-Cx004Matches -Actual $wsbNativeEnvelopeRaw `
    -Pattern '(?is)if\s*\(\s*-not\s+\$Receipt\.BindingStable\s*\).*wsb-alias-binding-drift' `
    -Message 'a changed or unproved post-use AppExecLink binding must fail closed'
foreach ($captureLifecycleMarker in @(
    'CaptureReadersSettled',
    'CaptureDiscarded',
    'CaptureFaulted',
    'CaptureCloseFaulted',
    'CaptureByteCountsAvailable',
    'CancellationTokenSource',
    'captureCancellation.Cancel()',
    'StandardOutput.Close()',
    'StandardError.Close()',
    'Interlocked.Read',
    'WaitForCaptureTasks'
)) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($captureLifecycleMarker)) `
        -Message "bounded native capture must retain lifecycle marker $captureLifecycleMarker"
}
Assert-Cx004Matches -Actual $wsbNativeCompleteRaw `
    -Pattern '(?is)Assert-Cx004WsbNativeEnvelope.*?-not\s+\$Receipt\.CaptureCompleted\s+-or\s+\$Receipt\.CaptureDiscarded' `
    -Message 'strict wsb operations must require settled EOF without discarded output'
foreach ($connectCaptureMarker in @(
    'Assert-Cx004WsbNativeEnvelope',
    'CaptureCompleted',
    'CaptureDiscarded',
    'CaptureReadersSettled',
    'ExitCode',
    'StderrBytes',
    'unknown-connect-result'
)) {
    Assert-Cx004Matches -Actual "$wsbNativeEnvelopeRaw`n$wsbConnectNativeCompleteRaw" `
        -Pattern ([regex]::Escape($connectCaptureMarker)) `
        -Message "connect capture classifier must retain marker $connectCaptureMarker"
}

# Source sealing uses one reviewed Git-for-Windows engine by exact path and
# byte identity. PATH discovery is forbidden, and each Git command re-proves
# the engine on both sides of execution.
foreach ($sealedGitConstantPattern in @(
    '(?m)^\s*\$script:Cx004ExpectedGitPath\s*=\s*''C:\\Program Files\\Git\\mingw64\\bin\\git\.exe''\s*$',
    '(?m)^\s*\$script:Cx004ExpectedGitSha256\s*=\s*''e996432581a70df2e7aaac5db71e3811ec0daa7f93a8ba73fe6db6f9941f4bf9''\s*$',
    '(?m)^\s*\$script:Cx004ExpectedGitLength\s*=\s*4284816L\s*$',
    '(?m)^\s*\$script:Cx004ExpectedGitVersion\s*=\s*''2\.51\.0\.windows\.2''\s*$',
    '(?m)^\s*\$script:Cx004ExpectedGitSignerSubject\s*=\s*''CN=Johannes Schindelin, O=Johannes Schindelin, S=Nordrhein-Westfalen, C=DE''\s*$',
    '(?m)^\s*\$script:Cx004ExpectedGitSignerThumbprint\s*=\s*''3EB14A3AEF84B7153E139397F0A49E2FAC662B0E''\s*$'
)) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern $sealedGitConstantPattern `
        -Message "sealed Git identity must retain exact constant pattern $sealedGitConstantPattern"
}
foreach ($gitIdentityMarker in @(
    'Assert-Cx004NoReparsePath',
    'Cx004ExpectedGitLength',
    'Cx004ExpectedGitVersion',
    'Cx004ExpectedGitSha256',
    "signature.status -cne 'Valid'",
    'Cx004ExpectedGitSignerSubject',
    'Cx004ExpectedGitSignerThumbprint',
    'git-identity-failed'
)) {
    Assert-Cx004Matches -Actual $gitIdentityRaw -Pattern ([regex]::Escape($gitIdentityMarker)) `
        -Message "Git identity proof must retain marker $gitIdentityMarker"
}
Assert-Cx004NotMatches -Actual "$gitPathRaw`n$gitInvokeRaw`n$sourceSealFunctionRaw" `
    -Pattern '(?im)Get-Command[^\r\n]*\bgit(?:\.exe)?\b' `
    -Message 'source sealing must never discover Git through PATH'
Assert-Cx004Equal -Actual ([regex]::Matches(
    $gitInvokeRaw,
    '(?i)Get-Cx004GitIdentity\s+-GitPath'
).Count) -Expected 2 -Message 'each Git command must re-prove the exact engine before and after native execution'
Assert-Cx004SourceOrder -Source $gitInvokeRaw -Markers @(
    '$identityBefore = Get-Cx004GitIdentity',
    'Invoke-Cx004BoundedNative',
    '$identityAfter = Get-Cx004GitIdentity',
    'ConvertTo-Cx004CanonicalJson -InputObject $identityBefore',
    'git-identity-failed'
) -Message 'Git engine before/after identity equality must be proved before accepting command output'
Assert-Cx004Matches -Actual $sourceSealFunctionRaw `
    -Pattern '(?i)git\s*=\s*Get-Cx004GitIdentity\s+-GitPath\s+\$gitPath' `
    -Message 'the source seal receipt must retain the final exact Git engine identity'
Assert-Cx004NotMatches -Actual $sourceSealFunctionRaw `
    -Pattern '(?im)Get-ChildItem[^\r\n]*-Recurse' `
    -Message 'source-seal surface discovery must not use recursive unbounded enumeration'
Assert-Cx004Matches -Actual $sourceSealFunctionRaw `
    -Pattern '(?is)foreach\s*\(\$sourceDirectory\s+in\s+@\(\s*\[ordered\]@\{\s*path\s*=.*?sandbox.*?maximumEntries\s*=\s*7\s*\},\s*\[ordered\]@\{\s*path\s*=.*?test.*?maximumEntries\s*=\s*3\s*\}\s*\)\).*?Get-Cx004BoundedDirectoryItems.*?-MaximumEntries\s+\$sourceDirectory\.maximumEntries' `
    -Message 'source seal must enumerate only the two flat harness directories at their exact closed bounds'
Assert-Cx004Matches -Actual $sourceSealFunctionRaw `
    -Pattern '(?is)\$item\.PSIsContainer.*FileAttributes\]::ReparsePoint.*unexpected-harness-source.*\$actualRelativePaths.*Sort-Object.*\$expectedRelativePaths\s*\|\s*Sort-Object' `
    -Message 'bounded source enumeration must reject directories/reparse points and equal the exact sorted allowlist'
Assert-Cx004Matches -Actual $sourceSealFunctionRaw `
    -Pattern '(?is)\[long\]\s*\$manifestFile\.length\s+-lt\s+1\s+-or\s+\[long\]\s*\$manifestFile\.length\s+-gt\s+4MB' `
    -Message 'each tracked source manifest length must stay within the four-MiB pre-allocation cap'
Assert-Cx004SourceOrder -Source $sourceSealFunctionRaw -Markers @(
    '$manifestFile.length -gt 4MB',
    '[Cx004NativeFileInfo]::ReadBoundedRegularFile($path, [int] $manifestFile.length)',
    '$sourceRead.Sha256',
    '$sourceRead.Bytes.Length',
    'Invoke-Cx004Git -GitPath $gitPath',
    "@('check-attr'",
    "@('ls-tree'"
) -Message 'each source must be retained under its manifest length before hash/length and Git blob/eol acceptance'

# Host-smoke compilation is a provider-free, sealed Roslyn invocation. Bind
# the exact 13-file runtime closure plus vswhere/csc/references/staged source,
# disable config/shared-server/implicit references, and re-prove all identities
# after compile and after controller execution.
$roslynClosureConstantMatch = [regex]::Match(
    $moduleRaw,
    '(?is)\$script:Cx004ExpectedRoslynClosure\s*=\s*\[ordered\]@\{(?<body>.*?)\r?\n\}'
)
Assert-Cx004True -Condition $roslynClosureConstantMatch.Success `
    -Message 'module must retain the reviewed Roslyn closure constant'
Assert-Cx004Equal -Actual ([regex]::Matches(
    $roslynClosureConstantMatch.Groups['body'].Value,
    '(?im)^\s*''[^'']+''\s*=\s*\[ordered\]@\{\s*sha256\s*=\s*''[0-9a-f]{64}'';\s*length\s*=\s*[1-9][0-9]*L\s*\}\s*$'
).Count) -Expected 13 -Message 'reviewed Roslyn closure must contain exactly 13 hash-and-length-pinned files'
foreach ($roslynClosureName in @(
    'csc.exe',
    'csc.exe.config',
    'Microsoft.CodeAnalysis.dll',
    'Microsoft.CodeAnalysis.CSharp.dll',
    'Microsoft.CodeAnalysis.ExternalAccess.RazorCompiler.dll',
    'System.Buffers.dll',
    'System.Collections.Immutable.dll',
    'System.Memory.dll',
    'System.Numerics.Vectors.dll',
    'System.Reflection.Metadata.dll',
    'System.Runtime.CompilerServices.Unsafe.dll',
    'System.Text.Encoding.CodePages.dll',
    'System.Threading.Tasks.Extensions.dll'
)) {
    Assert-Cx004Matches -Actual $roslynClosureConstantMatch.Groups['body'].Value `
        -Pattern ("(?m)^\s*'" + [regex]::Escape($roslynClosureName) + "'\s*=") `
        -Message "reviewed Roslyn closure must retain $roslynClosureName"
}
foreach ($namedSnapshotMarker in @('GetEnumerator', 'Get-Cx004FullPath', 'Get-Cx004PathFact', 'role', 'path', 'identity')) {
    Assert-Cx004Matches -Actual $namedFileSetSnapshotRaw -Pattern ([regex]::Escape($namedSnapshotMarker)) `
        -Message "named compiler-file snapshot must retain marker $namedSnapshotMarker"
}
foreach ($roslynSnapshotMarker in @(
    'ProgramFilesX86',
    'Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn',
    'Assert-Cx004NoReparsePath',
    'Cx004ExpectedRoslynClosure.GetEnumerator',
    'Get-Cx004PathFact',
    'fact.sha256',
    'fact.length',
    'host-smoke-toolchain-missing'
)) {
    Assert-Cx004Matches -Actual $roslynClosureSnapshotRaw -Pattern ([regex]::Escape($roslynSnapshotMarker)) `
        -Message "Roslyn closure snapshot must retain exact identity guard $roslynSnapshotMarker"
}
Assert-Cx004Matches -Actual $snapshotUnchangedRaw `
    -Pattern '(?is)ConvertTo-Cx004CanonicalJson\s+-InputObject\s+\$Before\s+-Depth\s+32\)\s+-cne\s*\r?\n\s*\(ConvertTo-Cx004CanonicalJson\s+-InputObject\s+\$After\s+-Depth\s+32\).*host-smoke-toolchain-drift' `
    -Message 'toolchain snapshots must use one case-sensitive canonical before/after equality proof'
Assert-Cx004Matches -Actual $hostSmokeFunctionRaw `
    -Pattern '(?is)\$compilerArguments\s*=\s*@\(\s*''/noconfig'',\s*''/shared:false'',\s*''/nostdlib\+''' `
    -Message 'Roslyn compilation must explicitly disable response config, compiler-server reuse, and implicit references'
Assert-Cx004Matches -Actual $hostSmokeFunctionRaw `
    -Pattern '(?is)\$compilerFilePaths\s*=\s*\[ordered\]@\{\s*vswhere\s*=\s*\$vswherePath\s*csc\s*=\s*\$cscPath\s*referenceMscorlib\s*=\s*\$referencePaths\[0\]\s*referenceSystem\s*=\s*\$referencePaths\[1\]\s*referenceSystemCore\s*=\s*\$referencePaths\[2\]\s*stagedSource\s*=\s*\$stagedSourcePath\s*\}' `
    -Message 'compiler identity snapshot must include vswhere, csc, all three references, and staged source'
Assert-Cx004SourceOrder -Source $hostSmokeFunctionRaw -Markers @(
    '$vswhereIdentityBefore = Get-Cx004NamedFileSetSnapshot',
    '$vswhereReceipt = Invoke-Cx004BoundedNative',
    'host-smoke-vswhere-native.json',
    '$vswhereIdentityAfter = Get-Cx004NamedFileSetSnapshot',
    'host-smoke-vswhere-identity-after.json',
    'Assert-Cx004SnapshotUnchanged -Before $vswhereIdentityBefore -After $vswhereIdentityAfter',
    '$vswhereReceipt.TimedOut',
    '$vswhereReceipt.ExitCode'
) -Message 'vswhere raw receipt and post-use identity must persist before any native result is accepted'
Assert-Cx004SourceOrder -Source $hostSmokeFunctionRaw -Markers @(
    '$compilerFilesBefore = Get-Cx004NamedFileSetSnapshot',
    '$roslynClosureBefore = Get-Cx004RoslynClosureSnapshot',
    '$compileReceipt = Invoke-Cx004BoundedNative',
    'host-smoke-compiler-native.json',
    '$compilerFilesAfterCompile = Get-Cx004NamedFileSetSnapshot',
    '$roslynClosureAfterCompile = Get-Cx004RoslynClosureSnapshot',
    'Assert-Cx004SnapshotUnchanged -Before $compilerFilesBefore -After $compilerFilesAfterCompile',
    'Assert-Cx004SnapshotUnchanged -Before $roslynClosureBefore -After $roslynClosureAfterCompile',
    '$compileReceipt.TimedOut',
    '$assemblyBefore = Get-Cx004PathFact',
    '$assemblyImmediatelyBeforeController = Get-Cx004PathFact',
    'Assert-Cx004SnapshotUnchanged -Before $assemblyBefore -After $assemblyImmediatelyBeforeController',
    '$controllerReceipt = Invoke-Cx004BoundedNative'
) -Message 'compiler inputs, closure, and output assembly must be re-proved before controller launch'
Assert-Cx004SourceOrder -Source $hostSmokeFunctionRaw -Markers @(
    '$controllerReceipt = Invoke-Cx004BoundedNative',
    'host-smoke-controller-native.json',
    'host-smoke-stdout.txt',
    'host-smoke-stderr.txt',
    '$compilerFilesAfterController = Get-Cx004NamedFileSetSnapshot',
    '$roslynClosureAfterController = Get-Cx004RoslynClosureSnapshot',
    'Assert-Cx004SnapshotUnchanged -Before $compilerFilesBefore -After $compilerFilesAfterController',
    'Assert-Cx004SnapshotUnchanged -Before $roslynClosureBefore -After $roslynClosureAfterController',
    '$controllerReceipt.TimedOut',
    '$controllerReceipt.Stderr.Length',
    'Get-Cx004JsonDocument',
    '$assemblyAfter = Get-Cx004PathFact',
    'Assert-Cx004SnapshotUnchanged -Before $assemblyBefore -After $assemblyAfter'
) -Message 'controller receipt, raw streams, compiler closure, inputs, and assembly must be retained and re-proved before acceptance'
Assert-Cx004SourceOrder -Source $hostDoctorRaw -Markers @(
    '$versionReceipt = Invoke-Cx004WsbNative',
    'host-doctor-version-native.json',
    'Assert-Cx004WsbNativeComplete -Receipt $versionReceipt',
    '$versionReceipt.ExitCode',
    '$versionReceipt.Raw -cnotmatch'
) -Message 'host-doctor raw version receipt must persist before binding, exit, stderr, or version acceptance'
foreach ($stageSealMarker in @(
    'SourceSeal',
    'staged-source-mismatch',
    'template-source-mismatch',
    'sha256',
    'length'
)) {
    Assert-Cx004Matches -Actual $stageFunctionRaw -Pattern ([regex]::Escape($stageSealMarker)) `
        -Message "staging must bind copied/executed bytes to the S0 seal marker $stageSealMarker"
}
foreach ($bundleManifestMarker in @(
    'bundle-manifest.json',
    'tracked-receipt.json',
    'relativePath',
    'sha256',
    'length'
)) {
    Assert-Cx004Matches -Actual "$bundleInventoryRaw`n$bundleCloserRaw" `
        -Pattern ([regex]::Escape($bundleManifestMarker)) `
        -Message "closed evidence bundle must retain marker $bundleManifestMarker"
}
foreach ($boundedEnumerationMarker in @(
    'MaximumEntries',
    'DeadlineUtc',
    'EnumerateFileSystemEntries',
    'directory-enumeration-timeout',
    'directory-entry-overflow',
    'Dispose'
)) {
    Assert-Cx004Matches -Actual $boundedDirectoryItemsRaw `
        -Pattern ([regex]::Escape($boundedEnumerationMarker)) `
        -Message "directory enumeration must retain finite guard $boundedEnumerationMarker"
}
foreach ($breadthFirstMarker in @(
    'Queue[string]',
    'Enqueue',
    'Dequeue',
    'bundle-object-overflow',
    'bundle-file-overflow',
    'bundle-reparse-object',
    'GetRelativePath',
    'Get-Cx004BoundedDirectoryItems'
)) {
    Assert-Cx004Matches -Actual $bundleInventoryRaw `
        -Pattern ([regex]::Escape($breadthFirstMarker)) `
        -Message "bundle inventory must retain bounded breadth-first guard $breadthFirstMarker"
}
Assert-Cx004Matches -Actual $bundleInventoryRaw `
    -Pattern '(?is)\$objectCount\s*-gt\s*512.*\$files\.Count\s*-gt\s*256.*\$totalBytes\s*-gt\s*64MB' `
    -Message 'bundle BFS must cap total objects, files, and bytes'
Assert-Cx004NotMatches -Actual "$bundleInventoryRaw`n$bundleCloserRaw" `
    -Pattern '(?im)Get-ChildItem[^\r\n]*-Recurse' `
    -Message 'bundle closure must not use an unbounded recursive enumeration primitive'
Assert-Cx004Matches -Actual $bundleCloserRaw `
    -Pattern '(?is)bundle-manifest\.json.{0,500}tracked-receipt\.json|tracked-receipt\.json.{0,500}bundle-manifest\.json' `
    -Message 'closed bundle enumeration must explicitly exclude only its manifest and safe tracked receipt'
Assert-Cx004Matches -Actual $bundleInventoryRaw -Pattern '(?i)(?:-c?notcontains|-notin|-ccontains)' `
    -Message 'closed bundle file enumeration must apply its explicit exclusion allowlist'
Assert-Cx004Matches -Actual $bundleInventoryRaw -Pattern '(?i)(?:Sort-Object|\.Sort\()' `
    -Message 'closed bundle manifest entries must use deterministic relative-path ordering'
Assert-Cx004True -Condition ([regex]::Matches(
    $bundleCloserRaw,
    '(?i)Get-Cx004BundleInventory'
).Count -ge 3) -Message 'bundle close must inventory before, during, and after manifest creation'
foreach ($bundleMutationMarker in @('bundle-mutated-during-close', 'firstInventory', 'secondInventory', 'finalInventory')) {
    Assert-Cx004Matches -Actual $bundleCloserRaw -Pattern ([regex]::Escape($bundleMutationMarker)) `
        -Message "bundle closure must retain mutation fence $bundleMutationMarker"
}
Assert-Cx004Matches -Actual $bundleCloserRaw `
    -Pattern '(?i)sha256\s*=\s*\$manifestFact\.sha256' `
    -Message 'bundle close must return the closed manifest SHA-256 as its aggregate binding'
foreach ($pinnedSessionParameter in @('ExpectedS0Commit', 'ExpectedS0Tree')) {
    Assert-Cx004Matches -Actual $sessionFunctionRaw -Pattern ([regex]::Escape($pinnedSessionParameter)) `
        -Message "each session must retain pinned source parameter $pinnedSessionParameter"
}
foreach ($cliReceiptName in @('startReceipt', 'stopReceipt')) {
    Assert-Cx004Matches -Actual $sessionFunctionRaw `
        -Pattern ("(?i)\$" + [regex]::Escape($cliReceiptName) + '\.Stderr(?:\.Length)?') `
        -Message "$cliReceiptName stderr must be empty before its operation can be accepted"
}

# Every raw native receipt is persisted before any binding, completion, exit,
# stderr, or parser check can throw. This preserves post-binding-drift and
# otherwise inconclusive native evidence instead of losing the observation.
Assert-Cx004SourceOrder -Source $wsbListReceiptRaw -Markers @(
    '$receipt = Invoke-Cx004WsbNative',
    'Write-Cx004JsonFile -LiteralPath $NativeReceiptPath',
    'Assert-Cx004WsbNativeComplete -Receipt $receipt',
    '$receipt.ExitCode',
    '$receipt.Stderr.Length',
    'ConvertFrom-Cx004WsbListRaw'
) -Message 'raw list receipt must persist before completion, binding, and schema acceptance'
Assert-Cx004Matches -Actual $sessionListWaitRaw `
    -Pattern '(?i)Get-Cx004WsbListReceipt\s+-WsbPath\s+\$WsbPath\s+-NativeReceiptPath\s+\$NativeReceiptPath' `
    -Message 'each list-state poll must immediately overwrite its retained raw native receipt'
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?is)\$runningList\s*=\s*Wait-Cx004SessionListState.*?-SessionId\s+\$sessionId.*?-ExpectedRunning\s+\$true' `
    -Message 'pre-connect running proof must bind the retained exact session id and require it running'
Assert-Cx004Matches -Actual $sessionListWaitRaw `
    -Pattern '(?is)if\s*\(\$ExpectedRunning\).*?\$ids\.Count\s+-eq\s+1\s+-and\s+\$ids\[0\]\s+-ceq\s+\$SessionId.*?return\s+\$lastReceipt' `
    -Message 'running-state acceptance must require the retained id as the sole case-exact identity'
Assert-Cx004Matches -Actual $sessionListWaitRaw `
    -Pattern '(?is)\$ids\.Count\s+-gt\s+0\s+-and\s+-not\s*\(\$ids\.Count\s+-eq\s+1\s+-and\s+\$ids\[0\]\s+-ceq\s+\$SessionId\).*?foreign-running-session' `
    -Message 'any nonempty running-list shape other than the sole retained id must fail closed'
Assert-Cx004SourceOrder -Source $sessionFunctionRaw -Markers @(
    '$startReceipt = Invoke-Cx004WsbNative',
    'cli-start.json',
    'Assert-Cx004WsbNativeComplete -Receipt $startReceipt',
    '$startReceipt.ExitCode',
    '$startReceipt.Stderr.Length',
    'ConvertFrom-Cx004WsbStartRaw'
) -Message 'raw start receipt must persist before completion, binding, and schema acceptance'
Assert-Cx004SourceOrder -Source $sessionFunctionRaw -Markers @(
    '$connectReceipt = Invoke-Cx004WsbNative',
    "Write-Cx004JsonFile -LiteralPath (Join-Path `$Stage.RunRoot 'cli-connect-native.json') -InputObject `$connectReceipt",
    'Assert-Cx004WsbConnectNativeComplete -Receipt $connectReceipt',
    'Wait-Cx004GuestTerminalFiles'
) -Message 'bounded opaque connect receipt must persist and validate before guest terminal polling'
$connectStartIndex = $sessionFunctionRaw.IndexOf('$connectReceipt = Invoke-Cx004WsbNative', [StringComparison]::Ordinal)
$connectTerminalIndex = if ($connectStartIndex -ge 0) {
    $sessionFunctionRaw.IndexOf('Wait-Cx004GuestTerminalFiles', $connectStartIndex, [StringComparison]::Ordinal)
}
else {
    -1
}
Assert-Cx004True -Condition ($connectStartIndex -ge 0 -and $connectTerminalIndex -gt $connectStartIndex) `
    -Message 'the exact-ID connect-to-terminal source slice must be present'
$connectToTerminalRaw = $sessionFunctionRaw.Substring(
    $connectStartIndex,
    $connectTerminalIndex - $connectStartIndex
)
Assert-Cx004NotMatches -Actual $connectToTerminalRaw `
    -Pattern '(?i)\$connectReceipt\.(?:Raw|Stdout)\b' `
    -Message 'connect stdout must remain opaque and cannot drive terminal polling or acceptance'
Assert-Cx004SourceOrder -Source $sessionFunctionRaw -Markers @(
    '$stopReceipt = Invoke-Cx004WsbNative',
    'cli-stop.json',
    'Assert-Cx004WsbNativeComplete -Receipt $stopReceipt',
    '$stopReceipt.ExitCode',
    '$stopReceipt.Stderr.Length',
    'ConvertFrom-Cx004WsbStopRaw'
) -Message 'raw stop receipt must persist before completion, binding, and schema acceptance'
foreach ($nativeReceiptName in @(
    'cli-pre-list-native.json',
    'cli-running-list-last-native.json',
    'cli-stopped-list-last-native.json'
)) {
    Assert-Cx004Matches -Actual $sessionFunctionRaw -Pattern ([regex]::Escape($nativeReceiptName)) `
        -Message "session evidence must retain immediate native receipt $nativeReceiptName"
}
foreach ($nativeReceiptName in @('cli-initial-list-native.json', 'cli-final-list-native.json')) {
    Assert-Cx004Matches -Actual $q0sFunctionRaw -Pattern ([regex]::Escape($nativeReceiptName)) `
        -Message "outer qualification evidence must retain immediate native receipt $nativeReceiptName"
}

# Staged executable/input bytes are re-proved at the last possible point before
# start, after the source seal is re-observed and before wsb receives config.
Assert-Cx004SourceOrder -Source $sessionFunctionRaw -Markers @(
    '$sourceSealBeforeStart = Get-Cx004SourceSeal',
    '$Stage.SourceHead',
    '$Stage.SourceTree',
    '$immediateInput = Get-Cx004DirectorySnapshot',
    'Assert-Cx004InputSnapshotUnchanged -Before $Stage.InitialInputSnapshot -After $immediateInput',
    'Get-Cx004Sha256 -LiteralPath $Stage.RenderedConfigPath',
    '$renderedConfigArgumentBytes = [System.Text.UTF8Encoding]',
    '$renderedConfigArgumentSha256 = [System.Convert]::ToHexString',
    '$renderedConfigArgumentSha256 -cne $Stage.RenderedConfigSha256',
    'input-snapshot-immediately-before-start.json',
    '$startReceipt = Invoke-Cx004WsbNative'
) -Message 'source, staged inputs, and the exact XML argument must be re-proved immediately before Sandbox start'
Assert-Cx004SourceOrder -Source $sessionFunctionRaw -Markers @(
    'Get-Cx004SourceSeal',
    'ConvertFrom-Cx004WsbStartRaw',
    'Wait-Cx004SessionListState',
    '$connectReceipt = Invoke-Cx004WsbNative',
    'cli-connect-native.json',
    'Wait-Cx004GuestTerminalFiles',
    'ConvertFrom-Cx004WsbStopRaw',
    'Wait-Cx004SessionListState',
    'Test-Cx004MappingRelease',
    'Complete-Cx004HostCanary',
    'Test-Cx004GuestOutput'
) -Message 'session flow must reprove source and validate final output only after exact stop, absence, and mapping release'
Assert-Cx004SourceOrder -Source $sessionFunctionRaw -Markers @(
    'ConvertFrom-Cx004WsbStopRaw',
    'Get-Cx004SourceSeal'
) -Message 'each stopped session must reprove the pinned S0 source seal'
Assert-Cx004True -Condition ([regex]::Matches(
    $sessionFunctionRaw,
    '(?i)Test-Cx004GuestOutput'
).Count -ge 1) -Message 'guest output must have an authoritative post-stop validation path'
Assert-Cx004Matches -Actual $sessionFunctionRaw -Pattern '(?i)inconclusive' `
    -Message 'uncertain start/stop/teardown must remain a typed inconclusive session outcome'
Assert-Cx004Matches -Actual $sessionFunctionRaw -Pattern '(?i)\$operationUncertain' `
    -Message 'session classification must explicitly retain operation uncertainty'
foreach ($uncertainOperationCode in @(
    'unknown-start-shape',
    'unknown-connect-result',
    'native-process-timeout',
    'native-output-overflow',
    'native-stdout-overflow',
    'native-stderr-overflow',
    'unknown-stop-shape',
    'session-state-timeout',
    'directory-entry-overflow',
    'unexpected-output-object',
    'unexpected-output-file',
    'oversized-output-file',
    'incomplete-terminal-output'
)) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($uncertainOperationCode)) `
        -Message "harness must retain typed uncertain operation marker $uncertainOperationCode"
}
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?is)catch\s*\{\s*\$runError\s*=\s*\$_\s*\r?\n\s*\$operationUncertain\s*=\s*\$true\s*\r?\n\s*if\s*\(Test-Cx004PositiveIntegrityError\s+-Message\s+\$_\.Exception\.Message\)\s*\{\s*\$positiveBoundaryFailure\s*=\s*\$true' `
    -Message 'every classified or unclassified pre-stop run error must default to operation uncertainty'
$expectedPositiveIntegrityPattern = '^CX004\[(stage-source-seal-drift|rendered-config-mutated|input-mutated|unexpected-directory-surface|missing-fixed-input|staged-source-mismatch|template-source-mismatch|unexpected-harness-source|dirty-source-tree|source-seal-mismatch|source-seal-manifest-missing|source-seal-manifest-untracked|source-seal-manifest-invalid|source-worktree-byte-mismatch|source-eol-policy-mismatch|source-blob-mismatch|host-smoke-source-missing|host-smoke-staged-source-mismatch)\]'
Assert-Cx004Matches -Actual $positiveIntegrityRaw `
    -Pattern ([regex]::Escape("'$expectedPositiveIntegrityPattern'")) `
    -Message 'positive integrity failure detection must remain anchored to its exact closed source/staging code set'
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?is)\$outcome\s*=\s*if\s*\(\$hostCanaryFailed\s+-or\s+\$positiveBoundaryFailure\s+-or\s+\$guestOutcome\s+-ceq\s+''failed''\)\s*\{\s*''failed''\s*\}\s*elseif\s*\(\$operationUncertain\s+-or\s+\$teardownUncertain\s+-or\s+\$validationUncertain\)\s*\{\s*''inconclusive''' `
    -Message 'only positive host-canary, boundary, or validated guest failure may dominate later uncertainty'
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?i)\$hostCanaryFailed\s*=\s*\$hostCanaryReceipt\.guestConnectionObserved\s+-eq\s+\$true' `
    -Message 'only a positive retained host-canary connection observation may select host-canary failure'
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?i)\$guestOutcome\s*=\s*if\s*\(\$null\s+-ne\s+\$guestValidation\)\s*\{\s*\[string\]\s*\$guestValidation\.outcome' `
    -Message 'guest failure precedence must use only the strictly validated guest outcome'
Assert-Cx004NotMatches -Actual $sessionFunctionRaw `
    -Pattern '(?i)definitiveRunFailure' `
    -Message 'an unclassified run error must never be inferred as a definitive failure'
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?is)\$validationError\s*=\s*\$_\s*\r?\n\s*\$validationUncertain\s*=\s*\$true' `
    -Message 'post-stop validation errors without positive boundary proof must remain validation uncertainty'
foreach ($positiveBoundaryCode in @('unexpected-directory-surface', 'input-mutated')) {
    Assert-Cx004Matches -Actual $sessionFunctionRaw -Pattern ([regex]::Escape($positiveBoundaryCode)) `
        -Message "positive staged/output boundary violation must retain failure marker $positiveBoundaryCode"
}
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?i)positiveBoundaryFailure\s*=\s*\[bool\]\s*\$positiveBoundaryFailure' `
    -Message 'session receipt must retain whether a positive boundary failure dominated uncertainty'
Assert-Cx004Matches -Actual $guestValidatorRaw `
    -Pattern '(?is)if\s*\(\s*Test-Path\s+-LiteralPath\s+\$failurePath\s*\).*?return\s+\[ordered\]@\{\s*outcome\s*=\s*''inconclusive''.*?disposition\s*=\s*''guest-execution-uncertain''' `
    -Message 'a schema-valid bounded guest-failure receipt must remain execution uncertainty rather than asserted probe failure'
Assert-Cx004NotMatches -Actual $guestValidatorRaw `
    -Pattern '(?i)guest-reported-failure' `
    -Message 'generic guest-failure.json must not be promoted to a definitive failed outcome'
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?is)elseif\s*\(\$null\s+-ne\s+\$terminal\s+-and\s+\$terminal\.Kind\s+-ceq\s+''failure''\)\s*\{\s*\$guestValidation\s*=\s*Test-Cx004GuestOutput.*ExpectedLeafNames\s+@\(''guest-failure\.json''\)' `
    -Message 'post-stop guest-failure validation must retain its inconclusive typed receipt and exact output snapshot'
Assert-Cx004True -Condition ([regex]::Matches(
    $q0sFunctionRaw,
    '(?i)Get-Cx004SourceSeal'
).Count -ge 3) -Message 'Q0S must reprove the source seal before and after host compilation and at finalization'
Assert-Cx004True -Condition (
    $q0sFunctionRaw.LastIndexOf('Get-Cx004SourceSeal', [System.StringComparison]::OrdinalIgnoreCase) -gt
        $q0sFunctionRaw.LastIndexOf('Invoke-Cx004SandboxSession', [System.StringComparison]::OrdinalIgnoreCase)
) -Message 'final Q0S source-seal reproof must occur after the second Sandbox session stops'
Assert-Cx004SourceOrder -Source $q0sFunctionRaw -Markers @(
    'Close-Cx004EvidenceBundle',
    'New-Cx004TrackedReceipt'
) -Message 'tracked receipt may be built only after the raw evidence bundle is closed'
Assert-Cx004Matches -Actual $q0sFunctionRaw `
    -Pattern '(?i)-LocalEvidenceBundleSha256\s+\$[A-Za-z0-9_]+\.sha256' `
    -Message 'tracked receipt must bind the closed bundle-manifest SHA-256 aggregate'

# The guest's explicit three-way outcome is schema-valid. Timeout and missing
# observations are not relabeled as failed, and only positive violations fail.
foreach ($outcome in @('passed', 'failed', 'inconclusive')) {
    Assert-Cx004Matches -Actual $guestValidatorRaw `
        -Pattern ('(?i)(?:''|"){0}(?:''|")' -f [regex]::Escape($outcome)) `
        -Message "host guest-output validator must admit outcome $outcome"
}
Assert-Cx004NotMatches -Actual $guestValidatorRaw `
    -Pattern '(?i)Get-Cx004JsonString[^\r\n]+-Name\s+[''\"]outcome[''\"][^\r\n]+-cne\s+[''\"]passed[''\"]' `
    -Message 'schema-valid failed/inconclusive guest outcomes must not be rejected as malformed'
Assert-Cx004Matches -Actual $sessionFunctionRaw `
    -Pattern '(?i)(?:guestValidation|guestResult)\.outcome' `
    -Message 'session classification must propagate the validated guest outcome'

# The host canary is a challenge-bound live endpoint selected for this run. The
# guest must not probe a guessed private address.
foreach ($dynamicCanaryField in @('hostCanaryAddress', 'hostCanaryPort')) {
    Assert-Cx004Matches -Actual $bootstrapRaw -Pattern ([regex]::Escape($dynamicCanaryField)) `
        -Message "bootstrap must validate dynamic run-manifest field $dynamicCanaryField"
    Assert-Cx004Matches -Actual $probeRaw -Pattern ([regex]::Escape($dynamicCanaryField)) `
        -Message "probe must consume dynamic run-manifest field $dynamicCanaryField"
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($dynamicCanaryField)) `
        -Message "host staging and validation must bind dynamic canary field $dynamicCanaryField"
}
foreach ($hostCanaryPositive in @('hostCanaryChallengeBound', 'hostCanaryConnectionBlocked')) {
    Assert-Cx004Matches -Actual $probeRaw -Pattern ([regex]::Escape($hostCanaryPositive)) `
        -Message "guest terminal facts must retain positive host-canary proof $hostCanaryPositive"
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($hostCanaryPositive)) `
        -Message "host validator must require positive host-canary proof $hostCanaryPositive"
}
Assert-Cx004NotMatches -Actual $probeRaw `
    -Pattern '(?i)Test-Cx004TcpCanary\s+-Address\s+(?:''|")192\.168\.0\.1(?:''|")' `
    -Message 'host canary must not use a hard-coded guessed host address'
foreach ($liveCanaryMarker in @(
    'Get-NetRoute',
    'Get-NetIPAddress',
    'TcpListener',
    'AcceptTcpClientAsync',
    'host-canary-self-probe'
)) {
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($liveCanaryMarker)) `
        -Message "host must prove and retain live synthetic canary marker $liveCanaryMarker"
}
Assert-Cx004SourceOrder -Source $hostCanaryCompleteRaw -Markers @(
    '$statusBeforeFence = $task.Status',
    '$wasPending = -not $task.IsCompleted',
    '$Canary.Listener.Stop()',
    'Task]::WaitAny',
    'TaskStatus]::RanToCompletion',
    '$connected = $true',
    'elseif ($wasPending',
    'TaskStatus]::Faulted',
    '$connected = $false',
    'listenerClosed = $true'
) -Message 'host-canary absence must be decided only after the retained listener-close settlement fence'
Assert-Cx004Matches -Actual $hostCanaryCompleteRaw `
    -Pattern '(?is)Task\]::WaitAny\s*\(.*?3000\s*\).*?host-canary-observation-uncertain' `
    -Message 'the listener-close accept task must settle within one finite three-second fence'
Assert-Cx004Matches -Actual $hostCanaryCompleteRaw `
    -Pattern '(?is)\$flattened\.Count\s+-ne\s+1.*SocketException.*SocketErrorCode\s+-ne\s+\[System\.Net\.Sockets\.SocketError\]::OperationAborted.*NativeErrorCode\s+-ne\s+995' `
    -Message 'only the exact single OperationAborted/995 listener-close fault may prove no guest connection'
Assert-Cx004NotMatches -Actual $hostCanaryCompleteRaw `
    -Pattern '(?is)TaskStatus\]::Canceled.*\$connected\s*=\s*\$false' `
    -Message 'a canceled accept task must not be treated as positive host-canary absence'
foreach ($canaryFenceMarker in @(
    'host-canary-listener-close-failed',
    'host-canary-observation-uncertain',
    'no-connection-before-listener-close-fence',
    'acceptStatusBeforeFence',
    'acceptStatusAfterFence'
)) {
    Assert-Cx004Matches -Actual $hostCanaryCompleteRaw -Pattern ([regex]::Escape($canaryFenceMarker)) `
        -Message "listener-close fence must retain marker $canaryFenceMarker"
}
Assert-Cx004Matches -Actual $sessionFunctionRaw -Pattern '(?i)\$HostCanary' `
    -Message 'each session must retain its exact live host-canary handle through teardown'
Assert-Cx004SourceOrder -Source $q0sFunctionRaw -Markers @(
    'New-Cx004HostCanary',
    'New-Cx004RunStage',
    'Invoke-Cx004SandboxSession'
) -Message 'host canary must self-prove and start before the first Sandbox stage/session'
Assert-Cx004True -Condition ([regex]::Matches(
    $q0sFunctionRaw,
    '(?i)New-Cx004HostCanary'
).Count -eq 2) -Message 'each of the two fresh Sandbox sessions must receive its own live synthetic host canary'
Assert-Cx004Matches -Actual $moduleRaw -Pattern 'host-canary-self-probe-timeout' `
    -Message 'bounded host-canary self-probe timeout must retain its typed uncertainty marker'
Assert-Cx004Matches -Actual $q0sFunctionRaw `
    -Pattern '(?is)\$positiveSessionFailure\s*=\s*\(\$null\s+-ne\s+\$firstSession\s+-and\s+\$firstSession\.outcome\s+-ceq\s+''failed''\)\s+-or\s*\(\$null\s+-ne\s+\$secondSession\s+-and\s+\$secondSession\.outcome\s+-ceq\s+''failed''\).*?\$positiveCaughtFailure\s*=\s*\(Test-Cx004PositiveIntegrityError.*?host-smoke-positive-violation\|guest-semantic-drift\|nonfresh-second-session\|stable-input-drift.*?\$outcome\s*=\s*if\s*\(\$positiveSessionFailure\s+-or\s+\$positiveCaughtFailure\)\s*\{\s*''failed''\s*\}\s*else\s*\{\s*''inconclusive''' `
    -Message 'outer qualification must preserve prior positive session failure, admit only closed positive caught failures, and default every other exception to inconclusive'

# Read-only mapping proof covers both file creation and write access to a known
# existing mapped input. IPv6 site-local addresses remain routable evidence.
Assert-Cx004NotMatches -Actual $probeRaw -Pattern '(?i)IsIPv6SiteLocal' `
    -Message 'deprecated IPv6 site-local space must not be excluded from routable-address detection'
foreach ($writeOpenMarker in @(
    'existingFileWriteOpenAttempted',
    'existingFileWriteOpenSucceeded',
    'existingFileWriteOpenErrorType',
    'existingFileSha256Before',
    'existingFileSha256After',
    'existingFileUnmodified',
    'UnauthorizedAccessException'
)) {
    Assert-Cx004Matches -Actual $probeRaw -Pattern ([regex]::Escape($writeOpenMarker)) `
        -Message "guest must retain existing-input write-open proof marker $writeOpenMarker"
    Assert-Cx004Matches -Actual $moduleRaw -Pattern ([regex]::Escape($writeOpenMarker)) `
        -Message "host must strictly validate existing-input write-open marker $writeOpenMarker"
}
foreach ($writeOpenOperationMarker in @('FileMode]::Open', 'FileAccess]::Write')) {
    Assert-Cx004Matches -Actual $probeRaw -Pattern ([regex]::Escape($writeOpenOperationMarker)) `
        -Message "guest must attempt existing-input write access using $writeOpenOperationMarker"
}

# Mapping proof is three-way: only positive create/open/artifact/hash mutation
# is failure; exact access-denied evidence passes; any other denial/error shape
# is inconclusive. Guest production and host re-derivation must agree.
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?is)\$inputMappingViolation\s*=\s*\$inputWriteSucceeded\s+-or\s+\$inputWriteArtifactPresent\s+-or\s+\$existingInputWriteOpenSucceeded\s+-or\s*\(\s*-not\s+\$existingInputUnmodified\s*\)' `
    -Message 'guest mapping failure must require positive create, artifact, write-open, or hash-mutation evidence'
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?is)\$inputMappingProbeInconclusive\s*=\s*\(\s*-not\s+\$inputMappingViolation\s*\)\s+-and\s*\(\s*-not\s+\$inputMappingReadOnly\s*\)' `
    -Message 'guest unexpected mapping denial/error evidence must remain inconclusive'
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?is)\$failed\s*=\s*\$inputMappingViolation\s+-or.*?\$networkViolation' `
    -Message 'guest failure classification must use positive mapping violation rather than absence of read-only proof'
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?is)\$inconclusive\s*=.*?\(\s*-not\s+\$outputWasEmpty\s*\).*?\$inputMappingProbeInconclusive.*?\$networkCanaryTimedOut.*?\$networkCanaryProbeError.*?\(\s*-not\s+\$persistenceProbePassed\s*\)' `
    -Message 'guest output, mapping, canary, and persistence uncertainty must select inconclusive'
Assert-Cx004Matches -Actual $guestValidatorRaw `
    -Pattern '(?is)\$inputMappingViolation\s*=\s*\$writeSucceeded\s+-or\s+\$artifactPresent\s+-or\s+\$existingSucceeded\s+-or\s*\(\s*-not\s+\$existingUnmodified\s*\)' `
    -Message 'host mapping failure re-derivation must require the same positive violation facts'
Assert-Cx004Matches -Actual $guestValidatorRaw `
    -Pattern '(?is)\$inputMappingInconclusive\s*=\s*\(\s*-not\s+\$inputMappingViolation\s*\)\s+-and\s*\(\s*-not\s+\$inputMappingReadOnlyDerived\s*\)' `
    -Message 'host mapping re-derivation must preserve unexpected denial/error as inconclusive'
Assert-Cx004Matches -Actual $guestValidatorRaw `
    -Pattern '(?i)\$probeFailed\s*=\s*\$inputMappingViolation\s+-or\s+\$networkViolation' `
    -Message 'host probe failure must require positive mapping or network violation'
Assert-Cx004Matches -Actual $guestValidatorRaw `
    -Pattern '(?is)\$probeInconclusive\s*=.*?\$networkTimedOut.*?\$networkProbeError.*?\(\s*-not\s+\$outputWasEmpty\s*\).*?\$inputMappingInconclusive.*?\(\s*-not\s+\$persistenceDerived\s*\)' `
    -Message 'host re-derivation must preserve output, mapping, canary, and persistence uncertainty'

# TCP/DNS exception handling is a closed SocketErrorCode allowlist. Timeouts
# remain timeouts, known isolation/peer rejection has typed meaning, and every
# unknown, transient, or resource error falls through to probe-error.
Assert-Cx004Matches -Actual $networkFailureDispositionRaw `
    -Pattern '(?is)SocketErrorCode.*SocketError\]::TimedOut\).*return\s+''timeout''' `
    -Message 'SocketError TimedOut must remain a timeout rather than isolation success'
foreach ($socketDispositionMarker in @(
    'SocketError]::AccessDenied',
    'SocketError]::AddressNotAvailable',
    'SocketError]::HostDown',
    'SocketError]::HostUnreachable',
    'SocketError]::NetworkDown',
    'SocketError]::NetworkUnreachable',
    'SocketError]::HostNotFound',
    'SocketError]::NoData',
    'SocketError]::ConnectionRefused',
    'SocketError]::ConnectionReset',
    'resolution-failed',
    'connection-failed',
    'peer-rejected'
)) {
    Assert-Cx004Matches -Actual $networkFailureDispositionRaw -Pattern ([regex]::Escape($socketDispositionMarker)) `
        -Message "closed network exception mapping must retain marker $socketDispositionMarker"
}
Assert-Cx004Matches -Actual $networkFailureDispositionRaw `
    -Pattern '(?is)return\s+''peer-rejected''\s*\}.*return\s+''probe-error''\s*\}' `
    -Message 'all Socket errors outside the closed allowlists must fall through to probe-error'
foreach ($resourceOrTransientSocketError in @(
    'NoBufferSpaceAvailable',
    'TooManyOpenSockets',
    'WouldBlock',
    'InProgress',
    'AlreadyInProgress',
    'TryAgain',
    'SystemNotReady',
    'NoRecovery',
    'ConnectionAborted'
)) {
    Assert-Cx004NotMatches -Actual $networkFailureDispositionRaw `
        -Pattern ([regex]::Escape("SocketError]::$resourceOrTransientSocketError")) `
        -Message "resource/transient socket error $resourceOrTransientSocketError must not be accepted as isolation evidence"
}
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?is)WaitOne\(1500\).*?disposition\s*=\s*''timeout''.*?GetHostAddressesAsync.*?Wait\(1500\).*?disposition\s*=\s*''timeout''' `
    -Message 'both TCP and DNS canaries must map their finite wait expiry to timeout'
Assert-Cx004Matches -Actual $guestValidatorRaw `
    -Pattern '(?is)AllowedDispositions\s+@\(''connection-failed'',\s*''peer-rejected'',\s*''timeout'',\s*''probe-error'',\s*''connected''\)' `
    -Message 'host TCP validation must admit the exact peer-rejected/timeout/probe-error tri-state vocabulary'
Assert-Cx004Matches -Actual $guestValidatorRaw `
    -Pattern '(?is)\$networkViolation\s*=.*?\$hostDisposition\s+-ceq\s+''peer-rejected''\s+-or\s+\$rawDisposition\s+-ceq\s+''peer-rejected''' `
    -Message 'a positively reached but rejecting TCP peer must remain network-violation failure evidence'
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?is)\$networkViolation\s*=\s*\$routableAddresses\.Count\s+-gt\s+0\s+-or\s+\$defaultRoutes\.Count\s+-gt\s+0' `
    -Message 'positive guest address or route observations must fail even when the broader observation pass was incomplete'
Assert-Cx004Matches -Actual $guestValidatorRaw `
    -Pattern '(?is)\$networkViolation\s*=\s*\$networkArrayCounts\.routableAddresses\s+-gt\s+0\s+-or\s+\$networkArrayCounts\.defaultRoutes\s+-gt\s+0' `
    -Message 'host re-derivation must preserve positive address or route failure without availability gating'
Assert-Cx004NotMatches -Actual "$probeRaw`n$guestValidatorRaw" `
    -Pattern '(?is)\$networkViolation\s*=\s*\(?\s*\$networkObservationAvailable\s+-and' `
    -Message 'network-observation availability must never suppress a positively observed address or route violation'

# A persistence canary proves reset only when it was absent, was freshly
# created, and its run challenge read back exactly. Stale or unverified state
# is uncertainty, not proof of persistence failure.
Assert-Cx004Matches -Actual $probeRaw `
    -Pattern '(?is)\$persistenceProbePassed\s*=\s*\(\s*-not\s+\$persistencePresentBefore\s*\)\s+-and\s+\$persistenceCreated\s+-and\s+\$persistenceChallengeVerified' `
    -Message 'guest persistence reset proof must require absent/fresh/challenge-verified state'
Assert-Cx004Matches -Actual $guestValidatorRaw `
    -Pattern '(?is)\$persistenceDerived\s*=\s*\(\s*-not\s+\$persistencePresentBefore\s*\)\s+-and\s+\$persistenceCreated\s+-and\s+\$persistenceChallengeVerified' `
    -Message 'host persistence reset re-derivation must require absent/fresh/challenge-verified state'

# Unexpected/oversized/incomplete terminal output is evidence uncertainty. It
# is classified in both the session and the outer qualification boundary.
foreach ($terminalUncertaintyCode in @(
    'unexpected-output-object',
    'unexpected-output-file',
    'oversized-output-file',
    'incomplete-terminal-output'
)) {
    Assert-Cx004Matches -Actual $guestTerminalWaitRaw -Pattern ([regex]::Escape($terminalUncertaintyCode)) `
        -Message "guest terminal watcher must emit typed uncertainty $terminalUncertaintyCode"
    Assert-Cx004NotMatches -Actual $positiveIntegrityRaw -Pattern ([regex]::Escape($terminalUncertaintyCode)) `
        -Message "terminal uncertainty $terminalUncertaintyCode must not enter the positive integrity-failure allowlist"
}

Import-Module -Name $modulePath -Force -DisableNameChecking
$sandboxModule = Get-Module -Name Cx004Sandbox
Assert-Cx004True -Condition ($null -ne $sandboxModule) `
    -Message 'Sandbox module must be loaded for private bounded-runner fixtures'

$expectedKnownLocalAppData = [System.IO.Path]::GetFullPath(
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$originalLocalAppDataEnvironment = $env:LOCALAPPDATA
try {
    $env:LOCALAPPDATA = [System.IO.Path]::GetFullPath((Join-Path $labRoot '..\..\..'))
    Remove-Module -Name Cx004Sandbox -Force
    Import-Module -Name $modulePath -Force -DisableNameChecking
    $sandboxModule = Get-Module -Name Cx004Sandbox
    $storageSelection = & $sandboxModule {
        [pscustomobject]@{
            KnownLocalAppData = $script:Cx004KnownLocalAppData
            RunsRoot = $script:Cx004RunsRoot
        }
    }
    Assert-Cx004Equal -Actual $storageSelection.KnownLocalAppData `
        -Expected $expectedKnownLocalAppData `
        -Message 'mutating LOCALAPPDATA must not change the OS-known qualification root'
    Assert-Cx004True -Condition $storageSelection.RunsRoot.StartsWith(
        "$expectedKnownLocalAppData$([System.IO.Path]::DirectorySeparatorChar)",
        [System.StringComparison]::OrdinalIgnoreCase
    ) -Message 'qualification storage must remain below OS-known LocalApplicationData'
}
finally {
    $env:LOCALAPPDATA = $originalLocalAppDataEnvironment
    Remove-Module -Name Cx004Sandbox -Force -ErrorAction SilentlyContinue
    Import-Module -Name $modulePath -Force -DisableNameChecking
    $sandboxModule = Get-Module -Name Cx004Sandbox
}

foreach ($commandName in @(
    'ConvertFrom-Cx004WsbListRaw',
    'ConvertFrom-Cx004WsbStartRaw',
    'ConvertFrom-Cx004WsbStopRaw',
    'Assert-Cx004NoRunningSessions',
    'Render-Cx004SandboxConfig',
    'New-Cx004TrackedReceipt'
)) {
    Assert-Cx004True -Condition ($null -ne (Get-Command -Name $commandName -ErrorAction SilentlyContinue)) `
        -Message "module must export pure contract helper $commandName"
}
Assert-Cx004True -Condition ($null -eq (Get-Command -Name 'Invoke-Cx004WsbNative' -ErrorAction SilentlyContinue)) `
    -Message 'generic native wsb invocation helper must remain private'
Assert-Cx004True -Condition ($null -eq (Get-Command -Name 'Invoke-Cx004BoundedNative' -ErrorAction SilentlyContinue)) `
    -Message 'generic bounded native process helper must remain private'

# The private primitive returns facts; its closed callers assign the typed
# operation classification. Exercise its timeout and each output-overflow lane
# without launching Windows Sandbox.
$boundedNativeFixture = {
    param([hashtable]$Parameters)
    Invoke-Cx004BoundedNative @Parameters
}
$pwshPath = Join-Path $PSHOME 'pwsh.exe'
Assert-Cx004True -Condition (Test-Path -LiteralPath $pwshPath -PathType Leaf) `
    -Message 'PowerShell executable must exist for bounded native-runner fixtures'

$timeoutReceipt = & $sandboxModule $boundedNativeFixture @{
    ExecutablePath = $pwshPath
    Arguments = [string[]] @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Threading.Thread]::Sleep(10000)'
    )
    WorkingDirectory = $PSScriptRoot
    TimeoutSeconds = 1
    MaxStdoutBytes = 4096
    MaxStderrBytes = 4096
    ScrubEnvironment = $true
}
Assert-Cx004Equal -Actual $timeoutReceipt.TimedOut -Expected $true `
    -Message 'bounded native runner must positively report its deadline expiry'
Assert-Cx004Equal -Actual $timeoutReceipt.OutputExceeded -Expected $false `
    -Message 'timeout fixture must not be mislabeled as output overflow'
Assert-Cx004Equal -Actual $timeoutReceipt.KillAttempted -Expected $true `
    -Message 'bounded native runner must kill only its retained timed-out process'
Assert-Cx004Equal -Actual $timeoutReceipt.KillSucceeded -Expected $true `
    -Message 'bounded native runner must positively report timeout kill success'
Assert-Cx004Equal -Actual $timeoutReceipt.ProcessExited -Expected $true `
    -Message 'bounded native runner must observe process exit after timeout kill'
Assert-Cx004True -Condition ([long]$timeoutReceipt.ElapsedMilliseconds -lt 8000) `
    -Message 'bounded native timeout must return well before the child natural exit'

$stdoutCap = 1024
$stdoutOverflowReceipt = & $sandboxModule $boundedNativeFixture @{
    ExecutablePath = $pwshPath
    Arguments = [string[]] @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Console]::Out.Write(('x' * 131072)); [Console]::Out.Flush(); [Threading.Thread]::Sleep(10000)"
    )
    WorkingDirectory = $PSScriptRoot
    TimeoutSeconds = 10
    MaxStdoutBytes = $stdoutCap
    MaxStderrBytes = 4096
    ScrubEnvironment = $true
}
Assert-Cx004Equal -Actual $stdoutOverflowReceipt.TimedOut -Expected $false `
    -Message 'stdout overflow fixture must not be mislabeled as timeout'
Assert-Cx004Equal -Actual $stdoutOverflowReceipt.OutputExceeded -Expected $true `
    -Message 'bounded native runner must report stdout overflow'
Assert-Cx004True -Condition ([long]$stdoutOverflowReceipt.StdoutBytes -ge $stdoutCap) `
    -Message 'stdout receipt must prove that the observed stream crossed its cap'
Assert-Cx004True -Condition (
    [Text.Encoding]::UTF8.GetByteCount([string]$stdoutOverflowReceipt.Stdout) -le $stdoutCap
) -Message 'retained stdout must never allocate beyond its configured byte cap'
Assert-Cx004Equal -Actual $stdoutOverflowReceipt.KillAttempted -Expected $true `
    -Message 'stdout overflow must terminate the one retained child process'
Assert-Cx004Equal -Actual $stdoutOverflowReceipt.KillSucceeded -Expected $true `
    -Message 'stdout overflow must positively report retained-child termination'
Assert-Cx004Equal -Actual $stdoutOverflowReceipt.ProcessExited -Expected $true `
    -Message 'stdout overflow must positively observe child process exit'

$stderrCap = 1024
$stderrOverflowReceipt = & $sandboxModule $boundedNativeFixture @{
    ExecutablePath = $pwshPath
    Arguments = [string[]] @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Console]::Error.Write(('y' * 131072)); [Console]::Error.Flush(); [Threading.Thread]::Sleep(10000)"
    )
    WorkingDirectory = $PSScriptRoot
    TimeoutSeconds = 10
    MaxStdoutBytes = 4096
    MaxStderrBytes = $stderrCap
    ScrubEnvironment = $true
}
Assert-Cx004Equal -Actual $stderrOverflowReceipt.TimedOut -Expected $false `
    -Message 'stderr overflow fixture must not be mislabeled as timeout'
Assert-Cx004Equal -Actual $stderrOverflowReceipt.OutputExceeded -Expected $true `
    -Message 'bounded native runner must report stderr overflow'
Assert-Cx004True -Condition ([long]$stderrOverflowReceipt.StderrBytes -ge $stderrCap) `
    -Message 'stderr receipt must prove that the observed stream crossed its cap'
Assert-Cx004True -Condition (
    [Text.Encoding]::UTF8.GetByteCount([string]$stderrOverflowReceipt.Stderr) -le $stderrCap
) -Message 'retained stderr must never allocate beyond its configured byte cap'
Assert-Cx004Equal -Actual $stderrOverflowReceipt.KillAttempted -Expected $true `
    -Message 'stderr overflow must terminate the one retained child process'
Assert-Cx004Equal -Actual $stderrOverflowReceipt.KillSucceeded -Expected $true `
    -Message 'stderr overflow must positively report retained-child termination'
Assert-Cx004Equal -Actual $stderrOverflowReceipt.ProcessExited -Expected $true `
    -Message 'stderr overflow must positively observe child process exit'

# Reproduce the exact inherited-pipe lifecycle without starting Sandbox: a short-lived
# retained launcher starts one long-lived child with inherited stdout/stderr writers.
# The runner must cancel/close and settle only its reader side, discard incomplete text,
# return while the exact child remains alive, and scope that disposition to connect.
$inheritedPipeFixtureId = [guid]::NewGuid().ToString('D')
$inheritedPipeBase = [System.IO.Path]::GetFullPath((Join-Path `
    ([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)) `
    'PC-SDK-Next\cx-004-contract-tests\inherited-pipe'))
$inheritedPipeRoot = [System.IO.Path]::GetFullPath((Join-Path $inheritedPipeBase $inheritedPipeFixtureId))
$childIdentityPath = Join-Path $inheritedPipeRoot 'retained-child.json'
$null = New-Item -ItemType Directory -Path $inheritedPipeRoot -Force
$retainedChildProcess = $null
$retainedChildIdentity = $null
$childIdentityLiteral = $childIdentityPath.Replace("'", "''")
$pwshLiteral = $pwshPath.Replace("'", "''")
$childScript = @'
[Console]::Out.Write('cx004-inherited-writer')
[Console]::Out.Flush()
[Threading.Thread]::Sleep(60000)
'@
$encodedChildScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
$parentScript = @"
`$start = [Diagnostics.ProcessStartInfo]::new()
`$start.FileName = '$pwshLiteral'
`$start.UseShellExecute = `$false
`$start.CreateNoWindow = `$true
[void]`$start.ArgumentList.Add('-NoLogo')
[void]`$start.ArgumentList.Add('-NoProfile')
[void]`$start.ArgumentList.Add('-NonInteractive')
[void]`$start.ArgumentList.Add('-EncodedCommand')
[void]`$start.ArgumentList.Add('$encodedChildScript')
`$child = [Diagnostics.Process]::Start(`$start)
try {
    `$identity = [ordered]@{
        processId = [int]`$child.Id
        startTimeUtcTicks = [long]`$child.StartTime.ToUniversalTime().Ticks
        expectedPath = '$pwshLiteral'
    }
    `$json = `$identity | ConvertTo-Json -Compress
    [IO.File]::WriteAllText('$childIdentityLiteral', `$json, [Text.UTF8Encoding]::new(`$false))
    [Console]::Out.Write('cx004-incomplete-launcher-output')
    [Console]::Out.Flush()
}
catch {
    `$parentError = `$_
    if (-not `$child.HasExited) {
        `$child.Kill(`$false)
        if (-not `$child.WaitForExit(5000)) {
            throw 'cx004-parent-child-cleanup-timeout'
        }
    }
    throw `$parentError
}
finally {
    `$child.Dispose()
}
"@
$encodedParentScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($parentScript))
$connectClassifierFixture = {
    param([object]$Receipt)
    Assert-Cx004WsbConnectNativeComplete -Receipt $Receipt
}
$strictClassifierFixture = {
    param([object]$Receipt)
    Assert-Cx004WsbNativeComplete -Receipt $Receipt
}
$copyReceiptFixture = {
    param(
        [object]$Receipt,
        [hashtable]$Overrides
    )
    $copy = [ordered]@{}
    foreach ($property in $Receipt.PSObject.Properties) {
        $copy[$property.Name] = $property.Value
    }
    foreach ($override in $Overrides.GetEnumerator()) {
        $copy[$override.Key] = $override.Value
    }
    return [pscustomobject]$copy
}
try {
    $inheritedPipeReceipt = & $sandboxModule $boundedNativeFixture @{
        ExecutablePath = $pwshPath
        Arguments = [string[]] @(
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            $encodedParentScript
        )
        WorkingDirectory = $inheritedPipeRoot
        TimeoutSeconds = 20
        MaxStdoutBytes = 4096
        MaxStderrBytes = 4096
        ScrubEnvironment = $true
    }
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.ProcessExited -Expected $true `
        -Message 'the inherited-pipe launcher must positively exit'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.ExitCode -Expected 0 `
        -Message 'the inherited-pipe launcher must exit zero'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.TimedOut -Expected $false `
        -Message 'inherited pipe writers must not be mislabeled as launcher timeout'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.OutputExceeded -Expected $false `
        -Message 'the bounded inherited-pipe fixture must stay below both output caps'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.KillAttempted -Expected $false `
        -Message 'reader settlement must not kill the retained launcher or its child'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.CaptureCompleted -Expected $false `
        -Message 'inherited pipe writers must prevent a false complete-EOF claim'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.CaptureDiscarded -Expected $true `
        -Message 'incomplete inherited-pipe text must have the explicit discarded disposition'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.CaptureReadersSettled -Expected $true `
        -Message 'both canceled/closed inherited-pipe readers must settle before return'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.CaptureFaulted -Expected $false `
        -Message 'expected cancellation/closure must be observed without a collector fault'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.CaptureCloseFaulted -Expected $false `
        -Message 'both inherited-pipe readers must close without an unobserved fault'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.CaptureByteCountsAvailable -Expected $true `
        -Message 'settled collectors must expose bounded observed byte counts'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.Stdout -Expected '' `
        -Message 'discarded incomplete stdout must not be returned as interpretable text'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.Stderr -Expected '' `
        -Message 'discarded incomplete stderr must not be returned as interpretable text'
    Assert-Cx004True -Condition ([long]$inheritedPipeReceipt.StdoutBytes -gt 0) `
        -Message 'the fixture must observe bounded launcher stdout before the inherited writer prevents EOF'
    Assert-Cx004Equal -Actual $inheritedPipeReceipt.StderrBytes -Expected 0 `
        -Message 'the accepted synthetic connect shape must have no observed stderr bytes'

    Assert-Cx004True -Condition (Test-Path -LiteralPath $childIdentityPath -PathType Leaf) `
        -Message 'the parent fixture must retain the exact child identity before exiting'
    $retainedChildIdentity = Get-Content -LiteralPath $childIdentityPath -Raw | ConvertFrom-Json
    $retainedChildProcess = Get-Process -Id ([int]$retainedChildIdentity.processId) -ErrorAction Stop
    Assert-Cx004Equal -Actual ([System.IO.Path]::GetFullPath($retainedChildProcess.Path)) `
        -Expected ([System.IO.Path]::GetFullPath($pwshPath)) `
        -Message 'the still-running inherited-writer child must be the exact fixture executable'
    Assert-Cx004Equal -Actual ([long]$retainedChildProcess.StartTime.ToUniversalTime().Ticks) `
        -Expected ([long]$retainedChildIdentity.startTimeUtcTicks) `
        -Message 'the still-running inherited-writer child must match the exact retained creation time'
    Assert-Cx004Equal -Actual $retainedChildProcess.HasExited -Expected $false `
        -Message 'reader settlement must return while the long-lived inherited-writer child remains alive'

    $connectReceiptFixture = [pscustomobject][ordered]@{
        ExitCode = [int]$inheritedPipeReceipt.ExitCode
        Raw = [string]$inheritedPipeReceipt.Stdout
        Stderr = [string]$inheritedPipeReceipt.Stderr
        ProcessId = [int]$inheritedPipeReceipt.ProcessId
        StdoutBytes = [long]$inheritedPipeReceipt.StdoutBytes
        StderrBytes = [long]$inheritedPipeReceipt.StderrBytes
        ElapsedMilliseconds = [long]$inheritedPipeReceipt.ElapsedMilliseconds
        TimedOut = [bool]$inheritedPipeReceipt.TimedOut
        OutputExceeded = [bool]$inheritedPipeReceipt.OutputExceeded
        KillAttempted = [bool]$inheritedPipeReceipt.KillAttempted
        KillSucceeded = [bool]$inheritedPipeReceipt.KillSucceeded
        ProcessExited = [bool]$inheritedPipeReceipt.ProcessExited
        CaptureCompleted = [bool]$inheritedPipeReceipt.CaptureCompleted
        CaptureReadersSettled = [bool]$inheritedPipeReceipt.CaptureReadersSettled
        CaptureDiscarded = [bool]$inheritedPipeReceipt.CaptureDiscarded
        CaptureFaulted = [bool]$inheritedPipeReceipt.CaptureFaulted
        CaptureCloseFaulted = [bool]$inheritedPipeReceipt.CaptureCloseFaulted
        CaptureByteCountsAvailable = [bool]$inheritedPipeReceipt.CaptureByteCountsAvailable
        BindingStable = $true
    }
    $null = & $sandboxModule $connectClassifierFixture $connectReceiptFixture
    $completeConnectReceipt = & $copyReceiptFixture $connectReceiptFixture @{
        CaptureCompleted = $true
        CaptureDiscarded = $false
        Raw = 'opaque-complete-connect-output'
        StdoutBytes = 30
    }
    $null = & $sandboxModule $connectClassifierFixture $completeConnectReceipt
    Assert-Cx004Throws -Action {
        & $sandboxModule $strictClassifierFixture $connectReceiptFixture
    } -MessagePattern 'native-capture-unproven' `
        -Message 'only the connect classifier may accept settled discarded output'

    $connectMutationCases = @(
        [pscustomobject]@{ name = 'timeout'; overrides = @{ TimedOut = $true }; pattern = 'native-process-timeout' },
        [pscustomobject]@{ name = 'overflow'; overrides = @{ OutputExceeded = $true }; pattern = 'native-output-overflow' },
        [pscustomobject]@{ name = 'kill'; overrides = @{ KillAttempted = $true; KillSucceeded = $true }; pattern = 'native-process-unproven' },
        [pscustomobject]@{ name = 'inconsistent kill'; overrides = @{ KillSucceeded = $true }; pattern = 'native-process-unproven' },
        [pscustomobject]@{ name = 'process exit'; overrides = @{ ProcessExited = $false }; pattern = 'native-process-unproven' },
        [pscustomobject]@{ name = 'process id'; overrides = @{ ProcessId = 0 }; pattern = 'native-process-unproven' },
        [pscustomobject]@{ name = 'reader settlement'; overrides = @{ CaptureReadersSettled = $false }; pattern = 'native-capture-unproven' },
        [pscustomobject]@{ name = 'byte-count availability'; overrides = @{ CaptureByteCountsAvailable = $false }; pattern = 'native-capture-unproven' },
        [pscustomobject]@{ name = 'reader close'; overrides = @{ CaptureCloseFaulted = $true }; pattern = 'native-capture-unproven' },
        [pscustomobject]@{ name = 'reader fault'; overrides = @{ CaptureFaulted = $true }; pattern = 'native-capture-unproven' },
        [pscustomobject]@{ name = 'binding'; overrides = @{ BindingStable = $false }; pattern = 'wsb-alias-binding-drift' },
        [pscustomobject]@{ name = 'missing disposition'; overrides = @{ CaptureDiscarded = $false }; pattern = 'native-capture-unproven' },
        [pscustomobject]@{ name = 'conflicting disposition'; overrides = @{ CaptureCompleted = $true }; pattern = 'native-capture-unproven' },
        [pscustomobject]@{ name = 'retained discarded stdout'; overrides = @{ Raw = 'must-not-be-retained' }; pattern = 'native-capture-unproven' },
        [pscustomobject]@{ name = 'retained discarded stderr'; overrides = @{ Stderr = 'must-not-be-retained' }; pattern = 'native-capture-unproven' },
        [pscustomobject]@{ name = 'exit code'; overrides = @{ ExitCode = 1 }; pattern = 'unknown-connect-result' },
        [pscustomobject]@{ name = 'observed stderr'; overrides = @{ StderrBytes = 1 }; pattern = 'unknown-connect-result' }
    )
    foreach ($mutationCase in $connectMutationCases) {
        $mutatedReceipt = & $copyReceiptFixture $connectReceiptFixture $mutationCase.overrides
        Assert-Cx004Throws -Action {
            & $sandboxModule $connectClassifierFixture $mutatedReceipt
        } -MessagePattern $mutationCase.pattern `
            -Message "connect classifier must reject mutated $($mutationCase.name) evidence"
    }
}
finally {
    if ($null -eq $retainedChildIdentity -and
        (Test-Path -LiteralPath $childIdentityPath -PathType Leaf)) {
        $retainedChildIdentity = Get-Content -LiteralPath $childIdentityPath -Raw | ConvertFrom-Json
    }
    if ($null -eq $retainedChildProcess -and $null -ne $retainedChildIdentity) {
        $retainedChildProcess = Get-Process -Id ([int]$retainedChildIdentity.processId) -ErrorAction SilentlyContinue
    }
    if ($null -ne $retainedChildProcess) {
        $retainedChildProcess.Refresh()
        if (-not $retainedChildProcess.HasExited) {
            Assert-Cx004Equal -Actual ([System.IO.Path]::GetFullPath($retainedChildProcess.Path)) `
                -Expected ([System.IO.Path]::GetFullPath($pwshPath)) `
                -Message 'cleanup refuses to terminate a child whose executable identity drifted'
            Assert-Cx004Equal -Actual ([long]$retainedChildProcess.StartTime.ToUniversalTime().Ticks) `
                -Expected ([long]$retainedChildIdentity.startTimeUtcTicks) `
                -Message 'cleanup refuses to terminate a reused or mismatched process id'
            $retainedChildProcess.Kill($false)
            Assert-Cx004Equal -Actual ($retainedChildProcess.WaitForExit(5000)) -Expected $true `
                -Message 'the exact synthetic inherited-writer child must exit during bounded cleanup'
        }
        $retainedChildProcess.Dispose()
        Assert-Cx004True -Condition ($null -eq (Get-Process -Id ([int]$retainedChildIdentity.processId) -ErrorAction SilentlyContinue)) `
            -Message 'synthetic inherited-writer cleanup must leave no exact retained child'
    }
    if (Test-Path -LiteralPath $inheritedPipeRoot) {
        $rootItem = Get-Item -LiteralPath $inheritedPipeRoot -Force
        Assert-Cx004Equal -Actual $rootItem.Name -Expected $inheritedPipeFixtureId `
            -Message 'inherited-pipe cleanup must target only its exact fresh fixture id'
        Assert-Cx004Equal -Actual ([bool]($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) -Expected $false `
            -Message 'inherited-pipe cleanup refuses a reparse-point fixture root'
        Assert-Cx004True -Condition $inheritedPipeRoot.StartsWith(
            "$($inheritedPipeBase.TrimEnd([IO.Path]::DirectorySeparatorChar))$([IO.Path]::DirectorySeparatorChar)",
            [StringComparison]::OrdinalIgnoreCase
        ) -Message 'inherited-pipe cleanup must remain beneath its dedicated local test root'
        Remove-Item -LiteralPath $inheritedPipeRoot -Recurse -Force
    }
}

# Integrity is normalized from the mandatory-label SID. The localized whoami
# label remains local evidence and never becomes the tracked semantic value.
$integrityFunctionRaw = Get-Cx004FunctionSource `
    -Path $probePath `
    -Name 'ConvertTo-Cx004IntegrityAlias'
$integrityCases = [ordered]@{
    'S-1-16-4096' = 'low'
    'S-1-16-8192' = 'medium'
    'S-1-16-8448' = 'medium-plus'
    'S-1-16-12288' = 'high'
    'S-1-16-16384' = 'system'
}
foreach ($integrityCase in $integrityCases.GetEnumerator()) {
    $actualAlias = Invoke-Cx004ExtractedFunction `
        -FunctionSource $integrityFunctionRaw `
        -Invocation "ConvertTo-Cx004IntegrityAlias -Sid '$($integrityCase.Key)'"
    Assert-Cx004Equal -Actual $actualAlias -Expected $integrityCase.Value `
        -Message "mandatory-label SID $($integrityCase.Key) must normalize to a stable safe alias"
}
Assert-Cx004Throws -Action {
    Invoke-Cx004ExtractedFunction `
        -FunctionSource $integrityFunctionRaw `
        -Invocation "ConvertTo-Cx004IntegrityAlias -Sid 'S-1-16-9999'"
} -MessagePattern '(?i)(?:outside the closed well-known set|integrity SID.*(?:unknown|unsupported))' `
    -Message 'an unknown mandatory-label SID must not be guessed or tracked'

$routableFunctionRaw = Get-Cx004FunctionSource `
    -Path $probePath `
    -Name 'Test-Cx004RoutableAddress'
$siteLocalIsRoutable = Invoke-Cx004ExtractedFunction `
    -FunctionSource $routableFunctionRaw `
    -Invocation "Test-Cx004RoutableAddress -Address ([System.Net.IPAddress]::Parse('fec0::1'))"
Assert-Cx004Equal -Actual $siteLocalIsRoutable -Expected $true `
    -Message 'an IPv6 site-local address must be reported as routable guest evidence'

$hostCanaryEndpointFunctionRaw = Get-Cx004FunctionSource `
    -Path $probePath `
    -Name 'Assert-Cx004HostCanaryEndpoint'
$null = Invoke-Cx004ExtractedFunction `
    -FunctionSource $hostCanaryEndpointFunctionRaw `
    -Invocation "Assert-Cx004HostCanaryEndpoint -Address '192.168.86.55' -Port 54321 -Context 'fixture'"
foreach ($unsafeEndpointInvocation in @(
    "Assert-Cx004HostCanaryEndpoint -Address '127.0.0.1' -Port 54321 -Context 'fixture'",
    "Assert-Cx004HostCanaryEndpoint -Address '0.0.0.0' -Port 54321 -Context 'fixture'",
    "Assert-Cx004HostCanaryEndpoint -Address '224.0.0.1' -Port 54321 -Context 'fixture'",
    "Assert-Cx004HostCanaryEndpoint -Address '192.168.86.55' -Port 0 -Context 'fixture'"
)) {
    Assert-Cx004Throws -Action {
        Invoke-Cx004ExtractedFunction `
            -FunctionSource $hostCanaryEndpointFunctionRaw `
            -Invocation $unsafeEndpointInvocation
    } -MessagePattern '(?i)(?:host-canary|fixture).*(?:address|port).*must' `
        -Message 'guest must reject an unsafe or unusable dynamic host-canary endpoint'
}

# Exercise the exact guest-compatible functions and parser under the real
# Windows PowerShell 5.1 executable used by Sandbox LogonCommand.
$windowsPowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Assert-Cx004True -Condition (Test-Path -LiteralPath $windowsPowerShellPath -PathType Leaf) `
    -Message 'Windows PowerShell 5.1 executable must exist for guest compatibility fixture'
$parsePathLiterals = @($bootstrapPath, $probePath) | ForEach-Object {
    "'$([System.IO.Path]::GetFullPath($_).Replace("'", "''"))'"
}
$ps51Fixture = @"
Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'
if (`$PSVersionTable.PSVersion.Major -ne 5 -or `$PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'unexpected-powershell-version'
}
foreach (`$path in @($($parsePathLiterals -join ', '))) {
    `$tokens = `$null
    `$parseErrors = `$null
    [void][System.Management.Automation.Language.Parser]::ParseFile(`$path, [ref]`$tokens, [ref]`$parseErrors)
    if (`$parseErrors.Count -ne 0) {
        throw "guest-parse-failed: `$path"
    }
}
$integrityFunctionRaw
$routableFunctionRaw
$hostCanaryEndpointFunctionRaw
if ((ConvertTo-Cx004IntegrityAlias -Sid 'S-1-16-12288') -cne 'high') {
    throw 'integrity-runtime-fixture-failed'
}
if (-not (Test-Cx004RoutableAddress -Address ([System.Net.IPAddress]::Parse('fec0::1')))) {
    throw 'ipv6-runtime-fixture-failed'
}
[void](Assert-Cx004HostCanaryEndpoint -Address '192.168.86.55' -Port 54321 -Context 'fixture')
[Console]::Out.Write('cx004-ps51-ok')
"@
$encodedPs51Fixture = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ps51Fixture))
$ps51Result = Invoke-Cx004BoundedTestProcess `
    -FilePath $windowsPowerShellPath `
    -Arguments @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        $encodedPs51Fixture
    )
Assert-Cx004Equal -Actual $ps51Result.ExitCode -Expected 0 `
    -Message "Windows PowerShell 5.1 guest fixture must exit successfully: $($ps51Result.Stderr)"
Assert-Cx004Equal -Actual $ps51Result.Stdout -Expected 'cx004-ps51-ok' `
    -Message 'Windows PowerShell 5.1 guest fixture must emit only its exact success marker'
Assert-Cx004Equal -Actual $ps51Result.Stderr -Expected '' `
    -Message 'Windows PowerShell 5.1 guest fixture must emit no error stream text'

# Strict raw-list parsing accepts only the discovered modern 0.5.3.0 closed shape.
$emptyListRaw = '{"WindowsSandboxEnvironments":[]}'
$firstSessionId = '11111111-1111-4111-8111-111111111111'
$secondSessionId = '22222222-2222-4222-8222-222222222222'
$oneSessionRaw = "{`"WindowsSandboxEnvironments`": [{`"Id`": `"$firstSessionId`"}]}"
$parsedEmpty = @(ConvertFrom-Cx004WsbListRaw -RawJson $emptyListRaw)
$parsedOne = @(ConvertFrom-Cx004WsbListRaw -RawJson $oneSessionRaw)
Assert-Cx004Equal -Actual $parsedEmpty.Count -Expected 0 `
    -Message 'empty modern wsb list output must parse as no running sessions'
Assert-Cx004Equal -Actual $parsedOne.Count -Expected 1 `
    -Message 'one modern wsb list row must parse as one running session'
Assert-Cx004Equal -Actual ([string]$parsedOne[0]).ToLowerInvariant() -Expected $firstSessionId `
    -Message 'parsed running-session identity must equal the exact CLI identity'

$startRaw = "{`"Id`":`"$firstSessionId`"}"
Assert-Cx004Equal -Actual (ConvertFrom-Cx004WsbStartRaw -RawJson $startRaw) `
    -Expected $firstSessionId `
    -Message 'start parser must return the exact canonical retained session identity'
Assert-Cx004Throws -Action {
    ConvertFrom-Cx004WsbStartRaw -RawJson "{`"Id`":`"$firstSessionId`",`"extra`":true}"
} -MessagePattern 'unknown-json-shape' `
    -Message 'start parser must reject extra receipt keys'
Assert-Cx004Throws -Action {
    ConvertFrom-Cx004WsbStartRaw -RawJson '{"Id":"not-a-guid"}'
} -MessagePattern 'invalid-session-id' `
    -Message 'start parser must reject a noncanonical session identity'

# Modern wsb 0.5.3.0 stop --raw reports success with exact empty stdout. Any
# other shape is unknown and therefore cannot be accepted as a stop receipt.
$null = ConvertFrom-Cx004WsbStopRaw -RawOutput ''
foreach ($invalidStopRaw in @(
    ' ',
    "`n",
    'null',
    '{}',
    "{`"Id`":`"$firstSessionId`"}"
)) {
    Assert-Cx004Throws -Action {
        ConvertFrom-Cx004WsbStopRaw -RawOutput $invalidStopRaw
    } -MessagePattern 'CX004\[(?:unknown-stop-(?:output|shape)|unknown-raw-shape|unknown-json-shape)\]' `
        -Message 'nonempty or whitespace-only stop output must be classified as unknown'
}

$null = Assert-Cx004NoRunningSessions -RawJson $emptyListRaw
Assert-Cx004Throws -Action { Assert-Cx004NoRunningSessions -RawJson $oneSessionRaw } `
    -MessagePattern 'preexisting-running-session' `
    -Message 'any initial running session must fail closed with the typed marker'

$invalidListCases = @(
    'not-json',
    '{}',
    '{"windowssandboxenvironments":[]}',
    '{"WindowsSandboxEnvironments":null}',
    '{"WindowsSandboxEnvironments":[],"extra":true}',
    "{`"WindowsSandboxEnvironments`": [{`"Id`": `"$firstSessionId`", `"extra`": true}]}",
    '{"WindowsSandboxEnvironments":{}}',
    "{`"WindowsSandboxEnvironments`": [{`"Id`": `"$firstSessionId`"}, {`"Id`": `"$firstSessionId`"}]}",
    '{"WindowsSandboxEnvironments":[{"Id":"not-a-guid"}]}',
    "{`"WindowsSandboxEnvironments`": [{`"Id`": `"$firstSessionId`"}], `"Other`": [{`"Id`": `"$secondSessionId`"}]}"
)
foreach ($invalidListRaw in $invalidListCases) {
    Assert-Cx004Throws -Action { ConvertFrom-Cx004WsbListRaw -RawJson $invalidListRaw } `
        -MessagePattern 'CX004\[(?:invalid-json|invalid-json-shape|unknown-json-shape|duplicate-session-id|invalid-session-id)\]' `
        -Message 'unknown, malformed, or duplicate wsb list output must fail closed'
}

# Rendering changes only a new dynamic output file under the dedicated run root.
$knownLocalAppData = [System.Environment]::GetFolderPath(
    [System.Environment+SpecialFolder]::LocalApplicationData
)
$runsBase = [System.IO.Path]::GetFullPath(
    (Join-Path $knownLocalAppData 'PC-SDK-Next\cx-004-runs\contract-tests')
)
$testRunId = [guid]::NewGuid().ToString('D')
$testRunRoot = [System.IO.Path]::GetFullPath((Join-Path $runsBase $testRunId))
$inputHostPath = Join-Path $testRunRoot 'input'
$outputHostPath = Join-Path $testRunRoot 'output'
$renderedPath = Join-Path $testRunRoot 'sandbox.wsb'

Assert-Cx004True -Condition $testRunRoot.StartsWith(
    "$($runsBase.TrimEnd([System.IO.Path]::DirectorySeparatorChar))$([System.IO.Path]::DirectorySeparatorChar)",
    [System.StringComparison]::OrdinalIgnoreCase
) -Message 'contract-test run root must remain beneath the dedicated CX-004 run root'

$stablePaths = @($templatePath, $bootstrapPath, $probePath)
$stableHashesBefore = @{}
foreach ($stablePath in $stablePaths) {
    $stableHashesBefore[$stablePath] = (Get-FileHash -LiteralPath $stablePath -Algorithm SHA256).Hash
}

try {
    $null = New-Item -ItemType Directory -Path $inputHostPath -Force
    $null = New-Item -ItemType Directory -Path $outputHostPath -Force

    $null = Render-Cx004SandboxConfig `
        -TemplatePath $templatePath `
        -InputHostPath $inputHostPath `
        -OutputHostPath $outputHostPath `
        -DestinationPath $renderedPath

    Assert-Cx004True -Condition (Test-Path -LiteralPath $renderedPath -PathType Leaf) `
        -Message 'renderer must create a distinct dynamic configuration file'
    Assert-Cx004True -Condition (-not [System.IO.Path]::GetFullPath($renderedPath).Equals(
        [System.IO.Path]::GetFullPath($templatePath),
        [System.StringComparison]::OrdinalIgnoreCase
    )) -Message 'renderer must never overwrite the stable template'

    $renderedRaw = Get-Content -LiteralPath $renderedPath -Raw
    Assert-Cx004NotMatches -Actual $renderedRaw -Pattern '\{\{[A-Z0-9_]+\}\}' `
        -Message 'rendered configuration must contain no unresolved substitutions'
    [xml]$renderedXml = $renderedRaw
    $renderedMappings = @($renderedXml.SelectNodes('/Configuration/MappedFolders/MappedFolder'))
    Assert-Cx004Equal -Actual $renderedMappings.Count -Expected 2 `
        -Message 'rendered configuration must retain exactly two mappings'
    Assert-Cx004Equal -Actual $renderedMappings[0].SelectSingleNode('HostFolder').InnerText `
        -Expected ([System.IO.Path]::GetFullPath($inputHostPath)) `
        -Message 'renderer must substitute only the canonical input host path'
    Assert-Cx004Equal -Actual $renderedMappings[1].SelectSingleNode('HostFolder').InnerText `
        -Expected ([System.IO.Path]::GetFullPath($outputHostPath)) `
        -Message 'renderer must substitute only the canonical output host path'

    foreach ($stablePath in $stablePaths) {
        Assert-Cx004Equal `
            -Actual (Get-FileHash -LiteralPath $stablePath -Algorithm SHA256).Hash `
            -Expected $stableHashesBefore[$stablePath] `
            -Message "rendering must not change pinned bytes: $stablePath"
    }

    $renderedHash = (Get-FileHash -LiteralPath $renderedPath -Algorithm SHA256).Hash
    Assert-Cx004Throws -Action {
        Render-Cx004SandboxConfig `
            -TemplatePath $templatePath `
            -InputHostPath $inputHostPath `
            -OutputHostPath $outputHostPath `
            -DestinationPath $renderedPath
    } -MessagePattern 'existing-render-destination' `
        -Message 'renderer must never replace an existing dynamic configuration'
    Assert-Cx004Equal -Actual (Get-FileHash -LiteralPath $renderedPath -Algorithm SHA256).Hash `
        -Expected $renderedHash `
        -Message 'existing rendered configuration bytes must remain unchanged after refusal'

    $wrongMappingRoot = Join-Path $testRunRoot 'wrong-mapping-fixture'
    $wrongInputPath = Join-Path $wrongMappingRoot 'not-input'
    $wrongOutputPath = Join-Path $wrongMappingRoot 'output'
    $wrongDestinationPath = Join-Path $wrongMappingRoot 'sandbox.wsb'
    $null = New-Item -ItemType Directory -Path $wrongInputPath -Force
    $null = New-Item -ItemType Directory -Path $wrongOutputPath -Force
    Assert-Cx004Throws -Action {
        Render-Cx004SandboxConfig `
            -TemplatePath $templatePath `
            -InputHostPath $wrongInputPath `
            -OutputHostPath $wrongOutputPath `
            -DestinationPath $wrongDestinationPath
    } -MessagePattern 'unsafe-mapping-(?:leaf|path)' `
        -Message 'renderer must require exact input and output mapping leaves'
    Assert-Cx004True -Condition (-not (Test-Path -LiteralPath $wrongDestinationPath)) `
        -Message 'invalid mapping leaves must be refused before rendered output mutation'

    $otherRunFixture = Join-Path $testRunRoot 'other-run-fixture'
    $otherOutputPath = Join-Path $otherRunFixture 'output'
    $otherDestinationPath = Join-Path $otherRunFixture 'sandbox.wsb'
    $null = New-Item -ItemType Directory -Path $otherOutputPath -Force
    Assert-Cx004Throws -Action {
        Render-Cx004SandboxConfig `
            -TemplatePath $templatePath `
            -InputHostPath $inputHostPath `
            -OutputHostPath $otherOutputPath `
            -DestinationPath $otherDestinationPath
    } -MessagePattern 'unsafe-render-destination' `
        -Message 'renderer must not combine mapping paths from different dynamic run roots'
    Assert-Cx004True -Condition (-not (Test-Path -LiteralPath $otherDestinationPath)) `
        -Message 'cross-run mapping mismatch must be refused before rendered output mutation'
}
finally {
    if (Test-Path -LiteralPath $testRunRoot) {
        $runItem = Get-Item -LiteralPath $testRunRoot -Force
        $isReparsePoint = [bool]($runItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
        Assert-Cx004True -Condition (-not $isReparsePoint) `
            -Message 'contract-test cleanup refuses a reparse-point run root'
        Assert-Cx004Equal -Actual $runItem.Name -Expected $testRunId `
            -Message 'contract-test cleanup must target only its exact fresh run id'
        Remove-Item -LiteralPath $testRunRoot -Recurse -Force
    }
}

# The tracked projection contains only aggregate local-evidence binding and redacted semantics.
$safeSemanticFacts = [ordered]@{
    hostFullBuild = '26200.8655'
    hostEditionId = 'Professional'
    hostInstallationType = 'Client'
    hostArchitecture = 'AMD64'
    sandboxPackageFullName = 'MicrosoftWindows.WindowsSandbox_0.5.3.0_x64__cw5n1h2txyewy'
    sandboxPackageVersion = '0.5.3.0'
    cliVersion = '0.5.3.0'
    guestFullBuild = '26200.1000'
    guestDisplayVersion = '25H2'
    guestEditionId = 'Professional'
    guestInstallationType = 'Client'
    guestProductType = 1
    guestArchitecture = 'AMD64'
    guestProcessArchitecture = 'AMD64'
    guestIntegrityLevel = 'high'
    guestGroupCount = 12
    guestPrivilegeCount = 20
    templateSha256 = ('11' * 32)
    stableManifestSha256 = ('22' * 32)
    sessionRuns = 2
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
    requestedMemoryMiB = 4096
}
$localEvidenceBundleSha256 = ('ab' * 32)
$trackedReceipt = New-Cx004TrackedReceipt `
    -LocalEvidenceBundleSha256 $localEvidenceBundleSha256 `
    -SemanticFacts $safeSemanticFacts

$trackedReceiptJson = $trackedReceipt | ConvertTo-Json -Depth 32 -Compress
$trackedPropertyNames = @(Get-Cx004PropertyNamesRecursive -Value $trackedReceipt)
Assert-Cx004Matches -Actual $trackedReceiptJson -Pattern ([regex]::Escape($localEvidenceBundleSha256)) `
    -Message 'tracked receipt must bind the aggregate local evidence bundle SHA-256'
Assert-Cx004Matches -Actual $trackedReceiptJson -Pattern 'runner-readiness-only' `
    -Message 'tracked receipt must state its runner-readiness-only scope'
Assert-Cx004Matches -Actual $trackedReceiptJson -Pattern 'sandbox-session-stopped' `
    -Message 'tracked receipt must state the bounded teardown level'
Assert-Cx004Matches -Actual $trackedReceiptJson -Pattern 'host-smoke-only' `
    -Message 'tracked receipt must state the bounded host-smoke scope'
Assert-Cx004Matches -Actual $trackedReceiptJson -Pattern '"guestIntegrityLevel":"high"' `
    -Message 'tracked receipt must retain only the normalized integrity-level alias'
Assert-Cx004NotMatches -Actual $trackedReceiptJson -Pattern 'guestIntegrityName' `
    -Message 'tracked receipt must not expose the provider/localized integrity-name field'
Assert-Cx004NotMatches -Actual $trackedReceiptJson -Pattern '(?i)Mandatory Label\\|Mandatory Level' `
    -Message 'localized raw integrity text must remain only in the local evidence bundle'

$forbiddenTrackedProperties = @(
    'machineName',
    'userName',
    'userSid',
    'profilePath',
    'integrityName',
    'integritySid',
    'integrity',
    'sid',
    'challenge',
    'sessionId'
)
foreach ($forbiddenProperty in $forbiddenTrackedProperties) {
    Assert-Cx004True -Condition ($forbiddenProperty -cnotin $trackedPropertyNames) `
        -Message "tracked receipt must omit raw field $forbiddenProperty"
    Assert-Cx004NotMatches -Actual $trackedReceiptJson `
        -Pattern ("(?i)[`"']$([regex]::Escape($forbiddenProperty))[`"']\s*:") `
        -Message "tracked receipt serialization must omit raw field $forbiddenProperty"
}

$unsafeSemanticFacts = [ordered]@{}
foreach ($entry in $safeSemanticFacts.GetEnumerator()) {
    $unsafeSemanticFacts[$entry.Key] = $entry.Value
}
$unsafeSemanticFacts.Remove('hostFullBuild')
$unsafeSemanticFacts.machineName = 'enumerable-machine-name'
Assert-Cx004Throws -Action {
    New-Cx004TrackedReceipt `
        -LocalEvidenceBundleSha256 $localEvidenceBundleSha256 `
        -SemanticFacts $unsafeSemanticFacts
} -MessagePattern 'unsafe-tracked-(?:receipt-)?(?:field|value)' `
    -Message 'tracked receipt builder must reject raw identity fields rather than serialize them'

$unsafeNestedFacts = [ordered]@{}
foreach ($entry in $safeSemanticFacts.GetEnumerator()) {
    $unsafeNestedFacts[$entry.Key] = $entry.Value
}
$unsafeNestedFacts.sessionRuns = @(
    [ordered]@{
        ordinal = 1
        outcome = 'passed'
        sessionId = '11111111-1111-4111-8111-111111111111'
    }
)
Assert-Cx004Throws -Action {
    New-Cx004TrackedReceipt `
        -LocalEvidenceBundleSha256 $localEvidenceBundleSha256 `
        -SemanticFacts $unsafeNestedFacts
} -MessagePattern 'unsafe-tracked-(?:receipt-)?(?:field|value)' `
    -Message 'tracked receipt builder must reject raw identity fields nested inside allowed semantic facts'

$rawIntegrityFacts = [ordered]@{}
foreach ($entry in $safeSemanticFacts.GetEnumerator()) {
    $rawIntegrityFacts[$entry.Key] = $entry.Value
}
$rawIntegrityFacts.guestIntegrityLevel = 'High Mandatory Level'
Assert-Cx004Throws -Action {
    New-Cx004TrackedReceipt `
        -LocalEvidenceBundleSha256 $localEvidenceBundleSha256 `
        -SemanticFacts $rawIntegrityFacts
} -MessagePattern 'CX004\[invalid-tracked-value\]' `
    -Message 'tracked integrity level must reject localized raw whoami text'

# PowerShell Boolean and enum values implement ValueType; accepting ValueType as
# an integer contract would silently serialize true as 1. Numeric fields admit
# only exact integral primitives within their semantic bounds.
foreach ($numericField in @(
    'guestProductType',
    'guestGroupCount',
    'guestPrivilegeCount',
    'sessionRuns',
    'requestedMemoryMiB'
)) {
    $booleanNumericFacts = [ordered]@{}
    foreach ($entry in $safeSemanticFacts.GetEnumerator()) {
        $booleanNumericFacts[$entry.Key] = $entry.Value
    }
    $booleanNumericFacts[$numericField] = $true
    Assert-Cx004Throws -Action {
        New-Cx004TrackedReceipt `
            -LocalEvidenceBundleSha256 $localEvidenceBundleSha256 `
            -SemanticFacts $booleanNumericFacts
    } -MessagePattern 'CX004\[(?:invalid|unsafe)-tracked-(?:receipt-)?value\]' `
        -Message "tracked numeric field $numericField must reject Boolean true rather than coerce it to 1"
}

$enumNumericFacts = [ordered]@{}
foreach ($entry in $safeSemanticFacts.GetEnumerator()) {
    $enumNumericFacts[$entry.Key] = $entry.Value
}
$enumNumericFacts.guestProductType = [System.DayOfWeek]::Monday
Assert-Cx004Throws -Action {
    New-Cx004TrackedReceipt `
        -LocalEvidenceBundleSha256 $localEvidenceBundleSha256 `
        -SemanticFacts $enumNumericFacts
} -MessagePattern 'CX004\[(?:invalid|unsafe)-tracked-(?:receipt-)?value\]' `
    -Message 'tracked numeric fields must reject enum ValueType instances'

foreach ($nonIntegralCase in @(
    [pscustomobject]@{ Field = 'guestGroupCount'; Value = [double] 12 },
    [pscustomobject]@{ Field = 'requestedMemoryMiB'; Value = [decimal] 4096 },
    [pscustomobject]@{ Field = 'sessionRuns'; Value = [datetime] '2026-07-13T00:00:00Z' }
)) {
    $nonIntegralFacts = [ordered]@{}
    foreach ($entry in $safeSemanticFacts.GetEnumerator()) {
        $nonIntegralFacts[$entry.Key] = $entry.Value
    }
    $nonIntegralFacts[$nonIntegralCase.Field] = $nonIntegralCase.Value
    Assert-Cx004Throws -Action {
        New-Cx004TrackedReceipt `
            -LocalEvidenceBundleSha256 $localEvidenceBundleSha256 `
            -SemanticFacts $nonIntegralFacts
    } -MessagePattern 'CX004\[(?:invalid|unsafe)-tracked-(?:receipt-)?value\]' `
        -Message "tracked numeric field $($nonIntegralCase.Field) must reject non-integral primitive/value types"
}

# The tracked S0 manifest closes the exact worktree bytes that will be copied,
# compiled, parsed, and executed after guarded landing. It excludes itself to
# avoid a hash cycle and must remain sorted and exhaustive for the lab surface.
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $labRoot '..\..\..'))
$sourceSealManifestPath = Join-Path $repoRoot 'docs\execution\manifests\CX-004-sandbox-runner.json'
Assert-Cx004True -Condition (Test-Path -LiteralPath $sourceSealManifestPath -PathType Leaf) `
    -Message 'tracked S0 runner source manifest must exist'
$sourceSealManifest = Get-Content -LiteralPath $sourceSealManifestPath -Raw |
    ConvertFrom-Json -AsHashtable -Depth 16
Assert-Cx004Equal -Actual (($sourceSealManifest.Keys | ForEach-Object { [string] $_ }) -join ',') `
    -Expected 'schemaVersion,classification,sourceFiles' `
    -Message 'tracked S0 runner source manifest root must have the exact ordered schema'
Assert-Cx004Equal -Actual ([string] $sourceSealManifest.schemaVersion) `
    -Expected 'cx004-s0-source-seal-v1' `
    -Message 'tracked S0 runner source manifest must use the sealed schema version'
Assert-Cx004Equal -Actual ([string] $sourceSealManifest.classification) `
    -Expected 'tracked-source-seal' `
    -Message 'tracked S0 runner source manifest must retain its narrow classification'
$expectedSealedSourcePaths = @(
    'packages/windows-containment/lab/sandbox/Cx004Sandbox.psm1',
    'packages/windows-containment/lab/sandbox/Invoke-Cx004Q0S.ps1',
    'packages/windows-containment/lab/sandbox/guest-bootstrap.ps1',
    'packages/windows-containment/lab/sandbox/guest-probe.ps1',
    'packages/windows-containment/lab/sandbox/host-job-smoke.cs',
    'packages/windows-containment/lab/sandbox/sandbox.template.wsb',
    'packages/windows-containment/lab/test/sandbox-contract.test.ps1',
    'packages/windows-containment/lab/test/sandbox-host-smoke.test.ps1'
) | Sort-Object
$sealedSourceFiles = @($sourceSealManifest.sourceFiles)
Assert-Cx004Equal -Actual $sealedSourceFiles.Count -Expected $expectedSealedSourcePaths.Count `
    -Message 'tracked S0 runner source manifest must enumerate exactly the closed lab surface'
for ($index = 0; $index -lt $expectedSealedSourcePaths.Count; $index++) {
    $expectedRelativePath = $expectedSealedSourcePaths[$index]
    $entry = $sealedSourceFiles[$index]
    Assert-Cx004Equal -Actual (($entry.Keys | ForEach-Object { [string] $_ }) -join ',') `
        -Expected 'relativePath,sha256,length' `
        -Message "tracked S0 source entry $index must have the exact ordered schema"
    Assert-Cx004Equal -Actual ([string] $entry.relativePath) -Expected $expectedRelativePath `
        -Message "tracked S0 source entry $index must be ordinal-path sorted"
    $sourcePath = Join-Path $repoRoot $expectedRelativePath
    $sourceItem = Get-Item -LiteralPath $sourcePath
    Assert-Cx004Equal -Actual ([string] $entry.sha256) `
        -Expected ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()) `
        -Message "tracked S0 source hash must match worktree bytes for $expectedRelativePath"
    Assert-Cx004Equal -Actual ([long] $entry.length) -Expected ([long] $sourceItem.Length) `
        -Message "tracked S0 source length must match worktree bytes for $expectedRelativePath"
}

Write-Output "sandbox-contract.test.ps1 passed ($script:AssertionCount assertions)"
