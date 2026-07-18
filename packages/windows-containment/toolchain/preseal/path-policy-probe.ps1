[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PathPolicyPlanText
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:Schema = 'pc-sdk.cx-004.preseal-path-policy.v1'
$script:MaximumCharacters = 65536

function Fail-Policy {
    param([Parameter(Mandatory = $true)][string]$Code)
    throw [System.InvalidOperationException]::new($Code)
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )
    if ($null -eq $Value) { Fail-Policy 'invalid-shape' }
    $actual = [string[]]@($Value.PSObject.Properties | ForEach-Object Name)
    $wanted = [string[]]@($Expected)
    [Array]::Sort($actual, [StringComparer]::Ordinal)
    [Array]::Sort($wanted, [StringComparer]::Ordinal)
    if ($actual.Length -ne $wanted.Length -or ($actual -join "`n") -cne ($wanted -join "`n")) {
        Fail-Policy 'invalid-shape'
    }
}

function Assert-Identifier {
    param([Parameter(Mandatory = $true)][object]$Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '^[a-z0-9][a-z0-9._-]{0,95}$') {
        Fail-Policy 'invalid-identifier'
    }
    return [string]$Value
}

function Get-LocalFixedPathFact {
    param(
        [Parameter(Mandatory = $true)][object]$Entry,
        [Parameter(Mandatory = $true)][bool]$IsExclusion
    )
    Assert-ExactProperties -Value $Entry -Expected @('id', 'mustExist', 'path', 'role')
    $id = Assert-Identifier -Value $Entry.id
    if ($Entry.path -isnot [string] -or [string]::IsNullOrWhiteSpace($Entry.path) -or
        $Entry.path.IndexOf([char]0) -ge 0) {
        Fail-Policy 'invalid-path'
    }
    if ($Entry.mustExist -isnot [bool]) { Fail-Policy 'invalid-must-exist' }
    if ($Entry.role -cne 'input' -and $Entry.role -cne 'output' -and $Entry.role -cne 'exclusion') {
        Fail-Policy 'invalid-role'
    }
    if ($IsExclusion -and $Entry.role -cne 'exclusion') { Fail-Policy 'invalid-role' }
    if (-not $IsExclusion -and $Entry.role -ceq 'exclusion') { Fail-Policy 'invalid-role' }
    $literal = [string]$Entry.path
    if (-not [IO.Path]::IsPathRooted($literal) -or $literal -cnotmatch '^[A-Za-z]:[\\/]' -or
        $literal.StartsWith('\\', [StringComparison]::Ordinal) -or
        $literal.StartsWith('\\?\', [StringComparison]::Ordinal) -or
        $literal.StartsWith('\\.\', [StringComparison]::Ordinal)) {
        Fail-Policy 'nonlocal-path'
    }
    $full = [IO.Path]::GetFullPath($literal)
    $root = [IO.Path]::GetPathRoot($full)
    if ($full.Substring(2).Contains(':')) { Fail-Policy 'stream-or-device-path' }
    $drive = [IO.DriveInfo]::new($root)
    if (-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed) {
        Fail-Policy 'nonfixed-volume'
    }
    if (-not $IsExclusion -and $drive.DriveFormat -cne 'NTFS') {
        Fail-Policy 'nonntfs-volume'
    }
    if ($IsExclusion) {
        return [ordered]@{
            exists = $false
            fixedVolume = $true
            id = $id
            noReparseComponents = $false
            normalized = $full.TrimEnd('\', '/')
            role = [string]$Entry.role
        }
    }
    $cursor = $root
    $missingSeen = $false
    $relative = $full.Substring($root.Length)
    foreach ($part in ($relative -split '[\\/]')) {
        if ([string]::IsNullOrEmpty($part) -or $part -ceq '.' -or $part -ceq '..' -or
            $part.Contains(':') -or $part.EndsWith('.') -or $part.EndsWith(' ')) {
            Fail-Policy 'invalid-component'
        }
        $cursor = [IO.Path]::Combine($cursor, $part)
        if ($missingSeen) { continue }
        if (-not (Test-Path -LiteralPath $cursor)) {
            $missingSeen = $true
            continue
        }
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail-Policy 'reparse-component'
        }
    }
    if ([bool]$Entry.mustExist -and $missingSeen) { Fail-Policy 'missing-required-path' }
    $unnamedStreamOnly = $true
    if (-not $missingSeen) {
        $finalItem = Get-Item -LiteralPath $full -Force
        if ($finalItem.PSIsContainer) {
            Assert-NativeAuditDirectoryStreams -LiteralPath $full
        }
        else {
            $streams = @(Get-Item -LiteralPath $full -Stream * -Force)
            if ($streams.Count -ne 1 -or $streams[0].Stream -cne ':$DATA' -or
                [long]$streams[0].Length -ne [long]$finalItem.Length) {
                Fail-Policy 'alternate-data-stream'
            }
        }
    }
    return [ordered]@{
        exists = -not $missingSeen
        fixedVolume = $true
        id = $id
        noReparseComponents = $true
        normalized = $full.TrimEnd('\', '/')
        role = [string]$Entry.role
        unnamedStreamOnly = $unnamedStreamOnly
    }
}

function Test-Overlap {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )
    $leftValue = $Left.TrimEnd('\', '/')
    $rightValue = $Right.TrimEnd('\', '/')
    if ($leftValue.Equals($rightValue, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $leftValue.StartsWith($rightValue + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $rightValue.StartsWith($leftValue + '\', [StringComparison]::OrdinalIgnoreCase)
}

try {
    $directoryStreamCommand = Get-Command `
        -Name 'Assert-NativeAuditDirectoryStreams' `
        -CommandType Function `
        -ErrorAction SilentlyContinue
    if ($null -eq $directoryStreamCommand -or
        $directoryStreamCommand.ModuleName -cne 'PcSdkFilesystemAuditCoreExact') {
        Fail-Policy 'missing-exact-audit-core'
    }
    if ($PathPolicyPlanText.Length -gt $script:MaximumCharacters) { Fail-Policy 'plan-too-large' }
    $plan = $PathPolicyPlanText | ConvertFrom-Json
    Assert-ExactProperties -Value $plan -Expected @('exclusions', 'paths', 'schemaVersion')
    if ($plan.schemaVersion -cne $script:Schema) { Fail-Policy 'invalid-schema' }
    $pathEntries = @($plan.paths)
    $exclusionEntries = @($plan.exclusions)
    if ($pathEntries.Count -eq 0 -or $pathEntries.Count -gt 32 -or $exclusionEntries.Count -gt 16) {
        Fail-Policy 'invalid-count'
    }
    $facts = [Collections.Generic.List[object]]::new()
    $exclusions = [Collections.Generic.List[object]]::new()
    $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $pathEntries) {
        $fact = Get-LocalFixedPathFact -Entry $entry -IsExclusion $false
        if (-not $ids.Add([string]$fact.id)) { Fail-Policy 'duplicate-id' }
        $facts.Add($fact)
    }
    foreach ($entry in $exclusionEntries) {
        $fact = Get-LocalFixedPathFact -Entry $entry -IsExclusion $true
        if (-not $ids.Add([string]$fact.id)) { Fail-Policy 'duplicate-id' }
        $exclusions.Add($fact)
    }
    foreach ($output in @($facts | Where-Object role -CEQ 'output')) {
        foreach ($excluded in $exclusions) {
            if (Test-Overlap -Left $output.normalized -Right $excluded.normalized) {
                Fail-Policy 'forbidden-overlap'
            }
        }
    }
    $publicFacts = @($facts | ForEach-Object {
        [ordered]@{
            exists = $_.exists
            fixedVolume = $_.fixedVolume
            id = $_.id
            noReparseComponents = $_.noReparseComponents
            role = $_.role
            unnamedStreamOnly = $_.unnamedStreamOnly
        }
    })
    [Console]::Out.WriteLine(([ordered]@{
        facts = [object[]]$publicFacts
        ok = $true
        schemaVersion = $script:Schema
    } | ConvertTo-Json -Compress -Depth 4))
}
catch {
    $code = if ($_.Exception.Message -match '^[a-z0-9-]{1,64}$') { $_.Exception.Message } else { 'path-policy-failed' }
    [Console]::Out.WriteLine(([ordered]@{
        code = $code
        ok = $false
        schemaVersion = $script:Schema
    } | ConvertTo-Json -Compress -Depth 3))
}
