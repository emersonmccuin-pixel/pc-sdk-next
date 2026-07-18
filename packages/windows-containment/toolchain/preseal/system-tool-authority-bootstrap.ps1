param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNull()]
    [string] $BootstrapPlanText
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:PlanSchema = 'pc-sdk.cx-004.system-tool-authority-bootstrap-plan.v1'
$script:ReceiptSchema = 'pc-sdk.cx-004.system-tool-authority-bootstrap-receipt.v1'
$script:FailureCode = 'bootstrap-failed'
$script:MaximumPlanCharacters = 131072
$script:MaximumSafeJsonInteger = [int64] 9007199254740991
$script:DirectoryInteropTypeName = 'PcSdkSystemToolBootstrapDirectoryInterop'

function Throw-BootstrapFailure {
    param([Parameter(Mandatory = $true)] [string] $Message)
    throw [System.InvalidOperationException]::new($Message)
}

function ConvertTo-CanonicalJsonString {
    param([AllowNull()] [object] $Value)

    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) {
        if ($Value) { return 'true' }
        return 'false'
    }
    if ($Value -is [string]) {
        return (ConvertTo-Json -InputObject $Value -Compress)
    }
    if (
        $Value -is [byte] -or
        $Value -is [sbyte] -or
        $Value -is [int16] -or
        $Value -is [uint16] -or
        $Value -is [int32] -or
        $Value -is [uint32] -or
        $Value -is [int64]
    ) {
        $integer = [int64] $Value
        if ([Math]::Abs([decimal] $integer) -gt $script:MaximumSafeJsonInteger) {
            Throw-BootstrapFailure 'canonical JSON integer is outside the safe range'
        }
        return $integer.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [uint64]) {
        if ($Value -gt [uint64] $script:MaximumSafeJsonInteger) {
            Throw-BootstrapFailure 'canonical JSON integer is outside the safe range'
        }
        return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if (
        $Value -is [single] -or
        $Value -is [double] -or
        $Value -is [decimal]
    ) {
        Throw-BootstrapFailure 'canonical JSON does not permit non-integral number representations'
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = [string[]] @($Value.Keys | ForEach-Object { [string] $_ })
        [Array]::Sort($keys, [System.StringComparer]::Ordinal)
        $members = [System.Collections.Generic.List[string]]::new()
        foreach ($key in $keys) {
            $members.Add(
                (ConvertTo-CanonicalJsonString -Value $key) + ':' +
                (ConvertTo-CanonicalJsonString -Value $Value[$key])
            )
        }
        return '{' + [string]::Join(',', $members) + '}'
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $keys = [string[]] @($Value.PSObject.Properties.Name)
        [Array]::Sort($keys, [System.StringComparer]::Ordinal)
        $members = [System.Collections.Generic.List[string]]::new()
        foreach ($key in $keys) {
            $members.Add(
                (ConvertTo-CanonicalJsonString -Value $key) + ':' +
                (ConvertTo-CanonicalJsonString -Value $Value.$key)
            )
        }
        return '{' + [string]::Join(',', $members) + '}'
    }
    if ($Value -is [System.Collections.IList] -or $Value -is [System.Array]) {
        $members = [System.Collections.Generic.List[string]]::new()
        foreach ($entry in $Value) {
            $members.Add((ConvertTo-CanonicalJsonString -Value $entry))
        }
        return '[' + [string]::Join(',', $members) + ']'
    }
    Throw-BootstrapFailure 'canonical JSON encountered an unsupported value'
}

function Write-CanonicalReceipt {
    param([Parameter(Mandatory = $true)] [object] $Receipt)

    $json = ConvertTo-CanonicalJsonString -Value $Receipt
    if ($json.IndexOf([char] 0) -ge 0 -or $json.Contains("`r") -or $json.Contains("`n")) {
        Throw-BootstrapFailure 'canonical JSON contains a forbidden framing character'
    }
    [Console]::Out.WriteLine($json)
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)] [object] $Value,
        [Parameter(Mandatory = $true)] [string[]] $Expected
    )

    if ($Value -isnot [System.Management.Automation.PSCustomObject]) {
        Throw-BootstrapFailure 'plan member is not an object'
    }
    $actual = [string[]] @($Value.PSObject.Properties.Name)
    $expectedSorted = [string[]] @($Expected)
    [Array]::Sort($actual, [System.StringComparer]::Ordinal)
    [Array]::Sort($expectedSorted, [System.StringComparer]::Ordinal)
    if ($actual.Length -ne $expectedSorted.Length) {
        Throw-BootstrapFailure 'plan object property count mismatch'
    }
    for ($index = 0; $index -lt $actual.Length; $index += 1) {
        if ($actual[$index] -cne $expectedSorted[$index]) {
            Throw-BootstrapFailure 'plan object property set mismatch'
        }
    }
}

function Assert-ExactString {
    param(
        [AllowNull()] [object] $Value,
        [Parameter(Mandatory = $true)] [string] $Expected
    )
    if ($Value -isnot [string] -or $Value -cne $Expected) {
        Throw-BootstrapFailure 'plan string authority mismatch'
    }
}

function Assert-StringShape {
    param(
        [AllowNull()] [object] $Value,
        [Parameter(Mandatory = $true)] [string] $Pattern,
        [Parameter(Mandatory = $true)] [int] $MaximumLength
    )
    if (
        $Value -isnot [string] -or
        $Value.Length -lt 1 -or
        $Value.Length -gt $MaximumLength -or
        $Value -cnotmatch $Pattern
    ) {
        Throw-BootstrapFailure 'plan string shape mismatch'
    }
}

function Assert-ExactInteger {
    param(
        [AllowNull()] [object] $Value,
        [Parameter(Mandatory = $true)] [int64] $Expected
    )
    if (
        $Value -isnot [byte] -and
        $Value -isnot [int16] -and
        $Value -isnot [int32] -and
        $Value -isnot [int64]
    ) {
        Throw-BootstrapFailure 'plan integer type mismatch'
    }
    if ([int64] $Value -ne $Expected) {
        Throw-BootstrapFailure 'plan integer authority mismatch'
    }
}

function Assert-ArrayCount {
    param(
        [AllowNull()] [object] $Value,
        [Parameter(Mandatory = $true)] [int] $Count
    )
    if ($Value -isnot [System.Array] -or $Value.Count -ne $Count) {
        Throw-BootstrapFailure 'plan array length mismatch'
    }
}

