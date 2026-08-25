#!/usr/bin/env bash
# Run one validated, digest-pinned IG diagnostic with explicit approval and cleanup.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=skills/aks-troubleshooting/scripts/evidence-common.sh
source "$SCRIPT_DIR/evidence-common.sh"

IG_VERSION="v0.51.0"
IG_IMAGE="mcr.microsoft.com/oss/v2/inspektor-gadget/ig:v0.51.0@sha256:6610863f6d8cae28800f9331756434639bca44be065719cbcfe76e34c91dffa4"
IG_CONTAINER="aks-skills-ig"

SUBSCRIPTION=""
RESOURCE_GROUP=""
CLUSTER=""
CONTEXT=""
ARTIFACTS_DIR=""
NAMESPACE=""
POD=""
NODE=""
WORKLOAD_CONTAINER=""
GADGET=""
TIMEOUT_SECONDS=""
DEADLINE=""
MAX_ENTRIES=""
MAP_FETCH_INTERVAL=""
INTERVAL=""
SYSCALL_FILTERS=""
PACKET_FILTER=""
APPROVED="false"
DRY_RUN="false"
DEBUG_POD=""
CLEANED="false"

usage() {
    cat <<'EOF'
Usage: run-ig.sh --subscription <uuid> -g <resource-group> -n <cluster>
       --context <kube-context> --artifacts-dir <empty-directory>
       --namespace <namespace> --gadget <allowed-gadget>
       (--pod <pod> | --node <node>) [--container <container>]
       [--timeout <seconds>] [--max-entries <n>]
       [--map-fetch-interval <duration>] [--interval <duration>]
       [--syscall-filters <comma-list>] [--packet-filter <expression>]
       [--dry-run | --approve-privileged --deadline <duration>]
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
        --node) require_option_value "$@"; NODE="$2"; shift 2 ;;
        --container) require_option_value "$@"; WORKLOAD_CONTAINER="$2"; shift 2 ;;
        --gadget) require_option_value "$@"; GADGET="$2"; shift 2 ;;
        --timeout) require_option_value "$@"; TIMEOUT_SECONDS="$2"; shift 2 ;;
        --deadline) require_option_value "$@"; DEADLINE="$2"; shift 2 ;;
        --max-entries) require_option_value "$@"; MAX_ENTRIES="$2"; shift 2 ;;
        --map-fetch-interval) require_option_value "$@"; MAP_FETCH_INTERVAL="$2"; shift 2 ;;
        --interval) require_option_value "$@"; INTERVAL="$2"; shift 2 ;;
        --syscall-filters) require_option_value "$@"; SYSCALL_FILTERS="$2"; shift 2 ;;
        --packet-filter) require_option_value "$@"; PACKET_FILTER="$2"; shift 2 ;;
        --approve-privileged) APPROVED="true"; shift ;;
        --dry-run) DRY_RUN="true"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) evidence_die "unknown argument: $1" ;;
    esac
done

[[ -n "$SUBSCRIPTION" && -n "$RESOURCE_GROUP" && -n "$CLUSTER" \
    && -n "$CONTEXT" && -n "$ARTIFACTS_DIR" && -n "$NAMESPACE" \
    && -n "$GADGET" ]] || {
    usage >&2
    evidence_die "target, artifact, namespace, and gadget arguments are required"
}
[[ -z "$POD" || -z "$NODE" ]] || evidence_die "--pod and --node are mutually exclusive"
[[ -n "$POD" || -n "$NODE" ]] || evidence_die "provide --pod or --node"

validate_kubernetes_name "namespace" "$NAMESPACE"
[[ -z "$POD" ]] || validate_kubernetes_name "pod name" "$POD"
[[ -z "$NODE" ]] || validate_kubernetes_name "node name" "$NODE"
[[ -z "$WORKLOAD_CONTAINER" ]] || validate_container_name "$WORKLOAD_CONTAINER"

