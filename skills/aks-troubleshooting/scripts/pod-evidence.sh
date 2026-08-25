#!/usr/bin/env bash
# Collect target-bound pod evidence with raw and model-safe projected artifacts.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=skills/aks-troubleshooting/scripts/evidence-common.sh
source "$SCRIPT_DIR/evidence-common.sh"

SUBSCRIPTION=""
RESOURCE_GROUP=""
CLUSTER=""
CONTEXT=""
ARTIFACTS_DIR=""
NAMESPACE=""
POD=""
ALL_FAILING="false"
TAIL_LINES=50

usage() {
    cat <<'EOF'
Usage: pod-evidence.sh --subscription <uuid> -g <resource-group> -n <cluster>
       --context <kube-context> --artifacts-dir <empty-directory>
       (--pod <pod> --namespace <namespace> | --all-failing [--namespace <namespace>])
       [--tail <positive-integer>]
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
        --artifacts-dir) require_option_value "$@"; ARTIFACTS_DIR="$2"; shift 2 ;;
        --namespace) require_option_value "$@"; NAMESPACE="$2"; shift 2 ;;
        --pod) require_option_value "$@"; POD="$2"; shift 2 ;;
        --all-failing) ALL_FAILING="true"; shift ;;
        --tail) require_option_value "$@"; TAIL_LINES="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) evidence_die "unknown argument: $1" ;;
    esac
done

[[ -n "$SUBSCRIPTION" && -n "$RESOURCE_GROUP" && -n "$CLUSTER" \
    && -n "$CONTEXT" && -n "$ARTIFACTS_DIR" ]] || {
    usage >&2
    evidence_die "subscription, resource group, cluster, context, and artifacts directory are required"
}
validate_positive_integer "tail" "$TAIL_LINES"
[[ -z "$NAMESPACE" ]] || validate_kubernetes_name "namespace" "$NAMESPACE"
if [[ "$ALL_FAILING" == "true" ]]; then
    [[ -z "$POD" ]] || evidence_die "--pod and --all-failing are mutually exclusive"
else
    [[ -n "$POD" && -n "$NAMESPACE" ]] || evidence_die "--pod requires --namespace"
    validate_kubernetes_name "pod name" "$POD"
fi

prepare_artifacts_dir "$ARTIFACTS_DIR"
verify_aks_target "$SUBSCRIPTION" "$RESOURCE_GROUP" "$CLUSTER" "$CONTEXT"
cat "$EVIDENCE_ARTIFACTS_DIR/target.projection.txt"

failures=0

save_and_project() {
    local label="$1"
    shift
    local raw projected
    if raw="$(collect_raw "$label" "$@")"; then
        projected="$EVIDENCE_ARTIFACTS_DIR/$label.projected.txt"
        redact_file "$raw" "$projected"
        printf '\n== %s ==\n' "$label"
        cat "$projected"
        emit_artifact_record "$label" "$raw"
    else
        printf '%s.status=inaccessible\n' "$label"
        failures=1
    fi
}

