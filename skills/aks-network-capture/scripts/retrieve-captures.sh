#!/usr/bin/env bash
# retrieve-captures.sh — Retrieve network captures from nodes to agent workspace and cleanup
set -euo pipefail

CAPTURE_NAME=""
OUTPUT_PATH="/var/log/aks-network-captures"
WORKSPACE_DIR="${WORKSPACE_DIR:-./aks-network-captures}"
CAPTURES_DIR="${WORKSPACE_DIR}/network-captures"
NAMESPACE="default"

usage() {
  cat <<EOF
Usage: $0 --name <capture-name> [options]

Required:
  --name <string>              Capture name (same as used in create-capture.sh)

Options:
  --output-path <path>        Host path where captures are stored (default: ${OUTPUT_PATH})
  --workspace-dir <path>      Agent workspace directory (default: ${WORKSPACE_DIR})
  --namespace <string>        Namespace containing capture Jobs (default: ${NAMESPACE})

Description:
  Retrieves network capture files from Kubernetes nodes to the agent workspace
  and cleans up the original files from the host filesystem.

Examples:
  # Retrieve captures for a specific capture job
  $0 --name node1-capture

  # Retrieve with custom paths
  $0 --name dns-debug --output-path /custom/path --workspace-dir /my/workspace --namespace default
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
die() { echo "Error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --name) CAPTURE_NAME="${2:-}"; shift 2 ;;
    --output-path) OUTPUT_PATH="${2:-}"; shift 2 ;;
    --workspace-dir) WORKSPACE_DIR="${2:-}"; shift 2 ;;
    --namespace) NAMESPACE="${2:-}"; shift 2 ;;
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
command -v kubectl >/dev/null 2>&1 || die "kubectl not found on PATH"

CAPTURES_DIR="${WORKSPACE_DIR}/network-captures"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
CAPTURE_OUTPUT_DIR="${CAPTURES_DIR}/${CAPTURE_NAME}-${TIMESTAMP}"

echo "Retrieving captures for: $CAPTURE_NAME"
echo "  Source: $OUTPUT_PATH (on nodes)"
echo "  Destination: $CAPTURE_OUTPUT_DIR"
echo ""

mkdir -p "$CAPTURE_OUTPUT_DIR"

CAPTURE_JOBS=$(kubectl get jobs -n "$NAMESPACE" -l "capture-id=${CAPTURE_NAME}" -o jsonpath='{.items[*].metadata.name}')

if [ -z "$CAPTURE_JOBS" ]; then
  echo "Error: No capture jobs found with capture-id=${CAPTURE_NAME}"
  exit 1
fi

echo "Found capture jobs: $CAPTURE_JOBS"
echo ""

cleanup_resources() {
  local failed=0
  if ! kubectl delete pods -n "$NAMESPACE" \
    -l "capture-id=${CAPTURE_NAME},role=retrieval" --ignore-not-found >/dev/null 2>&1; then
    echo "Warning: failed to delete retrieval pods for $CAPTURE_NAME" >&2
    failed=1
  fi
  if ! kubectl delete jobs -n "$NAMESPACE" -l "capture-id=${CAPTURE_NAME}" --ignore-not-found >/dev/null 2>&1; then
    echo "Warning: failed to delete capture Jobs for $CAPTURE_NAME" >&2
    failed=1
  fi
  return "$failed"
}
cleanup_on_exit() {
  local status=$?
  trap - EXIT
  if ! cleanup_resources && [ "$status" -eq 0 ]; then
    status=1
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

for job in $CAPTURE_JOBS; do
  echo "Processing job: $job"
  
  NODE_NAME=$(kubectl get job "$job" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.nodeName}')
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
      path: ${OUTPUT_PATH}
      type: Directory
EOF
)"
  [ -n "$TEMP_POD_NAME" ] || die "Kubernetes did not return a retrieval pod name"

  echo "  Waiting for retrieval pod to start..."
  kubectl wait -n "$NAMESPACE" --for=condition=Ready "pod/${TEMP_POD_NAME}" --timeout=60s
  
  echo "  Copying files from node to workspace..."
  kubectl cp -n "$NAMESPACE" "${TEMP_POD_NAME}:/capture-output/." "${CAPTURE_OUTPUT_DIR}/" -c retrieve
  find "$CAPTURE_OUTPUT_DIR" -name "capture-${NODE_NAME}-*.tar.gz" -type f -size +0c -print -quit | grep -q . \
    || die "no non-empty capture bundle was copied for node $NODE_NAME"
  
  echo "  Cleaning up capture files on node..."
  kubectl exec -n "$NAMESPACE" "${TEMP_POD_NAME}" -c retrieve -- sh -c \
    'node=$1; rm -f /capture-output/capture-"$node"-*.tar.gz /capture-output/capture-"$node"-*.pcap' \
    sh "$NODE_NAME"
  
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