case "$GADGET" in
    trace_dns|trace_tcp|trace_tcpretrans|trace_bind|trace_sni|snapshot_socket|tcpdump|\
    snapshot_process|trace_exec|trace_oomkill|trace_signal|top_process|profile_cpu|\
    traceloop|trace_open|trace_fsslower|top_file|trace_capabilities) ;;
    *) evidence_die "unsupported gadget" ;;
esac

if [[ -z "$TIMEOUT_SECONDS" ]]; then
    case "$GADGET" in
        snapshot_*|top_*) TIMEOUT_SECONDS=5 ;;
        *) TIMEOUT_SECONDS=30 ;;
    esac
fi
validate_positive_integer "timeout" "$TIMEOUT_SECONDS"
[[ -z "$MAX_ENTRIES" ]] || validate_positive_integer "max entries" "$MAX_ENTRIES"
[[ -z "$MAP_FETCH_INTERVAL" ]] || validate_kubectl_duration "map fetch interval" "$MAP_FETCH_INTERVAL"
[[ -z "$INTERVAL" ]] || validate_kubectl_duration "interval" "$INTERVAL"
[[ -z "$SYSCALL_FILTERS" ]] || validate_syscall_filter "$SYSCALL_FILTERS"
[[ -z "$PACKET_FILTER" ]] || validate_packet_filter "$PACKET_FILTER"

[[ -z "$MAX_ENTRIES" || "$GADGET" == top_* || "$GADGET" == profile_* ]] \
    || evidence_die "--max-entries is valid only for top/profile gadgets"
[[ -z "$MAP_FETCH_INTERVAL" || "$GADGET" == top_* || "$GADGET" == profile_* ]] \
    || evidence_die "--map-fetch-interval is valid only for top/profile gadgets"
[[ -z "$MAP_FETCH_INTERVAL" || "$GADGET" != "top_process" ]] \
    || evidence_die "top_process uses --interval, not --map-fetch-interval"
[[ -z "$INTERVAL" || "$GADGET" == "top_process" ]] \
    || evidence_die "--interval is valid only for top_process"
[[ -z "$PACKET_FILTER" || "$GADGET" == "tcpdump" ]] \
    || evidence_die "--packet-filter is valid only for tcpdump"
if [[ "$GADGET" == "traceloop" ]]; then
    [[ -n "$SYSCALL_FILTERS" ]] || evidence_die "traceloop requires --syscall-filters"
else
    [[ -z "$SYSCALL_FILTERS" ]] || evidence_die "--syscall-filters is valid only for traceloop"
fi
if [[ "$DRY_RUN" != "true" ]]; then
    [[ "$APPROVED" == "true" ]] || evidence_die "real execution requires --approve-privileged"
    [[ -n "$DEADLINE" ]] || evidence_die "real execution requires --deadline"
    validate_kubectl_duration "deadline" "$DEADLINE"
fi

prepare_artifacts_dir "$ARTIFACTS_DIR"
verify_aks_target "$SUBSCRIPTION" "$RESOURCE_GROUP" "$CLUSTER" "$CONTEXT"

if [[ -z "$NODE" ]]; then
    if ! NODE="$(kubectl_proven get pod "$POD" -n "$NAMESPACE" \
        -o jsonpath='{.spec.nodeName}' \
        2>"$EVIDENCE_ARTIFACTS_DIR/node-resolution.error.txt")"; then
        evidence_die "unable to resolve workload node"
    fi
    validate_kubernetes_name "node name" "$NODE"
fi

filters=()
[[ -z "$POD" ]] || filters+=(--k8s-namespace "$NAMESPACE" --k8s-podname "$POD")
[[ -z "$WORKLOAD_CONTAINER" ]] || filters+=(--k8s-containername "$WORKLOAD_CONTAINER")
[[ -z "$MAX_ENTRIES" ]] || filters+=(--max-entries "$MAX_ENTRIES")
[[ -z "$MAP_FETCH_INTERVAL" ]] || filters+=(--map-fetch-interval "$MAP_FETCH_INTERVAL")
[[ -z "$INTERVAL" ]] || filters+=(--interval "$INTERVAL")
[[ -z "$SYSCALL_FILTERS" ]] || filters+=(--syscall-filters "$SYSCALL_FILTERS")

