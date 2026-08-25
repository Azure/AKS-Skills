<#
.SYNOPSIS
Collects a target-bound AKS baseline and keeps raw artifacts outside model output.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][Alias('g')][string]$ResourceGroup,
    [Parameter(Mandatory)][Alias('n')][string]$Cluster,
    [Parameter(Mandatory)][string]$Context,
    [Parameter(Mandatory)][string]$ArtifactsDir,
    [string]$Namespace
)

. (Join-Path $PSScriptRoot 'evidence-common.ps1')

if ($Namespace) { Assert-KubernetesName 'namespace' $Namespace }
Initialize-ArtifactDirectory $ArtifactsDir
Initialize-AksEvidenceTarget $Subscription $ResourceGroup $Cluster $Context

$script:CollectionFailed = $false

function Save-BaselineSection {
    param(
        [string]$Name,
        [scriptblock]$Action
    )
    $rawPath = Join-Path $script:EvidenceArtifactsDir "$Name.raw.txt"
    $output = & $Action 2>&1
    $status = $LASTEXITCODE
    $output | Set-Content -LiteralPath $rawPath -Encoding utf8NoBOM
    Write-Output ''
    Write-Output "== $Name =="
    if ($status -ne 0) {
        Write-Output "$Name.status=inaccessible"
        $script:CollectionFailed = $true
        return
    }
    $projectedPath = Join-Path $script:EvidenceArtifactsDir "$Name.projected.txt"
    Save-RedactedEvidence $rawPath $projectedPath
    Get-Content -LiteralPath $projectedPath
    Write-ArtifactRecord $Name $rawPath
}

Get-Content -LiteralPath (Join-Path $script:EvidenceArtifactsDir 'target.projection.txt')

Save-BaselineSection 'cluster-state' {
    & az aks show --subscription $Subscription --resource-group $ResourceGroup `
        --name $Cluster `
        --query '{name:name,provisioningState:provisioningState,powerState:powerState.code,kubernetesVersion:currentKubernetesVersion,fqdn:fqdn}' `
        -o table
}
Save-BaselineSection 'node-pools' {
    & az aks nodepool list --subscription $Subscription `
        --resource-group $ResourceGroup --cluster-name $Cluster `
        --query '[].{name:name,mode:mode,count:count,vmSize:vmSize,state:provisioningState,powerState:powerState.code,kubernetesVersion:orchestratorVersion}' `
        -o table
}
Save-BaselineSection 'recent-activity' {
    & az monitor activity-log list --subscription $Subscription `
        --resource-group $ResourceGroup --max-events 20 `
        --query '[].{time:eventTimestamp,operation:operationName.value,status:status.value,resource:resourceId}' `
        -o table
}
Save-BaselineSection 'nodes' {
    & kubectl --context $Context get nodes `
        -o 'custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,INTERNAL-IP:.status.addresses[?(@.type=="InternalIP")].address,VERSION:.status.nodeInfo.kubeletVersion'
}
Save-BaselineSection 'pods' {
    & kubectl --context $Context get pods -A `
        -o 'custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName'
}
Save-BaselineSection 'kube-system' {
    & kubectl --context $Context get pods -n kube-system `
        -o 'custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName'
}
Save-BaselineSection 'warning-events' {
    & kubectl --context $Context get events -A --field-selector type=Warning `
        --sort-by=.metadata.creationTimestamp `
        -o 'custom-columns=NAMESPACE:.metadata.namespace,TIME:.metadata.creationTimestamp,REASON:.reason,OBJECT:.involvedObject.name,MESSAGE:.message'
}
if ($Namespace) {
    Save-BaselineSection 'namespace-pods' {
        & kubectl --context $Context get pods -n $Namespace `
            -o 'custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName'
    }
}

if ($script:CollectionFailed) {
    Write-Output ''
    Write-Output 'collectionStatus=incomplete'
    exit 1
}
Write-Output ''
Write-Output 'collectionStatus=complete'
