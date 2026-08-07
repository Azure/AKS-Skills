#!/usr/bin/env bash
# retrieve-captures.sh — Retrieve network captures from nodes to agent workspace and cleanup
set -euo pipefail

CAPTURE_NAME=""
OUTPUT_PATH="/var/log/aks-network-captures"
WORKSPACE_DIR="${WORKSPACE_DIR:-./aks-network-captures}"
CAPTURES_DIR="${WORKSPACE_DIR}/network-captures"
NAMESPACE="default"
RETRIEVE_RUN_ID=""

usage() {
  cat <<EOF
Usage: $0 --name <capture-name> [options]

Required:
  --name <string>              Capture name (same as used in create-capture.sh)

Options:
  --output-path <path>        Host path where captures are stored (default: ${OUTPUT_PATH})
  --workspace-dir <path>      Agent workspace directory (default: ${WORKSPACE_DIR})
  --namespace <string>        Namespace containing capture Jobs (default: ${NAMESPACE})
  --run-id <string>           Exact run ID (required when the capture name has multiple runs)

Description:
  Retrieves network capture files from Kubernetes nodes to the agent workspace
  and cleans up the original files from the host filesystem.

Examples:
  # Retrieve captures for a specific capture job
  $0 --name node1-capture

  # Retrieve with custom paths
  $0 --name dns-debug --run-id 20260807-120000-0123456789abcdef01234567
EOF
  exit 1
}

# Input validation (mirrors create-capture.sh's allowlist hardening).
validate_rfc1123() {
  case "$1" in
    ""|-*|*-) return 1 ;;
    *[!a-z0-9-]*) return 1 ;;
  esac
  [ "${#1}" -le 63 ]
}
validate_node_name() {
  [ "${#1}" -le 253 ] && printf '%s' "$1" \
    | grep -Eq '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
}
validate_hostpath() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *..*|*[!a-zA-Z0-9/_.-]*) return 1 ;;
  esac
  return 0
}
validate_run_id() {
  local run_date run_remainder run_time run_token
  run_date=${1%%-*}
  run_remainder=${1#*-}
  run_time=${run_remainder%%-*}
  run_token=${run_remainder#*-}
  case "$1" in
    ""|*[!0-9a-f-]*) return 1 ;;
  esac
  [ "${#run_date}" -eq 8 ] && [ "${#run_time}" -eq 6 ] \
    && [ "${#run_token}" -eq 24 ] || return 1
  case "$run_date:$run_time" in
    *[!0-9:]*) return 1 ;;
  esac
  case "$run_token" in
    *[!0-9a-f]*) return 1 ;;
  esac
}
die() { echo "Error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --name) CAPTURE_NAME="${2:-}"; shift 2 ;;
    --output-path) OUTPUT_PATH="${2:-}"; shift 2 ;;
    --workspace-dir) WORKSPACE_DIR="${2:-}"; shift 2 ;;
    --namespace) NAMESPACE="${2:-}"; shift 2 ;;
    --run-id) RETRIEVE_RUN_ID="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [ -z "$CAPTURE_NAME" ]; then
  echo "Error: --name is required"
  usage
fi

if ! validate_rfc1123 "$CAPTURE_NAME"; then
  echo "Error: --name must be an RFC 1123 label (lowercase alphanumeric and '-', no leading/trailing '-', <=63 chars)"
  exit 1
fi

if ! validate_hostpath "$OUTPUT_PATH"; then
  echo "Error: --output-path must be an absolute path with no '..' and only [a-zA-Z0-9/_.-] characters"
  exit 1
fi
if ! validate_rfc1123 "$NAMESPACE"; then
  die "--namespace must be an RFC 1123 label"
fi
[ -z "$RETRIEVE_RUN_ID" ] || validate_run_id "$RETRIEVE_RUN_ID" \
  || die "--run-id has an invalid format"
command -v kubectl >/dev/null 2>&1 || die "kubectl not found on PATH"

CAPTURES_DIR="${WORKSPACE_DIR}/network-captures"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)

