[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $AuditPlanText
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:AuditPlanSchema = 'pc-sdk.cx-004.native-build-input-filesystem-audit-plan.v1'
$script:AuditReceiptSchema = 'pc-sdk.cx-004.native-build-input-filesystem-audit-receipt.v1'
$script:MaximumPlanCharacters = 8 * 1024 * 1024
$script:MaximumSources = 512
$script:MaximumFiles = 200000
$script:MaximumTreeEntries = 400000

function Throw-AuditFailure {
    param(
        [Parameter(Mandatory)] [ValidatePattern('^[a-z0-9-]{1,64}$')] [string] $Code,
        [Parameter(Mandatory)] [string] $Message
    )

    throw [System.InvalidOperationException]::new("$Code|$Message")
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory)] [object] $Value,
        [Parameter(Mandatory)] [string[]] $Expected,
        [Parameter(Mandatory)] [string] $Label
    )

    if ($null -eq $Value) {
        Throw-AuditFailure 'invalid-plan-shape' "$Label must be an object."
    }
    $actual = @($Value.PSObject.Properties | ForEach-Object Name)
    $actualSorted = [string[]] @($actual)
    $expectedSorted = [string[]] @($Expected)
    [Array]::Sort($actualSorted, [System.StringComparer]::Ordinal)
    [Array]::Sort($expectedSorted, [System.StringComparer]::Ordinal)
    if ($actualSorted.Length -ne $expectedSorted.Length -or
        ($actualSorted -join "`n") -cne ($expectedSorted -join "`n")) {
        Throw-AuditFailure 'invalid-plan-shape' "$Label has unknown or missing properties."
    }
}

function Assert-Identifier {
    param(
        [Parameter(Mandatory)] [object] $Value,
        [Parameter(Mandatory)] [string] $Label
    )

    if ($Value -isnot [string] -or $Value -cnotmatch '^[a-z0-9][a-z0-9._-]{0,95}$') {
        Throw-AuditFailure 'invalid-plan-identifier' "$Label is not one closed identifier."
    }
    return [string] $Value
}

