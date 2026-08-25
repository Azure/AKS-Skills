<#
.SYNOPSIS
Collects target-bound AKS pod evidence with raw and model-safe projections.
#>
[CmdletBinding(DefaultParameterSetName = 'Single')]
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][Alias('g')][string]$ResourceGroup,
    [Parameter(Mandatory)][Alias('n')][string]$Cluster,
    [Parameter(Mandatory)][string]$Context,
    [Parameter(Mandatory)][string]$ArtifactsDir,
    [Parameter(Mandatory, ParameterSetName = 'Single')][string]$Pod,
    [Parameter(ParameterSetName = 'Single')]
    [Parameter(ParameterSetName = 'All')][string]$Namespace,
    [Parameter(Mandatory, ParameterSetName = 'All')][switch]$AllFailing,
    [int]$Tail = 50
)

. (Join-Path $PSScriptRoot 'evidence-common.ps1')

Assert-PositiveInteger 'tail' $Tail
if ($Namespace) { Assert-KubernetesName 'namespace' $Namespace }
if ($PSCmdlet.ParameterSetName -eq 'Single') {
    Assert-KubernetesName 'pod name' $Pod
    if (-not $Namespace) { Throw-EvidenceError '-Pod requires -Namespace' }
}

Initialize-ArtifactDirectory $ArtifactsDir
Initialize-AksEvidenceTarget $Subscription $ResourceGroup $Cluster $Context
Get-Content -LiteralPath (Join-Path $script:EvidenceArtifactsDir 'target.projection.txt')

$script:CollectionFailed = $false

function Save-PodProjection {
    param(
        [string]$Name,
        [scriptblock]$Action,
        [switch]$Optional
    )
    $rawPath = Join-Path $script:EvidenceArtifactsDir "$Name.raw.txt"
    $output = & $Action 2>&1
    $status = $LASTEXITCODE
    $output | Set-Content -LiteralPath $rawPath -Encoding utf8NoBOM
    if ($status -ne 0) {
        Write-Output "$Name.status=$(if ($Optional) { 'unavailable' } else { 'inaccessible' })"
        if (-not $Optional) { $script:CollectionFailed = $true }
        Write-ArtifactRecord $Name $rawPath
        return
    }
    $projectedPath = Join-Path $script:EvidenceArtifactsDir "$Name.projected.txt"
    Save-RedactedEvidence $rawPath $projectedPath
    Write-Output ''
    Write-Output "== $Name =="
    Get-Content -LiteralPath $projectedPath
    Write-ArtifactRecord $Name $rawPath
}

function Save-PodEvidence {
    param([string]$Ns, [string]$Name)
    Assert-KubernetesName 'namespace' $Ns
    Assert-KubernetesName 'pod name' $Name
    $prefix = "$Ns.$Name"

    Save-PodProjection "$prefix.status" {
        & kubectl --context $Context get pod $Name -n $Ns `
            -o 'custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName'
    }
    Save-PodProjection "$prefix.state" {
        & kubectl --context $Context get pod $Name -n $Ns `
            -o 'jsonpath={range .status.initContainerStatuses[*]}init/{.name}{"\t"}{.ready}{"\t"}{.restartCount}{"\t"}{.state.waiting.reason}{"\t"}{.state.terminated.reason}{"\t"}{.state.terminated.exitCode}{"\t"}{.lastState.terminated.reason}{"\t"}{.lastState.terminated.exitCode}{"\n"}{end}{range .status.containerStatuses[*]}container/{.name}{"\t"}{.ready}{"\t"}{.restartCount}{"\t"}{.state.waiting.reason}{"\t"}{.state.terminated.reason}{"\t"}{.state.terminated.exitCode}{"\t"}{.lastState.terminated.reason}{"\t"}{.lastState.terminated.exitCode}{"\n"}{end}'
    }
    Save-PodProjection "$prefix.events" {
        & kubectl --context $Context get events -n $Ns `
            --field-selector "involvedObject.kind=Pod,involvedObject.name=$Name" `
            --sort-by=.metadata.creationTimestamp `
            -o 'custom-columns=TIME:.metadata.creationTimestamp,TYPE:.type,REASON:.reason,MESSAGE:.message'
    }
    Save-PodProjection "$prefix.resources" {
        & kubectl --context $Context get pod $Name -n $Ns `
            -o 'jsonpath={range .spec.initContainers[*]}init/{.name}{"\trequests="}{.resources.requests}{"\tlimits="}{.resources.limits}{"\n"}{end}{range .spec.containers[*]}container/{.name}{"\trequests="}{.resources.requests}{"\tlimits="}{.resources.limits}{"\n"}{end}'
    }
    Save-PodProjection "$prefix.logs.current" {
        & kubectl --context $Context logs $Name -n $Ns --all-containers=true `
            --prefix=true --tail=$Tail
    }
    Save-PodProjection "$prefix.logs.previous" -Optional {
        & kubectl --context $Context logs $Name -n $Ns --all-containers=true `
            --prefix=true --previous --tail=$Tail
    }
    Save-PodProjection "$prefix.usage" -Optional {
        & kubectl --context $Context top pod $Name -n $Ns --containers
    }

    $describePath = Join-Path $script:EvidenceArtifactsDir "$prefix.describe.raw.txt"
    & kubectl --context $Context describe pod $Name -n $Ns *> $describePath
    if ($LASTEXITCODE -ne 0) { $script:CollectionFailed = $true }
    Write-ArtifactRecord "$prefix.describe" $describePath
}

if ($AllFailing) {
    $scanPath = Join-Path $script:EvidenceArtifactsDir 'pod-scan.raw.txt'
    $scope = if ($Namespace) { @('-n', $Namespace) } else { @('-A') }
    $scan = & kubectl --context $Context get pods @scope `
        -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount' `
        --no-headers 2>&1
    $scanStatus = $LASTEXITCODE
    $scan | Set-Content -LiteralPath $scanPath -Encoding utf8NoBOM
    if ($scanStatus -ne 0) { Throw-EvidenceError 'unable to scan pods' }
    foreach ($line in $scan) {
        $parts = @($line -split '\s+' | Where-Object { $_ })
        if ($parts.Count -lt 5) { continue }
        $phase = $parts[3]
        $restarts = 0
        [void][int]::TryParse($parts[4], [ref]$restarts)
        if ($phase -notin @('Succeeded', 'Completed') -and
            ($phase -ne 'Running' -or $parts[2] -match 'false' -or $restarts -gt 0)) {
            Save-PodEvidence $parts[0] $parts[1]
        }
    }
    Write-ArtifactRecord 'pod-scan' $scanPath
} else {
    Save-PodEvidence $Namespace $Pod
}

if ($script:CollectionFailed) {
    Write-Output ''
    Write-Output 'collectionStatus=incomplete'
    exit 1
}
Write-Output ''
Write-Output 'collectionStatus=complete'
