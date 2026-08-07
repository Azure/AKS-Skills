#!/usr/bin/env bash
# create-capture.sh — Create bounded, distributed packet-capture Jobs on AKS nodes.
#
# Safe-by-construction implementation modelled on Microsoft Retina
# (pkg/capture/provider/network_capture_unix.go, crd_to_job.go):
#   1. Every user input is validated against a strict allowlist before use.
#   2. The BPF filter never touches a shell: it is validated (no flag tokens,
#      bounded length, safe charset), passed to the capture pod as an ENV value,
#      compile-checked in-pod with `tcpdump -d`, and handed to tcpdump as a single
#      trailing argv element. There is no `eval` and no shell string interpolation
#      of user data into a command.
#   3. The capture pod is scoped, not `privileged`: NET_ADMIN + NET_RAW and
#      hostNetwork, with only the capture output directory mounted from the node.
#      The node root is never mounted and hostPID is never enabled.
#   4. The container image is pinned by digest to Microsoft Container Registry.
#
# NOTE: packet capture on live nodes cannot be exercised in CI. Run the live-cluster
# smoke test in tests/ before relying on this in production (see SKILL.md).
set -euo pipefail

# Microsoft Retina's network-tool image contains tcpdump and archive tooling.
# The multi-architecture v1.2.3 manifest is pinned by digest.
CAPTURE_IMAGE_DEFAULT="mcr.microsoft.com/containernetworking/retina-shell:v1.2.3@sha256:c7dfe8e0c0dc7fa28e4cfbad04ade270c3051c42a5495488d4d897b49fb3366f"
CONFIGMAP_NAME="network-capture-scripts"

CAPTURE_NAME=""
DURATION="60s"
NODE_SELECTOR="kubernetes.io/os=linux"
NODE_NAMES=""
POD_SELECTOR=""
POD_NAMES=""
NAMESPACE="default"
TCPDUMP_FILTER=""
PACKET_SIZE="0"
OUTPUT_BASE="/var/log/aks-network-captures"   # fixed base dir; not user-settable
CAPTURE_IMAGE="$CAPTURE_IMAGE_DEFAULT"
MAX_DURATION_SECONDS=1800                      # hard cap (matches Retina's pod grace)

usage() {
  cat <<EOF
Usage: $0 --name <capture-name> [options]

Required:
  --name <string>              Unique capture name (RFC 1123: lowercase alnum and '-')

Target selection (choose one mode):
  --node-selector <key=val>    Node label selector (default: kubernetes.io/os=linux)
  --node-names <n1,n2>         Comma-separated node names
  --pod-selector <key=val>     Pod label selector (resolves to the pods' host nodes)
  --pod-names <p1,p2>          Comma-separated pod names (with --namespace)
  --namespace <string>         Namespace for target pods and capture Jobs (default: default)

Capture configuration:
  --duration <Ns|Nm|Nh>        Capture duration (default: 60s, max: ${MAX_DURATION_SECONDS}s)
  --packet-size <bytes>        Truncate packets to N bytes (0 = full, default: 0)
  --tcpdump-filter <expr>      BPF filter, e.g. "tcp and port 443". No flags/metachars.

Examples:
  $0 --name dns-debug --tcpdump-filter "udp port 53" --duration 120s
  $0 --name frontend --pod-selector "app=frontend" --namespace production
EOF
  exit 1
}

die() { echo "Error: $*" >&2; exit 1; }

# --- strict validators (allowlist, never denylist) ---
valid_rfc1123() {
  [ "${#1}" -le 63 ] && printf '%s' "$1" | grep -Eq '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
}
valid_label_selector() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._/=,-]+$'; }
valid_duration() { printf '%s' "$1" | grep -Eq '^[0-9]+[smh]$'; }
valid_uint() { printf '%s' "$1" | grep -Eq '^[0-9]+$'; }

duration_to_seconds() {
  local d="$1" n unit
  n="${d%[smh]}"; unit="${d##*[0-9]}"
  case "$unit" in s) echo "$n";; m) echo "$((n*60))";; h) echo "$((n*3600))";; esac
}