echo "Retrieving captures for: $CAPTURE_NAME"

if [ -z "$RETRIEVE_RUN_ID" ]; then
  CAPTURE_RUNS=$(kubectl get jobs -n "$NAMESPACE" -l "capture-id=${CAPTURE_NAME}" \
    -o jsonpath='{range .items[*]}{.metadata.labels.capture-run}{"\n"}{end}' \
    | sed '/^$/d' | sort -u)
  RUN_COUNT=$(printf '%s\n' "$CAPTURE_RUNS" | sed '/^$/d' | wc -l | tr -d '[:space:]')
  case "$RUN_COUNT" in
    0) die "no capture runs found for capture-id=${CAPTURE_NAME}" ;;
    1) RETRIEVE_RUN_ID="$CAPTURE_RUNS" ;;
    *) die "multiple capture runs found for '$CAPTURE_NAME'; specify --run-id" ;;
  esac
fi
validate_run_id "$RETRIEVE_RUN_ID" || die "capture run has an invalid identity"

CAPTURE_JOBS=$(kubectl get jobs -n "$NAMESPACE" \
  -l "capture-id=${CAPTURE_NAME},capture-run=${RETRIEVE_RUN_ID}" \
  -o jsonpath='{.items[*].metadata.name}')

if [ -z "$CAPTURE_JOBS" ]; then
  die "no capture Jobs found for capture-id=${CAPTURE_NAME}, capture-run=${RETRIEVE_RUN_ID}"
fi
IFS=' ' read -r -a CAPTURE_JOB_NAMES <<< "$CAPTURE_JOBS"

CAPTURE_OUTPUT_DIR="${CAPTURES_DIR}/${CAPTURE_NAME}-${RETRIEVE_RUN_ID}-${TIMESTAMP}"
echo "  Run: $RETRIEVE_RUN_ID"
echo "  Source: ${OUTPUT_PATH}/${CAPTURE_NAME}/${RETRIEVE_RUN_ID} (on nodes)"
echo "  Destination: $CAPTURE_OUTPUT_DIR"
echo ""
mkdir -p "$CAPTURE_OUTPUT_DIR"

echo "Found capture jobs: $CAPTURE_JOBS"
echo ""

