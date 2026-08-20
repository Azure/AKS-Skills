#!/bin/sh
# cluster-snapshot.sh — Quick cluster health overview
# Run at the start of any investigation to capture baseline state.
# Usage: sh cluster-snapshot.sh [resource-group] [cluster-name]
set -e

# Identify AKS Skills as the caller on Azure CLI requests so this traffic is
# attributable server-side. Appends to any user agent the caller already set.
export AZURE_HTTP_USER_AGENT="${AZURE_HTTP_USER_AGENT:+$AZURE_HTTP_USER_AGENT }AKS-Skills"

RG="${1:-${AKS_RESOURCE_GROUP:-}}"
CLUSTER="${2:-${AKS_CLUSTER_NAME:-}}"

echo "=== Cluster Snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo ""
echo "--- Nodes ---"
kubectl get nodes -o wide 2>/dev/null || echo "(kubectl not configured)"

echo ""
echo "--- Node Conditions (non-Ready or pressure) ---"
# Use one API response so both condition groups describe the same node snapshot.
kubectl get nodes -o json 2>/dev/null | \
  jq -r '
    (
      [.items[] | .metadata.name as $n | .status.conditions[]
        | select(.type != "Ready" and .status == "True")
        | [$n, .type, .reason]]
      +
      [.items[] | .metadata.name as $n | .status.conditions[]
        | select(.type == "Ready" and .status != "True")
        | [$n, .type, .status, .reason]]
    )[] | @tsv
  ' 2>/dev/null || true

echo ""
echo "--- Pods Not Running/Succeeded (all namespaces) ---"
kubectl get pods -A --field-selector 'status.phase!=Running,status.phase!=Succeeded' 2>/dev/null || echo "(none or error)"

echo ""
echo "--- Recent Warning Events (last 30m) ---"
kubectl get events -A --field-selector type=Warning --sort-by='.lastTimestamp' 2>/dev/null | tail -20 || true

echo ""
echo "--- Resource Pressure ---"
kubectl top nodes 2>/dev/null || echo "(metrics-server not available)"

if [ -n "$RG" ] && [ -n "$CLUSTER" ]; then
  echo ""
  echo "--- AKS Cluster State ---"
  az aks show -g "$RG" -n "$CLUSTER" -o json 2>/dev/null | \
    jq '{provisioningState, powerState: .powerState.code, kubernetesVersion, networkPlugin: .networkProfile.networkPlugin, networkPolicy: .networkProfile.networkPolicy, nodePools: [.agentPoolProfiles[] | {name, count, vmSize, provisioningState, mode, osType}]}' 2>/dev/null || echo "(az cli not configured or cluster not found)"
fi

echo ""
echo "=== End Snapshot ==="
