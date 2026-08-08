# Networking Troubleshooting

For CNI-specific issues, check CNI pod health and review [AKS networking concepts](https://learn.microsoft.com/azure/aks/concepts-network).

## Service Unreachable / Connection Refused

**Diagnostics - always start here:**

```bash
# 1. Verify service exists and has endpoints (read-only)
kubectl get svc <service-name> -n <ns>
kubectl get endpoints <service-name> -n <ns>
kubectl get endpointslice -n <ns> \
  -l kubernetes.io/service-name=<service-name> -o wide
kubectl get pods -n <ns> -l <service-selector> -o wide
```

**Decision tree:**

| Observation                             | Cause                              | Fix                                             |
| --------------------------------------- | ---------------------------------- | ----------------------------------------------- |
| Endpoints shows `<none>`                | Label selector mismatch            | Align selector with pod labels; check for typos |
| Endpoints has IPs but unreachable       | Port mismatch or app not listening | Confirm `targetPort` = actual container port    |
| Works from some pods, fails from others | Network policy blocking            | See Network Policy section                      |
| Works inside cluster, fails externally  | Load balancer issue                | See Load Balancer section                       |
| `ECONNREFUSED` immediately              | App not listening on that port     | Check listening ports in the pod                |

Pods that are running but not Ready are removed from Endpoints. Check `kubectl get pod <pod> -n <ns>`.

**Deep diagnostics with Inspektor Gadget** (when the above checks are inconclusive):

Use the [IG base command pattern](references/inspektor-gadget.md) with `--k8s-namespace <ns> --k8s-podname <pod-name>` and these gadgets:

- `snapshot_socket` (timeout 5) — check what ports the pod is listening on
- `trace_tcp` (timeout 30) — trace connect/accept/close events
- `trace_tcpretrans` (timeout 30) — packet retransmissions

See [references/inspektor-gadget.md](references/inspektor-gadget.md).

---

## DNS Resolution Failures

Use the affected pod; do not create a test pod or change DNS, NetworkPolicy, NSG, route, or firewall configuration without explicit approval.

### Ordered read-only evidence

```bash
# 1. Preserve the affected pod resolver inputs: nameserver, search, and options
kubectl exec <affected-pod> -n <ns> -- cat /etc/resolv.conf

# 2. Check the kube-dns Service, backends, CoreDNS pods, logs, and config
kubectl get service kube-dns -n kube-system -o wide
kubectl get endpoints kube-dns -n kube-system -o wide
kubectl get endpointslice -n kube-system \
  -l kubernetes.io/service-name=kube-dns -o wide
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
kubectl logs -n kube-system -l k8s-app=kube-dns \
  --all-containers --prefix --tail=-1
kubectl get configmap coredns -n kube-system -o yaml
kubectl get configmap -n kube-system

# 3. From the affected pod, compare cluster DNS with each custom upstream
# forwarder named in the CoreDNS configuration, if the pod already has a DNS
# client. Do not install packages or create a test pod without approval.
kubectl exec <affected-pod> -n <ns> -- \
  nslookup <failing-fqdn> <kube-dns-cluster-ip>
kubectl exec <affected-pod> -n <ns> -- \
  nslookup <failing-fqdn> <custom-forwarder-ip>

# 4. Preserve NetworkPolicy evidence for both UDP and TCP 53
kubectl get networkpolicy -n <ns> -o yaml
kubectl get networkpolicy -n kube-system -o yaml
az network nic list-effective-nsg \
  --ids <affected-node-nic-id> -o json
az network nic show-effective-route-table \
  --ids <affected-node-nic-id> -o table
```

Derive `<affected-node-nic-id>` from the affected pod and node as shown in [AKS to an External Azure Service](#aks-to-an-external-azure-service). Evaluate effective NSG rules for both UDP and TCP destination port 53. If the selected DNS route has a `VirtualAppliance` next hop, identify whether it is Azure Firewall or a custom NVA before inspecting that present firewall's DNS rules.

If CoreDNS imports a custom ConfigMap, retrieve the named ConfigMap shown by the inventory before evaluating its forwarding rules. A successful direct query to a custom forwarder with a failed query through kube-dns points to CoreDNS configuration or service-path evidence; failure to reach the forwarder points to routing, NSG, firewall, or NetworkPolicy evidence.

**DNS failure patterns:**

| Symptom | Evidence boundary |
|---|---|
| `NXDOMAIN` for `svc.cluster.local` | Confirm search domains, kube-dns endpoints, and the CoreDNS `kubernetes` plugin before changing CoreDNS |
| Internal names resolve; external names return `NXDOMAIN` | Compare CoreDNS forwarding configuration and direct queries to each configured upstream |
| `SERVFAIL` | Correlate CoreDNS logs with upstream reachability and forwarder responses |
| Private endpoint FQDN resolves publicly | Inspect the `privatelink.*` private DNS zone, record set, virtual network links, and conditional forwarders |
| `i/o timeout` | Inspect NetworkPolicy plus effective node-NIC NSG, route, and present firewall rules for both UDP and TCP 53 |

Changing CoreDNS replicas/configuration, custom forwarders, NetworkPolicy, NSGs, routes, or firewall rules is remediation and requires explicit approval.

**Deep diagnostics with Inspektor Gadget** (when the above checks are inconclusive):

Use the [IG base command pattern](references/inspektor-gadget.md) with `--k8s-namespace <ns> --k8s-podname <pod-name>` and `trace_dns` (timeout 30). Key signals: `rcode=3` (NXDOMAIN), `rcode=2` (SERVFAIL), high `latency` values, queries going to unexpected destinations.

See [references/inspektor-gadget.md](references/inspektor-gadget.md).

---

## AKS to an External Azure Service

Use this path when a pod cannot reach Azure SQL or another Azure service. It starts from the affected node NIC so effective NSGs and routes reflect the actual source path.

### 1. Identify cluster and source-node networking

```bash
az aks show \
  --resource-group <cluster-resource-group> \
  --name <cluster-name> \
  --query '{nodeResourceGroup:nodeResourceGroup,networkPlugin:networkProfile.networkPlugin,networkPluginMode:networkProfile.networkPluginMode,networkPolicy:networkProfile.networkPolicy,networkDataplane:networkProfile.networkDataplane,outboundType:networkProfile.outboundType}' \
  -o yaml

NODE_RESOURCE_GROUP=$(az aks show \
  --resource-group <cluster-resource-group> \
  --name <cluster-name> \
  --query nodeResourceGroup -o tsv)
SOURCE_NODE=$(kubectl get pod <affected-pod> -n <ns> \
  -o jsonpath='{.spec.nodeName}')
SOURCE_POOL=$(kubectl get node "$SOURCE_NODE" \
  -o jsonpath='{.metadata.labels.agentpool}')
PROVIDER_ID=$(kubectl get node "$SOURCE_NODE" \
  -o jsonpath='{.spec.providerID}')
VMSS_NAME=$(printf '%s\n' "$PROVIDER_ID" |
  awk -F'/virtualMachineScaleSets/' '{print $2}' | cut -d/ -f1)
INSTANCE_ID=${PROVIDER_ID##*/}
NODE_NIC_ID=$(az vmss nic list-vm-nics \
  --resource-group "$NODE_RESOURCE_GROUP" \
  --vmss-name "$VMSS_NAME" \
  --instance-id "$INSTANCE_ID" \
  --query '[0].id' -o tsv)
```

### 2. Inspect effective NSGs, routes, and next hops

```bash
az network nic list-effective-nsg \
  --ids "$NODE_NIC_ID" -o json
az network nic show-effective-route-table \
  --ids "$NODE_NIC_ID" -o table
```

Evaluate the destination IP and port against the effective outbound NSG rules. In the route output, record the selected prefix, `nextHopType`, and `nextHopIpAddress`. `VirtualAppliance` identifies a UDR to an Azure Firewall or NVA; confirm the next-hop owner before inspecting its rules. `Internet`, `VirtualNetwork`, and `InterfaceEndpoint` represent different paths and must not be diagnosed as firewall paths.

Inspect Azure Firewall only when the effective route identifies a deployed Azure Firewall as the next hop:

```bash
az network firewall show \
  --resource-group <firewall-resource-group> \
  --name <firewall-name> \
  --query '{provisioningState:provisioningState,firewallPolicy:firewallPolicy.id,privateIPs:ipConfigurations[].privateIPAddress}' \
  -o yaml
```

If `firewallPolicy.id` is present, inspect the policy and each rule collection group:

```bash
az network firewall policy show \
  --ids <firewall-policy-resource-id> -o yaml
az network firewall policy rule-collection-group list \
  --resource-group <firewall-policy-resource-group> \
  --policy-name <firewall-policy-name> -o table
az network firewall policy rule-collection-group show \
  --resource-group <firewall-policy-resource-group> \
  --policy-name <firewall-policy-name> \
  --name <rule-collection-group-name> -o json
```

If `firewallPolicy.id` is absent, inspect the classic collections on that firewall:

```bash
az network firewall network-rule collection list \
  --resource-group <firewall-resource-group> \
  --firewall-name <firewall-name> -o json
az network firewall application-rule collection list \
  --resource-group <firewall-resource-group> \
  --firewall-name <firewall-name> -o json
az network firewall nat-rule collection list \
  --resource-group <firewall-resource-group> \
  --firewall-name <firewall-name> -o json
```

For a custom NVA, preserve its route, health, and vendor-specific rule evidence rather than substituting Azure Firewall commands.

### 3. Classify the Azure SQL path

Always connect by `<server>.database.windows.net`; do not pin an Azure SQL gateway IP.

```bash
# DNS answer observed by the affected workload
kubectl exec <affected-pod> -n <ns> -- \
  nslookup <server>.database.windows.net

# Public endpoint evidence
az sql server show \
  --resource-group <sql-resource-group> \
  --name <server> \
  --query '{publicNetworkAccess:publicNetworkAccess,minimalTlsVersion:minimalTlsVersion}' \
  -o yaml
az sql server firewall-rule list \
  --resource-group <sql-resource-group> \
  --server <server> -o table

# Service endpoint evidence: Azure CNI Pod Subnet is the pod source subnet
NODE_SUBNET_ID=$(az network nic show --ids "$NODE_NIC_ID" \
  --query 'ipConfigurations[0].subnet.id' -o tsv)
POD_SUBNET_ID=$(az aks nodepool show \
  --resource-group <cluster-resource-group> \
  --cluster-name <cluster-name> \
  --name "$SOURCE_POOL" \
  --query podSubnetId -o tsv)
SOURCE_SUBNET_ID=${POD_SUBNET_ID:-$NODE_SUBNET_ID}
az network vnet subnet show \
  --ids "$SOURCE_SUBNET_ID" \
  --query '{serviceEndpoints:serviceEndpoints,routeTable:routeTable.id,networkSecurityGroup:networkSecurityGroup.id}' \
  -o yaml
az sql server vnet-rule list \
  --resource-group <sql-resource-group> \
  --server <server> -o table

# Private endpoint and private DNS evidence
SQL_SERVER_ID=$(az sql server show \
  --resource-group <sql-resource-group> \
  --name <server> --query id -o tsv)
az network private-endpoint-connection list \
  --id "$SQL_SERVER_ID" -o table
az network private-dns zone show \
  --resource-group <private-dns-resource-group> \
  --name privatelink.database.windows.net -o yaml
az network private-dns record-set a list \
  --resource-group <private-dns-resource-group> \
  --zone-name privatelink.database.windows.net -o table
az network private-dns link vnet list \
  --resource-group <private-dns-resource-group> \
  --zone-name privatelink.database.windows.net -o table
```

- **Public endpoint:** the server FQDN resolves to a public address; evaluate SQL public network access/firewall rules and the cluster outbound path.
- **Service endpoint:** the FQDN remains public, while the source subnet advertises `Microsoft.Sql` and the SQL server has a matching virtual network rule.
- **Private endpoint:** the FQDN follows the `privatelink.database.windows.net` chain to the private endpoint IP; verify endpoint approval, the A record, the affected VNet link or conditional forwarder, and the effective route to that private IP.

Do not change SQL networking, DNS links/records, NSGs, UDRs, NetworkPolicy, NVA rules, or Azure Firewall policy until the failing path and blocking rule are identified and remediation is explicitly approved.

---

## Detailed Networking Guides

- [Load Balancer And Ingress Troubleshooting](load-balancer-and-ingress.md) for pending services, ingress controller state, backend routing, and TLS failures.
- [Network Policy Troubleshooting](network-policy.md) for default-deny checks, Azure NPM or Calico validation, and ingress or egress rule audits.