cleanup_resources() {
  local failed=0 pod
  if [ "${#TEMP_PODS[@]}" -gt 0 ]; then
    for pod in "${TEMP_PODS[@]}"; do
      if ! kubectl delete pod "$pod" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1; then
        echo "Warning: failed to delete retrieval pod $pod" >&2
        failed=1
      fi
    done
  fi
  if ! kubectl delete jobs -n "$NAMESPACE" "${CAPTURE_JOB_NAMES[@]}" --ignore-not-found >/dev/null 2>&1; then
    echo "Warning: failed to delete capture Jobs for $CAPTURE_NAME" >&2
    failed=1
  fi
  return "$failed"
}
declare -a TEMP_PODS=()
cleanup_on_exit() {
  local status=$?
  trap - EXIT
  if ! cleanup_resources && [ "$status" -eq 0 ]; then
    status=1
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

for job in "${CAPTURE_JOB_NAMES[@]}"; do
  echo "Processing job: $job"
  
  NODE_NAME=$(kubectl get job "$job" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.nodeName}')
  RUN_ID=$(kubectl get job "$job" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUN_ID")].value}')
  validate_node_name "$NODE_NAME" || die "capture Job $job has an invalid node name"
  validate_run_id "$RUN_ID" || die "capture Job $job has an invalid run identity"
  [ "$RUN_ID" = "$RETRIEVE_RUN_ID" ] || die "capture Job $job does not match the requested run"
  echo "  Node: $NODE_NAME"
  
  POD_NAME=$(kubectl get pods -n "$NAMESPACE" -l "job-name=${job}" -o jsonpath='{.items[0].metadata.name}')
  
  if [ -z "$POD_NAME" ]; then
    die "no pod found for capture Job $job"
  fi
  
  POD_STATUS=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.phase}')
  echo "  Pod: $POD_NAME (Status: $POD_STATUS)"
  
  if [ "$POD_STATUS" != "Succeeded" ]; then
    echo "  Check pod logs: kubectl logs -n $NAMESPACE $POD_NAME" >&2
    die "capture pod $POD_NAME did not succeed"
  fi
  
  echo "  Retrieving capture files..."
  
  capture_slug="$(printf '%s' "$CAPTURE_NAME" | cut -c1-20)"
  node_slug="$(printf '%s' "$NODE_NAME" | tr '._' '--' | cut -c1-20)"
  TEMP_POD_NAME="$(cat <<EOF | kubectl create -f - -o jsonpath='{.metadata.name}'
apiVersion: v1
kind: Pod
metadata:
  generateName: retrieve-${capture_slug}-${node_slug}-
  namespace: ${NAMESPACE}
  labels: { app: aks-network-capture, capture-id: "${CAPTURE_NAME}", role: retrieval }
spec:
  hostNetwork: true
  nodeName: ${NODE_NAME}
  restartPolicy: Never
  containers:
  - name: retrieve
    image: mcr.microsoft.com/cbl-mariner/busybox:2.0@sha256:e4fb4d51fc9b70d6cdc1ce66a0af02ab40554d2ca632e1d188fabc760e432fdd
    command: ["sh", "-c", "sleep 300"]
    volumeMounts:
    - name: capture-output
      mountPath: /capture-output
  volumes:
  - name: capture-output
    hostPath:
      path: ${OUTPUT_PATH}/${CAPTURE_NAME}/${RETRIEVE_RUN_ID}
      type: Directory
EOF
)"
  [ -n "$TEMP_POD_NAME" ] || die "Kubernetes did not return a retrieval pod name"
  TEMP_PODS+=("$TEMP_POD_NAME")

  echo "  Waiting for retrieval pod to start..."
  kubectl wait -n "$NAMESPACE" --for=condition=Ready "pod/${TEMP_POD_NAME}" --timeout=60s
  
  echo "  Copying files from node to workspace..."
  BUNDLE_NAME="capture-${CAPTURE_NAME}-${NODE_NAME}-${RUN_ID}.tar.gz"
  kubectl cp -n "$NAMESPACE" "${TEMP_POD_NAME}:/capture-output/${BUNDLE_NAME}" \
    "${CAPTURE_OUTPUT_DIR}/${BUNDLE_NAME}" -c retrieve
  [ -s "${CAPTURE_OUTPUT_DIR}/${BUNDLE_NAME}" ] \
    || die "expected non-empty capture bundle $BUNDLE_NAME was not copied"
  
  echo "  Cleaning up capture files on node..."
  kubectl exec -n "$NAMESPACE" "${TEMP_POD_NAME}" -c retrieve -- sh -c \
    'rm -f "/capture-output/$1" "/capture-output/$2"' sh \
    "$BUNDLE_NAME" "capture-${CAPTURE_NAME}-${NODE_NAME}-${RUN_ID}.pcap"
  
  echo "  Deleting retrieval pod..."
  kubectl delete pod "${TEMP_POD_NAME}" -n "$NAMESPACE" --ignore-not-found
  
  echo "  Retrieved captures from node: $NODE_NAME"
  echo ""
done

echo "Cleaning up capture jobs..."
cleanup_resources || die "failed to clean up one or more capture resources"
trap - EXIT

echo ""
echo "=== Capture Retrieval Complete ==="
echo "Captures saved to: $CAPTURE_OUTPUT_DIR"
echo ""
echo "Files retrieved:"
ls -lh "$CAPTURE_OUTPUT_DIR"
echo ""
echo "To analyze captures:"
echo "  # Extract tarball"
echo "  tar -xzf ${CAPTURE_OUTPUT_DIR}/capture-*.tar.gz -C ${CAPTURE_OUTPUT_DIR}/"
echo ""
echo "  # Analyze pcap with tcpdump"
echo "  tcpdump -r ${CAPTURE_OUTPUT_DIR}/capture-*.pcap -nn"