if [[ "$GADGET" == "tcpdump" ]]; then
    ig_command=(
        ig run "tcpdump:$IG_VERSION" -o pcap-ng
        ${filters[@]+"${filters[@]}"}
        --timeout "$TIMEOUT_SECONDS"
    )
    [[ -z "$PACKET_FILTER" ]] || ig_command+=(--pf "$PACKET_FILTER")
else
    ig_command=(
        ig run "$GADGET:$IG_VERSION" -o json
        ${filters[@]+"${filters[@]}"}
        --timeout "$TIMEOUT_SECONDS"
    )
fi

RUN_ID="${AKS_SKILLS_RUN_ID:-aks-skills-ig-$(date -u +%Y%m%d%H%M%S)-$$}"
validate_value "run identifier" "$RUN_ID" '^[A-Za-z0-9._-]+$'
request_timeout=()
[[ -z "$DEADLINE" ]] || request_timeout=(--request-timeout="$DEADLINE")
debug_command=(
    kubectl --context "$CONTEXT"
    ${request_timeout[@]+"${request_timeout[@]}"}
    --namespace "$NAMESPACE"
    debug --profile=sysadmin "node/$NODE" --attach=false
    --container="$IG_CONTAINER" --image="$IG_IMAGE"
    --env="AKS_SKILLS_RUN_ID=$RUN_ID" --
    "${ig_command[@]}"
)

print_command() {
    printf '%q ' "$@"
    printf '\n'
}

cat "$EVIDENCE_ARTIFACTS_DIR/target.projection.txt"
printf 'gadget=%s\nnode=%s\nnamespace=%s\ntimeoutSeconds=%s\nimage=%s\n' \
    "$GADGET" "$NODE" "$NAMESPACE" "$TIMEOUT_SECONDS" "$IG_IMAGE"
printf 'command='
print_command "${debug_command[@]}"

if [[ "$DRY_RUN" == "true" ]]; then
    printf 'executionStatus=dry-run\n'
    exit 0
fi

MARKER_PODS=""

discover_marker_pods() {
    marker_path="$EVIDENCE_ARTIFACTS_DIR/debug-marker.raw.txt"
    if ! kubectl_proven get pods -n "$NAMESPACE" \
        -o 'custom-columns=NAME:.metadata.name,RUN_IDS:.spec.containers[*].env[*].value' \
        --no-headers \
        >"$marker_path" 2>"$EVIDENCE_ARTIFACTS_DIR/debug-marker.error.txt"; then
        chmod 600 "$marker_path"
        MARKER_PODS=""
        evidence_error "unable to discover debug pods by run marker"
        return 1
    fi
    chmod 600 "$marker_path"
    MARKER_PODS="$(awk -v run="$RUN_ID" '{for (i = 2; i <= NF; i++) if ($i == run) print $1}' "$marker_path")"
}

cleanup_debug_pod() {
    [[ "$CLEANED" != "true" ]] || return 0

    local candidates="$DEBUG_POD"
    if [[ -z "$candidates" ]]; then
        if [[ -n "$MARKER_PODS" ]]; then
            candidates="$MARKER_PODS"
        else
            discover_marker_pods || return 1
            candidates="$MARKER_PODS"
        fi
    fi
    if [[ -z "$candidates" ]]; then
        evidence_error "no debug pod could be identified for cleanup"
        return 1
    fi

    local pod found=0 failed=0
    while IFS= read -r pod; do
        [[ -n "$pod" ]] || continue
        if [[ ! "$pod" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]]; then
            evidence_error "refusing invalid debug pod name during cleanup"
            failed=1
            continue
        fi
        found=1
        if ! kubectl_proven --request-timeout="$DEADLINE" \
            delete pod "$pod" -n "$NAMESPACE" --wait=false \
            >>"$EVIDENCE_ARTIFACTS_DIR/cleanup.raw.txt" 2>&1; then
            evidence_error "failed to request cleanup for debug pod $NAMESPACE/$pod"
            failed=1
        fi
    done < <(printf '%s\n' "$candidates" | awk 'NF && !seen[$0]++')

    if [[ "$found" -eq 1 && "$failed" -eq 0 ]]; then
        CLEANED="true"
        return 0
    fi
    return 1
}
trap cleanup_debug_pod EXIT
trap 'cleanup_debug_pod; exit 130' INT TERM

