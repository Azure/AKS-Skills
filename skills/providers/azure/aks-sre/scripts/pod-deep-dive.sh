#!/bin/sh
# pod-deep-dive.sh — Full diagnostic dump for a single pod
# Usage: sh pod-deep-dive.sh <namespace> <pod-name>
set -e

NS="${1:?Usage: pod-deep-dive.sh <namespace> <pod-name>}"
POD="${2:?Usage: pod-deep-dive.sh <namespace> <pod-name>}"

echo "=== Pod Deep Dive: $NS/$POD $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo ""
echo "--- Pod Status ---"
kubectl get pod "$POD" -n "$NS" -o wide 2>/dev/null || { echo "Pod not found"; exit 1; }

echo ""
echo "--- Describe ---"
kubectl describe pod "$POD" -n "$NS" 2>/dev/null

echo ""
echo "--- Container Resources ---"
kubectl get pod "$POD" -n "$NS" -o json | \
  jq '.spec.containers[] | {name, resources}' 2>/dev/null || true

echo ""
echo "--- Current Logs (all containers) ---"
kubectl logs "$POD" -n "$NS" --all-containers 2>/dev/null || echo "(no current logs)"

echo ""
echo "--- Previous Logs (all containers) ---"
kubectl logs "$POD" -n "$NS" --previous --all-containers 2>/dev/null || echo "(no previous logs)"

echo ""
echo "--- Events ---"
kubectl get events -n "$NS" --field-selector "involvedObject.name=$POD" --sort-by='.lastTimestamp' 2>/dev/null || true

echo ""
echo "--- Resource Usage ---"
kubectl top pod "$POD" -n "$NS" --containers 2>/dev/null || echo "(metrics not available)"

echo ""
echo "=== End Deep Dive ==="
