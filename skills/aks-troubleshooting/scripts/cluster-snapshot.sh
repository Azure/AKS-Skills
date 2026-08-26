#!/bin/sh
# cluster-snapshot.sh — Target-bound cluster health overview.
# Usage: cluster-snapshot.sh <resource-group> <cluster-name> <kube-context>
set -eu

export AZURE_HTTP_USER_AGENT="${AZURE_HTTP_USER_AGENT:+$AZURE_HTTP_USER_AGENT }AKS-Skills"

RG="${1:-${AKS_RESOURCE_GROUP:-}}"
CLUSTER="${2:-${AKS_CLUSTER_NAME:-}}"
CONTEXT="${3:-${AKS_KUBE_CONTEXT:-}}"
SUBSCRIPTION="${AKS_SUBSCRIPTION_ID:-}"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH"
}

normalize_endpoint() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's#^[a-z]+://##; s#/.*$##; s#:[0-9]+$##; s/\.$//'
}

read_aks_target() {
  if [ -n "$SUBSCRIPTION" ]; then
    az aks show --subscription "$SUBSCRIPTION" \
      --resource-group "$RG" --name "$CLUSTER" -o json
  else
    az aks show --resource-group "$RG" --name "$CLUSTER" -o json
  fi
}

kube() {
  kubectl --context "$CONTEXT" "$@"
}

[ -n "$RG" ] && [ -n "$CLUSTER" ] && [ -n "$CONTEXT" ] ||
  die "usage: cluster-snapshot.sh <resource-group> <cluster-name> <kube-context>"

require_command az
require_command jq
require_command kubectl

if ! AKS_JSON="$(read_aks_target 2>/dev/null)"; then
  die "AKS resource target is inaccessible"
fi
PUBLIC_FQDN="$(printf '%s\n' "$AKS_JSON" | jq -r '.fqdn // empty')"
PRIVATE_FQDN="$(printf '%s\n' "$AKS_JSON" | jq -r '.privateFqdn // empty')"
if ! KUBE_SERVER="$(kube config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null)"; then
  die "kube context is inaccessible"
fi

KUBE_HOST="$(normalize_endpoint "$KUBE_SERVER")"
PUBLIC_HOST="$(normalize_endpoint "$PUBLIC_FQDN")"
PRIVATE_HOST="$(normalize_endpoint "$PRIVATE_FQDN")"
if [ -z "$KUBE_HOST" ] ||
  { [ "$KUBE_HOST" != "$PUBLIC_HOST" ] && [ "$KUBE_HOST" != "$PRIVATE_HOST" ]; }; then
  die "kube context does not target the named AKS cluster"
fi

echo "=== Cluster Snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "targetProof=matched cluster=$RG/$CLUSTER context=$CONTEXT"

echo ""
echo "--- Nodes ---"
kube get nodes -o wide 2>/dev/null || echo "(kubectl not configured)"

echo ""
echo "--- Node Conditions (non-Ready or pressure) ---"
kube get nodes -o json 2>/dev/null |
  jq -r '.items[] | .metadata.name as $n | .status.conditions[] | select(.type != "Ready" and .status == "True") | [$n, .type, .reason] | @tsv' 2>/dev/null || true
kube get nodes -o json 2>/dev/null |
  jq -r '.items[] | .metadata.name as $n | .status.conditions[] | select(.type == "Ready" and .status != "True") | [$n, .type, .status, .reason] | @tsv' 2>/dev/null || true

echo ""
echo "--- Pods Not Running/Succeeded (all namespaces) ---"
kube get pods -A --field-selector 'status.phase!=Running,status.phase!=Succeeded' 2>/dev/null || echo "(none or error)"

echo ""
echo "--- Recent Warning Events ---"
kube get events -A --field-selector type=Warning --sort-by='.lastTimestamp' 2>/dev/null | tail -20 || true

echo ""
echo "--- Resource Pressure ---"
kube top nodes 2>/dev/null || echo "(metrics-server not available)"

echo ""
echo "--- AKS Cluster State ---"
printf '%s\n' "$AKS_JSON" |
  jq '{provisioningState, powerState: .powerState.code, kubernetesVersion, networkPlugin: .networkProfile.networkPlugin, networkPolicy: .networkProfile.networkPolicy, nodePools: [.agentPoolProfiles[] | {name, count, vmSize, provisioningState, mode, osType}]}' 2>/dev/null ||
  echo "(unable to project AKS cluster state)"

echo ""
echo "=== End Snapshot ==="
