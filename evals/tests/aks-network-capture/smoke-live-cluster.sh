#!/usr/bin/env bash
# smoke-live-cluster.sh — MANUAL pre-production gate for aks-network-capture.
#
# Node packet capture cannot be exercised in CI (no cluster, no elevated node
# access). This script is the documented live-cluster smoke test: run it against a
# throwaway AKS cluster you control before relying on the capture skill in production.
# It creates a short capture, retrieves it, asserts a non-empty pcap came back, and
# cleans up. It is NOT run by CI.
#
# Prereqs: kubectl context pointed at a test AKS cluster; nodes running Linux; you
# accept that a host-network capture pod with NET_ADMIN/NET_RAW will run briefly.
#
# Usage: ./smoke-live-cluster.sh [--node <name>] [--namespace <name>] [--keep]
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")/../../../skills/aks-network-capture/scripts" && pwd)"
NAME="smoke-$(date -u +%H%M%S)"
NODE=""
NAMESPACE="default"
KEEP=0
OUT=""
CREATED_CONFIGMAP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null || { echo "kubectl required"; exit 2; }
kubectl cluster-info >/dev/null 2>&1 || { echo "kubectl is not pointed at a live cluster"; exit 2; }

if [ -z "$NODE" ]; then
  NODE="$(kubectl get nodes -l kubernetes.io/os=linux -o jsonpath='{.items[0].metadata.name}')"
fi
[ -n "$NODE" ] || { echo "no Linux node found"; exit 2; }
echo "== smoke test on node: $NODE =="

cleanup() {
  [ "$KEEP" -eq 1 ] && return 0
  kubectl delete pods -n "$NAMESPACE" -l "capture-id=$NAME" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete jobs -n "$NAMESPACE" -l "capture-id=$NAME" --ignore-not-found >/dev/null 2>&1 || true
  if [ "$CREATED_CONFIGMAP" -eq 1 ]; then
    kubectl delete configmap network-capture-scripts -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  fi
  [ -z "$OUT" ] || rm -rf "$OUT"
}
trap cleanup EXIT

# Install the exact capture runner under test. Cleanup removes the ConfigMap only
# when this smoke run created it.
if ! kubectl get configmap network-capture-scripts -n "$NAMESPACE" >/dev/null 2>&1; then
  CREATED_CONFIGMAP=1
fi
"$SCRIPTS/setup-capture-configmap.sh" "$NAMESPACE"

# 1. Start a short capture with a benign filter (safe-by-construction path).
"$SCRIPTS/create-capture.sh" --name "$NAME" --node-names "$NODE" --namespace "$NAMESPACE" \
  --duration 15s --tcpdump-filter "udp port 53"

# 2. Wait for the Job to complete.
echo "== waiting for capture Job to finish =="
kubectl wait -n "$NAMESPACE" --for=condition=complete \
  job -l "capture-id=$NAME" --timeout=120s \
  || { echo "FAIL: capture Job did not complete"; kubectl logs -n "$NAMESPACE" -l "capture-id=$NAME" --tail=50 || true; exit 1; }

# 3. Retrieve and assert the bundle contains a non-empty pcap.
OUT="$(mktemp -d)"
"$SCRIPTS/retrieve-captures.sh" --name "$NAME" --namespace "$NAMESPACE" --workspace-dir "$OUT"
bundle="$(find "$OUT" -name '*.tar.gz' -size +0c -print -quit)"
pcap_entry=""
pcap_size=0
if [ -n "$bundle" ]; then
  pcap_entry="$(tar -tzf "$bundle" | awk '/\.pcap$/{print; exit}')"
fi
if [ -n "$pcap_entry" ]; then
  pcap_size="$(tar -xOzf "$bundle" "$pcap_entry" | wc -c | tr -d '[:space:]')"
fi
if [ "$pcap_size" -gt 0 ]; then
  echo "PASS: retrieved a non-empty capture bundle"
  ls -lh "$bundle"
else
  echo "FAIL: no non-empty pcap found in the retrieved bundle"
  exit 1
fi

echo "== smoke test PASSED =="
