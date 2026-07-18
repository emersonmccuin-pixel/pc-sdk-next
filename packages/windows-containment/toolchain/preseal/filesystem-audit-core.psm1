Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:InteropTypeName = 'PcSdkNativeBuildInputAuditInterop'
$script:InvalidHandleValue = [IntPtr]::new(-1)
$script:ErrorHandleEof = 38
$script:FileInformationBytes = 52
$script:FindStreamDataBytes = 600
$script:MaximumJsonInteger = [uint64] 9007199254740991

function Initialize-NativeBuildInputAuditInterop {
    if ($null -ne ([System.Management.Automation.PSTypeName] $script:InteropTypeName).Type) {
        return
    }

    $assemblyName = [System.Reflection.AssemblyName]::new('PcSdkNativeBuildInputAuditInteropAssembly')
    $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
        $assemblyName,
        [System.Reflection.Emit.AssemblyBuilderAccess]::Run
    )
    $moduleBuilder = $assemblyBuilder.DefineDynamicModule('PcSdkNativeBuildInputAuditInteropModule')
    $typeBuilder = $moduleBuilder.DefineType(
        $script:InteropTypeName,
        [System.Reflection.TypeAttributes]'Public,Abstract,Sealed,BeforeFieldInit'
    )

    function Add-PInvokeMethod {
        param(
            [Parameter(Mandatory)] [string] $Name,
            [Parameter(Mandatory)] [Type] $ReturnType,
            [Parameter(Mandatory)] [Type[]] $ParameterTypes,
            [Parameter(Mandatory)] [System.Runtime.InteropServices.CharSet] $CharSet
        )

        $method = $typeBuilder.DefineMethod(
            $Name,
            [System.Reflection.MethodAttributes]'Public,Static,PinvokeImpl',
            [System.Reflection.CallingConventions]::Standard,
            $ReturnType,
            $ParameterTypes
        )
        $method.SetImplementationFlags(
            $method.GetMethodImplementationFlags() -bor
            [System.Reflection.MethodImplAttributes]::PreserveSig
        )

        $attributeConstructor = [System.Runtime.InteropServices.DllImportAttribute].GetConstructor(
            [Type[]] @([string])
        )
        $attributeFields = [System.Reflection.FieldInfo[]] @(
            [System.Runtime.InteropServices.DllImportAttribute].GetField('EntryPoint'),
            [System.Runtime.InteropServices.DllImportAttribute].GetField('CharSet'),
            [System.Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
            [System.Runtime.InteropServices.DllImportAttribute].GetField('CallingConvention'),
            [System.Runtime.InteropServices.DllImportAttribute].GetField('PreserveSig')
        )
        $attributeValues = [object[]] @(
            $Name,
            $CharSet,
            $true,
            [System.Runtime.InteropServices.CallingConvention]::Winapi,
            $true
        )
        $method.SetCustomAttribute([System.Reflection.Emit.CustomAttributeBuilder]::new(
            $attributeConstructor,
            [object[]] @('kernel32.dll'),
            $attributeFields,
            $attributeValues
        ))
    }

    Add-PInvokeMethod -Name 'CreateFileW' -ReturnType ([IntPtr]) -CharSet Unicode -ParameterTypes ([Type[]] @(
        [string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]
    ))
    Add-PInvokeMethod -Name 'GetFileInformationByHandle' -ReturnType ([bool]) -CharSet None -ParameterTypes ([Type[]] @(
        [IntPtr], [IntPtr]
    ))
    Add-PInvokeMethod -Name 'GetFinalPathNameByHandleW' -ReturnType ([uint32]) -CharSet Unicode -ParameterTypes ([Type[]] @(
        [IntPtr], [System.Text.StringBuilder], [uint32], [uint32]
    ))
    Add-PInvokeMethod -Name 'FindFirstStreamW' -ReturnType ([IntPtr]) -CharSet Unicode -ParameterTypes ([Type[]] @(
        [string], [int32], [IntPtr], [uint32]
    ))
    Add-PInvokeMethod -Name 'FindNextStreamW' -ReturnType ([bool]) -CharSet Unicode -ParameterTypes ([Type[]] @(
        [IntPtr], [IntPtr]
    ))
    Add-PInvokeMethod -Name 'FindClose' -ReturnType ([bool]) -CharSet None -ParameterTypes ([Type[]] @(
        [IntPtr]
    ))

    [void] $typeBuilder.CreateType()
}