# Validate a BPF filter WITHOUT a shell. Mirrors Retina's obtainAndValidateUserFilter:
# reject empty-after-trim as "capture all"; reject any whitespace token beginning with
# '-' (blocks -w/-i/-c and the -z postrotate-command RCE); bound length; allow only a
# conservative BPF charset. Final syntax validation is done in-pod via `tcpdump -d`.
validate_filter() {
  local f="$1" tok
  [ -z "$f" ] && return 0
  [ "${#f}" -le 1024 ] || die "--tcpdump-filter too long (max 1024 chars)"
  # Safe BPF charset only: letters, digits, spaces, dots, colons, slashes, brackets,
  # and the operators () and & | . No quotes, backticks, ;, $, newlines, or backslashes.
  printf '%s' "$f" | grep -Eq '^[A-Za-z0-9 ._:/()&|<>=!-]+$' \
    || die "--tcpdump-filter contains disallowed characters"
  for tok in $f; do
    case "$tok" in
      -*) die "--tcpdump-filter may not contain flag tokens (found '$tok')";;
    esac
  done
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) CAPTURE_NAME="${2:-}"; shift 2 ;;
    --duration) DURATION="${2:-}"; shift 2 ;;
    --node-selector) NODE_SELECTOR="${2:-}"; shift 2 ;;
    --node-names) NODE_NAMES="${2:-}"; shift 2 ;;
    --pod-selector) POD_SELECTOR="${2:-}"; shift 2 ;;
    --pod-names) POD_NAMES="${2:-}"; shift 2 ;;
    --namespace) NAMESPACE="${2:-}"; shift 2 ;;
    --tcpdump-filter) TCPDUMP_FILTER="${2:-}"; shift 2 ;;
    --packet-size) PACKET_SIZE="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

# --- validate every input up front ---
[ -n "$CAPTURE_NAME" ] || die "--name is required"
valid_rfc1123 "$CAPTURE_NAME" || die "--name must be RFC 1123 (lowercase alnum and '-')"
valid_duration "$DURATION" || die "--duration must look like 30s, 5m, or 1h"
DUR_SECONDS="$(duration_to_seconds "$DURATION")"
[ "$DUR_SECONDS" -ge 1 ] && [ "$DUR_SECONDS" -le "$MAX_DURATION_SECONDS" ] \
  || die "--duration must be between 1s and ${MAX_DURATION_SECONDS}s"
valid_uint "$PACKET_SIZE" || die "--packet-size must be a non-negative integer"
[ "$PACKET_SIZE" -le 262144 ] || die "--packet-size too large (max 262144)"
valid_label_selector "$NODE_SELECTOR" || die "--node-selector has invalid characters"
[ -z "$POD_SELECTOR" ] || valid_label_selector "$POD_SELECTOR" || die "--pod-selector invalid"
valid_rfc1123 "$NAMESPACE" || die "--namespace must be RFC 1123"
validate_filter "$TCPDUMP_FILTER"

command -v kubectl >/dev/null 2>&1 || die "kubectl not found on PATH"
kubectl get configmap "$CONFIGMAP_NAME" -n "$NAMESPACE" \
  -o go-template='{{ index .data "run-capture.sh" }}' 2>/dev/null | grep -q . \
  || die "ConfigMap '$CONFIGMAP_NAME' not found in namespace '$NAMESPACE'; run setup-capture-configmap.sh $NAMESPACE first"

# --- resolve target nodes and (for pod modes) the pod IPs to narrow the filter ---
POD_IP_FILTER=""
declare -a TARGET_NODES=()

resolve_pod_targets() {
  # Resolve pods -> their host nodes and all pod IPs (dual-stack aware), then build
  # an OR-combined "(host ip ...)" filter, exactly as Retina does. Node scope stays,
  # but the BPF filter is narrowed to the pod IPs.
  local jsonpath='{range .items[*]}{.spec.nodeName}{" "}{range .status.podIPs[*]}{.ip}{","}{end}{"\n"}{end}'
  local out
  if [ -n "$POD_NAMES" ]; then
    IFS=',' read -r -a _pods <<< "$POD_NAMES"
    for p in "${_pods[@]}"; do
      valid_rfc1123 "$p" || die "pod name '$p' is not RFC 1123"
    done
    out="$(kubectl get pods -n "$NAMESPACE" "${_pods[@]}" -o jsonpath="$jsonpath")"
  else
    out="$(kubectl get pods -n "$NAMESPACE" -l "$POD_SELECTOR" -o jsonpath="$jsonpath")"
  fi
  local ips=""
  while read -r node iplist; do
    [ -n "$node" ] || continue
    TARGET_NODES+=("$node")
    IFS=',' read -r -a _ips <<< "$iplist"
    for ip in "${_ips[@]}"; do [ -n "$ip" ] && ips="${ips:+$ips or }host $ip"; done
  done <<< "$out"
  [ -n "$ips" ] && POD_IP_FILTER="($ips)"
  # de-duplicate nodes
  mapfile -t TARGET_NODES < <(printf '%s\n' "${TARGET_NODES[@]}" | sort -u)
}

if [ -n "$POD_SELECTOR" ] || [ -n "$POD_NAMES" ]; then
  resolve_pod_targets
elif [ -n "$NODE_NAMES" ]; then
  IFS=',' read -r -a TARGET_NODES <<< "$NODE_NAMES"
  for n in "${TARGET_NODES[@]}"; do valid_rfc1123 "$n" || die "node name '$n' is not RFC 1123"; done
