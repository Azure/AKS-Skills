Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Throw-EvidenceError {
    param([string]$Message)
    throw "ERROR: $Message"
}

function Assert-EvidenceValue {
    param(
        [string]$Label,
        [string]$Value,
        [string]$Pattern
    )
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch $Pattern) {
        Throw-EvidenceError "invalid $Label"
    }
}

function Assert-SubscriptionId {
    param([string]$Value)
    Assert-EvidenceValue 'subscription ID' $Value '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

function Assert-ResourceGroup {
    param([string]$Value)
    Assert-EvidenceValue 'resource group' $Value '^[A-Za-z0-9._() -]+$'
}

function Assert-ClusterName {
    param([string]$Value)
    Assert-EvidenceValue 'cluster name' $Value '^[A-Za-z0-9][A-Za-z0-9_-]*$'
}

function Assert-KubeContext {
    param([string]$Value)
    Assert-EvidenceValue 'kube context' $Value '^[A-Za-z0-9._:@/-]+$'
}

function Assert-KubernetesName {
    param([string]$Label, [string]$Value)
    Assert-EvidenceValue $Label $Value '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$'
}

function Assert-ContainerName {
    param([string]$Value)
    Assert-EvidenceValue 'container name' $Value '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
}

function Assert-PositiveInteger {
    param([string]$Label, [int]$Value)
    if ($Value -le 0) { Throw-EvidenceError "$Label must be positive" }
}

function Assert-KubectlDuration {
    param([string]$Label, [string]$Value)
    Assert-EvidenceValue $Label $Value '^[1-9][0-9]*(ms|s|m)$'
}

function Assert-SyscallFilter {
    param([string]$Value)
    Assert-EvidenceValue 'syscall filter' $Value '^[a-z0-9_]+(,[a-z0-9_]+)*$'
}

function Assert-PacketFilter {
    param([string]$Value)
    Assert-EvidenceValue 'packet filter' $Value '^[A-Za-z0-9:./() _-]+$'
}

function Initialize-ArtifactDirectory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -eq '/') {
        Throw-EvidenceError 'invalid artifact directory'
    }
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (-not $item.PSIsContainer -or $item.LinkType) {
            Throw-EvidenceError 'artifact directory must be a real directory'
        }
        if (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1) {
            Throw-EvidenceError 'artifact directory must be empty'
        }
    } else {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
    $script:EvidenceArtifactsDir = (Resolve-Path -LiteralPath $Path).Path
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Unix) {
        & chmod 700 -- $script:EvidenceArtifactsDir
        if ($LASTEXITCODE -ne 0) {
            Throw-EvidenceError 'unable to restrict artifact directory permissions'
        }
    }
}

