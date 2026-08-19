#!/usr/bin/env bash
# smoke-live-cluster.sh — MANUAL pre-production gate for aks-network-capture.
#
# Runs the production setup, create, and retrieval scripts in a unique namespace
# against exactly one Linux node. The test generates bounded DNS traffic on that
# node, proves the retrieved pcap contains packet records, and removes every
# Kubernetes resource plus the exact host artifact path on every exit.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")/../../../skills/aks-network-capture/scripts" && pwd)"
CAPTURE_IMAGE="mcr.microsoft.com/containernetworking/retina-shell:v1.2.3@sha256:c7dfe8e0c0dc7fa28e4cfbad04ade270c3051c42a5495488d4d897b49fb3366f"
HELPER_IMAGE="mcr.microsoft.com/cbl-mariner/busybox:2.0@sha256:e4fb4d51fc9b70d6cdc1ce66a0af02ab40554d2ca632e1d188fabc760e432fdd"
OUTPUT_BASE="/var/log/aks-network-captures"
NODE=""
NAMESPACE=""
OUT=""
RUN_ID=""
JOB_NAME=""
NAMESPACE_CREATED=0
DNS_POD="dns-source"

usage() {
  cat <<EOF
Usage: $0 [--node <linux-node>] [--namespace <unique-namespace>]

The namespace must not already exist. When omitted, a unique namespace is generated.
EOF
}

valid_rfc1123() {
  case "$1" in ""|-*|*-) return 1 ;; *[!a-z0-9-]*) return 1 ;; esac
  [ "${#1}" -le 63 ]
}

valid_run_id() {
  printf '%s' "$1" | grep -Eq '^[0-9]{8}-[0-9]{6}-[0-9a-f]{24}$'
}

wait_for_succeeded_pod() {
  local pod="$1"
  if ! kubectl wait -n "$NAMESPACE" --for=jsonpath='{.status.phase}'=Succeeded \
    "pod/${pod}" --timeout=120s; then
    kubectl logs -n "$NAMESPACE" "$pod" >&2 || :
    return 1
  fi
}

get_namespace_name() {
  kubectl get namespace "$NAMESPACE" --ignore-not-found -o name
}

create_host_probe() {
  local pod="$1" action="$2"
  case "$action" in
    absent)
      cat <<EOF | kubectl create -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  namespace: ${NAMESPACE}
spec:
  nodeName: "${NODE}"
  restartPolicy: Never
  containers:
  - name: probe
    image: "${HELPER_IMAGE}"
    securityContext:
      privileged: false
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsUser: 0
      capabilities: { drop: ["ALL"] }
    command: ["sh", "-c"]
    args:
    - 'test ! -e "/capture-root/\$1"'
    - sh
    - "${NAME}"
    volumeMounts:
    - { name: capture-root, mountPath: /capture-root, readOnly: true }
  volumes:
  - name: capture-root
    hostPath: { path: "${OUTPUT_BASE}", type: DirectoryOrCreate }
EOF
      ;;
    cleanup)
      [ -n "$RUN_ID" ] && valid_run_id "$RUN_ID" || return 1
      cat <<EOF | kubectl create -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  namespace: ${NAMESPACE}
spec:
  nodeName: "${NODE}"
  restartPolicy: Never
  containers:
  - name: cleanup
    image: "${HELPER_IMAGE}"
    securityContext:
      privileged: false
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsUser: 0
      capabilities: { drop: ["ALL"] }
    command: ["sh", "-c"]
    args:
    - |
      set -eu
      capture_dir="/capture-root/\$1"
      run_dir="\${capture_dir}/\$2"
      rm -f "\${run_dir}/\$3" "\${run_dir}/\$4"
      if [ -d "\$run_dir" ]; then rmdir "\$run_dir"; fi
      if [ -d "\$capture_dir" ]; then rmdir "\$capture_dir"; fi
      test ! -e "\$capture_dir"
    - sh
    - "${NAME}"
    - "${RUN_ID}"
    - "capture-${NAME}-${NODE}-${RUN_ID}.tar.gz"
    - "capture-${NAME}-${NODE}-${RUN_ID}.pcap"
    volumeMounts:
    - { name: capture-root, mountPath: /capture-root }
  volumes:
  - name: capture-root
    hostPath: { path: "${OUTPUT_BASE}", type: DirectoryOrCreate }
EOF
      ;;
    *) return 1 ;;
  esac
}