collect_pod() {
    local namespace="$1" pod="$2" prefix
    validate_kubernetes_name "namespace" "$namespace"
    validate_kubernetes_name "pod name" "$pod"
    prefix="${namespace}.${pod}"

    save_and_project "$prefix.status" \
        kubectl_proven get pod "$pod" -n "$namespace" \
        -o custom-columns='NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName'
    save_and_project "$prefix.state" \
        kubectl_proven get pod "$pod" -n "$namespace" \
        -o jsonpath='{range .status.initContainerStatuses[*]}init/{.name}{"\t"}{.ready}{"\t"}{.restartCount}{"\t"}{.state.waiting.reason}{"\t"}{.state.terminated.reason}{"\t"}{.state.terminated.exitCode}{"\t"}{.lastState.terminated.reason}{"\t"}{.lastState.terminated.exitCode}{"\n"}{end}{range .status.containerStatuses[*]}container/{.name}{"\t"}{.ready}{"\t"}{.restartCount}{"\t"}{.state.waiting.reason}{"\t"}{.state.terminated.reason}{"\t"}{.state.terminated.exitCode}{"\t"}{.lastState.terminated.reason}{"\t"}{.lastState.terminated.exitCode}{"\n"}{end}'
    save_and_project "$prefix.events" \
        kubectl_proven get events -n "$namespace" \
        --field-selector "involvedObject.kind=Pod,involvedObject.name=$pod" \
        --sort-by=.metadata.creationTimestamp \
        -o custom-columns='TIME:.metadata.creationTimestamp,TYPE:.type,REASON:.reason,MESSAGE:.message'
    save_and_project "$prefix.resources" \
        kubectl_proven get pod "$pod" -n "$namespace" \
        -o jsonpath='{range .spec.initContainers[*]}init/{.name}{"\trequests="}{.resources.requests}{"\tlimits="}{.resources.limits}{"\n"}{end}{range .spec.containers[*]}container/{.name}{"\trequests="}{.resources.requests}{"\tlimits="}{.resources.limits}{"\n"}{end}'

    local describe_path="$EVIDENCE_ARTIFACTS_DIR/$prefix.describe.raw.txt"
    if kubectl_proven describe pod "$pod" -n "$namespace" >"$describe_path" 2>&1; then
        chmod 600 "$describe_path"
        emit_artifact_record "$prefix.describe" "$describe_path"
    else
        chmod 600 "$describe_path"
        evidence_error "pod describe collection failed for $namespace/$pod"
        failures=1
    fi

    save_and_project "$prefix.logs.current" \
        kubectl_proven logs "$pod" -n "$namespace" --all-containers=true \
        --prefix=true --tail="$TAIL_LINES"

    local previous_path="$EVIDENCE_ARTIFACTS_DIR/$prefix.logs.previous.raw.txt"
    if kubectl_proven logs "$pod" -n "$namespace" --all-containers=true \
        --prefix=true --previous --tail="$TAIL_LINES" >"$previous_path" 2>&1; then
        chmod 600 "$previous_path"
        local previous_projected="$EVIDENCE_ARTIFACTS_DIR/$prefix.logs.previous.projected.txt"
        redact_file "$previous_path" "$previous_projected"
        printf '\n== %s ==\n' "$prefix.logs.previous"
        cat "$previous_projected"
        emit_artifact_record "$prefix.logs.previous" "$previous_path"
    else
        chmod 600 "$previous_path"
        printf '%s.status=unavailable\n' "$prefix.logs.previous"
        emit_artifact_record "$prefix.logs.previous" "$previous_path"
    fi

    local top_path="$EVIDENCE_ARTIFACTS_DIR/$prefix.usage.raw.txt"
    if kubectl_proven top pod "$pod" -n "$namespace" --containers \
        >"$top_path" 2>&1; then
        chmod 600 "$top_path"
        local top_projected="$EVIDENCE_ARTIFACTS_DIR/$prefix.usage.projected.txt"
        redact_file "$top_path" "$top_projected"
        printf '\n== %s ==\n' "$prefix.usage"
        cat "$top_projected"
        emit_artifact_record "$prefix.usage" "$top_path"
    else
        chmod 600 "$top_path"
        printf '%s.status=metrics-unavailable\n' "$prefix.usage"
    fi
}

if [[ "$ALL_FAILING" == "true" ]]; then
    scan_path="$EVIDENCE_ARTIFACTS_DIR/pod-scan.raw.txt"
    if [[ -n "$NAMESPACE" ]]; then
        scan_scope=(-n "$NAMESPACE")
    else
        scan_scope=(-A)
    fi
    if ! kubectl_proven get pods "${scan_scope[@]}" \
        -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount' \
        --no-headers >"$scan_path" 2>&1; then
        chmod 600 "$scan_path"
        evidence_die "unable to scan pods"
    fi
    chmod 600 "$scan_path"
    while IFS=$'\t' read -r namespace pod _; do
        [[ -n "$namespace" && -n "$pod" ]] || continue
        collect_pod "$namespace" "$pod"
    done < <(awk '{
        ready=$3; phase=$4; restarts=$5+0;
        if (phase!="Succeeded" && phase!="Completed" &&
            (phase!="Running" || ready ~ /false/ || restarts>0)) {
            print $1 "\t" $2 "\tselected"
        }
    }' "$scan_path")
    emit_artifact_record "pod-scan" "$scan_path"
else
    collect_pod "$NAMESPACE" "$POD"
fi

if [[ "$failures" -ne 0 ]]; then
    printf '\ncollectionStatus=incomplete\n'
    exit 1
fi
printf '\ncollectionStatus=complete\n'
