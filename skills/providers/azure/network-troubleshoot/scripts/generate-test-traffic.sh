#!/bin/bash
# generate-test-traffic.sh — Generate test network traffic from pod's network namespace
set -e

TRAFFIC_TYPE="http"
TARGET=""
TARGET_PORT=""
SOURCE_POD=""
SOURCE_NAMESPACE="default"
DURATION="30s"
REQUEST_RATE="1"

usage() {
  cat <<EOF
Usage: $0 --source-pod <pod> --target <target> [options]

Required:
  --source-pod <name>        Pod to generate traffic from (shares network namespace)
  --target <ip|hostname>     Target IP or hostname

Options:
  --type <type>              Traffic type: http, https, dns, tcp, ping (default: http)
  --target-port <port>       Target port (default: 80 for http, 443 for https, 53 for dns)
  --source-namespace <ns>    Source pod namespace (default: default)
  --duration <duration>      How long to generate traffic (default: 30s)
  --rate <requests/sec>      Request rate per second (default: 1)

Description:
  Generates test network traffic from the source pod's network namespace.
  First tries to exec directly into the pod. If that fails, uses 'kubectl debug'
  to create an ephemeral debug container sharing the pod's network namespace.

Traffic Types:
  http     - HTTP GET requests (default port 80)
  https    - HTTPS GET requests (default port 443)
  dns      - DNS queries (default port 53)
  tcp      - TCP connection attempts
  ping     - ICMP ping

Examples:
  # Generate HTTP traffic from frontend pod to backend
  $0 --source-pod frontend-abc123 --target backend.default.svc.cluster.local

  # Generate traffic to specific IP from app pod
  $0 --source-pod app-xyz --source-namespace production --target 10.244.0.5 --target-port 8080 --type tcp

  # DNS test from pod
  $0 --source-pod debug-pod --target 10.0.0.10 --type dns --duration 60s
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --source-pod) SOURCE_POD="$2"; shift 2 ;;
    --source-namespace) SOURCE_NAMESPACE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --target-port) TARGET_PORT="$2"; shift 2 ;;
    --type) TRAFFIC_TYPE="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --rate) REQUEST_RATE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [ -z "$SOURCE_POD" ] || [ -z "$TARGET" ]; then
  echo "Error: --source-pod and --target are required"
  usage
fi

case "$TRAFFIC_TYPE" in
  dns) TARGET_PORT="${TARGET_PORT:-53}" ;;
  https) TARGET_PORT="${TARGET_PORT:-443}" ;;
  http) TARGET_PORT="${TARGET_PORT:-80}" ;;
  tcp) 
    if [ -z "$TARGET_PORT" ]; then
      echo "Error: --target-port is required for tcp traffic"
      exit 1
    fi
    ;;
esac

echo "Generating test traffic from pod: $SOURCE_POD"
echo "  Namespace: $SOURCE_NAMESPACE"
echo "  Type: $TRAFFIC_TYPE"
echo "  Target: $TARGET${TARGET_PORT:+:$TARGET_PORT}"
echo "  Duration: $DURATION"
echo "  Rate: $REQUEST_RATE requests/sec"
echo ""

INTERVAL=$(echo "scale=2; 1 / $REQUEST_RATE" | bc)

build_traffic_command() {
  case "$TRAFFIC_TYPE" in
    http)
      echo "timeout $DURATION sh -c 'while true; do curl -s -o /dev/null -w \"HTTP %{http_code} - %{time_total}s\n\" http://${TARGET}:${TARGET_PORT}/ || echo \"Request failed\"; sleep $INTERVAL; done'"
      ;;
    https)
      echo "timeout $DURATION sh -c 'while true; do curl -s -k -o /dev/null -w \"HTTPS %{http_code} - %{time_total}s\n\" https://${TARGET}:${TARGET_PORT}/ || echo \"Request failed\"; sleep $INTERVAL; done'"
      ;;
    dns)
      echo "timeout $DURATION sh -c 'while true; do nslookup ${TARGET} && echo \"DNS query succeeded\" || echo \"DNS query failed\"; sleep $INTERVAL; done'"
      ;;
    tcp)
      echo "timeout $DURATION sh -c 'while true; do nc -zv ${TARGET} ${TARGET_PORT} 2>&1 && echo \"TCP connection succeeded\" || echo \"TCP connection failed\"; sleep $INTERVAL; done'"
      ;;
    ping)
      echo "timeout $DURATION ping -i $INTERVAL ${TARGET}"
      ;;
    *)
      echo "Error: Unknown traffic type: $TRAFFIC_TYPE"
      exit 1
      ;;
  esac
}

TRAFFIC_CMD=$(build_traffic_command)

echo "Trying to exec directly into pod..."
if kubectl exec -n "$SOURCE_NAMESPACE" "$SOURCE_POD" -- sh -c "echo 'Pod accessible'" >/dev/null 2>&1; then
  echo "✓ Pod is accessible via exec"
  echo "Generating traffic..."
  echo "----------------------------------------"
  kubectl exec -n "$SOURCE_NAMESPACE" "$SOURCE_POD" -- sh -c "$TRAFFIC_CMD"
  echo "----------------------------------------"
  echo "Traffic generation complete"
else
  echo "✗ Cannot exec into pod directly"
  echo "Using kubectl debug to create ephemeral container in pod's network namespace..."
  echo ""
  
  DEBUG_CONTAINER="traffic-gen-$(date +%s)"
  
  echo "Creating debug container: $DEBUG_CONTAINER"
  echo "This container shares the network namespace with $SOURCE_POD"
  echo "----------------------------------------"
  
  kubectl debug -n "$SOURCE_NAMESPACE" "$SOURCE_POD" \
    --image=nicolaka/netshoot:latest \
    --target="$(kubectl get pod -n "$SOURCE_NAMESPACE" "$SOURCE_POD" -o jsonpath='{.spec.containers[0].name}')" \
    -it -- sh -c "$TRAFFIC_CMD"
  
  echo "----------------------------------------"
  echo "Traffic generation complete"
  echo ""
  echo "Note: Debug container was automatically cleaned up"
fi
