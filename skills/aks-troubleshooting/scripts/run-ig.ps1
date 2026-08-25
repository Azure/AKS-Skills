<#
.SYNOPSIS
Runs one validated, digest-pinned IG diagnostic with approval and cleanup.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][Alias('g')][string]$ResourceGroup,
    [Parameter(Mandatory)][Alias('n')][string]$Cluster,
    [Parameter(Mandatory)][string]$Context,
    [Parameter(Mandatory)][string]$ArtifactsDir,
    [Parameter(Mandatory)][string]$Namespace,
    [Parameter(Mandatory)][string]$Gadget,
    [string]$Pod,
    [string]$Node,
    [string]$Container,
    [int]$Timeout,
    [string]$Deadline,
    [int]$MaxEntries,
    [string]$MapFetchInterval,
    [string]$Interval,
    [string]$SyscallFilters,
    [string]$PacketFilter,
    [switch]$ApprovePrivileged,
    [switch]$DryRun
)

. (Join-Path $PSScriptRoot 'evidence-common.ps1')

$IgVersion = 'v0.51.0'
$IgImage = 'mcr.microsoft.com/oss/v2/inspektor-gadget/ig:v0.51.0@sha256:6610863f6d8cae28800f9331756434639bca44be065719cbcfe76e34c91dffa4'
$IgContainer = 'aks-skills-ig'
$AllowedGadgets = @(
    'trace_dns', 'trace_tcp', 'trace_tcpretrans', 'trace_bind', 'trace_sni',
    'snapshot_socket', 'tcpdump', 'snapshot_process', 'trace_exec',
    'trace_oomkill', 'trace_signal', 'top_process', 'profile_cpu', 'traceloop',
    'trace_open', 'trace_fsslower', 'top_file', 'trace_capabilities'
)

Assert-KubernetesName 'namespace' $Namespace
if (($Pod -and $Node) -or (-not $Pod -and -not $Node)) {
    Throw-EvidenceError 'provide exactly one of -Pod or -Node'
}
if ($Pod) { Assert-KubernetesName 'pod name' $Pod }
if ($Node) { Assert-KubernetesName 'node name' $Node }
if ($Container) { Assert-ContainerName $Container }
if ($Gadget -notin $AllowedGadgets) { Throw-EvidenceError 'unsupported gadget' }

if (-not $PSBoundParameters.ContainsKey('Timeout')) {
    $Timeout = if ($Gadget -like 'snapshot_*' -or $Gadget -like 'top_*') { 5 } else { 30 }
}
Assert-PositiveInteger 'timeout' $Timeout
$hasMaxEntries = $PSBoundParameters.ContainsKey('MaxEntries')
if ($hasMaxEntries) { Assert-PositiveInteger 'max entries' $MaxEntries }
if ($MapFetchInterval) { Assert-KubectlDuration 'map fetch interval' $MapFetchInterval }
if ($Interval) { Assert-KubectlDuration 'interval' $Interval }
if ($SyscallFilters) { Assert-SyscallFilter $SyscallFilters }
if ($PacketFilter) { Assert-PacketFilter $PacketFilter }

if ($hasMaxEntries -and $Gadget -notlike 'top_*' -and $Gadget -notlike 'profile_*') {
    Throw-EvidenceError '-MaxEntries is valid only for top/profile gadgets'
}
if ($MapFetchInterval -and $Gadget -notlike 'top_*' -and $Gadget -notlike 'profile_*') {
    Throw-EvidenceError '-MapFetchInterval is valid only for top/profile gadgets'
}
if ($MapFetchInterval -and $Gadget -eq 'top_process') {
    Throw-EvidenceError 'top_process uses -Interval, not -MapFetchInterval'
}
if ($Interval -and $Gadget -ne 'top_process') {
    Throw-EvidenceError '-Interval is valid only for top_process'
}
if ($PacketFilter -and $Gadget -ne 'tcpdump') {
    Throw-EvidenceError '-PacketFilter is valid only for tcpdump'
}
if ($Gadget -eq 'traceloop' -and -not $SyscallFilters) {
    Throw-EvidenceError 'traceloop requires -SyscallFilters'
}
if ($Gadget -ne 'traceloop' -and $SyscallFilters) {
    Throw-EvidenceError '-SyscallFilters is valid only for traceloop'
}
if (-not $DryRun) {
    if (-not $ApprovePrivileged) {
        Throw-EvidenceError 'real execution requires -ApprovePrivileged'
    }
    if (-not $Deadline) { Throw-EvidenceError 'real execution requires -Deadline' }
    Assert-KubectlDuration 'deadline' $Deadline
}

