[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AuthenticodePlanText
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:PlanSchema = 'pc-sdk.cx-004.authenticode-probe-plan.v1'
$script:ReceiptSchema = 'pc-sdk.cx-004.authenticode-probe.v1'
$script:MaximumPlanCharacters = 32768

function Fail-Probe {
    param([Parameter(Mandatory = $true)][string]$Code)
    throw [System.InvalidOperationException]::new($Code)
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )
    if ($null -eq $Value) { Fail-Probe 'invalid-shape' }
    $actual = [string[]]@($Value.PSObject.Properties | ForEach-Object Name)
    $wanted = [string[]]@($Expected)
    [Array]::Sort($actual, [StringComparer]::Ordinal)
    [Array]::Sort($wanted, [StringComparer]::Ordinal)
    if ($actual.Length -ne $wanted.Length -or
        ($actual -join [char]0) -cne ($wanted -join [char]0)) {
        Fail-Probe 'invalid-shape'
    }
}

function Assert-PlanPath {
    param([Parameter(Mandatory = $true)][object]$Value)
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$Value) -or
        ([string]$Value).IndexOf([char]0) -ge 0) {
        Fail-Probe 'invalid-path'
    }
    return [string]$Value
}

function Get-SafeAuthenticodeFact {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$LiteralPath
    )

    $signature = Get-AuthenticodeSignature -LiteralPath $LiteralPath
    if ($null -eq $signature.SignerCertificate) { Fail-Probe 'missing-signer-certificate' }
    $item = Get-Item -LiteralPath $LiteralPath -Force
    return [ordered]@{
        certificateSubject = $signature.SignerCertificate.Subject
        embeddedFileVersion = $item.VersionInfo.FileVersionRaw.ToString()
        id = $Id
        serial = $signature.SignerCertificate.SerialNumber.ToUpperInvariant()
        status = $signature.Status.ToString()
        subject = $signature.SignerCertificate.GetNameInfo(
            [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
            $false
        )
        thumbprint = $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
    }
}

try {
    if ($AuthenticodePlanText.Length -gt $script:MaximumPlanCharacters) {
        Fail-Probe 'plan-too-large'
    }
    try { $plan = $AuthenticodePlanText | ConvertFrom-Json }
    catch { Fail-Probe 'invalid-json' }
    Assert-ExactProperties -Value $plan -Expected @(
        'nodePath',
        'powershellPath',
        'pythonPath',
        'schemaVersion',
        'taskkillPath'
    )
    if ($plan.schemaVersion -cne $script:PlanSchema) { Fail-Probe 'invalid-schema' }
    $nodePath = Assert-PlanPath -Value $plan.nodePath
    $powershellPath = Assert-PlanPath -Value $plan.powershellPath
    $pythonPath = Assert-PlanPath -Value $plan.pythonPath
    $taskkillPath = Assert-PlanPath -Value $plan.taskkillPath

    $facts = @(
        Get-SafeAuthenticodeFact -Id 'node' -LiteralPath $nodePath
        Get-SafeAuthenticodeFact -Id 'python' -LiteralPath $pythonPath
        Get-SafeAuthenticodeFact -Id 'powershell-private' -LiteralPath $powershellPath
        Get-SafeAuthenticodeFact -Id 'taskkill-private' -LiteralPath $taskkillPath
    )
    [Console]::Out.WriteLine(([ordered]@{
        facts = [object[]]$facts
        osBound = $true
        schemaVersion = $script:ReceiptSchema
    } | ConvertTo-Json -Compress -Depth 4))
}
catch {
    $code = if ($_.Exception.Message -match '^[a-z0-9-]{1,64}$') {
        $_.Exception.Message
    } else {
        'authenticode-probe-failed'
    }
    [Console]::Out.WriteLine(([ordered]@{
        code = $code
        ok = $false
        schemaVersion = $script:ReceiptSchema
    } | ConvertTo-Json -Compress -Depth 3))
}
