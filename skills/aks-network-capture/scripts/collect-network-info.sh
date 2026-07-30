#!/bin/bash
# collect-network-info.sh — Collect static network configuration and state
# This script runs inside the capture pod with hostNetwork to gather node network info
set -e

echo "=== Network Capture Static Info - $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "Node: ${NODE_NAME:-$(hostname)}"
echo "Kernel: $(uname -r)"
echo ""

detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "$ID"
  elif [ "$(uname -s)" = "Linux" ]; then
    echo "linux"
  else
    uname -s | tr '[:upper:]' '[:lower:]'
  fi
}

OS_TYPE=$(detect_os)
echo "OS: $OS_TYPE"
echo ""

if [ "$OS_TYPE" = "windows" ] || [ "$OS_TYPE" = "msys" ]; then
  echo "=== Windows Network Configuration ==="
  
  echo "--- Network Adapters ---"
  ipconfig /all 2>/dev/null || echo "ipconfig not available"
  
  echo ""
  echo "--- Routing Table ---"
  route print 2>/dev/null || echo "route not available"
  
  echo ""
  echo "--- ARP Table ---"
  arp -a 2>/dev/null || echo "arp not available"
  
  echo ""
  echo "--- Active Connections ---"
  netstat -ano 2>/dev/null || echo "netstat not available"
  
else
  echo "=== Linux Network Configuration ==="
  
  echo "--- IP Addresses (detailed) ---"
  ip -d -j addr show 2>/dev/null || ip addr show 2>/dev/null || echo "ip command not available"
  
  echo ""
  echo "--- IP Routes ---"
  ip -d -j route show 2>/dev/null || ip route show 2>/dev/null || echo "ip route not available"
  
  echo ""
  echo "--- IP Rules ---"
  ip rule show 2>/dev/null || echo "ip rule not available"
  
  echo ""
  echo "--- Neighbor Table (ARP/NDP) ---"
  ip -d -j neighbor show 2>/dev/null || ip neighbor show 2>/dev/null || echo "ip neighbor not available"
  
  echo ""
  echo "--- Network Interfaces (detailed) ---"
  ip -d -j link show 2>/dev/null || ip link show 2>/dev/null || echo "ip link not available"
  
  echo ""
  echo "--- iptables: filter table ---"
  iptables -t filter -L -n -v --line-numbers 2>/dev/null || echo "iptables not available or permission denied"
  
  echo ""
  echo "--- iptables: nat table ---"
  iptables -t nat -L -n -v --line-numbers 2>/dev/null || echo "iptables nat not available"
  
  echo ""
  echo "--- iptables: mangle table ---"
  iptables -t mangle -L -n -v --line-numbers 2>/dev/null || echo "iptables mangle not available"
  
  echo ""
  echo "--- iptables-save (complete ruleset) ---"
  iptables-save 2>/dev/null || echo "iptables-save not available"
  
  echo ""
  echo "--- ip6tables: filter table ---"
  ip6tables -t filter -L -n -v --line-numbers 2>/dev/null || echo "ip6tables not available or permission denied"
  
  echo ""
  echo "--- ip6tables-save (complete ruleset) ---"
  ip6tables-save 2>/dev/null || echo "ip6tables-save not available"
  
  echo ""
  echo "--- nftables (if available) ---"
  nft list ruleset 2>/dev/null || echo "nftables not in use or not available"
  
  echo ""
  echo "--- Connection Tracking ---"
  conntrack -L 2>/dev/null | head -100 || echo "conntrack not available (showing first 100)"
  conntrack -S 2>/dev/null || echo "conntrack statistics not available"
  
  echo ""
  echo "--- Socket Statistics ---"
  ss -s 2>/dev/null || echo "ss not available"
  
  echo ""
  echo "--- Active Sockets (listening) ---"
  ss -tulpn 2>/dev/null | head -50 || netstat -tulpn 2>/dev/null | head -50 || echo "ss/netstat not available"
  
  echo ""
  echo "--- Active Sockets (established) ---"
  ss -tupn 2>/dev/null | head -50 || netstat -tupn 2>/dev/null | head -50 || echo "ss/netstat not available"
  
  echo ""
  echo "--- Network Statistics (summary) ---"
  netstat -s 2>/dev/null || cat /proc/net/snmp 2>/dev/null || echo "network stats not available"
  
  echo ""
  echo "--- /proc/net/dev (interface statistics) ---"
  cat /proc/net/dev 2>/dev/null || echo "/proc/net/dev not available"
  
  echo ""
  echo "--- /proc/sys/net (kernel network parameters - sample) ---"
  echo "IPv4 forwarding: $(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 'N/A')"
  echo "IPv6 forwarding: $(cat /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null || echo 'N/A')"
  echo "TCP timestamps: $(cat /proc/sys/net/ipv4/tcp_timestamps 2>/dev/null || echo 'N/A')"
  echo "TCP SACK: $(cat /proc/sys/net/ipv4/tcp_sack 2>/dev/null || echo 'N/A')"
  echo "TCP window scaling: $(cat /proc/sys/net/ipv4/tcp_window_scaling 2>/dev/null || echo 'N/A')"
  echo "CONNTRACK max: $(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 'N/A')"
  echo "CONNTRACK count: $(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo 'N/A')"
  
  echo ""
  echo "--- Bridge Information (if applicable) ---"
  if command -v brctl >/dev/null 2>&1; then
    brctl show 2>/dev/null || echo "No bridges"
  else
    ip link show type bridge 2>/dev/null || echo "bridge info not available"
  fi
  
  echo ""
  echo "--- DNS Configuration ---"
  cat /etc/resolv.conf 2>/dev/null || echo "/etc/resolv.conf not available"
  
  echo ""
  echo "--- Network Namespaces ---"
  ip netns list 2>/dev/null || echo "network namespaces not available or empty"
  
  echo ""
  echo "--- CNI Configuration (if available) ---"
  if [ -d /etc/cni/net.d ]; then
    echo "CNI configs in /etc/cni/net.d:"
    ls -la /etc/cni/net.d/ 2>/dev/null
    echo ""
    for conf in /etc/cni/net.d/*.conf /etc/cni/net.d/*.conflist; do
      if [ -f "$conf" ]; then
        echo "--- $conf ---"
        cat "$conf" 2>/dev/null
        echo ""
      fi
    done
  else
    echo "CNI configuration directory not found"
  fi
  
  echo ""
  echo "--- Kubernetes Service IP Tables (kube-proxy iptables mode) ---"
  iptables -t nat -L KUBE-SERVICES -n 2>/dev/null | head -50 || echo "KUBE-SERVICES chain not found (kube-proxy not in iptables mode or not running)"
  
  echo ""
  echo "--- IPVS Configuration (if kube-proxy in ipvs mode) ---"
  if command -v ipvsadm >/dev/null 2>&1; then
    ipvsadm -Ln 2>/dev/null || echo "ipvs not configured or not available"
  else
    echo "ipvsadm not available"
  fi
fi

echo ""
echo "=== End Static Network Info ==="