Initialize-ArtifactDirectory $ArtifactsDir
Initialize-AksEvidenceTarget $Subscription $ResourceGroup $Cluster $Context

if (-not $Node) {
    $Node = (& kubectl --context $Context get pod $Pod -n $Namespace `
        -o 'jsonpath={.spec.nodeName}' `
        2>"$script:EvidenceArtifactsDir/node-resolution.error.txt" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $Node) {
        Throw-EvidenceError 'unable to resolve workload node'
    }
    Assert-KubernetesName 'node name' $Node
}

$filters = @()
if ($Pod) { $filters += @('--k8s-namespace', $Namespace, '--k8s-podname', $Pod) }
if ($Container) { $filters += @('--k8s-containername', $Container) }
if ($hasMaxEntries) { $filters += @('--max-entries', "$MaxEntries") }
if ($MapFetchInterval) { $filters += @('--map-fetch-interval', $MapFetchInterval) }
if ($Interval) { $filters += @('--interval', $Interval) }
if ($SyscallFilters) { $filters += @('--syscall-filters', $SyscallFilters) }

if ($Gadget -eq 'tcpdump') {
    $igCommand = @('ig', 'run', "tcpdump:$IgVersion", '-o', 'pcap-ng') +
        $filters + @('--timeout', "$Timeout")
    if ($PacketFilter) { $igCommand += @('--pf', $PacketFilter) }
} else {
    $igCommand = @('ig', 'run', "${Gadget}:$IgVersion", '-o', 'json') +
        $filters + @('--timeout', "$Timeout")
}

$runId = if ($env:AKS_SKILLS_RUN_ID) {
    $env:AKS_SKILLS_RUN_ID
} else {
    'aks-skills-ig-' + [guid]::NewGuid().ToString('N')
}
Assert-EvidenceValue 'run identifier' $runId '^[A-Za-z0-9._-]+$'
$requestArguments = if ($Deadline) { @("--request-timeout=$Deadline") } else { @() }
$debugArguments = @(
    '--context', $Context
) + $requestArguments + @(
    '--namespace', $Namespace,
    'debug', '--profile=sysadmin', "node/$Node", '--attach=false',
    "--container=$IgContainer", "--image=$IgImage",
    "--env=AKS_SKILLS_RUN_ID=$runId", '--'
) + $igCommand

Get-Content -LiteralPath (Join-Path $script:EvidenceArtifactsDir 'target.projection.txt')
Write-Output "gadget=$Gadget"
Write-Output "node=$Node"
Write-Output "namespace=$Namespace"
Write-Output "timeoutSeconds=$Timeout"
Write-Output "image=$IgImage"
Write-Output ('command=kubectl ' + (($debugArguments | ForEach-Object {
    if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
}) -join ' '))

if ($DryRun) {
    Write-Output 'executionStatus=dry-run'
    exit 0
}

$debugPod = ''
$cleanupRequested = $false
$cleanupCandidates = @()
$script:MarkerDiscoveryFailed = $false
$createPath = Join-Path $script:EvidenceArtifactsDir 'debug-create.raw.txt'
$waitPath = Join-Path $script:EvidenceArtifactsDir 'debug-wait.raw.txt'
$igRawPath = Join-Path $script:EvidenceArtifactsDir 'ig-output.raw.txt'
$waitStatus = 1

function Find-MarkerPods {
    $podJsonPath = Join-Path $script:EvidenceArtifactsDir 'debug-marker.raw.json'
    & kubectl --context $Context --request-timeout=$Deadline `
        get pods -n $Namespace -o json > $podJsonPath `
        2>"$script:EvidenceArtifactsDir/debug-marker.error.txt"
    if ($LASTEXITCODE -ne 0) {
        $script:MarkerDiscoveryFailed = $true
        return @()
    }
    $script:MarkerDiscoveryFailed = $false
    try {
        $podList = Get-Content -LiteralPath $podJsonPath -Raw | ConvertFrom-Json
    } catch {
        $script:MarkerDiscoveryFailed = $true
        [Console]::Error.WriteLine('Unable to parse debug-pod marker discovery output')
        return @()
    }
    $matches = @()
    foreach ($item in $podList.items) {
        $marked = $false
        foreach ($candidateContainer in $item.spec.containers) {
            foreach ($environmentValue in $candidateContainer.env) {
                if ($environmentValue.name -eq 'AKS_SKILLS_RUN_ID' -and
                    $environmentValue.value -eq $runId) {
                    $marked = $true
                }
            }
        }
        if ($marked) { $matches += [string]$item.metadata.name }
    }
    return @($matches | Sort-Object -Unique)
}