cleanup() {
  local original_status=$? cleanup_failed=0 discovered_runs namespace_name="" run_count
  trap - EXIT
  set +e

  if [ "$NAMESPACE_CREATED" -eq 1 ]; then
    if ! namespace_name="$(get_namespace_name 2>/dev/null)"; then
      echo "CLEANUP ERROR: namespace state could not be queried" >&2
      cleanup_failed=1
      namespace_name=""
    elif [ -z "$namespace_name" ]; then
      if kubectl create namespace "$NAMESPACE" >/dev/null; then
        namespace_name="namespace/${NAMESPACE}"
      else
        echo "CLEANUP ERROR: cleanup namespace could not be recreated" >&2
        cleanup_failed=1
      fi
    fi
  fi

  if [ -n "$namespace_name" ]; then
    if [ -z "$RUN_ID" ]; then
      discovered_runs="$(kubectl get jobs -n "$NAMESPACE" -l "capture-id=${NAME}" \
        -o jsonpath='{range .items[*]}{.metadata.labels.capture-run}{"\n"}{end}' 2>/dev/null \
        | sed '/^$/d' | sort -u)"
      run_count="$(printf '%s\n' "$discovered_runs" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
      if [ "$run_count" = "1" ] && valid_run_id "$discovered_runs"; then
        RUN_ID="$discovered_runs"
      fi
    fi

    if [ -n "$RUN_ID" ]; then
      kubectl delete pod host-cleanup -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1
      if create_host_probe host-cleanup cleanup >/dev/null \
        && wait_for_succeeded_pod host-cleanup >/dev/null; then
        echo "CLEANUP: exact host capture files and directories removed"
      else
        echo "CLEANUP ERROR: exact host capture path could not be removed" >&2
        cleanup_failed=1
      fi
      kubectl delete pod host-cleanup -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1
    fi

    kubectl delete pod host-verify -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1
    if create_host_probe host-verify absent >/dev/null \
      && wait_for_succeeded_pod host-verify >/dev/null; then
      echo "CLEANUP VERIFIED: ${OUTPUT_BASE}/${NAME} is absent on ${NODE}"
    else
      echo "CLEANUP ERROR: ${OUTPUT_BASE}/${NAME} still exists on ${NODE}" >&2
      cleanup_failed=1
    fi

    if ! kubectl delete namespace "$NAMESPACE" --wait=true >/dev/null; then
      echo "CLEANUP ERROR: namespace $NAMESPACE could not be deleted" >&2
      cleanup_failed=1
    elif ! namespace_name="$(get_namespace_name 2>/dev/null)"; then
      echo "CLEANUP ERROR: namespace absence could not be verified" >&2
      cleanup_failed=1
    elif [ -n "$namespace_name" ]; then
      echo "CLEANUP ERROR: namespace $NAMESPACE still exists" >&2
      cleanup_failed=1
    else
      echo "CLEANUP VERIFIED: namespace $NAMESPACE is absent"
    fi
  fi

  if [ -n "$OUT" ] && [ -d "$OUT" ]; then
    rm -rf "$OUT"
  fi

  if [ "$original_status" -ne 0 ]; then
    exit "$original_status"
  fi
  [ "$cleanup_failed" -eq 0 ] || exit 1
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE="${2:-}"; shift 2 ;;
    --namespace) NAMESPACE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for command in kubectl tcpdump tar od; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command required" >&2; exit 2; }
done
kubectl cluster-info >/dev/null 2>&1 || {
  echo "kubectl is not pointed at a live cluster" >&2
  exit 2
}

token="$(LC_ALL=C od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
[ "${#token}" -eq 8 ] || { echo "failed to generate smoke identity" >&2; exit 2; }
NAME="smoke-${token}"
NAMESPACE="${NAMESPACE:-aks-netcap-smoke-${token}}"
valid_rfc1123 "$NAMESPACE" || { echo "namespace must be an RFC 1123 label" >&2; exit 2; }

if [ -z "$NODE" ]; then
  NODE="$(kubectl get nodes \
    -l 'kubernetes.io/os=linux,kubernetes.azure.com/mode=user' \
    -o jsonpath='{.items[0].metadata.name}')"
fi
[ -n "$NODE" ] || { echo "no Linux user-pool node found" >&2; exit 2; }
[ "$(kubectl get node "$NODE" -o jsonpath='{.metadata.labels.kubernetes\.io/os}')" = "linux" ] \
  || { echo "selected node is not Linux: $NODE" >&2; exit 2; }
if ! namespace_name="$(get_namespace_name 2>/dev/null)"; then
  echo "namespace state could not be queried; refusing mutation" >&2
  exit 2
elif [ -n "$namespace_name" ]; then
  echo "namespace already exists; refusing mutation: $NAMESPACE" >&2
  exit 2
fi

echo "== isolated smoke test =="
echo "namespace: $NAMESPACE"
echo "node: $NODE"
echo "capture: $NAME"

kubectl create namespace "$NAMESPACE" >/dev/null
NAMESPACE_CREATED=1
trap cleanup EXIT

