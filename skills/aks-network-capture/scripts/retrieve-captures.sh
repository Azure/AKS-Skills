#!/bin/bash
# retrieve-captures.sh — Retrieve network captures from nodes to agent workspace and cleanup
set -e

CAPTURE_NAME=""
OUTPUT_PATH="/var/log/aks-network-captures"
WORKSPACE_DIR="${WORKSPACE_DIR:-./aks-network-captures}"
CAPTURES_DIR="${WORKSPACE_DIR}/network-captures"

usage() {
  cat <<EOF
Usage: $0 --name <capture-name> [options]

Required:
  --name <string>              Capture name (same as used in create-capture.sh)

Options:
  --output-path <path>        Host path where captures are stored (default: ${OUTPUT_PATH})
  --workspace-dir <path>      Agent workspace directory (default: ${WORKSPACE_DIR})

Description:
  Retrieves network capture files from Kubernetes nodes to the agent workspace
  and cleans up the original files from the host filesystem.

Examples:
  # Retrieve captures for a specific capture job
  $0 --name node1-capture

  # Retrieve with custom paths
  $0 --name dns-debug --output-path /custom/path --workspace-dir /my/workspace
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --name) CAPTURE_NAME="$2"; shift 2 ;;
    --output-path) OUTPUT_PATH="$2"; shift 2 ;;
    --workspace-dir) WORKSPACE_DIR="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [ -z "$CAPTURE_NAME" ]; then
  echo "Error: --name is required"
  usage
fi

CAPTURES_DIR="${WORKSPACE_DIR}/network-captures"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
CAPTURE_OUTPUT_DIR="${CAPTURES_DIR}/${CAPTURE_NAME}-${TIMESTAMP}"

echo "Retrieving captures for: $CAPTURE_NAME"
echo "  Source: $OUTPUT_PATH (on nodes)"
echo "  Destination: $CAPTURE_OUTPUT_DIR"
echo ""

mkdir -p "$CAPTURE_OUTPUT_DIR"

CAPTURE_JOBS=$(kubectl get jobs -l "capture-id=${CAPTURE_NAME}" -o jsonpath='{.items[*].metadata.name}')

if [ -z "$CAPTURE_JOBS" ]; then
  echo "Error: No capture jobs found with capture-id=${CAPTURE_NAME}"
  exit 1
fi

echo "Found capture jobs: $CAPTURE_JOBS"
echo ""

for job in $CAPTURE_JOBS; do
  echo "Processing job: $job"
  
  NODE_NAME=$(kubectl get job "$job" -o jsonpath='{.spec.template.spec.nodeName}')
  echo "  Node: $NODE_NAME"
  
  POD_NAME=$(kubectl get pods -l "job-name=${job}" -o jsonpath='{.items[0].metadata.name}')
  
  if [ -z "$POD_NAME" ]; then
    echo "  Warning: No pod found for job $job, skipping"
    continue
  fi
  
  POD_STATUS=$(kubectl get pod "$POD_NAME" -o jsonpath='{.status.phase}')
  echo "  Pod: $POD_NAME (Status: $POD_STATUS)"
  
  if [ "$POD_STATUS" != "Succeeded" ]; then
    echo "  Warning: Pod has not completed successfully, skipping retrieval"
    echo "  Check pod logs: kubectl logs $POD_NAME"
    continue
  fi
  
  echo "  Retrieving capture files..."
  
  TEMP_POD_NAME="retrieve-${CAPTURE_NAME}-$(echo $NODE_NAME | tr '.' '-' | tr '_' '-' | cut -c1-20)-$(date +%s)"
  
  cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${TEMP_POD_NAME}
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

  echo "  Waiting for retrieval pod to start..."
  kubectl wait --for=condition=Ready pod/${TEMP_POD_NAME} --timeout=60s
  
  echo "  Copying files from node to workspace..."
  kubectl cp "${TEMP_POD_NAME}:/capture-output/." "${CAPTURE_OUTPUT_DIR}/" -c retrieve || echo "  Warning: Copy may have partially failed"
  
  echo "  Cleaning up capture files on node..."
  kubectl exec ${TEMP_POD_NAME} -c retrieve -- sh -c "rm -f /capture-output/capture-${NODE_NAME}-*.tar.gz /capture-output/capture-${NODE_NAME}-*.pcap /capture-output/network-info-${NODE_NAME}-*.txt" || echo "  Warning: Cleanup may have partially failed"
  
  echo "  Deleting retrieval pod..."
  kubectl delete pod ${TEMP_POD_NAME} --wait=false
  
  echo "  ✓ Retrieved captures from node: $NODE_NAME"
  echo ""
done

echo "Cleaning up capture jobs..."
kubectl delete jobs -l "capture-id=${CAPTURE_NAME}"

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
echo "  # View network info"
echo "  cat ${CAPTURE_OUTPUT_DIR}/network-info-*.txt"
echo ""
echo "  # Analyze pcap with tcpdump"
echo "  tcpdump -r ${CAPTURE_OUTPUT_DIR}/capture-*.pcap -nn"