function Remove-DebugPods {
    param([string[]]$Candidates)
    $pods = @($Candidates | Where-Object { $_ } | Sort-Object -Unique)
    if ($pods.Count -eq 0) { $pods = @(Find-MarkerPods) }
    if ($pods.Count -eq 0) {
        [Console]::Error.WriteLine('No debug pod could be identified for cleanup')
        return $false
    }

    $allDeleted = $true
    foreach ($candidatePod in $pods) {
        if ($candidatePod -notmatch '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$') {
            [Console]::Error.WriteLine('Refusing invalid debug pod name during cleanup')
            $allDeleted = $false
            continue
        }
        $deleteOutput = & kubectl --context $Context --request-timeout=$Deadline `
            delete pod $candidatePod -n $Namespace --wait=false 2>&1
        $deleteOutput | Add-Content -LiteralPath `
            "$script:EvidenceArtifactsDir/cleanup.raw.txt" -Encoding utf8NoBOM
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine(
                "Failed to request cleanup for debug pod $Namespace/$candidatePod"
            )
            $allDeleted = $false
        }
    }
    return $allDeleted
}

try {
    $createOutput = & kubectl @debugArguments 2>&1
    $createStatus = $LASTEXITCODE
    $createOutput | Set-Content -LiteralPath $createPath -Encoding utf8NoBOM

    $match = [regex]::Match(($createOutput -join "`n"), 'node-debugger-[a-z0-9.-]+')
    $parsedPod = if ($match.Success) { $match.Value } else { '' }
    if ($parsedPod) { $cleanupCandidates = @($parsedPod) }
    $markerPods = @(Find-MarkerPods)
    if ($script:MarkerDiscoveryFailed) {
        if ($parsedPod) { $cleanupCandidates = @($parsedPod) }
        Throw-EvidenceError 'unable to identify the created debug pod by run marker'
    }
    if ($markerPods.Count -ne 1) {
        $cleanupCandidates = @($markerPods)
        if ($parsedPod) { $cleanupCandidates += $parsedPod }
        Throw-EvidenceError 'debug pod identity is unknown or ambiguous'
    }

    $debugPod = $markerPods[0]
    if ($parsedPod -and $parsedPod -ne $debugPod) {
        $cleanupCandidates = @($debugPod, $parsedPod)
        $debugPod = ''
        Throw-EvidenceError 'debug pod output and run marker disagree'
    }
    Assert-KubernetesName 'debug pod name' $debugPod
    $cleanupCandidates = @($debugPod)
    if ($createStatus -ne 0) { Throw-EvidenceError 'IG debug-pod creation command failed' }

    $waitOutput = & kubectl --context $Context --request-timeout=$Deadline `
        wait -n $Namespace `
        --for='jsonpath={.status.phase}=Succeeded' "pod/$debugPod" `
        --timeout=$Deadline 2>&1
    $waitStatus = $LASTEXITCODE
    $waitOutput | Set-Content -LiteralPath $waitPath -Encoding utf8NoBOM

    & kubectl --context $Context --request-timeout=$Deadline `
        logs $debugPod -n $Namespace -c $IgContainer `
        > $igRawPath 2>"$script:EvidenceArtifactsDir/ig-output.error.txt"
    if ($LASTEXITCODE -ne 0) { Throw-EvidenceError 'unable to retrieve IG output' }
} finally {
    $cleanupRequested = Remove-DebugPods -Candidates $cleanupCandidates
}

if (-not $cleanupRequested) { Throw-EvidenceError 'debug pod cleanup was not confirmed' }
$createProjected = Join-Path $script:EvidenceArtifactsDir 'debug-create.projected.txt'
Save-RedactedEvidence $createPath $createProjected
Get-Content -LiteralPath $createProjected
Write-ArtifactRecord 'ig-output' $igRawPath
Write-Output "debugPod=$debugPod"
Write-Output 'cleanupStatus=requested'
if ($waitStatus -ne 0) {
    Write-Output 'executionStatus=deadline-or-command-failure'
    exit 1
}
Write-Output 'executionStatus=complete'