function Get-NativeAuditInteropType {
    Initialize-NativeBuildInputAuditInterop
    return ([System.Management.Automation.PSTypeName] $script:InteropTypeName).Type
}

function ConvertTo-ExtendedNativeAuditPath {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
    if ($fullPath.StartsWith('\\?\', [System.StringComparison]::Ordinal)) {
        return $fullPath
    }
    if ($fullPath.StartsWith('\\', [System.StringComparison]::Ordinal)) {
        return '\\?\UNC\' + $fullPath.Substring(2)
    }
    return '\\?\' + $fullPath
}

function Read-NativeAuditUInt32 {
    param(
        [Parameter(Mandatory)] [IntPtr] $Buffer,
        [Parameter(Mandatory)] [int] $Offset
    )
    $signed = [System.Runtime.InteropServices.Marshal]::ReadInt32($Buffer, $Offset)
    if ($signed -ge 0) { return [uint32] $signed }
    return [uint32] ([uint64] ([int64] $signed + 4294967296))
}

function Read-NativeAuditFileInformation {
    param([Parameter(Mandatory)] [Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle)

    $interop = Get-NativeAuditInteropType
    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($script:FileInformationBytes)
    try {
        [System.Runtime.InteropServices.Marshal]::Copy(
            [byte[]]::new($script:FileInformationBytes),
            0,
            $buffer,
            $script:FileInformationBytes
        )
        if (-not $interop::GetFileInformationByHandle($Handle.DangerousGetHandle(), $buffer)) {
            throw [System.ComponentModel.Win32Exception]::new(
                [System.Runtime.InteropServices.Marshal]::GetLastWin32Error(),
                'GetFileInformationByHandle failed during filesystem audit.'
            )
        }
        $creationLow = Read-NativeAuditUInt32 -Buffer $buffer -Offset 4
        $creationHigh = Read-NativeAuditUInt32 -Buffer $buffer -Offset 8
        $writeLow = Read-NativeAuditUInt32 -Buffer $buffer -Offset 20
        $writeHigh = Read-NativeAuditUInt32 -Buffer $buffer -Offset 24
        $sizeHigh = Read-NativeAuditUInt32 -Buffer $buffer -Offset 32
        $sizeLow = Read-NativeAuditUInt32 -Buffer $buffer -Offset 36
        $indexHigh = Read-NativeAuditUInt32 -Buffer $buffer -Offset 44
        $indexLow = Read-NativeAuditUInt32 -Buffer $buffer -Offset 48
        return [pscustomobject] [ordered] @{
            attributes = Read-NativeAuditUInt32 -Buffer $buffer -Offset 0
            creationTime = (([uint64] $creationHigh -shl 32) -bor [uint64] $creationLow)
            fileId = (([uint64] $indexHigh -shl 32) -bor [uint64] $indexLow)
            length = (([uint64] $sizeHigh -shl 32) -bor [uint64] $sizeLow)
            linkCount = Read-NativeAuditUInt32 -Buffer $buffer -Offset 40
            volumeSerial = Read-NativeAuditUInt32 -Buffer $buffer -Offset 28
            writeTime = (([uint64] $writeHigh -shl 32) -bor [uint64] $writeLow)
        }
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
}

function Read-NativeAuditFinalPath {
    param([Parameter(Mandatory)] [Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle)

    $interop = Get-NativeAuditInteropType
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
            'GetFinalPathNameByHandleW failed during filesystem audit.'
        )
    }
    $value = $buffer.ToString()
    if ($value.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return '\\' + $value.Substring(8)
    }
    if ($value.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $value.Substring(4)
    }
    return $value
}

function Read-NativeAuditStreamRecord {
    param([Parameter(Mandatory)] [IntPtr] $Buffer)

    $name = [System.Runtime.InteropServices.Marshal]::PtrToStringUni(
        [IntPtr]::Add($Buffer, 8),
        296
    ).TrimEnd([char] 0)
    return [pscustomobject] [ordered] @{
        length = [System.Runtime.InteropServices.Marshal]::ReadInt64($Buffer, 0)
        name = $name
    }
}

function Get-NativeAuditStreams {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    $interop = Get-NativeAuditInteropType
    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($script:FindStreamDataBytes)
    $find = $script:InvalidHandleValue
    $closeRequired = $false
    try {
        [System.Runtime.InteropServices.Marshal]::Copy(
            [byte[]]::new($script:FindStreamDataBytes),
            0,
            $buffer,
            $script:FindStreamDataBytes
        )
        $find = $interop::FindFirstStreamW(
            (ConvertTo-ExtendedNativeAuditPath -LiteralPath $LiteralPath),
            0,
            $buffer,
            0
        )
        if ($find -eq $script:InvalidHandleValue) {
            $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($errorCode -eq $script:ErrorHandleEof) {
                return @()
            }
            throw [System.ComponentModel.Win32Exception]::new(
                $errorCode,
                'FindFirstStreamW failed during filesystem audit.'
            )
        }
        $closeRequired = $true
        $records = [System.Collections.Generic.List[object]]::new()
        $records.Add((Read-NativeAuditStreamRecord -Buffer $buffer))
        [System.Runtime.InteropServices.Marshal]::Copy(
            [byte[]]::new($script:FindStreamDataBytes),
            0,
            $buffer,
            $script:FindStreamDataBytes
        )
        if ($interop::FindNextStreamW($find, $buffer)) {
            $records.Add((Read-NativeAuditStreamRecord -Buffer $buffer))
            return [object[]] $records.ToArray()
        }
        $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -ne $script:ErrorHandleEof) {
            throw [System.ComponentModel.Win32Exception]::new(
                $errorCode,
                'FindNextStreamW failed during filesystem audit.'
            )
        }
        return [object[]] $records.ToArray()
    }
    finally {
        $closeError = $null
        if ($closeRequired -and -not $interop::FindClose($find)) {
            $closeError = [System.ComponentModel.Win32Exception]::new(
                [System.Runtime.InteropServices.Marshal]::GetLastWin32Error(),
                'FindClose failed during filesystem audit.'
            )
        }
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
        if ($null -ne $closeError) { throw $closeError }
    }
}

function Assert-NativeAuditDirectoryStreams {
    param([Parameter(Mandatory)] [string] $LiteralPath)

    $streams = @(Get-NativeAuditStreams -LiteralPath $LiteralPath)
    foreach ($stream in $streams) {
        if ($stream.name -cne '::$DATA') {
            throw [System.InvalidOperationException]::new(
                'A native build-input directory has a named alternate data stream.'
            )
        }
    }
    if ($streams.Count -gt 1) {
        throw [System.InvalidOperationException]::new(
            'A native build-input directory has more than one data stream.'
        )
    }
}

function Open-NativeAuditFileSession {
    param(
        [Parameter(Mandatory)] [string] $LiteralPath,
        [Parameter(Mandatory)] [uint32] $ExpectedLinkCount
    )

    $interop = Get-NativeAuditInteropType
    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath).TrimEnd('\')
    $rawHandle = $interop::CreateFileW(
        (ConvertTo-ExtendedNativeAuditPath -LiteralPath $fullPath),
        [uint32] 2147483776,
        [uint32] 0x00000001,
        [IntPtr]::Zero,
        [uint32] 3,
        [uint32] 0x08200000,
        [IntPtr]::Zero
    )
    if ($rawHandle -eq $script:InvalidHandleValue) {
        throw [System.ComponentModel.Win32Exception]::new(
            [System.Runtime.InteropServices.Marshal]::GetLastWin32Error(),
            'CreateFileW failed during filesystem audit.'
        )
    }
    $handle = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new($rawHandle, $true)
    $stream = $null
    try {
        $information = Read-NativeAuditFileInformation -Handle $handle
        $positiveObservedLinkCount = $ExpectedLinkCount -eq 0
        if (
            ($information.attributes -band 0x00000010) -ne 0 -or
            ($information.attributes -band 0x00000400) -ne 0 -or
            $information.linkCount -lt 1 -or
            (-not $positiveObservedLinkCount -and $information.linkCount -ne $ExpectedLinkCount)
        ) {
            throw [System.InvalidOperationException]::new(
                'The native build input did not have its exact declared link count.'
            )
        }
        if ($information.length -gt $script:MaximumJsonInteger) {
            throw [System.InvalidOperationException]::new(
                'The native build input exceeds the exact JSON integer length bound.'
            )
        }
        $finalPath = (Read-NativeAuditFinalPath -Handle $handle).TrimEnd('\')
        if (-not $finalPath.Equals($fullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw [System.InvalidOperationException]::new(
                'The native build input resolved through an unexpected physical path.'
            )
        }
        $stream = [System.IO.FileStream]::new(
            $handle,
            [System.IO.FileAccess]::Read,
            1024 * 1024,
            $false
        )
        return [pscustomobject] [ordered] @{
            expectedLinkCount = [uint32] $information.linkCount
            handle = $handle
            information = $information
            requestedPath = $fullPath
            stream = $stream
        }
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose() } else { $handle.Dispose() }
        throw
    }
}

function Get-NativeAuditFileHash {
    param([Parameter(Mandatory)] [object] $Session)

    $length = [int64] $Session.information.length
    $hashes = [System.Collections.Generic.List[string]]::new()
    for ($pass = 0; $pass -lt 2; $pass += 1) {
        $Session.stream.Position = 0
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            $digest = $algorithm.ComputeHash($Session.stream)
        }
        finally {
            $algorithm.Dispose()
        }
        if ($Session.stream.Position -ne $length -or $Session.stream.Length -ne $length) {
            throw [System.IO.IOException]::new(
                'A native build input length changed while hashing.'
            )
        }
        $hashes.Add(-join ($digest | ForEach-Object { $_.ToString('x2') }))
    }
    if ($hashes[0] -cne $hashes[1]) {
        throw [System.IO.IOException]::new(
            'A native build input yielded different streaming hashes.'
        )
    }
    return [pscustomobject] [ordered] @{
        ByteLength = $length
        IdentityToken = '{0:x8}:{1:x16}:{2:x16}:{3:x16}:{4}:{5}' -f @(
            $Session.information.volumeSerial,
            $Session.information.fileId,
            $Session.information.creationTime,
            $Session.information.writeTime,
            $length,
            $Session.information.linkCount
        )
        LinkCount = [uint32] $Session.information.linkCount
        Sha256 = $hashes[0]
    }
}

function Assert-NativeAuditFileStreams {
    param([Parameter(Mandatory)] [object] $Session)

    $streams = @(Get-NativeAuditStreams -LiteralPath $Session.requestedPath)
    $expectedLength = [int64] $Session.information.length
    if (
        $streams.Count -ne 1 -or
        $streams[0].name -cne '::$DATA' -or
        $streams[0].length -ne $expectedLength
    ) {
        throw [System.InvalidOperationException]::new(
            'A native build input does not have exactly one unnamed :$DATA stream.'
        )
    }
}

function Assert-NativeAuditFileStable {
    param([Parameter(Mandatory)] [object] $Session)

    $current = Read-NativeAuditFileInformation -Handle $Session.handle
    foreach ($field in @('attributes', 'creationTime', 'fileId', 'length', 'linkCount', 'volumeSerial', 'writeTime')) {
        if ($current.$field -ne $Session.information.$field) {
            throw [System.IO.IOException]::new(
                'A native build input identity changed during filesystem audit.'
            )
        }
    }
    if ($current.linkCount -ne $Session.expectedLinkCount) {
        throw [System.IO.IOException]::new(
            'A native build input link count changed during filesystem audit.'
        )
    }
    $finalPath = (Read-NativeAuditFinalPath -Handle $Session.handle).TrimEnd('\')
    if (-not $finalPath.Equals($Session.requestedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw [System.IO.IOException]::new(
            'A native build input final path changed during filesystem audit.'
        )
    }
}

function Close-NativeAuditFileSession {
    param([Parameter(Mandatory)] [object] $Session)
    $Session.stream.Dispose()
}

Export-ModuleMember -Function @(
    'Assert-NativeAuditDirectoryStreams',
    'Assert-NativeAuditFileStable',
    'Assert-NativeAuditFileStreams',
    'Close-NativeAuditFileSession',
    'Get-NativeAuditFileHash',
    'Get-NativeAuditStreams',
    'Open-NativeAuditFileSession'
)