function Get-FileSha256 {
    param([string]$Path)
    return 'sha256:' + (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Protect-EvidenceText {
    param([AllowEmptyString()][string[]]$Text)
    $insidePrivateKey = $false
    foreach ($lineValue in $Text) {
        $line = [string]$lineValue
        if ($line -match '(?i)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----') {
            '[REDACTED PRIVATE KEY BLOCK]'
            $insidePrivateKey = $true
            continue
        }
        if ($insidePrivateKey) {
            if ($line -match '(?i)-----END [A-Z0-9 ]*PRIVATE KEY-----') {
                $insidePrivateKey = $false
            }
            continue
        }
        $line = [regex]::Replace($line, '(?i)Authorization:\s*(Bearer|Basic)\s+\S+', 'Authorization: [REDACTED]')
        $line = [regex]::Replace($line, '(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]')
        $line = [regex]::Replace(
            $line,
            '(?i)(password|passwd|token|secret|api[_-]?key|client[_-]?secret|connection[_-]?string)(\s*[:=]\s*)\S.*$',
            '$1$2[REDACTED]'
        )
        $line = [regex]::Replace($line, '://[^/\s@]+:[^/\s@]+@', '://[REDACTED]@')
        $line
    }
}

function Save-RedactedEvidence {
    param([string]$InputPath, [string]$OutputPath)
    Protect-EvidenceText (Get-Content -LiteralPath $InputPath) |
        Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
}

function Normalize-AksEndpoint {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $normalized = $Value.ToLowerInvariant()
    $normalized = $normalized -replace '^[a-z]+://', ''
    $normalized = $normalized -replace '/.*$', ''
    $normalized = $normalized -replace ':[0-9]+$', ''
    return $normalized.TrimEnd('.')
}

function Invoke-AzTsv {
    param([string[]]$Arguments)
    $output = & az @Arguments -o tsv 2>"$script:EvidenceArtifactsDir/az-query-error.txt"
    if ($LASTEXITCODE -ne 0) { Throw-EvidenceError 'Azure target query failed' }
    return (($output | Out-String).Trim())
}

function Initialize-AksEvidenceTarget {
    param(
        [string]$Subscription,
        [string]$ResourceGroup,
        [string]$Cluster,
        [string]$Context
    )
    Assert-SubscriptionId $Subscription
    Assert-ResourceGroup $ResourceGroup
    Assert-ClusterName $Cluster
    Assert-KubeContext $Context
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) { Throw-EvidenceError 'az not found on PATH' }
    if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { Throw-EvidenceError 'kubectl not found on PATH' }

    & az account show --subscription $Subscription -o json `
        >"$script:EvidenceArtifactsDir/azure-account.raw.json" `
        2>"$script:EvidenceArtifactsDir/azure-account.error.txt"
    if ($LASTEXITCODE -ne 0) { Throw-EvidenceError 'Azure identity or subscription is inaccessible' }
    & az aks show --subscription $Subscription --resource-group $ResourceGroup `
        --name $Cluster -o json >"$script:EvidenceArtifactsDir/aks-cluster.raw.json" `
        2>"$script:EvidenceArtifactsDir/aks-cluster.error.txt"
    if ($LASTEXITCODE -ne 0) { Throw-EvidenceError 'AKS resource target is inaccessible' }

    $accountId = Invoke-AzTsv -Arguments @('account', 'show', '--subscription', $Subscription, '--query', 'id')
    if ($accountId.ToLowerInvariant() -ne $Subscription.ToLowerInvariant()) {
        Throw-EvidenceError 'Azure identity resolved a different subscription'
    }
    $script:EvidenceTenantId = Invoke-AzTsv -Arguments @('account', 'show', '--subscription', $Subscription, '--query', 'tenantId')
    $script:EvidenceIdentityType = Invoke-AzTsv -Arguments @('account', 'show', '--subscription', $Subscription, '--query', 'user.type')
    $script:EvidenceClusterId = Invoke-AzTsv -Arguments @('aks', 'show', '--subscription', $Subscription, '--resource-group', $ResourceGroup, '--name', $Cluster, '--query', 'id')
    $fqdn = Invoke-AzTsv -Arguments @('aks', 'show', '--subscription', $Subscription, '--resource-group', $ResourceGroup, '--name', $Cluster, '--query', 'fqdn')
    $privateFqdn = Invoke-AzTsv -Arguments @('aks', 'show', '--subscription', $Subscription, '--resource-group', $ResourceGroup, '--name', $Cluster, '--query', 'privateFqdn')
    if ([string]::IsNullOrWhiteSpace($script:EvidenceClusterId)) { Throw-EvidenceError 'AKS resource ID is unknown' }

    $kubeServer = & kubectl --context $Context config view --minify `
        -o 'jsonpath={.clusters[0].cluster.server}' `
        2>"$script:EvidenceArtifactsDir/kube-context.error.txt"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($kubeServer)) {
        Throw-EvidenceError 'kube context server is unknown or inaccessible'
    }
    $kubeServer = (($kubeServer | Out-String).Trim())
    $kubeHost = Normalize-AksEndpoint $kubeServer
    if ($kubeHost -ne (Normalize-AksEndpoint $fqdn) -and
        $kubeHost -ne (Normalize-AksEndpoint $privateFqdn)) {
        Throw-EvidenceError 'kube context does not target the named AKS cluster'
    }

    $script:EvidenceSubscription = $Subscription
    $script:EvidenceResourceGroup = $ResourceGroup
    $script:EvidenceCluster = $Cluster
    $script:EvidenceContext = $Context
    $script:EvidenceKubeServer = $kubeServer

    @(
        "subscription=$script:EvidenceSubscription"
        "tenantId=$script:EvidenceTenantId"
        "identityType=$script:EvidenceIdentityType"
        "resourceGroup=$script:EvidenceResourceGroup"
        "cluster=$script:EvidenceCluster"
        "clusterResourceId=$script:EvidenceClusterId"
        "kubeContext=$script:EvidenceContext"
        "kubeServer=$script:EvidenceKubeServer"
        'targetProof=matched'
    ) | Set-Content -LiteralPath "$script:EvidenceArtifactsDir/target.projection.txt" -Encoding utf8NoBOM
}

function Write-ArtifactRecord {
    param([string]$Label, [string]$Path)
    Write-Output "$Label.path=$Path"
    Write-Output "$Label.sha256=$(Get-FileSha256 $Path)"
}
