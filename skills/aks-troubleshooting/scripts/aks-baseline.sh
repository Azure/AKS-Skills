#!/usr/bin/env bash
# Collect a target-bound AKS baseline while keeping raw artifacts off stdout.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=skills/aks-troubleshooting/scripts/evidence-common.sh
source "$SCRIPT_DIR/evidence-common.sh"

SUBSCRIPTION=""
RESOURCE_GROUP=""
CLUSTER=""
CONTEXT=""
NAMESPACE=""
ARTIFACTS_DIR=""

usage() {
    cat <<'EOF'
Usage: aks-baseline.sh --subscription <uuid> -g <resource-group> -n <cluster>
       --context <kube-context> --artifacts-dir <empty-directory>
       [--namespace <namespace>]
EOF
}

require_option_value() {
    [[ $# -ge 2 ]] || evidence_die "$1 requires a value"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --subscription) require_option_value "$@"; SUBSCRIPTION="$2"; shift 2 ;;
        -g|--resource-group) require_option_value "$@"; RESOURCE_GROUP="$2"; shift 2 ;;
        -n|--cluster) require_option_value "$@"; CLUSTER="$2"; shift 2 ;;
        --context) require_option_value "$@"; CONTEXT="$2"; shift 2 ;;
        --namespace) require_option_value "$@"; NAMESPACE="$2"; shift 2 ;;
        --artifacts-dir) require_option_value "$@"; ARTIFACTS_DIR="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) evidence_die "unknown argument: $1" ;;
    esac
done

[[ -n "$SUBSCRIPTION" && -n "$RESOURCE_GROUP" && -n "$CLUSTER" \
    && -n "$CONTEXT" && -n "$ARTIFACTS_DIR" ]] || {
    usage >&2
    evidence_die "subscription, resource group, cluster, context, and artifacts directory are required"
}
[[ -z "$NAMESPACE" ]] || validate_kubernetes_name "namespace" "$NAMESPACE"

prepare_artifacts_dir "$ARTIFACTS_DIR"
verify_aks_target "$SUBSCRIPTION" "$RESOURCE_GROUP" "$CLUSTER" "$CONTEXT"

failures=0

run_section() {
    local label="$1"
    shift
    local raw projected
    printf '\n== %s ==\n' "$label"
    if raw="$(collect_raw "$label" "$@")"; then
        projected="$EVIDENCE_ARTIFACTS_DIR/$label.projected.txt"
        redact_file "$raw" "$projected"
        cat "$projected"
        emit_artifact_record "$label" "$raw"
    else
        printf '%s.status=inaccessible\n' "$label"
        failures=1
    fi
}

cat "$EVIDENCE_ARTIFACTS_DIR/target.projection.txt"

run_section "cluster-state" \
    az aks show --subscription "$SUBSCRIPTION" \
    --resource-group "$RESOURCE_GROUP" --name "$CLUSTER" \
    --query '{name:name,provisioningState:provisioningState,powerState:powerState.code,kubernetesVersion:currentKubernetesVersion,fqdn:fqdn}' \
    -o table

run_section "node-pools" \
    az aks nodepool list --subscription "$SUBSCRIPTION" \
    --resource-group "$RESOURCE_GROUP" --cluster-name "$CLUSTER" \
    --query '[].{name:name,mode:mode,count:count,vmSize:vmSize,state:provisioningState,powerState:powerState.code,kubernetesVersion:orchestratorVersion}' \
    -o table

run_section "recent-activity" \
    az monitor activity-log list --subscription "$SUBSCRIPTION" \
    --resource-group "$RESOURCE_GROUP" --max-events 20 \
    --query '[].{time:eventTimestamp,operation:operationName.value,status:status.value,resource:resourceId}' \
    -o table

run_section "nodes" \
    kubectl_proven get nodes \
    -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,INTERNAL-IP:.status.addresses[?(@.type=="InternalIP")].address,VERSION:.status.nodeInfo.kubeletVersion'

run_section "pods" \
    kubectl_proven get pods -A \
    -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName'

run_section "kube-system" \
    kubectl_proven get pods -n kube-system \
    -o custom-columns='NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName'

run_section "warning-events" \
    kubectl_proven get events -A --field-selector type=Warning \
    --sort-by=.metadata.creationTimestamp \
    -o custom-columns='NAMESPACE:.metadata.namespace,TIME:.metadata.creationTimestamp,REASON:.reason,OBJECT:.involvedObject.name,MESSAGE:.message'

if [[ -n "$NAMESPACE" ]]; then
    run_section "namespace-pods" \
        kubectl_proven get pods -n "$NAMESPACE" \
        -o custom-columns='NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName'
fi

if [[ "$failures" -ne 0 ]]; then
    printf '\ncollectionStatus=incomplete\n'
    exit 1
fi
printf '\ncollectionStatus=complete\n'
