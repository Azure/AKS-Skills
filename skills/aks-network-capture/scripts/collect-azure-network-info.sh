#!/bin/bash
# collect-azure-network-info.sh — Collect Azure network resource configuration for AKS clusters
set -e

RESOURCE_GROUP=""
CLUSTER_NAME=""
OUTPUT_DIR="${WORKSPACE_DIR:-/home/azureuser/.openclaw/workspace}/network-captures"
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

# Initialize JSON output
cat > "$OUTPUT_FILE" <<EOF
{
  "cluster": {
    "name": "$CLUSTER_NAME",
    "resourceGroup": "$RESOURCE_GROUP",
    "nodeResourceGroup": "$NODE_RESOURCE_GROUP",
    "networkPlugin": "$NETWORK_PLUGIN",
    "networkPolicy": "$NETWORK_POLICY",
    "timestamp": "$TIMESTAMP"
  },
  "vnet": {},
  "subnets": [],
  "nsgs": [],
  "routeTables": [],
  "loadBalancers": [],
  "publicIPs": [],
  "vnetPeerings": [],
  "privateDnsZones": []
}
EOF

# Get VNET and subnet information
if [ -n "$VNET_SUBNET_ID" ]; then
  echo "Collecting VNET and subnet information..."
  VNET_NAME=$(echo "$VNET_SUBNET_ID" | awk -F'/' '{for(i=1;i<=NF;i++) if ($i=="virtualNetworks") print $(i+1)}')
  SUBNET_NAME=$(echo "$VNET_SUBNET_ID" | awk -F'/' '{for(i=1;i<=NF;i++) if ($i=="subnets") print $(i+1)}')
  VNET_RG=$(echo "$VNET_SUBNET_ID" | awk -F'/' '{for(i=1;i<=NF;i++) if ($i=="resourceGroups") print $(i+1)}')
  
  VNET_INFO=$(az network vnet show --resource-group "$VNET_RG" --name "$VNET_NAME" -o json 2>/dev/null || echo "{}")
  SUBNETS=$(az network vnet subnet list --resource-group "$VNET_RG" --vnet-name "$VNET_NAME" -o json 2>/dev/null || echo "[]")
  # Scoped detail for the cluster's own subnet: the effective UDR, NSG, and delegations.
  NODE_SUBNET=$(az network vnet subnet show --resource-group "$VNET_RG" --vnet-name "$VNET_NAME" --name "$SUBNET_NAME" \
    --query "{name:name, addressPrefix:addressPrefix, udr:routeTable, nsg:networkSecurityGroup, delegations:delegations}" \
    -o json 2>/dev/null || echo "{}")

  jq --argjson vnet "$VNET_INFO" '.vnet = $vnet' "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"
  jq --argjson subnets "$SUBNETS" '.subnets = $subnets' "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"
  jq --argjson node_subnet "$NODE_SUBNET" '.nodeSubnet = $node_subnet' "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"
  
  # Get VNET peerings
  echo "Collecting VNET peering information..."
  PEERINGS=$(az network vnet peering list --resource-group "$VNET_RG" --vnet-name "$VNET_NAME" -o json 2>/dev/null || echo "[]")
  jq --argjson peerings "$PEERINGS" '.vnetPeerings = $peerings' "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"
fi

# Get NSGs in node resource group
echo "Collecting Network Security Groups..."
NSGS=$(az network nsg list --resource-group "$NODE_RESOURCE_GROUP" -o json 2>/dev/null || echo "[]")
jq --argjson nsgs "$NSGS" '.nsgs = $nsgs' "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"

# Get route tables in node resource group
echo "Collecting Route Tables..."
ROUTE_TABLES=$(az network route-table list --resource-group "$NODE_RESOURCE_GROUP" -o json 2>/dev/null || echo "[]")
jq --argjson routes "$ROUTE_TABLES" '.routeTables = $routes' "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"

# Get load balancers in node resource group
echo "Collecting Load Balancers..."
LBS=$(az network lb list --resource-group "$NODE_RESOURCE_GROUP" -o json 2>/dev/null || echo "[]")
jq --argjson lbs "$LBS" '.loadBalancers = $lbs' "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"

# Get public IPs in node resource group
echo "Collecting Public IPs..."
PUBLIC_IPS=$(az network public-ip list --resource-group "$NODE_RESOURCE_GROUP" -o json 2>/dev/null || echo "[]")
jq --argjson ips "$PUBLIC_IPS" '.publicIPs = $ips' "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"

# Get private DNS zones. Enumerate subscription-wide (no --resource-group): a zone
# linked to the cluster VNET frequently lives in a DIFFERENT resource group than the
# cluster, so scoping to the cluster RG silently misses it.
if [ -n "$VNET_NAME" ]; then
  echo "Collecting Private DNS Zones (subscription-wide)..."
  DNS_ZONES=$(az network private-dns zone list -o json 2>/dev/null || echo "[]")
  jq --argjson zones "$DNS_ZONES" '.privateDnsZones = $zones' "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"
fi

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
