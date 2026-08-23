#!/bin/bash
# collect-azure-network-info.sh — Collect Azure network resource configuration for AKS clusters
set -e

# Identify AKS Skills as the caller on Azure CLI requests so this traffic is
# attributable server-side. Appends to any user agent the caller already set.
export AZURE_HTTP_USER_AGENT="${AZURE_HTTP_USER_AGENT:+$AZURE_HTTP_USER_AGENT }AKS-Skills"

RESOURCE_GROUP=""
CLUSTER_NAME=""
OUTPUT_DIR="${WORKSPACE_DIR:-./aks-network-captures}/network-captures"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)

usage() {
  cat <<EOF
Usage: $0 --resource-group <rg> --cluster-name <name> [options]

Required:
  --resource-group <string>    Azure resource group containing the AKS cluster
  --cluster-name <string>      AKS cluster name

Options:
  --output-dir <path>         Directory to save Azure network info (default: ${OUTPUT_DIR})

Description:
  Collects Azure network resource configurations that may impact AKS cluster networking:
  - Network Security Groups (NSG) rules
  - Route tables and user-defined routes
  - VNET and subnet configurations
  - VNET peering status
  - Load balancer configurations
  - Azure Firewall rules (if applicable)
  - Private DNS zones

Examples:
  # Collect Azure network info for an AKS cluster
  $0 --resource-group myaks-rg --cluster-name myaks-cluster

  # Save to custom output directory
  $0 --resource-group myaks-rg --cluster-name myaks-cluster --output-dir /tmp/azure-net
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --resource-group) RESOURCE_GROUP="$2"; shift 2 ;;
    --cluster-name) CLUSTER_NAME="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [ -z "$RESOURCE_GROUP" ] || [ -z "$CLUSTER_NAME" ]; then
  echo "Error: --resource-group and --cluster-name are required"
  usage
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Error: Azure CLI (az) is not installed or not in PATH"
  exit 1
fi

OUTPUT_FILE="${OUTPUT_DIR}/azure-network-info-${CLUSTER_NAME}-${TIMESTAMP}.json"
COLLECTION_DIR=$(mktemp -d)
cleanup() { rm -rf "$COLLECTION_DIR"; }
trap cleanup EXIT
mkdir -p "$OUTPUT_DIR"

echo "Collecting Azure network configuration for AKS cluster: $CLUSTER_NAME"
echo "Resource Group: $RESOURCE_GROUP"
echo "Output: $OUTPUT_FILE"
echo ""

echo "Checking Azure CLI login status..."
if ! az account show >/dev/null 2>&1; then
  echo "Error: Not logged in to Azure CLI. Run 'az login' first."
  exit 1
fi

echo "Getting AKS cluster information..."
AKS_INFO=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" -o json 2>/dev/null)
if [ -z "$AKS_INFO" ]; then
  echo "Error: Could not retrieve AKS cluster information"
  exit 1
fi

NODE_RESOURCE_GROUP=$(echo "$AKS_INFO" | jq -r '.nodeResourceGroup')
VNET_SUBNET_ID=$(echo "$AKS_INFO" | jq -r '.agentPoolProfiles[0].vnetSubnetId // empty')
NETWORK_PLUGIN=$(echo "$AKS_INFO" | jq -r '.networkProfile.networkPlugin')
NETWORK_POLICY=$(echo "$AKS_INFO" | jq -r '.networkProfile.networkPolicy // "none"')

echo "  Node Resource Group: $NODE_RESOURCE_GROUP"
echo "  Network Plugin: $NETWORK_PLUGIN"
echo "  Network Policy: $NETWORK_POLICY"
echo ""

# Each Azure network query is independent once the cluster metadata is known.
# Write results to isolated files so the control-plane requests can overlap safely.
collect_json() {
  local fallback=$1 output=$2
  shift 2
  if ! "$@" > "$output" 2>/dev/null; then
    printf '%s\n' "$fallback" > "$output"
  fi
}

declare -a COLLECTION_PIDS=()
collect_json_async() {
  collect_json "$@" &
  COLLECTION_PIDS+=("$!")
}

printf '{}\n' > "$COLLECTION_DIR/vnet.json"
printf '{}\n' > "$COLLECTION_DIR/node-subnet.json"
for collection in subnets nsgs route-tables load-balancers public-ips vnet-peerings private-dns-zones; do
  printf '[]\n' > "$COLLECTION_DIR/${collection}.json"
done

# Get VNET and subnet information
VNET_NAME=""
SUBNET_NAME=""
VNET_RG=""
if [ -n "$VNET_SUBNET_ID" ]; then
  echo "Collecting VNET and subnet information..."
  VNET_NAME=$(echo "$VNET_SUBNET_ID" | awk -F'/' '{for(i=1;i<=NF;i++) if ($i=="virtualNetworks") print $(i+1)}')
  SUBNET_NAME=$(echo "$VNET_SUBNET_ID" | awk -F'/' '{for(i=1;i<=NF;i++) if ($i=="subnets") print $(i+1)}')
  VNET_RG=$(echo "$VNET_SUBNET_ID" | awk -F'/' '{for(i=1;i<=NF;i++) if ($i=="resourceGroups") print $(i+1)}')

  collect_json_async "{}" "$COLLECTION_DIR/vnet.json" \
    az network vnet show --resource-group "$VNET_RG" --name "$VNET_NAME" -o json
  collect_json_async "[]" "$COLLECTION_DIR/subnets.json" \
    az network vnet subnet list --resource-group "$VNET_RG" --vnet-name "$VNET_NAME" -o json
  # Scoped detail for the cluster's own subnet: the effective UDR, NSG, and delegations.
  collect_json_async "{}" "$COLLECTION_DIR/node-subnet.json" \
    az network vnet subnet show --resource-group "$VNET_RG" --vnet-name "$VNET_NAME" --name "$SUBNET_NAME" \
      --query "{name:name, addressPrefix:addressPrefix, udr:routeTable, nsg:networkSecurityGroup, delegations:delegations}" \
      -o json

  # Get VNET peerings
  echo "Collecting VNET peering information..."
  collect_json_async "[]" "$COLLECTION_DIR/vnet-peerings.json" \
    az network vnet peering list --resource-group "$VNET_RG" --vnet-name "$VNET_NAME" -o json