else
  IFS=$'\n' read -r -d '' -a TARGET_NODES < <(kubectl get nodes -l "$NODE_SELECTOR" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' && printf '\0')
fi
[ "${#TARGET_NODES[@]}" -gt 0 ] || die "no nodes match the selection criteria"

# Combine the user filter with the pod-IP filter (both already validated / API-derived).
EFFECTIVE_FILTER="$TCPDUMP_FILTER"
if [ -n "$POD_IP_FILTER" ]; then
  if [ -n "$EFFECTIVE_FILTER" ]; then EFFECTIVE_FILTER="($EFFECTIVE_FILTER) and $POD_IP_FILTER"
  else EFFECTIVE_FILTER="$POD_IP_FILTER"; fi
fi

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
echo "Creating capture '$CAPTURE_NAME' on ${#TARGET_NODES[@]} node(s): ${TARGET_NODES[*]}"

declare -a CREATED_JOBS=()
cleanup_partial_jobs() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "${#CREATED_JOBS[@]}" -gt 0 ]; then
    echo "Capture Job creation failed; removing partially created Jobs" >&2
    kubectl delete jobs -n "$NAMESPACE" "${CREATED_JOBS[@]}" --ignore-not-found >/dev/null 2>&1 \
      || echo "Warning: failed to remove one or more partially created Jobs" >&2
  fi
  exit "$status"
}
trap cleanup_partial_jobs EXIT

# --- render one Job per node ---
# The container command is a fixed ConfigMap script. All user values reach the pod only
# through env entries whose values were validated above. The filter is compile-checked
# in-pod and passed to tcpdump as one trailing argument.
for node in "${TARGET_NODES[@]}"; do
  node_slug="$(printf '%s' "$node" | tr '._' '--' | cut -c1-40 | sed 's/-*$//')"
  capture_slug="$(printf '%s' "$CAPTURE_NAME" | cut -c1-20 | sed 's/-*$//')"
  node_prefix="$(printf '%s' "$node_slug" | cut -c1-12 | sed 's/-*$//')"
  node_checksum="$(printf '%s' "$node" | cksum | awk '{print $1}')"
  job_name="${capture_slug}-${node_prefix}-${node_checksum}"
  CREATED_JOBS+=("$job_name")
  kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job_name}
  namespace: ${NAMESPACE}
  labels: { app: aks-network-capture, capture-id: "${CAPTURE_NAME}", capture-node: "${node_slug}" }
spec:
  ttlSecondsAfterFinished: 3600
  backoffLimit: 0
  template:
    metadata:
      labels: { app: aks-network-capture, capture-id: "${CAPTURE_NAME}" }
    spec:
      hostNetwork: true
      nodeName: "${node}"
      restartPolicy: Never
      terminationGracePeriodSeconds: ${MAX_DURATION_SECONDS}
      containers:
      - name: capture
        image: "${CAPTURE_IMAGE}"
        securityContext:
          privileged: false
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          runAsUser: 0
          capabilities:
            drop: ["ALL"]
            add: ["NET_ADMIN", "NET_RAW"]
        env:
        - { name: PCAP_FILTER, value: "${EFFECTIVE_FILTER}" }
        - { name: CAPTURE_DURATION, value: "${DUR_SECONDS}" }
        - { name: PACKET_SIZE, value: "${PACKET_SIZE}" }
        - { name: OUT_DIR, value: "${OUTPUT_BASE}" }
        - { name: STAMP, value: "${TIMESTAMP}" }
        - { name: NODE_NAME, valueFrom: { fieldRef: { fieldPath: spec.nodeName } } }
        command: ["/bin/sh", "/capture-scripts/run-capture.sh"]
        volumeMounts:
        - { name: capture-output, mountPath: "${OUTPUT_BASE}" }
        - { name: capture-scripts, mountPath: /capture-scripts, readOnly: true }
      volumes:
      - name: capture-output
        hostPath: { path: "${OUTPUT_BASE}", type: DirectoryOrCreate }
      - name: capture-scripts
        configMap:
          name: ${CONFIGMAP_NAME}
          defaultMode: 0555
EOF
  echo "  job created for node: $node"
done
trap - EXIT

cat <<EOF

Capture started. Monitor and retrieve:
  kubectl get jobs -n ${NAMESPACE} -l capture-id=${CAPTURE_NAME} -w
  kubectl logs -n ${NAMESPACE} -l capture-id=${CAPTURE_NAME} -f
  ./scripts/retrieve-captures.sh --name ${CAPTURE_NAME} --namespace ${NAMESPACE}

Bundles are written to ${OUTPUT_BASE} on each node.
EOF