create_path="$EVIDENCE_ARTIFACTS_DIR/debug-create.raw.txt"
"${debug_command[@]}" >"$create_path" 2>&1
create_status=$?
chmod 600 "$create_path"

parsed_pod="$(grep -Eo 'node-debugger-[a-z0-9.-]+' "$create_path" | head -n 1 || true)"
if ! discover_marker_pods; then
    DEBUG_POD="$parsed_pod"
    if ! cleanup_debug_pod; then
        evidence_error "debug pod cleanup could not be completed after marker discovery failed"
    fi
    evidence_die "unable to identify the created debug pod by run marker"
fi

marker_count="$(printf '%s\n' "$MARKER_PODS" | awk 'NF { count++ } END { print count + 0 }')"
if [[ "$marker_count" -ne 1 ]]; then
    if [[ -n "$parsed_pod" ]]; then
        if [[ -n "$MARKER_PODS" ]]; then
            MARKER_PODS="${MARKER_PODS}"$'\n'"${parsed_pod}"
        else
            MARKER_PODS="$parsed_pod"
        fi
    fi
    if ! cleanup_debug_pod; then
        evidence_error "debug pod cleanup could not be completed after ambiguous discovery"
    fi
    evidence_die "debug pod identity is unknown or ambiguous"
fi

DEBUG_POD="$MARKER_PODS"
if [[ -n "$parsed_pod" && "$parsed_pod" != "$DEBUG_POD" ]]; then
    MARKER_PODS="${MARKER_PODS}"$'\n'"${parsed_pod}"
    DEBUG_POD=""
    if ! cleanup_debug_pod; then
        evidence_error "debug pod cleanup could not be completed after identity disagreement"
    fi
    evidence_die "debug pod output and run marker disagree"
fi
validate_kubernetes_name "debug pod name" "$DEBUG_POD"
[[ "$create_status" -eq 0 ]] || evidence_die "IG debug-pod creation command failed"

wait_path="$EVIDENCE_ARTIFACTS_DIR/debug-wait.raw.txt"
kubectl_proven --request-timeout="$DEADLINE" wait -n "$NAMESPACE" \
    --for=jsonpath='{.status.phase}'=Succeeded "pod/$DEBUG_POD" \
    --timeout="$DEADLINE" >"$wait_path" 2>&1
wait_status=$?
chmod 600 "$wait_path"

ig_raw="$EVIDENCE_ARTIFACTS_DIR/ig-output.raw.txt"
if ! kubectl_proven --request-timeout="$DEADLINE" \
    logs "$DEBUG_POD" -n "$NAMESPACE" -c "$IG_CONTAINER" \
    >"$ig_raw" 2>"$EVIDENCE_ARTIFACTS_DIR/ig-output.error.txt"; then
    chmod 600 "$ig_raw"
    evidence_die "unable to retrieve IG output"
fi
chmod 600 "$ig_raw"

cleanup_debug_pod
trap - EXIT
trap - INT TERM
[[ "$CLEANED" == "true" ]] || evidence_die "debug pod cleanup was not confirmed"

create_projected="$EVIDENCE_ARTIFACTS_DIR/debug-create.projected.txt"
redact_file "$create_path" "$create_projected"
cat "$create_projected"
emit_artifact_record "ig-output" "$ig_raw"
printf 'debugPod=%s\ncleanupStatus=requested\n' "$DEBUG_POD"
if [[ "$wait_status" -ne 0 ]]; then
    printf 'executionStatus=deadline-or-command-failure\n'
    exit 1
fi
printf 'executionStatus=complete\n'