fi

# Get NSGs in node resource group
echo "Collecting Network Security Groups..."
collect_json_async "[]" "$COLLECTION_DIR/nsgs.json" \
  az network nsg list --resource-group "$NODE_RESOURCE_GROUP" -o json

# Get route tables in node resource group
echo "Collecting Route Tables..."
collect_json_async "[]" "$COLLECTION_DIR/route-tables.json" \
  az network route-table list --resource-group "$NODE_RESOURCE_GROUP" -o json

# Get load balancers in node resource group
echo "Collecting Load Balancers..."
collect_json_async "[]" "$COLLECTION_DIR/load-balancers.json" \
  az network lb list --resource-group "$NODE_RESOURCE_GROUP" -o json

# Get public IPs in node resource group
echo "Collecting Public IPs..."
collect_json_async "[]" "$COLLECTION_DIR/public-ips.json" \
  az network public-ip list --resource-group "$NODE_RESOURCE_GROUP" -o json

# Get private DNS zones. Enumerate subscription-wide (no --resource-group): a zone
# linked to the cluster VNET frequently lives in a DIFFERENT resource group than the
# cluster, so scoping to the cluster RG silently misses it.
if [ -n "$VNET_NAME" ]; then
  echo "Collecting Private DNS Zones (subscription-wide)..."
  collect_json_async "[]" "$COLLECTION_DIR/private-dns-zones.json" \
    az network private-dns zone list -o json
fi

for collection_pid in "${COLLECTION_PIDS[@]}"; do
  wait "$collection_pid"
done

HAS_VNET=false
[ -n "$VNET_SUBNET_ID" ] && HAS_VNET=true
jq -n \
  --arg cluster_name "$CLUSTER_NAME" \
  --arg resource_group "$RESOURCE_GROUP" \
  --arg node_resource_group "$NODE_RESOURCE_GROUP" \
  --arg network_plugin "$NETWORK_PLUGIN" \
  --arg network_policy "$NETWORK_POLICY" \
  --arg timestamp "$TIMESTAMP" \
  --argjson has_vnet "$HAS_VNET" \
  --slurpfile vnet "$COLLECTION_DIR/vnet.json" \
  --slurpfile subnets "$COLLECTION_DIR/subnets.json" \
  --slurpfile node_subnet "$COLLECTION_DIR/node-subnet.json" \
  --slurpfile nsgs "$COLLECTION_DIR/nsgs.json" \
  --slurpfile route_tables "$COLLECTION_DIR/route-tables.json" \
  --slurpfile load_balancers "$COLLECTION_DIR/load-balancers.json" \
  --slurpfile public_ips "$COLLECTION_DIR/public-ips.json" \
  --slurpfile vnet_peerings "$COLLECTION_DIR/vnet-peerings.json" \
  --slurpfile private_dns_zones "$COLLECTION_DIR/private-dns-zones.json" \
  '{
    cluster: {
      name: $cluster_name,
      resourceGroup: $resource_group,
      nodeResourceGroup: $node_resource_group,
      networkPlugin: $network_plugin,
      networkPolicy: $network_policy,
      timestamp: $timestamp
    },
    vnet: $vnet[0],
    subnets: $subnets[0],
    nsgs: $nsgs[0],
    routeTables: $route_tables[0],
    loadBalancers: $load_balancers[0],
    publicIPs: $public_ips[0],
    vnetPeerings: $vnet_peerings[0],
    privateDnsZones: $private_dns_zones[0]
  } + if $has_vnet then {nodeSubnet: $node_subnet[0]} else {} end' \
  > "$OUTPUT_FILE"

echo ""
echo "=== Azure Network Info Collection Complete ==="
echo "Output saved to: $OUTPUT_FILE"
echo ""
echo "Summary:"
jq -r '
  "Cluster: \(.cluster.name)",
  "Network Plugin: \(.cluster.networkPlugin)",
  "Network Policy: \(.cluster.networkPolicy)",
  "NSGs: \(.nsgs | length)",
  "Route Tables: \(.routeTables | length)",
  "Load Balancers: \(.loadBalancers | length)",
  "Public IPs: \(.publicIPs | length)",
  "VNET Peerings: \(.vnetPeerings | length)",
  "Private DNS Zones: \(.privateDnsZones | length)"
' "$OUTPUT_FILE"
echo ""
echo "Next steps:"
echo "  - Review NSG rules: jq '.nsgs[].securityRules' $OUTPUT_FILE"
echo "  - Review route tables: jq '.routeTables[].routes' $OUTPUT_FILE"
echo "  - Review load balancer rules: jq '.loadBalancers[].loadBalancingRules' $OUTPUT_FILE"
