#!/bin/bash
# create-capture.sh — Create distributed packet capture jobs on Kubernetes nodes
# Based on Microsoft Retina capture functionality
set -e

CAPTURE_NAME=""
DURATION="60s"
NODE_SELECTOR="kubernetes.io/os=linux"
NODE_NAMES=""
POD_SELECTOR=""
POD_NAMES=""
NAMESPACE="default"
NAMESPACE_SELECTOR=""
INCLUDE_FILTER=""
EXCLUDE_FILTER=""
TCPDUMP_FILTER=""
PACKET_SIZE="0"
OUTPUT_PATH="/var/log/network-captures"
MAX_CAPTURE_SIZE="100"
CAPTURE_IMAGE="nicolaka/netshoot:v0.15"

usage() {
  cat <<EOF
Usage: $0 --name <capture-name> [options]

Required:
  --name <string>              Unique name for this capture

Target Selection (choose one or more):
  --node-selector <key=val>    Node label selector (default: kubernetes.io/os=linux)
  --node-names <name1,name2>   Comma-separated list of node names
  --pod-selector <key=val>     Pod label selector
  --pod-names <name1,name2>    Comma-separated list of pod names
  --namespace <string>         Namespace for pod selection (default: default)
  --namespace-selector <key=val> Namespace label selector

Capture Configuration:
  --duration <duration>        Capture duration (default: 60s, e.g., 30s, 5m, 1h)
  --max-size <MB>             Max capture file size in MB (default: 100)
  --packet-size <bytes>       Truncate packets to size (0=no limit, default: 0)

Filters:
  --include-filter <filter>   Include filter: IP:Port,IP,Port,*:Port,IP:* (Linux only)
  --exclude-filter <filter>   Exclude filter: same format as include (Linux only)
  --tcpdump-filter <filter>   Raw tcpdump/BPF filter (e.g., "tcp and port 443")

Output:
  --output-path <path>        Host path for captures (default: /var/log/network-captures)

Advanced:
  --image <image>            Custom capture container image

Examples:
  # Capture traffic on specific node for 60 seconds
  $0 --name node1-capture --node-names "aks-node1" --duration 60s

  # Capture traffic to/from specific IP:port
  $0 --name api-traffic --include-filter "10.244.0.5:8080" --duration 30s

  # Capture DNS traffic across all Linux nodes
  $0 --name dns-debug --tcpdump-filter "udp port 53" --duration 120s

  # Capture traffic for pods with specific label
  $0 --name frontend-capture --pod-selector "app=frontend" --namespace production
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --name) CAPTURE_NAME="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --node-selector) NODE_SELECTOR="$2"; shift 2 ;;
    --node-names) NODE_NAMES="$2"; shift 2 ;;
    --pod-selector) POD_SELECTOR="$2"; shift 2 ;;
    --pod-names) POD_NAMES="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --namespace-selector) NAMESPACE_SELECTOR="$2"; shift 2 ;;
    --include-filter) INCLUDE_FILTER="$2"; shift 2 ;;
    --exclude-filter) EXCLUDE_FILTER="$2"; shift 2 ;;
    --tcpdump-filter) TCPDUMP_FILTER="$2"; shift 2 ;;
    --packet-size) PACKET_SIZE="$2"; shift 2 ;;
    --output-path) OUTPUT_PATH="$2"; shift 2 ;;
    --max-size) MAX_CAPTURE_SIZE="$2"; shift 2 ;;
    --image) CAPTURE_IMAGE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [ -z "$CAPTURE_NAME" ]; then
  echo "Error: --name is required"
  usage
fi

RANDOM_SUFFIX=$(cat /dev/urandom | tr -dc 'a-z0-9' | fold -w 5 | head -n 1)
JOB_NAME="${CAPTURE_NAME}-${RANDOM_SUFFIX}"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)

echo "Creating network capture job: $JOB_NAME"
echo "  Duration: $DURATION"
echo "  Output: $OUTPUT_PATH"