function Normalize-AbsoluteLocalPath {
    param([AllowNull()] [object] $Value)

    if ($Value -isnot [string] -or $Value.Length -lt 3 -or $Value.Length -gt 32700) {
        Throw-BootstrapFailure 'path value is invalid'
    }
    if (
        $Value.IndexOf([char] 0) -ge 0 -or
        $Value.StartsWith('\\', [System.StringComparison]::Ordinal) -or
        $Value.StartsWith('\\?\', [System.StringComparison]::Ordinal) -or
        $Value -notmatch '^[A-Za-z]:\\'
    ) {
        Throw-BootstrapFailure 'path is not a local drive path'
    }
    if ($Value.IndexOf(':', 2) -ge 0) {
        Throw-BootstrapFailure 'path contains an alternate stream selector'
    }
    $segments = $Value.Substring(3).Split([char] '\')
    foreach ($segment in $segments) {
        if (
            $segment -eq '.' -or
            $segment -eq '..' -or
            $segment.EndsWith(' ', [System.StringComparison]::Ordinal) -or
            $segment.EndsWith('.', [System.StringComparison]::Ordinal)
        ) {
            Throw-BootstrapFailure 'path contains a noncanonical component'
        }
    }
    $fullPath = [System.IO.Path]::GetFullPath($Value)
    $normalized = if ($fullPath.Length -gt 3) { $fullPath.TrimEnd([char] '\') } else { $fullPath }
    $supplied = if ($Value.Length -gt 3) { $Value.TrimEnd([char] '\') } else { $Value }
    if (-not $normalized.Equals($supplied, [System.StringComparison]::OrdinalIgnoreCase)) {
        Throw-BootstrapFailure 'path is not in canonical absolute form'
    }
    return $normalized
}

function Test-SamePath {
    param(
        [Parameter(Mandatory = $true)] [string] $Left,
        [Parameter(Mandatory = $true)] [string] $Right
    )
    return $Left.Equals($Right, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathWithin {
    param(
        [Parameter(Mandatory = $true)] [string] $Candidate,
        [Parameter(Mandatory = $true)] [string] $Parent,
        [switch] $AllowEqual
    )
    if (Test-SamePath -Left $Candidate -Right $Parent) { return [bool] $AllowEqual }
    $prefix = if ($Parent.EndsWith('\', [System.StringComparison]::Ordinal)) { $Parent } else { $Parent + '\' }
    return $Candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathsOverlap {
    param(
        [Parameter(Mandatory = $true)] [string] $Left,
        [Parameter(Mandatory = $true)] [string] $Right
    )
    return (
        (Test-PathWithin -Candidate $Left -Parent $Right -AllowEqual) -or
        (Test-PathWithin -Candidate $Right -Parent $Left -AllowEqual)
    )
}

function Assert-FixedLocalNtfsPath {
    param([Parameter(Mandatory = $true)] [string] $LiteralPath)

    $drive = [System.IO.DriveInfo]::new($LiteralPath.Substring(0, 3))
    if (
        -not $drive.IsReady -or
        $drive.DriveType -ne [System.IO.DriveType]::Fixed -or
        -not $drive.DriveFormat.Equals('NTFS', [System.StringComparison]::OrdinalIgnoreCase)
    ) {
        Throw-BootstrapFailure 'path is not on a ready fixed NTFS volume'
    }
}

function Assert-NoReparseExistingComponents {
    param(
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [Parameter(Mandatory = $true)] [bool] $RequireLeaf
    )

    $root = $LiteralPath.Substring(0, 3)
    $current = $root
    $parts = @()
    if ($LiteralPath.Length -gt 3) {
        $parts = @($LiteralPath.Substring(3).Split([char] '\'))
    }
    $rootItem = Get-Item -LiteralPath $root -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Throw-BootstrapFailure 'path traverses a reparse point'
    }
    foreach ($part in $parts) {
        $current = [System.IO.Path]::Combine($current, $part)
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) {
            if ($RequireLeaf) { Throw-BootstrapFailure 'required path does not exist' }
            return
        }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-BootstrapFailure 'path traverses a reparse point'
        }
    }
}

function Assert-DirectoryPath {
    param([Parameter(Mandatory = $true)] [string] $LiteralPath)

    $item = Get-Item -LiteralPath $LiteralPath -Force
    if (-not $item.PSIsContainer) { Throw-BootstrapFailure 'required directory is not a directory' }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Throw-BootstrapFailure 'required directory is a reparse point'
    }
    Assert-NativeAuditDirectoryStreams -LiteralPath $LiteralPath
}

function Test-AnyPathEntry {
    param([Parameter(Mandatory = $true)] [string] $LiteralPath)

    if ([System.IO.File]::Exists($LiteralPath) -or [System.IO.Directory]::Exists($LiteralPath)) {
        return $true
    }
    $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction SilentlyContinue
    return $null -ne $item
}

function Initialize-DirectoryInterop {
    if ($null -ne ([System.Management.Automation.PSTypeName] $script:DirectoryInteropTypeName).Type) {
        return
    }
    $assemblyName = [System.Reflection.AssemblyName]::new('PcSdkSystemToolBootstrapDirectoryInteropAssembly')
    $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
        $assemblyName,
        [System.Reflection.Emit.AssemblyBuilderAccess]::Run
    )
    $moduleBuilder = $assemblyBuilder.DefineDynamicModule('PcSdkSystemToolBootstrapDirectoryInteropModule')
    $typeBuilder = $moduleBuilder.DefineType(
        $script:DirectoryInteropTypeName,
        [System.Reflection.TypeAttributes] 'Public,Abstract,Sealed,BeforeFieldInit'
    )
    $constructor = [System.Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]] @([string]))
    $fields = [System.Reflection.FieldInfo[]] @(
        [System.Runtime.InteropServices.DllImportAttribute].GetField('EntryPoint'),
        [System.Runtime.InteropServices.DllImportAttribute].GetField('CharSet'),
        [System.Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
        [System.Runtime.InteropServices.DllImportAttribute].GetField('CallingConvention'),
        [System.Runtime.InteropServices.DllImportAttribute].GetField('PreserveSig')
    )
    function Add-DirectoryPInvokeMethod {
        param(
            [Parameter(Mandatory = $true)] [string] $Name,
            [Parameter(Mandatory = $true)] [Type] $ReturnType,
            [Parameter(Mandatory = $true)] [Type[]] $ParameterTypes,
            [Parameter(Mandatory = $true)] [System.Runtime.InteropServices.CharSet] $CharSet
        )
        $method = $typeBuilder.DefineMethod(
            $Name,
            [System.Reflection.MethodAttributes] 'Public,Static,PinvokeImpl',
            [System.Reflection.CallingConventions]::Standard,
            $ReturnType,
            $ParameterTypes
        )
        $method.SetImplementationFlags(
            $method.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig
        )
        $values = [object[]] @(
            $Name,
            $CharSet,
            $true,
            [System.Runtime.InteropServices.CallingConvention]::Winapi,
            $true
        )
        $method.SetCustomAttribute([System.Reflection.Emit.CustomAttributeBuilder]::new(
            $constructor,
            [object[]] @('kernel32.dll'),
            $fields,
            $values
        ))
    }
    Add-DirectoryPInvokeMethod -Name 'CreateDirectoryW' -ReturnType ([bool]) -CharSet Unicode -ParameterTypes ([Type[]] @(
        [string], [IntPtr]
    ))
    Add-DirectoryPInvokeMethod -Name 'CreateFileW' -ReturnType ([IntPtr]) -CharSet Unicode -ParameterTypes ([Type[]] @(
        [string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]
    ))
    Add-DirectoryPInvokeMethod -Name 'GetFileInformationByHandle' -ReturnType ([bool]) -CharSet None -ParameterTypes ([Type[]] @(
        [IntPtr], [IntPtr]
    ))
    Add-DirectoryPInvokeMethod -Name 'GetFinalPathNameByHandleW' -ReturnType ([uint32]) -CharSet Unicode -ParameterTypes ([Type[]] @(
        [IntPtr], [System.Text.StringBuilder], [uint32], [uint32]
    ))
    [void] $typeBuilder.CreateType()
}

function ConvertTo-ExtendedBootstrapPath {
    param([Parameter(Mandatory = $true)] [string] $LiteralPath)
    return '\\?\' + $LiteralPath
}

function Read-BootstrapUInt32 {
    param(
        [Parameter(Mandatory = $true)] [IntPtr] $Buffer,
        [Parameter(Mandatory = $true)] [int] $Offset
    )
    $signed = [System.Runtime.InteropServices.Marshal]::ReadInt32($Buffer, $Offset)
    if ($signed -ge 0) { return [uint32] $signed }
    return [uint32] ([uint64] ([int64] $signed + 4294967296))
}

function Read-BootstrapDirectoryInformation {
    param([Parameter(Mandatory = $true)] [Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle)

    $interop = ([System.Management.Automation.PSTypeName] $script:DirectoryInteropTypeName).Type
    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(52)
    try {
        [System.Runtime.InteropServices.Marshal]::Copy([byte[]]::new(52), 0, $buffer, 52)
        if (-not $interop::GetFileInformationByHandle($Handle.DangerousGetHandle(), $buffer)) {
            throw [System.ComponentModel.Win32Exception]::new(
                [System.Runtime.InteropServices.Marshal]::GetLastWin32Error(),
                'directory identity query failed'
            )
        }
        $attributes = Read-BootstrapUInt32 -Buffer $buffer -Offset 0
        $creationLow = Read-BootstrapUInt32 -Buffer $buffer -Offset 4
        $creationHigh = Read-BootstrapUInt32 -Buffer $buffer -Offset 8
        $volumeSerial = Read-BootstrapUInt32 -Buffer $buffer -Offset 28
        $fileIndexHigh = Read-BootstrapUInt32 -Buffer $buffer -Offset 44
        $fileIndexLow = Read-BootstrapUInt32 -Buffer $buffer -Offset 48
        if (
            ($attributes -band 0x00000010) -eq 0 -or
            ($attributes -band 0x00000400) -ne 0
        ) {
            Throw-BootstrapFailure 'authority parent handle is not one non-reparse directory'
        }
        return [pscustomobject] [ordered] @{
            attributes = $attributes
            creationTime = (([uint64] $creationHigh -shl 32) -bor [uint64] $creationLow)
            fileId = (([uint64] $fileIndexHigh -shl 32) -bor [uint64] $fileIndexLow)
            volumeSerial = $volumeSerial
        }
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
}

function Read-BootstrapDirectoryFinalPath {
    param([Parameter(Mandatory = $true)] [Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle)

    $interop = ([System.Management.Automation.PSTypeName] $script:DirectoryInteropTypeName).Type
    $buffer = [System.Text.StringBuilder]::new(32768)
    $length = $interop::GetFinalPathNameByHandleW(
        $Handle.DangerousGetHandle(),
        $buffer,
        [uint32] $buffer.Capacity,
        0
    )
    if ($length -eq 0 -or $length -ge $buffer.Capacity) {
        throw [System.ComponentModel.Win32Exception]::new(
            [System.Runtime.InteropServices.Marshal]::GetLastWin32Error(),
            'directory final-path query failed'
        )
    }
    $value = $buffer.ToString()
    if ($value.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $value.Substring(4).TrimEnd([char] '\')
    }
    return $value.TrimEnd([char] '\')
}

function Open-BootstrapDirectoryIdentity {
    param([Parameter(Mandatory = $true)] [string] $LiteralPath)

    Initialize-DirectoryInterop
    $interop = ([System.Management.Automation.PSTypeName] $script:DirectoryInteropTypeName).Type
    $rawHandle = $interop::CreateFileW(
        (ConvertTo-ExtendedBootstrapPath -LiteralPath $LiteralPath),
        [uint32] 0x00000080,
        [uint32] 0x00000003,
        [IntPtr]::Zero,
        [uint32] 3,
        [uint32] 0x02200000,
        [IntPtr]::Zero
    )
    if ($rawHandle -eq [IntPtr]::new(-1)) {
        throw [System.ComponentModel.Win32Exception]::new(
            [System.Runtime.InteropServices.Marshal]::GetLastWin32Error(),
            'authority parent handle open failed'
        )
    }
    $handle = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new($rawHandle, $true)
    try {
        $information = Read-BootstrapDirectoryInformation -Handle $handle
        $finalPath = Read-BootstrapDirectoryFinalPath -Handle $handle
        if (-not (Test-SamePath -Left $finalPath -Right $LiteralPath)) {
            Throw-BootstrapFailure 'authority parent resolved through an unexpected path'
        }
        return [pscustomobject] [ordered] @{
            finalPath = $finalPath
            handle = $handle
            information = $information
        }
    }
    catch {
        $handle.Dispose()
        throw
    }
}

function Assert-BootstrapDirectoryIdentityStable {
    param([Parameter(Mandatory = $true)] [object] $Identity)

    $current = Read-BootstrapDirectoryInformation -Handle $Identity.handle
    foreach ($field in @('attributes', 'creationTime', 'fileId', 'volumeSerial')) {
        if ($current.$field -ne $Identity.information.$field) {
            Throw-BootstrapFailure 'authority parent identity changed during bootstrap'
        }
    }
    $finalPath = Read-BootstrapDirectoryFinalPath -Handle $Identity.handle
    if (-not (Test-SamePath -Left $finalPath -Right $Identity.finalPath)) {
        Throw-BootstrapFailure 'authority parent final path changed during bootstrap'
    }
}

function New-ExclusiveDirectory {
    param([Parameter(Mandatory = $true)] [string] $LiteralPath)

    Initialize-DirectoryInterop
    $interop = ([System.Management.Automation.PSTypeName] $script:DirectoryInteropTypeName).Type
    if (-not $interop::CreateDirectoryW($LiteralPath, [IntPtr]::Zero)) {
        throw [System.ComponentModel.Win32Exception]::new(
            [System.Runtime.InteropServices.Marshal]::GetLastWin32Error(),
            'exclusive directory creation failed'
        )
    }
    Assert-NoReparseExistingComponents -LiteralPath $LiteralPath -RequireLeaf $true
    Assert-DirectoryPath -LiteralPath $LiteralPath
}

function Open-ExactAuditFile {
    param(
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [Parameter(Mandatory = $true)] [int64] $ExpectedBytes,
        [Parameter(Mandatory = $true)] [string] $ExpectedSha256,
        [Parameter(Mandatory = $true)] [uint32] $ExpectedLinkCount
    )

    Assert-NoReparseExistingComponents -LiteralPath $LiteralPath -RequireLeaf $true
    $session = Open-NativeAuditFileSession -LiteralPath $LiteralPath -ExpectedLinkCount $ExpectedLinkCount
    try {
        Assert-NativeAuditFileStreams -Session $session
        $fact = Get-NativeAuditFileHash -Session $session
        if ($fact.ByteLength -ne $ExpectedBytes -or $fact.Sha256 -cne $ExpectedSha256) {
            Throw-BootstrapFailure 'audited file bytes do not match authority'
        }
        Assert-NativeAuditFileStable -Session $session
        return [pscustomobject] [ordered] @{
            fact = $fact
            session = $session
        }
    }
    catch {
        Close-NativeAuditFileSession -Session $session
        throw
    }
}

function Replay-ExactAuditFile {
    param(
        [Parameter(Mandatory = $true)] [object] $Audit,
        [Parameter(Mandatory = $true)] [int64] $ExpectedBytes,
        [Parameter(Mandatory = $true)] [string] $ExpectedSha256
    )

    Assert-NativeAuditFileStable -Session $Audit.session
    Assert-NativeAuditFileStreams -Session $Audit.session
    $fact = Get-NativeAuditFileHash -Session $Audit.session
    if (
        $fact.ByteLength -ne $ExpectedBytes -or
        $fact.Sha256 -cne $ExpectedSha256 -or
        $fact.IdentityToken -cne $Audit.fact.IdentityToken
    ) {
        Throw-BootstrapFailure 'audited file changed during bootstrap'
    }
    Assert-NativeAuditFileStable -Session $Audit.session
    return $fact
}

function Copy-RetainedFileExclusive {
    param(
        [Parameter(Mandatory = $true)] [object] $SourceAudit,
        [Parameter(Mandatory = $true)] [string] $DestinationPath
    )

    $sourceStream = $SourceAudit.session.stream
    $sourceStream.Position = 0
    $destination = [System.IO.FileStream]::new(
        $DestinationPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None,
        1024 * 1024,
        [System.IO.FileOptions]::WriteThrough
    )
    try {
        $sourceStream.CopyTo($destination, 1024 * 1024)
        if ($sourceStream.Position -ne [int64] $SourceAudit.fact.ByteLength) {
            Throw-BootstrapFailure 'retained source copy length mismatch'
        }
        $destination.Flush($true)
        if ($destination.Length -ne [int64] $SourceAudit.fact.ByteLength) {
            Throw-BootstrapFailure 'private destination length mismatch'
        }
    }
    finally {
        $destination.Dispose()
    }
}

function Assert-ExactDirectoryEntries {
    param(
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [string[]] $ExpectedNames,
        [Parameter(Mandatory = $true)] [bool] $ExpectDirectories
    )

    Assert-NoReparseExistingComponents -LiteralPath $LiteralPath -RequireLeaf $true
    Assert-DirectoryPath -LiteralPath $LiteralPath
    $entries = @([System.IO.Directory]::EnumerateFileSystemEntries($LiteralPath))
    $actualNames = [string[]] @($entries | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    $expectedSorted = [string[]] @($ExpectedNames)
    [Array]::Sort($actualNames, [System.StringComparer]::Ordinal)
    [Array]::Sort($expectedSorted, [System.StringComparer]::Ordinal)
    if ($actualNames.Length -ne $expectedSorted.Length) {
        Throw-BootstrapFailure 'private directory entry count mismatch'
    }
    for ($index = 0; $index -lt $actualNames.Length; $index += 1) {
        if ($actualNames[$index] -cne $expectedSorted[$index]) {
            Throw-BootstrapFailure 'private directory entry set mismatch'
        }
    }
    foreach ($entry in $entries) {
        $item = Get-Item -LiteralPath $entry -Force
        if ([bool] $item.PSIsContainer -ne $ExpectDirectories) {
            Throw-BootstrapFailure 'private directory entry type mismatch'
        }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-BootstrapFailure 'private directory contains a reparse point'
        }
    }
}

function Close-AllAudits {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]] $Audits
    )
    foreach ($audit in $Audits) {
        if ($null -ne $audit -and $null -ne $audit.session) {
            try { Close-NativeAuditFileSession -Session $audit.session } catch { }
        }
    }
    $Audits.Clear()
}

$openAudits = [System.Collections.Generic.List[object]]::new()
$authorityParentIdentity = $null
$outputDirectoryIdentities = [System.Collections.Generic.List[object]]::new()
try {
    $script:FailureCode = 'invalid-plan'
    if (
        $BootstrapPlanText.Length -lt 2 -or
        $BootstrapPlanText.Length -gt $script:MaximumPlanCharacters -or
        $BootstrapPlanText.IndexOf([char] 0) -ge 0 -or
        $BootstrapPlanText.Contains("`r") -or
        $BootstrapPlanText.Contains("`n") -or
        $BootstrapPlanText[0] -eq [char] 0xfeff
    ) {
        Throw-BootstrapFailure 'bootstrap plan framing is invalid'
    }
    $plan = ConvertFrom-Json -InputObject $BootstrapPlanText
    if ((ConvertTo-CanonicalJsonString -Value $plan) -cne $BootstrapPlanText) {
        Throw-BootstrapFailure 'bootstrap plan is not canonical JSON'
    }
    Assert-ExactProperties -Value $plan -Expected @(
        'schemaVersion', 'authorityParent', 'runLeaf', 'runRoot', 'privateToolRoot',
        'tempRoot', 'bootstrapScratchRoot', 'systemRoot', 'pathPolicy', 'tools', 'bindings'
    )
    Assert-ExactString -Value $plan.schemaVersion -Expected $script:PlanSchema
    Assert-StringShape -Value $plan.runLeaf -Pattern '^[0-9a-f]{32}$' -MaximumLength 32

    $authorityParent = Normalize-AbsoluteLocalPath -Value $plan.authorityParent
    $runRoot = Normalize-AbsoluteLocalPath -Value $plan.runRoot
    $privateToolRoot = Normalize-AbsoluteLocalPath -Value $plan.privateToolRoot
    $tempRoot = Normalize-AbsoluteLocalPath -Value $plan.tempRoot
    $bootstrapScratchRoot = Normalize-AbsoluteLocalPath -Value $plan.bootstrapScratchRoot
    $systemRoot = Normalize-AbsoluteLocalPath -Value $plan.systemRoot
    if (-not (Test-SamePath -Left $runRoot -Right ([System.IO.Path]::Combine($authorityParent, $plan.runLeaf)))) {
        Throw-BootstrapFailure 'run root is not the exact authority child'
    }
    if (
        -not (Test-SamePath -Left $privateToolRoot -Right ([System.IO.Path]::Combine($runRoot, 'system-tools'))) -or
        -not (Test-SamePath -Left $tempRoot -Right ([System.IO.Path]::Combine($runRoot, 'temp')))
    ) {
        Throw-BootstrapFailure 'private output topology mismatch'
    }
    if (
        -not (Test-SamePath -Left $systemRoot -Right 'C:\Windows') -or
        -not (Test-SamePath -Left $systemRoot -Right ([Environment]::GetEnvironmentVariable('SystemRoot'))) -or
        -not (Test-SamePath -Left $bootstrapScratchRoot -Right ([System.IO.Path]::Combine($systemRoot, 'Temp')))
    ) {
        Throw-BootstrapFailure 'fixed system path authority mismatch'
    }

    Assert-ExactProperties -Value $plan.tools[0] -Expected @(
        'id', 'sourceRelativePaths', 'destinationFileName', 'bytes', 'sha256',
        'sourceLinkCount', 'privateLinkCount'
    )
    Assert-ExactProperties -Value $plan.tools[1] -Expected @(
        'id', 'sourceRelativePaths', 'destinationFileName', 'bytes', 'sha256',
        'sourceLinkCount', 'privateLinkCount'
    )
    Assert-ArrayCount -Value $plan.tools -Count 2
    $sealedTools = @(
        [pscustomobject] [ordered] @{
            bytes = [int64] 454656
            destinationFileName = 'powershell.exe'
            id = 'powershell'
            privateLinkCount = [int64] 1
            sha256 = '7600ffe12da441fe89d035b13801e8e91d064bc544a27b19a5cf49f6ab8b18f5'
            sourceLinkCount = [int64] 2
            sourceRelativePaths = @(
                'System32/WindowsPowerShell/v1.0/powershell.exe',
                'WinSxS/amd64_microsoft-windows-powershell-exe_31bf3856ad364e35_10.0.26100.8875_none_04b33bacb253ee82/powershell.exe'
            )
        },
        [pscustomobject] [ordered] @{
            bytes = [int64] 118784
            destinationFileName = 'taskkill.exe'
            id = 'taskkill'
            privateLinkCount = [int64] 1
            sha256 = '1249717315fc8f4d2df17d5db9da0444795fdb9fb83dfb1f763c3f39282244f7'
            sourceLinkCount = [int64] 2
            sourceRelativePaths = @(
                'System32/taskkill.exe',
                'WinSxS/amd64_microsoft-windows-taskkill_31bf3856ad364e35_10.0.26100.1_none_2271a765c49d2684/taskkill.exe'
            )
        }
    )
    for ($toolIndex = 0; $toolIndex -lt $sealedTools.Count; $toolIndex += 1) {
        $actualTool = $plan.tools[$toolIndex]
        $expectedTool = $sealedTools[$toolIndex]
        Assert-ExactString -Value $actualTool.id -Expected $expectedTool.id
        Assert-ExactString -Value $actualTool.destinationFileName -Expected $expectedTool.destinationFileName
        Assert-ExactInteger -Value $actualTool.bytes -Expected $expectedTool.bytes
        Assert-ExactString -Value $actualTool.sha256 -Expected $expectedTool.sha256
        Assert-ExactInteger -Value $actualTool.sourceLinkCount -Expected $expectedTool.sourceLinkCount
        Assert-ExactInteger -Value $actualTool.privateLinkCount -Expected $expectedTool.privateLinkCount
        Assert-ArrayCount -Value $actualTool.sourceRelativePaths -Count 2
        for ($aliasIndex = 0; $aliasIndex -lt 2; $aliasIndex += 1) {
            Assert-ExactString -Value $actualTool.sourceRelativePaths[$aliasIndex] -Expected $expectedTool.sourceRelativePaths[$aliasIndex]
        }
    }

    Assert-ArrayCount -Value $plan.bindings -Count 4
    $bindingIds = @('config', 'bootstrap-wrapper', 'audit-core', 'audit-worker')
    $bindingPaths = @{}
    for ($bindingIndex = 0; $bindingIndex -lt $bindingIds.Count; $bindingIndex += 1) {
        $binding = $plan.bindings[$bindingIndex]
        Assert-ExactProperties -Value $binding -Expected @('id', 'path', 'bytes', 'sha256')
        Assert-ExactString -Value $binding.id -Expected $bindingIds[$bindingIndex]
        $bindingPath = Normalize-AbsoluteLocalPath -Value $binding.path
        $bindingPaths[$binding.id] = $bindingPath
        if (
            $binding.bytes -isnot [int32] -and
            $binding.bytes -isnot [int64]
        ) {
            Throw-BootstrapFailure 'binding byte length type mismatch'
        }
        if ([int64] $binding.bytes -lt 1 -or [int64] $binding.bytes -gt $script:MaximumSafeJsonInteger) {
            Throw-BootstrapFailure 'binding byte length is invalid'
        }
        Assert-StringShape -Value $binding.sha256 -Pattern '^[0-9a-f]{64}$' -MaximumLength 64
    }
    $presealDirectory = [System.IO.Path]::GetDirectoryName($bindingPaths['bootstrap-wrapper'])
    $toolchainDirectory = [System.IO.Path]::GetDirectoryName($presealDirectory)
    if (
        -not (Test-SamePath -Left $bindingPaths['bootstrap-wrapper'] -Right ([System.IO.Path]::Combine($presealDirectory, 'system-tool-authority-bootstrap.ps1'))) -or
        -not (Test-SamePath -Left $bindingPaths['audit-core'] -Right ([System.IO.Path]::Combine($presealDirectory, 'filesystem-audit-core.psm1'))) -or
        -not (Test-SamePath -Left $bindingPaths['config'] -Right ([System.IO.Path]::Combine($toolchainDirectory, 'native-build-input.config.json'))) -or
        -not (Test-SamePath -Left $bindingPaths['audit-worker'] -Right ([System.IO.Path]::Combine($toolchainDirectory, 'native-build-input-filesystem-audit.ps1')))
    ) {
        Throw-BootstrapFailure 'binding path topology mismatch'
    }

    Assert-ExactProperties -Value $plan.pathPolicy -Expected @('inputs', 'outputs', 'exclusions')
    Assert-ArrayCount -Value $plan.pathPolicy.inputs -Count 11
    Assert-ArrayCount -Value $plan.pathPolicy.outputs -Count 3
    $exclusionCount = @($plan.pathPolicy.exclusions).Count
    if ($exclusionCount -ne 6) { Throw-BootstrapFailure 'path-policy exclusion count mismatch' }
    $inputIds = @(
        'authority-parent', 'bootstrap-scratch-root', 'system-root', 'config',
        'bootstrap-wrapper', 'audit-core', 'audit-worker', 'powershell-source-0',
        'powershell-source-1', 'taskkill-source-0', 'taskkill-source-1'
    )
    $sourcePaths = @()
    foreach ($tool in $sealedTools) {
        foreach ($relativePath in $tool.sourceRelativePaths) {
            $sourcePaths += [System.IO.Path]::Combine($systemRoot, $relativePath.Replace('/', '\'))
        }
    }
    $expectedInputPaths = @(
        $authorityParent, $bootstrapScratchRoot, $systemRoot,
        $bindingPaths['config'], $bindingPaths['bootstrap-wrapper'],
        $bindingPaths['audit-core'], $bindingPaths['audit-worker'],
        $sourcePaths[0], $sourcePaths[1], $sourcePaths[2], $sourcePaths[3]
    )
    $inputEntries = @()
    for ($index = 0; $index -lt $inputIds.Count; $index += 1) {
        $entry = $plan.pathPolicy.inputs[$index]
        Assert-ExactProperties -Value $entry -Expected @('id', 'path')
        Assert-ExactString -Value $entry.id -Expected $inputIds[$index]
        $entryPath = Normalize-AbsoluteLocalPath -Value $entry.path
        if (-not (Test-SamePath -Left $entryPath -Right $expectedInputPaths[$index])) {
            Throw-BootstrapFailure 'path-policy input binding mismatch'
        }
        $inputEntries += [pscustomobject] [ordered] @{ id = $entry.id; path = $entryPath }
    }
    $outputIds = @('run-root', 'private-tool-root', 'temp-root')
    $expectedOutputPaths = @($runRoot, $privateToolRoot, $tempRoot)
    $outputEntries = @()
    for ($index = 0; $index -lt $outputIds.Count; $index += 1) {
        $entry = $plan.pathPolicy.outputs[$index]
        Assert-ExactProperties -Value $entry -Expected @('id', 'path')
        Assert-ExactString -Value $entry.id -Expected $outputIds[$index]
        $entryPath = Normalize-AbsoluteLocalPath -Value $entry.path
        if (-not (Test-SamePath -Left $entryPath -Right $expectedOutputPaths[$index])) {
            Throw-BootstrapFailure 'path-policy output binding mismatch'
        }
        $outputEntries += [pscustomobject] [ordered] @{ id = $entry.id; path = $entryPath }
    }
    $exclusionEntries = @()
    for ($index = 0; $index -lt $exclusionCount; $index += 1) {
        $entry = $plan.pathPolicy.exclusions[$index]
        Assert-ExactProperties -Value $entry -Expected @('id', 'path')
        $entryPath = Normalize-AbsoluteLocalPath -Value $entry.path
        $exclusionEntries += [pscustomobject] [ordered] @{ id = $entry.id; path = $entryPath }
    }
    $exclusionIds = @(
        'provider-codex-configured-home', 'provider-codex-default-home',
        'provider-claude-configured-home', 'provider-claude-default-home',
        'stable-repository', 'active-repository'
    )
    for ($index = 0; $index -lt $exclusionIds.Count; $index += 1) {
        Assert-ExactString -Value $exclusionEntries[$index].id -Expected $exclusionIds[$index]
    }

    $script:FailureCode = 'unsafe-path'
    foreach ($entry in $inputEntries) {
        Assert-FixedLocalNtfsPath -LiteralPath $entry.path
        Assert-NoReparseExistingComponents -LiteralPath $entry.path -RequireLeaf $true
    }
    foreach ($entry in $outputEntries) {
        Assert-FixedLocalNtfsPath -LiteralPath $entry.path
    }
    foreach ($entry in $exclusionEntries) {
        Assert-NoReparseExistingComponents -LiteralPath $entry.path -RequireLeaf $false
    }
    foreach ($directoryPath in @($authorityParent, $bootstrapScratchRoot, $systemRoot)) {
        Assert-DirectoryPath -LiteralPath $directoryPath
    }
    for ($leftIndex = 0; $leftIndex -lt $exclusionEntries.Count; $leftIndex += 1) {
        for ($rightIndex = $leftIndex + 1; $rightIndex -lt $exclusionEntries.Count; $rightIndex += 1) {
            $sameProviderFallback = (
                (($leftIndex -eq 0 -and $rightIndex -eq 1) -or ($leftIndex -eq 2 -and $rightIndex -eq 3)) -and
                (Test-SamePath -Left $exclusionEntries[$leftIndex].path -Right $exclusionEntries[$rightIndex].path)
            )
            if (-not $sameProviderFallback -and (Test-PathsOverlap -Left $exclusionEntries[$leftIndex].path -Right $exclusionEntries[$rightIndex].path)) {
                Throw-BootstrapFailure 'exclusion paths overlap'
            }
        }
    }
    $activeRepository = $exclusionEntries[$exclusionEntries.Count - 1].path
    foreach ($bindingId in $bindingIds) {
        if (-not (Test-PathWithin -Candidate $bindingPaths[$bindingId] -Parent $activeRepository)) {
            Throw-BootstrapFailure 'binding is outside the active repository exclusion'
        }
    }
    foreach ($inputEntry in $inputEntries) {
        foreach ($exclusionEntry in $exclusionEntries) {
            if (-not (Test-PathsOverlap -Left $inputEntry.path -Right $exclusionEntry.path)) { continue }
            $allowed = (
                $exclusionEntry.id -ceq 'active-repository' -and
                @('config', 'bootstrap-wrapper', 'audit-core', 'audit-worker') -ccontains $inputEntry.id -and
                (Test-PathWithin -Candidate $inputEntry.path -Parent $exclusionEntry.path)
            )
            if (-not $allowed) { Throw-BootstrapFailure 'input overlaps a forbidden exclusion' }
        }
    }
    foreach ($outputEntry in $outputEntries) {
        foreach ($exclusionEntry in $exclusionEntries) {
            if (Test-PathsOverlap -Left $outputEntry.path -Right $exclusionEntry.path) {
                Throw-BootstrapFailure 'output overlaps a forbidden exclusion'
            }
        }
        foreach ($inputEntry in $inputEntries) {
            if (-not (Test-PathsOverlap -Left $outputEntry.path -Right $inputEntry.path)) { continue }
            $allowed = (
                $inputEntry.id -ceq 'authority-parent' -and
                (Test-PathWithin -Candidate $outputEntry.path -Parent $inputEntry.path)
            )
            if (-not $allowed) { Throw-BootstrapFailure 'output overlaps an input path'
            }
        }
    }
    if (
        -not (Test-PathWithin -Candidate $runRoot -Parent $authorityParent) -or
        -not (Test-PathWithin -Candidate $privateToolRoot -Parent $runRoot) -or
        -not (Test-PathWithin -Candidate $tempRoot -Parent $runRoot) -or
        (Test-PathsOverlap -Left $privateToolRoot -Right $tempRoot)
    ) {
        Throw-BootstrapFailure 'output nesting policy mismatch'
    }
    foreach ($outputEntry in $outputEntries) {
        if (Test-AnyPathEntry -LiteralPath $outputEntry.path) {
            Throw-BootstrapFailure 'bootstrap output already exists'
        }
    }
    $authorityParentIdentity = Open-BootstrapDirectoryIdentity -LiteralPath $authorityParent

    $requiredCoreFunctions = @(
        'Assert-NativeAuditDirectoryStreams', 'Assert-NativeAuditFileStable',
        'Assert-NativeAuditFileStreams', 'Close-NativeAuditFileSession',
        'Get-NativeAuditFileHash', 'Open-NativeAuditFileSession'
    )
    $loadedCore = @(Get-Module -Name 'PcSdkFilesystemAuditCoreExact')
    if ($loadedCore.Count -ne 1) {
        Throw-BootstrapFailure 'exact in-memory audit core module is absent'
    }
    foreach ($functionName in $requiredCoreFunctions) {
        $command = Get-Command -Name $functionName -CommandType Function -ErrorAction SilentlyContinue
        if (
            $null -eq $command -or
            $command.ModuleName -cne 'PcSdkFilesystemAuditCoreExact'
        ) {
            Throw-BootstrapFailure 'required in-memory audit core function is absent'
        }
    }

    $script:FailureCode = 'binding-mismatch'
    $bindingAudits = @()
    $bindingTuples = @()
    foreach ($binding in $plan.bindings) {
        $audit = Open-ExactAuditFile -LiteralPath $bindingPaths[$binding.id] -ExpectedBytes ([int64] $binding.bytes) -ExpectedSha256 $binding.sha256 -ExpectedLinkCount 1
        $openAudits.Add($audit)
        $bindingAudits += $audit
        $bindingTuples += ,@($binding.id, [int64] $binding.bytes, $binding.sha256)
    }

    $script:FailureCode = 'source-audit-failed'
    $sourceToolAudits = @()
    $sourceBefore = @()
    $sourceOffset = 0
    foreach ($tool in $sealedTools) {
        $aliases = @()
        $tuples = @()
        for ($aliasIndex = 0; $aliasIndex -lt 2; $aliasIndex += 1) {
            $sourcePath = $sourcePaths[$sourceOffset + $aliasIndex]
            $audit = Open-ExactAuditFile -LiteralPath $sourcePath -ExpectedBytes $tool.bytes -ExpectedSha256 $tool.sha256 -ExpectedLinkCount ([uint32] $tool.sourceLinkCount)
            $openAudits.Add($audit)
            $aliases += $audit
            $logicalPath = 'windows/' + $tool.sourceRelativePaths[$aliasIndex]
            $tuples += ,@($logicalPath, $tool.bytes, $tool.sha256)
        }
        if ($aliases[0].fact.IdentityToken -cne $aliases[1].fact.IdentityToken) {
            Throw-BootstrapFailure 'serviced source aliases do not share one identity'
        }
        $sourceToolAudits += ,$aliases
        $sourceBefore += [pscustomobject] [ordered] @{
            id = $tool.id
            identityToken = $aliases[0].fact.IdentityToken
            tuples = $tuples
        }
        $sourceOffset += 2
    }

    $script:FailureCode = 'create-failed'
    New-ExclusiveDirectory -LiteralPath $runRoot
    $outputDirectoryIdentities.Add((Open-BootstrapDirectoryIdentity -LiteralPath $runRoot))
    New-ExclusiveDirectory -LiteralPath $privateToolRoot
    $outputDirectoryIdentities.Add((Open-BootstrapDirectoryIdentity -LiteralPath $privateToolRoot))
    New-ExclusiveDirectory -LiteralPath $tempRoot
    $outputDirectoryIdentities.Add((Open-BootstrapDirectoryIdentity -LiteralPath $tempRoot))
    Assert-ExactDirectoryEntries -LiteralPath $runRoot -ExpectedNames @('system-tools', 'temp') -ExpectDirectories $true
    Assert-ExactDirectoryEntries -LiteralPath $privateToolRoot -ExpectedNames @() -ExpectDirectories $false
    Assert-ExactDirectoryEntries -LiteralPath $tempRoot -ExpectedNames @() -ExpectDirectories $false

    $script:FailureCode = 'copy-failed'
    $destinationPaths = @(
        [System.IO.Path]::Combine($privateToolRoot, $sealedTools[0].destinationFileName),
        [System.IO.Path]::Combine($privateToolRoot, $sealedTools[1].destinationFileName)
    )
    for ($toolIndex = 0; $toolIndex -lt 2; $toolIndex += 1) {
        Copy-RetainedFileExclusive -SourceAudit $sourceToolAudits[$toolIndex][0] -DestinationPath $destinationPaths[$toolIndex]
    }

    $script:FailureCode = 'private-audit-failed'
    Assert-ExactDirectoryEntries -LiteralPath $runRoot -ExpectedNames @('system-tools', 'temp') -ExpectDirectories $true
    Assert-ExactDirectoryEntries -LiteralPath $privateToolRoot -ExpectedNames @('powershell.exe', 'taskkill.exe') -ExpectDirectories $false
    Assert-ExactDirectoryEntries -LiteralPath $tempRoot -ExpectedNames @() -ExpectDirectories $false
    $privateAudits = @()
    $privateTuples = @()
    for ($toolIndex = 0; $toolIndex -lt 2; $toolIndex += 1) {
        $tool = $sealedTools[$toolIndex]
        $audit = Open-ExactAuditFile -LiteralPath $destinationPaths[$toolIndex] -ExpectedBytes $tool.bytes -ExpectedSha256 $tool.sha256 -ExpectedLinkCount ([uint32] $tool.privateLinkCount)
        $openAudits.Add($audit)
        $privateAudits += $audit
        $privateTuples += ,@(('run-private/system-tools/' + $tool.destinationFileName), $tool.bytes, $tool.sha256)
    }

    $script:FailureCode = 'replay-failed'
    for ($index = 0; $index -lt $bindingAudits.Count; $index += 1) {
        [void] (Replay-ExactAuditFile -Audit $bindingAudits[$index] -ExpectedBytes ([int64] $plan.bindings[$index].bytes) -ExpectedSha256 $plan.bindings[$index].sha256)
    }
    $sourceAfter = @()
    for ($toolIndex = 0; $toolIndex -lt 2; $toolIndex += 1) {
        $tool = $sealedTools[$toolIndex]
        $aliases = $sourceToolAudits[$toolIndex]
        $first = Replay-ExactAuditFile -Audit $aliases[0] -ExpectedBytes $tool.bytes -ExpectedSha256 $tool.sha256
        $second = Replay-ExactAuditFile -Audit $aliases[1] -ExpectedBytes $tool.bytes -ExpectedSha256 $tool.sha256
        if ($first.IdentityToken -cne $second.IdentityToken -or $first.IdentityToken -cne $sourceBefore[$toolIndex].identityToken) {
            Throw-BootstrapFailure 'serviced source identity changed during bootstrap'
        }
        $sourceAfter += [pscustomobject] [ordered] @{
            id = $tool.id
            identityToken = $first.IdentityToken
            tuples = $sourceBefore[$toolIndex].tuples
        }
        [void] (Replay-ExactAuditFile -Audit $privateAudits[$toolIndex] -ExpectedBytes $tool.bytes -ExpectedSha256 $tool.sha256)
    }
    Assert-ExactDirectoryEntries -LiteralPath $runRoot -ExpectedNames @('system-tools', 'temp') -ExpectDirectories $true
    Assert-ExactDirectoryEntries -LiteralPath $privateToolRoot -ExpectedNames @('powershell.exe', 'taskkill.exe') -ExpectDirectories $false
    Assert-ExactDirectoryEntries -LiteralPath $tempRoot -ExpectedNames @() -ExpectDirectories $false
    Assert-NoReparseExistingComponents -LiteralPath $authorityParent -RequireLeaf $true
    Assert-DirectoryPath -LiteralPath $authorityParent
    Assert-BootstrapDirectoryIdentityStable -Identity $authorityParentIdentity
    foreach ($identity in $outputDirectoryIdentities) {
        Assert-BootstrapDirectoryIdentityStable -Identity $identity
    }

    $copyFacts = @()
    foreach ($tool in $sealedTools) {
        $copyFacts += [pscustomobject] [ordered] @{
            exclusiveCreate = $true
            flushToDisk = $true
            id = $tool.id
            privateStable = $true
            sourceStable = $true
        }
    }
    $receipt = [pscustomobject] [ordered] @{
        bindings = $bindingTuples
        copyFacts = $copyFacts
        helperProcessCount = 0
        ok = $true
        pathPolicy = [pscustomobject] [ordered] @{
            authorityParentStable = $true
            fixedLocalNtfs = $true
            noForbiddenOverlap = $true
            noReparseComponents = $true
            outputsAbsentBefore = $true
            outputsExactAfter = $true
            runRootDirectChild = $true
        }
        privateAfter = [pscustomobject] [ordered] @{
            identityPolicy = 'run-private-single-link-copy-v1'
            tuples = $privateTuples
        }
        runLeaf = $plan.runLeaf
        schemaVersion = $script:ReceiptSchema
        sourceAfter = $sourceAfter
        sourceBefore = $sourceBefore
    }
    Write-CanonicalReceipt -Receipt $receipt
    Close-AllAudits -Audits $openAudits
    foreach ($identity in $outputDirectoryIdentities) { $identity.handle.Dispose() }
    $outputDirectoryIdentities.Clear()
    $authorityParentIdentity.handle.Dispose()
    $authorityParentIdentity = $null
    exit 0
}
catch {
    Close-AllAudits -Audits $openAudits
    foreach ($identity in $outputDirectoryIdentities) {
        try { $identity.handle.Dispose() } catch { }
    }
    $outputDirectoryIdentities.Clear()
    if ($null -ne $authorityParentIdentity) {
        try { $authorityParentIdentity.handle.Dispose() } catch { }
        $authorityParentIdentity = $null
    }
    $allowedCodes = @(
        'invalid-plan', 'unsafe-path', 'binding-mismatch', 'source-audit-failed',
        'create-failed', 'copy-failed', 'private-audit-failed', 'replay-failed',
        'bootstrap-failed'
    )
    $code = if ($allowedCodes -ccontains $script:FailureCode) { $script:FailureCode } else { 'bootstrap-failed' }
    $messages = @{
        'invalid-plan' = 'bootstrap plan rejected'
        'unsafe-path' = 'bootstrap path policy rejected'
        'binding-mismatch' = 'bootstrap binding verification failed'
        'source-audit-failed' = 'serviced source audit failed'
        'create-failed' = 'exclusive bootstrap root creation failed'
        'copy-failed' = 'private system tool copy failed'
        'private-audit-failed' = 'private system tool audit failed'
        'replay-failed' = 'bootstrap replay verification failed'
        'bootstrap-failed' = 'system tool bootstrap failed'
    }
    $failure = [pscustomobject] [ordered] @{
        code = $code
        message = $messages[$code]
        ok = $false
        schemaVersion = $script:ReceiptSchema
    }
    try { Write-CanonicalReceipt -Receipt $failure } catch {
        [Console]::Out.WriteLine('{"code":"bootstrap-failed","message":"system tool bootstrap failed","ok":false,"schemaVersion":"pc-sdk.cx-004.system-tool-authority-bootstrap-receipt.v1"}')
    }
    exit 1
}
