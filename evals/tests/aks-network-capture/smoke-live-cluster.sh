#!/usr/bin/env bash
# smoke-live-cluster.sh — MANUAL pre-production gate for aks-network-capture.
#
# Privileged packet capture cannot be exercised in CI (no cluster, no elevated node
# access). This script is the documented live-cluster smoke test: run it against a
# throwaway AKS cluster you control before relying on the capture skill in production.
# It creates a short capture, retrieves it, asserts a non-empty pcap came back, and
# cleans up. It is NOT run by CI.
#
# Prereqs: kubectl context pointed at a test AKS cluster; nodes running Linux; you
# accept that a privileged capture pod will run briefly on one node.
#
# Usage: ./smoke-live-cluster.sh [--node <name>] [--keep]
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")/../../../skills/aks-network-capture/scripts" && pwd)"
NAME="smoke-$(date -u +%H%M%S)"
NODE=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE="$2"; shift 2 ;;
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
  kubectl delete jobs -l "capture-id=$NAME" --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. Start a short capture with a benign filter (safe-by-construction path).
"$SCRIPTS/create-capture.sh" --name "$NAME" --node-names "$NODE" --duration 15s --tcpdump-filter "udp port 53"

# 2. Wait for the Job to complete.
echo "== waiting for capture Job to finish =="
kubectl wait --for=condition=complete "job/${NAME}-$(printf '%s' "$NODE" | tr '._' '--' | cut -c1-40)" --timeout=120s \
  || { echo "FAIL: capture Job did not complete"; kubectl logs -l "capture-id=$NAME" --tail=50 || true; exit 1; }

# 3. Retrieve and assert a non-empty pcap bundle came back.
OUT="$(mktemp -d)"
"$SCRIPTS/retrieve-captures.sh" --name "$NAME" --output-dir "$OUT" || true
if find "$OUT" -name '*.tar.gz' -size +0c | grep -q .; then
  echo "PASS: retrieved a non-empty capture bundle"
  find "$OUT" -name '*.tar.gz' -exec ls -lh {} \;
else
  echo "FAIL: no non-empty capture bundle retrieved"
  exit 1
fi

echo "== smoke test PASSED =="