function Assert-RelativePath {
    param(
        [Parameter(Mandatory)] [object] $Value,
        [Parameter(Mandatory)] [string] $Label,
        [switch] $AllowEmpty
    )

    if ($Value -isnot [string] -or $Value.IndexOf([char] 0) -ge 0 -or
        $Value.Contains('\') -or [System.IO.Path]::IsPathRooted($Value)) {
        Throw-AuditFailure 'invalid-plan-path' "$Label is not a portable relative path."
    }
    if ($Value.Length -eq 0) {
        if ($AllowEmpty) { return '' }
        Throw-AuditFailure 'invalid-plan-path' "$Label must not be empty."
    }
    foreach ($part in $Value.Split('/')) {
        if ([string]::IsNullOrEmpty($part) -or $part -ceq '.' -or $part -ceq '..' -or
            $part.Contains(':') -or $part.EndsWith('.') -or $part.EndsWith(' ')) {
            Throw-AuditFailure 'invalid-plan-path' "$Label contains a forbidden path segment."
        }
    }
    return [string] $Value
}

function Get-AuditFullPath {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    if (-not [System.IO.Path]::IsPathRooted($LiteralPath) -or
        $LiteralPath -cnotmatch '^[A-Za-z]:[\\/]' -or
        $LiteralPath.StartsWith('\\', [System.StringComparison]::Ordinal) -or
        $LiteralPath.StartsWith('\\?\', [System.StringComparison]::Ordinal) -or
        $LiteralPath.StartsWith('\\.\', [System.StringComparison]::Ordinal)) {
        Throw-AuditFailure 'nonlocal-path' 'The filesystem audit accepts only fully-qualified local drive paths.'
    }
    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
    if ($fullPath.Length -lt 3 -or $fullPath[1] -cne ':' -or
        $fullPath.Substring(2).Contains(':')) {
        Throw-AuditFailure 'nonlocal-path' 'The filesystem audit rejected a device, stream, or non-drive path.'
    }
    $loweredSegments = @($fullPath.Replace('\', '/').ToLowerInvariant().Split('/'))
    if ($loweredSegments -ccontains '.codex' -or $loweredSegments -ccontains '.claude') {
        Throw-AuditFailure 'provider-home-path' 'The filesystem audit rejected a provider-home path.'
    }
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    try {
        $drive = [System.IO.DriveInfo]::new($root)
        if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or -not $drive.IsReady) {
            Throw-AuditFailure 'nonfixed-volume' 'The filesystem audit accepts only ready fixed local volumes.'
        }
    }
    catch {
        if ($_.Exception.Message -match '^[a-z0-9-]{1,64}\|') { throw }
        Throw-AuditFailure 'volume-unproven' 'The filesystem audit could not prove a ready fixed local volume.'
    }
    if ($fullPath.Length -gt $root.Length) {
        return $fullPath.TrimEnd('\')
    }
    return $fullPath
}

function Assert-NoReparsePath {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    $fullPath = Get-AuditFullPath -LiteralPath $LiteralPath
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    try {
        $rootItem = Get-Item -LiteralPath $root -Force
    }
    catch {
        Throw-AuditFailure 'missing-path' 'A filesystem audit path root was unavailable.'
    }
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Throw-AuditFailure 'reparse-path' 'A filesystem audit path root is a reparse point.'
    }
    $relative = $fullPath.Substring($root.Length)
    $cursor = $root
    foreach ($part in ($relative -split '\\')) {
        if ([string]::IsNullOrEmpty($part)) { continue }
        $cursor = [System.IO.Path]::Combine($cursor, $part)
        try {
            $item = Get-Item -LiteralPath $cursor -Force
        }
        catch {
            Throw-AuditFailure 'missing-path' 'A selected filesystem audit path component was unavailable.'
        }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-AuditFailure 'reparse-path' 'A selected filesystem audit path component is a reparse point.'
        }
    }
    return $fullPath
}

function Assert-DirectorySurface {
    param(
        [Parameter(Mandatory)] [string] $LiteralPath,
        [Parameter(Mandatory)] [string] $Label
    )

    $fullPath = Assert-NoReparsePath -LiteralPath $LiteralPath
    try {
        $item = Get-Item -LiteralPath $fullPath -Force
    }
    catch {
        Throw-AuditFailure 'missing-directory' "$Label was unavailable."
    }
    if (-not $item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Throw-AuditFailure 'unsafe-directory' "$Label is not one non-reparse directory."
    }
    try {
        Assert-NativeAuditDirectoryStreams -LiteralPath $fullPath
    }
    catch {
        Throw-AuditFailure 'unexpected-alternate-stream' "$Label has a named alternate data stream or unproven stream closure."
    }
    return $fullPath
}

function Get-TreeRelativePaths {
    param(
        [Parameter(Mandatory)] [string] $RootPath,
        [Parameter(Mandatory)] [string] $Label,
        [Parameter(Mandatory)] [int] $RemainingFileCapacity
    )

    $root = Assert-DirectorySurface -LiteralPath $RootPath -Label "$Label root"
    $directories = [System.Collections.Generic.Stack[string]]::new()
    $directories.Push('')
    $files = [System.Collections.Generic.List[string]]::new()
    $entryCount = 0
    while ($directories.Count -ne 0) {
        $relativeDirectory = $directories.Pop()
        $directoryPath = if ($relativeDirectory.Length -eq 0) {
            $root
        } else {
            [System.IO.Path]::Combine($root, $relativeDirectory.Replace('/', '\'))
        }
        [void] (Assert-DirectorySurface -LiteralPath $directoryPath -Label "$Label directory")
        $entryList = [System.Collections.Generic.List[string]]::new()
        $enumerator = $null
        try {
            $enumerator = [System.IO.Directory]::EnumerateFileSystemEntries($directoryPath).GetEnumerator()
            while ($enumerator.MoveNext()) {
                $entryCount += 1
                if ($entryCount -gt $script:MaximumTreeEntries) {
                    Throw-AuditFailure 'tree-entry-overflow' 'The filesystem audit exceeded its fixed tree-entry cap.'
                }
                $entryList.Add([string] $enumerator.Current)
            }
        }
        catch {
            if ($_.Exception.Message -match '^[a-z0-9-]{1,64}\|') { throw }
            Throw-AuditFailure 'directory-enumeration-unproven' "$Label directory membership could not be enumerated."
        }
        finally {
            if ($null -ne $enumerator -and $enumerator -is [System.IDisposable]) {
                $enumerator.Dispose()
            }
        }
        $entryPaths = $entryList.ToArray()
        [Array]::Sort($entryPaths, [System.StringComparer]::Ordinal)
        for ($index = $entryPaths.Length - 1; $index -ge 0; $index -= 1) {
            $entryPath = $entryPaths[$index]
            $leaf = [System.IO.Path]::GetFileName($entryPath)
            $relativePath = if ($relativeDirectory.Length -eq 0) {
                $leaf
            } else {
                "$relativeDirectory/$leaf"
            }
            [void] (Assert-RelativePath -Value $relativePath -Label "$Label tree entry")
            try {
                $entry = Get-Item -LiteralPath $entryPath -Force
            }
            catch {
                Throw-AuditFailure 'tree-entry-unavailable' "$Label tree membership changed during enumeration."
            }
            if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-AuditFailure 'reparse-path' "$Label contains a reparse tree entry."
            }
            if ($entry.PSIsContainer) {
                $directories.Push($relativePath)
            } else {
                if ($files.Count -ge $RemainingFileCapacity) {
                    Throw-AuditFailure 'file-count-overflow' 'The filesystem audit exceeded its fixed file-count cap.'
                }
                $files.Add($relativePath)
            }
        }
    }
    $result = $files.ToArray()
    [Array]::Sort($result, [System.StringComparer]::Ordinal)
    return [string[]] $result
}

function Assert-FileParentSurface {
    param(
        [Parameter(Mandatory)] [string] $RootPath,
        [Parameter(Mandatory)] [string] $RelativePath,
        [Parameter(Mandatory)] [string] $Label
    )

    [void] (Assert-DirectorySurface -LiteralPath $RootPath -Label "$Label root")
    $parts = $RelativePath.Split('/')
    $cursor = $RootPath
    for ($index = 0; $index -lt $parts.Length - 1; $index += 1) {
        $cursor = [System.IO.Path]::Combine($cursor, $parts[$index])
        [void] (Assert-DirectorySurface -LiteralPath $cursor -Label "$Label parent directory")
    }
}

function Get-AuditedFileFact {
    param(
        [Parameter(Mandatory)] [string] $RootPath,
        [Parameter(Mandatory)] [string] $RelativePath,
        [Parameter(Mandatory)] [string] $LogicalPrefix,
        [Parameter(Mandatory)] [string] $Label,
        [Parameter(Mandatory)] [int] $ExpectedLinkCount
    )

    Assert-FileParentSurface -RootPath $RootPath -RelativePath $RelativePath -Label $Label
    $filePath = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::Combine($RootPath, $RelativePath.Replace('/', '\'))
    )
    if (-not $filePath.StartsWith(
        $RootPath.TrimEnd('\') + '\',
        [System.StringComparison]::OrdinalIgnoreCase)) {
        Throw-AuditFailure 'path-escape' "$Label escaped its declared source root."
    }
    [void] (Assert-NoReparsePath -LiteralPath $filePath)
    $session = $null
    try {
        $session = Open-NativeAuditFileSession -LiteralPath $filePath -ExpectedLinkCount ([uint32] $ExpectedLinkCount)
        $fact = Get-NativeAuditFileHash -Session $session
        try {
            Assert-NativeAuditFileStreams -Session $session
        }
        catch {
            Throw-AuditFailure 'unexpected-alternate-stream' "$Label does not have exactly one unnamed data stream."
        }
        [void] (Assert-NoReparsePath -LiteralPath $filePath)
        Assert-NativeAuditFileStable -Session $session
    }
    catch {
        if ($_.Exception.Message -match '^[a-z0-9-]{1,64}\|') { throw }
        Throw-AuditFailure 'file-identity-unproven' "$Label failed its handle-bound identity and streaming digest audit."
    }
    finally {
        if ($null -ne $session) { Close-NativeAuditFileSession -Session $session }
    }
    $logicalPath = if ($LogicalPrefix.Length -eq 0) {
        $RelativePath
    } else {
        "$LogicalPrefix/$RelativePath"
    }
    [void] (Assert-RelativePath -Value $logicalPath -Label "$Label logical path")
    return [ordered]@{
        identityToken = [string] $fact.IdentityToken
        tuple = @($logicalPath, [long] $fact.ByteLength, [string] $fact.Sha256)
    }
}

function Invoke-AuditSource {
    param(
        [Parameter(Mandatory)] [object] $Source,
        [Parameter(Mandatory)] [int] $RemainingFileCapacity
    )

    $hasIdentityPolicy = $null -ne $Source.PSObject.Properties['identityPolicy']
    $sourceProperties = @(
        'files',
        'logicalPrefix',
        'mode',
        'rootPath',
        'sourceId',
        'sourceIndex',
        'surfaceId'
    )
    if ($hasIdentityPolicy) { $sourceProperties += 'identityPolicy' }
    Assert-ExactProperties -Value $Source -Expected $sourceProperties -Label 'audit source'
    $sourceId = Assert-Identifier -Value $Source.sourceId -Label 'audit sourceId'
    $surfaceId = Assert-Identifier -Value $Source.surfaceId -Label 'audit surfaceId'
    if ($Source.sourceIndex -isnot [int] -and $Source.sourceIndex -isnot [long]) {
        Throw-AuditFailure 'invalid-source-index' 'An audit source index was not an integer.'
    }
    $sourceIndex = [long] $Source.sourceIndex
    if ($sourceIndex -lt 0 -or $sourceIndex -gt 4095) {
        Throw-AuditFailure 'invalid-source-index' 'An audit source index was outside its closed bound.'
    }
    if ($Source.mode -cne 'tree' -and $Source.mode -cne 'empty-tree' -and $Source.mode -cne 'files') {
        Throw-AuditFailure 'invalid-source-mode' 'An audit source mode was not tree, empty-tree, or files.'
    }
    $logicalPrefix = Assert-RelativePath `
        -Value $Source.logicalPrefix `
        -Label 'audit logicalPrefix' `
        -AllowEmpty
    $rootPath = Get-AuditFullPath -LiteralPath ([string] $Source.rootPath)
    $label = "source $sourceId"
    [void] (Assert-DirectorySurface -LiteralPath $rootPath -Label "$label root")

    if ($Source.mode -ceq 'tree' -or $Source.mode -ceq 'empty-tree') {
        if (@($Source.files).Count -ne 0) {
            Throw-AuditFailure 'invalid-plan-shape' 'A tree audit source supplied an explicit file list.'
        }
        $selected = @(Get-TreeRelativePaths `
            -RootPath $rootPath `
            -Label $label `
            -RemainingFileCapacity $RemainingFileCapacity)
    } else {
        $selectedList = [System.Collections.Generic.List[string]]::new()
        $selectedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in @($Source.files)) {
            if ($selectedList.Count -ge $RemainingFileCapacity) {
                Throw-AuditFailure 'file-count-overflow' 'The filesystem audit exceeded its fixed file-count cap.'
            }
            $selectedPath = Assert-RelativePath -Value $entry -Label "$label selected file"
            if (-not $selectedSet.Add($selectedPath)) {
                Throw-AuditFailure 'duplicate-source-path' "$label selected a file more than once under the Windows case-insensitive path model."
            }
            $selectedList.Add($selectedPath)
        }
        if ($selectedList.Count -eq 0) {
            Throw-AuditFailure 'empty-source' "$label selected no files."
        }
        $selected = $selectedList.ToArray()
        [Array]::Sort($selected, [System.StringComparer]::Ordinal)
    }
    if ($selected.Length -eq 0 -and $Source.mode -cne 'empty-tree') {
        Throw-AuditFailure 'empty-source' "$label selected no files."
    }
    if ($Source.mode -ceq 'empty-tree' -and $selected.Length -ne 0) {
        Throw-AuditFailure 'nonempty-source' "$label was required to be one exact empty directory."
    }

    $expectedLinkCount = 1
    if ($hasIdentityPolicy) {
        if ($Source.identityPolicy.kind -isnot [string]) {
            Throw-AuditFailure 'invalid-identity-policy' "$label identity policy used coercible scalar values."
        }
        $isServicedPolicy = $Source.identityPolicy.kind -ceq 'windows-servicing-hardlink-v1'
        $isGitPolicy = $Source.identityPolicy.kind -ceq 'git-for-windows-runtime-hardlink-v1'
        $isPnpmStorePolicy = $Source.identityPolicy.kind -ceq 'pnpm-content-addressed-store-hardlink-v1'
        if ($isPnpmStorePolicy) {
            Assert-ExactProperties -Value $Source.identityPolicy -Expected @('kind') -Label "$label identity policy"
            if ($Source.mode -cne 'tree' -or $surfaceId -cne 'pnpm-store-v10') {
                Throw-AuditFailure 'invalid-identity-policy' "$label pnpm store policy escaped its exact tree surface."
            }
            $expectedLinkCount = 0
        }
        else {
            Assert-ExactProperties -Value $Source.identityPolicy -Expected @('kind', 'linkCount', 'relativePaths') -Label "$label identity policy"
            if (($Source.identityPolicy.linkCount -isnot [int] -and $Source.identityPolicy.linkCount -isnot [long]) -or
                $Source.mode -cne 'files' -or
                (-not $isServicedPolicy -and -not $isGitPolicy) -or
                [long] $Source.identityPolicy.linkCount -ne 2 -or
                ($isServicedPolicy -and $surfaceId -cne 'authenticode-verification-tool' -and $surfaceId -cne 'process-tree-termination-tool') -or
                ($isGitPolicy -and $surfaceId -cne 'git-execution-closure')) {
                Throw-AuditFailure 'invalid-identity-policy' "$label identity policy was not one admitted exact two-alias policy."
            }
            $policyPaths = @($Source.identityPolicy.relativePaths)
            $policyPathSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($policyPath in $policyPaths) {
                if ($policyPath -isnot [string] -or
                    -not $policyPathSet.Add([string] $policyPath)) {
                    Throw-AuditFailure 'invalid-identity-policy' "$label identity policy repeated an alias under the Windows case-insensitive path model."
                }
            }
            if ($policyPaths.Count -ne 2 -or
                $policyPaths[0] -isnot [string] -or $policyPaths[1] -isnot [string] -or
                ($policyPaths -join "`n") -cne ($selected -join "`n")) {
                Throw-AuditFailure 'invalid-identity-policy' "$label identity policy did not bind its exact selected aliases."
            }
            $expectedLinkCount = 2
        }
    }

    $tuples = [System.Collections.Generic.List[object]]::new()
    $identityTokens = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($relativePath in $selected) {
        $audited = Get-AuditedFileFact `
            -RootPath $rootPath `
            -RelativePath $relativePath `
            -LogicalPrefix $logicalPrefix `
            -Label "$label file '$relativePath'" `
            -ExpectedLinkCount $expectedLinkCount
        $tuples.Add($audited.tuple)
        [void] $identityTokens.Add([string] $audited.identityToken)
    }
    if ($hasIdentityPolicy -and $expectedLinkCount -eq 2 -and $identityTokens.Count -ne 1) {
        Throw-AuditFailure 'hardlink-identity-mismatch' "$label aliases did not share one exact stable file identity."
    }
    if ($Source.mode -ceq 'tree' -or $Source.mode -ceq 'empty-tree') {
        $afterSelection = @(Get-TreeRelativePaths `
            -RootPath $rootPath `
            -Label $label `
            -RemainingFileCapacity $RemainingFileCapacity)
        if ($afterSelection.Length -ne $selected.Length -or
            ($afterSelection -join "`n") -cne ($selected -join "`n")) {
            Throw-AuditFailure 'directory-membership-changed' "$label membership changed during its audit."
        }
    }
    [void] (Assert-DirectorySurface -LiteralPath $rootPath -Label "$label root")
    return [ordered]@{
        files = [object[]] $tuples.ToArray()
        sourceId = $sourceId
        sourceIndex = $sourceIndex
        surfaceId = $surfaceId
    }
}

try {
    if (-not [System.Environment]::Is64BitProcess -or
        [System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        Throw-AuditFailure 'unsupported-platform' 'The native build-input filesystem audit requires 64-bit Windows.'
    }
    if ($AuditPlanText.Length -eq 0) {
        Throw-AuditFailure 'empty-plan' 'The filesystem audit plan was empty.'
    }
    if ($AuditPlanText.Length -gt $script:MaximumPlanCharacters) {
        Throw-AuditFailure 'plan-too-large' 'The filesystem audit plan exceeded its fixed character cap.'
    }
    $rawPlan = $AuditPlanText
    try {
        $plan = $rawPlan | ConvertFrom-Json
    }
    catch {
        Throw-AuditFailure 'invalid-plan-json' 'The filesystem audit plan was not valid JSON.'
    }
    Assert-ExactProperties -Value $plan -Expected @('schemaVersion', 'sources') -Label 'audit plan'
    if ($plan.schemaVersion -cne $script:AuditPlanSchema) {
        Throw-AuditFailure 'invalid-plan-schema' 'The filesystem audit plan schema was not exact.'
    }
    $sources = @($plan.sources)
    if ($sources.Count -eq 0 -or $sources.Count -gt $script:MaximumSources) {
        Throw-AuditFailure 'invalid-source-count' 'The filesystem audit source count was outside its closed bound.'
    }
    $sourceIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $results = [System.Collections.Generic.List[object]]::new()
    $fileCount = 0
    foreach ($source in $sources) {
        $result = Invoke-AuditSource `
            -Source $source `
            -RemainingFileCapacity ($script:MaximumFiles - $fileCount)
        if (-not $sourceIds.Add([string] $result.sourceId)) {
            Throw-AuditFailure 'duplicate-source-id' 'The filesystem audit plan repeated a sourceId.'
        }
        $fileCount += @($result.files).Count
        if ($fileCount -gt $script:MaximumFiles) {
            Throw-AuditFailure 'file-count-overflow' 'The filesystem audit exceeded its fixed file-count cap.'
        }
        $results.Add($result)
    }
    $receipt = [ordered]@{
        fileCount = $fileCount
        ok = $true
        schemaVersion = $script:AuditReceiptSchema
        sources = [object[]] $results.ToArray()
    }
    [Console]::Out.WriteLine(($receipt | ConvertTo-Json -Depth 8 -Compress))
}
catch {
    $code = 'filesystem-audit-failed'
    $message = 'The filesystem audit failed closed.'
    if ($_.Exception.Message -match '^([a-z0-9-]{1,64})\|(.+)$') {
        $code = $Matches[1]
        $message = $Matches[2]
    }
    $failure = [ordered]@{
        code = $code
        message = $message
        ok = $false
        schemaVersion = $script:AuditReceiptSchema
    }
    [Console]::Out.WriteLine(($failure | ConvertTo-Json -Depth 4 -Compress))
}
