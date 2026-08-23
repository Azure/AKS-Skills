#!/usr/bin/env bash
# Regression test for concurrent Azure network inventory collection.
set -u

SCRIPT="$(cd "$(dirname "$0")/../../../skills/aks-network-capture/scripts" && pwd)/collect-azure-network-info.sh"
TEST_ROOT="$(mktemp -d)"
MOCK_BIN="$TEST_ROOT/bin"
OUTPUT_DIR="$TEST_ROOT/output"
AZ_CALL_LOG="$TEST_ROOT/az-calls.log"
fails=0

pass() { echo "  ok: $1"; }
fail() { echo "  FAIL: $1" >&2; fails=$((fails+1)); }
cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

mkdir -p "$MOCK_BIN"
export AZ_CALL_LOG

cat > "$MOCK_BIN/az" <<'EOF'
#!/bin/sh
record_network_call() {
  printf 'start:%s\n' "$1" >> "$AZ_CALL_LOG"
  sleep 1
  printf 'done:%s\n' "$1" >> "$AZ_CALL_LOG"
}

case "$*" in
  "account show"*)
    printf '{}\n'
    ;;
  "aks show "*)
    if [ "${AKS_NO_VNET:-0}" -eq 1 ]; then
      cat <<'JSON'
{"nodeResourceGroup":"MC_rg_cluster_region","agentPoolProfiles":[{}],"networkProfile":{"networkPlugin":"kubenet","networkPolicy":null}}
JSON
    else
      cat <<'JSON'
{"nodeResourceGroup":"MC_rg_cluster_region","agentPoolProfiles":[{"vnetSubnetId":"/subscriptions/sub/resourceGroups/network-rg/providers/Microsoft.Network/virtualNetworks/vnet-a/subnets/subnet-a"}],"networkProfile":{"networkPlugin":"azure","networkPolicy":"cilium"}}
JSON
    fi
    ;;
  "network vnet show "*)
    record_network_call vnet
    printf '{"name":"vnet-a"}\n'
    ;;
  "network vnet subnet list "*)
    record_network_call subnets
    printf '[{"name":"subnet-a"}]\n'
    ;;
  "network vnet subnet show "*)
    record_network_call node-subnet
    printf '{"name":"subnet-a","addressPrefix":"10.0.0.0/24"}\n'
    ;;
  "network vnet peering list "*)
    record_network_call vnet-peerings
    printf '[{"name":"peer-a"}]\n'
    ;;
  "network nsg list "*)
    record_network_call nsgs
    printf '[{"name":"nsg-a"}]\n'
    ;;
  "network route-table list "*)
    record_network_call route-tables
    printf '[{"name":"routes-a"}]\n'
    ;;
  "network lb list "*)
    record_network_call load-balancers
    exit 17
    ;;
  "network public-ip list "*)
    record_network_call public-ips
    printf '[{"name":"pip-a"}]\n'
    ;;
  "network private-dns zone list "*)
    record_network_call private-dns-zones
    printf '[{"name":"privatelink.example"}]\n'
    ;;
  *)
    echo "unexpected az call: $*" >&2
    exit 97
    ;;
esac
EOF
chmod +x "$MOCK_BIN/az"

assert_parallel_wave() {
  local expected=$1 desc=$2
  local total_starts first_done_line starts_before_first_done
  total_starts="$(grep -c '^start:' "$AZ_CALL_LOG" 2>/dev/null || true)"
  first_done_line="$(grep -n '^done:' "$AZ_CALL_LOG" 2>/dev/null | head -1 | cut -d: -f1)"
  starts_before_first_done=0
  if [ -n "$first_done_line" ] && [ "$first_done_line" -gt 1 ]; then
    starts_before_first_done="$(head -n "$((first_done_line - 1))" "$AZ_CALL_LOG" | grep -c '^start:' || true)"
  fi

  if [ "$total_starts" -eq "$expected" ] && [ "$starts_before_first_done" -eq "$expected" ]; then
    pass "$desc"
  else
    fail "$desc"
  fi
}

echo "== Azure network inventory performance regression test =="

if output="$(PATH="$MOCK_BIN:$PATH" "$SCRIPT" \
  --resource-group rg --cluster-name cluster-a --output-dir "$OUTPUT_DIR" 2>&1)"; then
  pass "collector succeeds with mocked Azure control-plane responses"
else
  fail "collector succeeds with mocked Azure control-plane responses"
  printf '%s\n' "$output" >&2
fi

assert_parallel_wave 9 "all nine independent network reads start before any one completes"

OUTPUT_FILE="$(find "$OUTPUT_DIR" -type f -name 'azure-network-info-cluster-a-*.json' -print -quit 2>/dev/null)"
if [ -n "$OUTPUT_FILE" ] && jq -e '
  .cluster.name == "cluster-a"
  and .cluster.resourceGroup == "rg"
  and .cluster.nodeResourceGroup == "MC_rg_cluster_region"
  and .cluster.networkPlugin == "azure"
  and .cluster.networkPolicy == "cilium"
  and .vnet.name == "vnet-a"
  and .subnets[0].name == "subnet-a"
  and .nodeSubnet.name == "subnet-a"
  and .nsgs[0].name == "nsg-a"
  and .routeTables[0].name == "routes-a"
  and .loadBalancers == []
  and .publicIPs[0].name == "pip-a"
  and .vnetPeerings[0].name == "peer-a"
  and .privateDnsZones[0].name == "privatelink.example"
' "$OUTPUT_FILE" >/dev/null; then
  pass "parallel collection preserves the output contract and per-query fallbacks"
else
  fail "parallel collection preserves the output contract and per-query fallbacks"
fi

echo
echo "== Cluster without a VNET subnet =="

: > "$AZ_CALL_LOG"
NO_VNET_OUTPUT_DIR="$TEST_ROOT/no-vnet-output"
if output="$(AKS_NO_VNET=1 PATH="$MOCK_BIN:$PATH" "$SCRIPT" \
  --resource-group rg --cluster-name cluster-b --output-dir "$NO_VNET_OUTPUT_DIR" 2>&1)"; then
  pass "collector succeeds when the cluster has no VNET subnet ID"
else
  fail "collector succeeds when the cluster has no VNET subnet ID"
  printf '%s\n' "$output" >&2
fi

assert_parallel_wave 4 "only the four applicable network reads run, and they overlap"

NO_VNET_OUTPUT_FILE="$(find "$NO_VNET_OUTPUT_DIR" -type f -name 'azure-network-info-cluster-b-*.json' -print -quit 2>/dev/null)"
if [ -n "$NO_VNET_OUTPUT_FILE" ] && jq -e '
  .cluster.name == "cluster-b"
  and .cluster.networkPlugin == "kubenet"
  and .cluster.networkPolicy == "none"
  and .vnet == {}
  and .subnets == []
  and .vnetPeerings == []
  and .privateDnsZones == []
  and (has("nodeSubnet") | not)
' "$NO_VNET_OUTPUT_FILE" >/dev/null; then
  pass "clusters without VNET metadata retain the existing output shape"
else
  fail "clusters without VNET metadata retain the existing output shape"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "All Azure network inventory regression tests passed."
  exit 0
fi

echo "$fails Azure network inventory regression test(s) FAILED."
exit 1