create_host_probe host-preflight absent >/dev/null
wait_for_succeeded_pod host-preflight >/dev/null || {
  echo "pre-existing host capture path detected; refusing capture" >&2
  exit 2
}
kubectl delete pod host-preflight -n "$NAMESPACE" --wait=true >/dev/null

"$SCRIPTS/setup-capture-configmap.sh" "$NAMESPACE"

cat <<EOF | kubectl create -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${DNS_POD}
  namespace: ${NAMESPACE}
spec:
  nodeName: "${NODE}"
  restartPolicy: Never
  containers:
  - name: dns-source
    image: "${HELPER_IMAGE}"
    securityContext:
      privileged: false
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities: { drop: ["ALL"] }
    command: ["sh", "-c", "sleep 300"]
EOF
kubectl wait -n "$NAMESPACE" --for=condition=Ready "pod/${DNS_POD}" --timeout=120s >/dev/null

"$SCRIPTS/create-capture.sh" --name "$NAME" --node-names "$NODE" \
  --namespace "$NAMESPACE" --duration 15s --tcpdump-filter "udp port 53"

capture_runs="$(kubectl get jobs -n "$NAMESPACE" -l "capture-id=${NAME}" \
  -o jsonpath='{range .items[*]}{.metadata.labels.capture-run}{"\n"}{end}' \
  | sed '/^$/d' | sort -u)"
run_count="$(printf '%s\n' "$capture_runs" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
[ "$run_count" = "1" ] && valid_run_id "$capture_runs" \
  || { echo "expected exactly one valid capture run identity" >&2; exit 1; }
RUN_ID="$capture_runs"

capture_jobs="$(kubectl get jobs -n "$NAMESPACE" \
  -l "capture-id=${NAME},capture-run=${RUN_ID}" \
  -o jsonpath='{.items[*].metadata.name}')"
[ "$(printf '%s\n' "$capture_jobs" | wc -w | tr -d '[:space:]')" = "1" ] \
  || { echo "expected exactly one generated capture Job" >&2; exit 1; }
JOB_NAME="$capture_jobs"

job_image="$(kubectl get job "$JOB_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].image}')"
job_caps="$(kubectl get job "$JOB_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].securityContext.capabilities.add[*]}')"
job_privileged="$(kubectl get job "$JOB_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].securityContext.privileged}')"
job_host_pid="$(kubectl get job "$JOB_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.hostPID}')"
[ "$job_image" = "$CAPTURE_IMAGE" ] \
  && [ "$job_caps" = "NET_ADMIN NET_RAW" ] \
  && [ "$job_privileged" = "false" ] \
  && { [ -z "$job_host_pid" ] || [ "$job_host_pid" = "false" ]; } \
  || { echo "capture Job violates the live safety contract" >&2; exit 1; }

capture_pod="$(kubectl get pods -n "$NAMESPACE" -l "job-name=${JOB_NAME}" \
  -o jsonpath='{.items[0].metadata.name}')"
[ -n "$capture_pod" ] || { echo "capture pod was not created" >&2; exit 1; }
kubectl wait -n "$NAMESPACE" --for=condition=Ready "pod/${capture_pod}" --timeout=120s >/dev/null

kubectl exec -n "$NAMESPACE" "$DNS_POD" -- sh -c \
  'i=0; while [ "$i" -lt 8 ]; do nslookup kubernetes.default.svc.cluster.local >/dev/null; i=$((i+1)); done'

if ! kubectl wait -n "$NAMESPACE" --for=condition=complete \
  "job/${JOB_NAME}" --timeout=120s; then
  kubectl logs -n "$NAMESPACE" "$capture_pod" --tail=50 >&2 || :
  exit 1
fi

OUT="$(mktemp -d)"
"$SCRIPTS/retrieve-captures.sh" --name "$NAME" --run-id "$RUN_ID" \
  --namespace "$NAMESPACE" --workspace-dir "$OUT"

bundle="$(find "$OUT" -name "capture-${NAME}-${NODE}-${RUN_ID}.tar.gz" -type f -size +0c -print -quit)"
[ -n "$bundle" ] || { echo "retrieved capture bundle is missing" >&2; exit 1; }
pcap_name="capture-${NAME}-${NODE}-${RUN_ID}.pcap"
pcap_path="${OUT}/${pcap_name}"
tar -xOzf "$bundle" "$pcap_name" > "$pcap_path"
packet_count="$(tcpdump -nn -r "$pcap_path" 2>/dev/null | awk 'END { print NR + 0 }')"
[ "$packet_count" -gt 0 ] || { echo "pcap contains no packet records" >&2; exit 1; }

echo "PASS: decoded ${packet_count} DNS packet record(s) from the retrieved pcap"
echo "== smoke test PASSED =="