if [ -n "$NODE_NAMES" ]; then
  TARGET_NODES=(${NODE_NAMES//,/ })
else
  TARGET_NODES=($(kubectl get nodes -l "$NODE_SELECTOR" -o jsonpath='{.items[*].metadata.name}'))
fi

if [ ${#TARGET_NODES[@]} -eq 0 ]; then
  echo "Error: No nodes match the selection criteria"
  exit 1
fi

echo "  Target nodes (${#TARGET_NODES[@]}): ${TARGET_NODES[*]}"

build_tcpdump_filter() {
  # Outputs only the BPF filter string (no surrounding quotes).
  # The caller is responsible for quoting when passing to tcpdump.
  if [ -n "$TCPDUMP_FILTER" ]; then
    echo "$TCPDUMP_FILTER"
  elif [ -n "$INCLUDE_FILTER" ] || [ -n "$EXCLUDE_FILTER" ]; then
    local filter_expr=""
    if [ -n "$INCLUDE_FILTER" ]; then
      IFS=',' read -ra FILTERS <<< "$INCLUDE_FILTER"
      for f in "${FILTERS[@]}"; do
        if [[ "$f" =~ ^([0-9.]+):([0-9]+)$ ]]; then
          filter_expr="${filter_expr} or (host ${BASH_REMATCH[1]} and port ${BASH_REMATCH[2]})"
        elif [[ "$f" =~ ^([0-9.]+):\*$ ]]; then
          filter_expr="${filter_expr} or host ${BASH_REMATCH[1]}"
        elif [[ "$f" =~ ^\*:([0-9]+)$ ]]; then
          filter_expr="${filter_expr} or port ${BASH_REMATCH[1]}"
        elif [[ "$f" =~ ^[0-9.]+$ ]]; then
          filter_expr="${filter_expr} or host $f"
        elif [[ "$f" =~ ^[0-9]+$ ]]; then
          filter_expr="${filter_expr} or port $f"
        fi
      done
      filter_expr="${filter_expr# or }"
    fi
    echo "$filter_expr"
  fi
  # If neither filter is set, output nothing (capture all traffic)
}

TCPDUMP_FILTER_EXPR=$(build_tcpdump_filter)

for node in "${TARGET_NODES[@]}"; do
  cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}-$(echo $node | tr '.' '-' | tr '_' '-' | cut -c1-20)
  labels:
    app: network-capture
    capture-id: ${CAPTURE_NAME}
    capture-node: ${node}
spec:
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app: network-capture
        capture-id: ${CAPTURE_NAME}
    spec:
      hostNetwork: true
      hostPID: true
      nodeName: ${node}
      restartPolicy: Never
      containers:
      - name: capture
        image: nicolaka/netshoot:latest
        command: ["/bin/bash", "-c"]
        args:
        - |
          set -e
          export NODE_NAME="${node}"
          
          echo "Starting network capture on node \${NODE_NAME}"
          echo "Duration: ${DURATION}"
          echo "Output: /capture-output/capture-\${NODE_NAME}-${TIMESTAMP}.pcap"
          
          mkdir -p /capture-output
          
          echo "Collecting static network information..."
          /scripts/collect-network-info.sh > /capture-output/network-info-\${NODE_NAME}-${TIMESTAMP}.txt 2>&1 || echo "Warning: static network collection failed"
          
          echo "Starting packet capture..."
          TCPDUMP_CMD="timeout ${DURATION} tcpdump -i any -w /capture-output/capture-\${NODE_NAME}-${TIMESTAMP}.pcap"
          if [ "${PACKET_SIZE}" != "0" ]; then
            TCPDUMP_CMD="\$TCPDUMP_CMD -s ${PACKET_SIZE}"
          fi
          FILTER_EXPR="${TCPDUMP_FILTER_EXPR}"
          if [ -n "\$FILTER_EXPR" ]; then
            TCPDUMP_CMD="\$TCPDUMP_CMD '\$FILTER_EXPR'"
          fi
          echo "Command: \$TCPDUMP_CMD"
          eval "\$TCPDUMP_CMD" || echo "tcpdump exited with code \$?"
          
          echo "Capture complete. Files in /capture-output:"
          ls -lh /capture-output/
          
          echo "Creating tarball..."
          cd /capture-output
          tar -czf capture-\${NODE_NAME}-${TIMESTAMP}.tar.gz *.pcap *.txt
          rm -f *.pcap *.txt
          
          echo "Capture bundle created: capture-\${NODE_NAME}-${TIMESTAMP}.tar.gz"
          ls -lh capture-\${NODE_NAME}-${TIMESTAMP}.tar.gz
        securityContext:
          privileged: true
          capabilities:
            add:
            - NET_ADMIN
            - NET_RAW
        volumeMounts:
        - name: capture-output
          mountPath: /capture-output
        - name: scripts
          mountPath: /scripts
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
      volumes:
      - name: capture-output
        hostPath:
          path: ${OUTPUT_PATH}
          type: DirectoryOrCreate
      - name: scripts
        configMap:
          name: network-capture-scripts
          defaultMode: 0755
EOF

  echo "  Created job for node: $node"
done

cat <<EOF

Capture jobs created successfully!

Monitor capture jobs:
  kubectl get jobs -l capture-id=${CAPTURE_NAME} -w

View job logs:
  kubectl logs -l capture-id=${CAPTURE_NAME} -f

Check job status:
  kubectl get pods -l capture-id=${CAPTURE_NAME}

After jobs complete, retrieve captures:
  ./scripts/retrieve-captures.sh --name ${CAPTURE_NAME}

Capture files will be in: ${OUTPUT_PATH} (on nodes)

EOF
