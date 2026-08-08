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

### Mandatory ordered read-only evidence

A DNS diagnosis is incomplete until every step below is collected, or the inability to collect it is recorded. Do not skip resolver inputs, a query through kube-dns, direct upstream behavior, or the CoreDNS-to-upstream UDP/TCP 53 network path.

```bash
# 1. Preserve and explicitly inspect every nameserver, search suffix, and option
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

# 3. Prove CoreDNS query health through the kube-dns ClusterIP, then compare
# direct UDP and TCP 53 behavior for every configured upstream forwarder.
# Use clients already present in the affected pod; do not install packages.
kubectl exec <affected-pod> -n <ns> -- \
  nslookup <failing-fqdn> <kube-dns-cluster-ip>
kubectl exec <affected-pod> -n <ns> -- \
  dig +notcp +time=<timeout-seconds> +tries=<attempt-count> \
  @<custom-forwarder-ip> <failing-fqdn>
kubectl exec <affected-pod> -n <ns> -- \
  dig +tcp +time=<timeout-seconds> +tries=<attempt-count> \
  @<custom-forwarder-ip> <failing-fqdn>

# 4. Preserve policy plus the node-NIC NSG/route path used by each CoreDNS pod
kubectl get networkpolicy -n <ns> -o yaml
kubectl get networkpolicy -n kube-system -o yaml
kubectl get pods -n kube-system -l k8s-app=kube-dns \
  -o custom-columns='POD:.metadata.name,POD_IP:.status.podIP,NODE:.spec.nodeName'
NODE_RESOURCE_GROUP=$(az aks show \
  --resource-group <cluster-resource-group> \
  --name <cluster-name> \
  --query nodeResourceGroup -o tsv)
COREDNS_PROVIDER_ID=$(kubectl get node <coredns-node> \
  -o jsonpath='{.spec.providerID}')
COREDNS_POOL=$(kubectl get node <coredns-node> \
  -o jsonpath='{.metadata.labels.agentpool}')
COREDNS_VMSS_NAME=$(printf '%s\n' "$COREDNS_PROVIDER_ID" |
  awk -F'/virtualMachineScaleSets/' '{print $2}' | cut -d/ -f1)
COREDNS_INSTANCE_ID=${COREDNS_PROVIDER_ID##*/}
COREDNS_NODE_NIC_ID=$(az vmss nic list-vm-nics \
  --resource-group "$NODE_RESOURCE_GROUP" \
  --vmss-name "$COREDNS_VMSS_NAME" \
  --instance-id "$COREDNS_INSTANCE_ID" \
  --query '[0].id' -o tsv)
COREDNS_NODE_SUBNET_ID=$(az network nic show \
  --ids "$COREDNS_NODE_NIC_ID" \
  --query 'ipConfigurations[0].subnet.id' -o tsv)
COREDNS_POD_SUBNET_ID=$(az aks nodepool show \
  --resource-group <cluster-resource-group> \
  --cluster-name <cluster-name> \
  --name "$COREDNS_POOL" \
  --query podSubnetId -o tsv)
COREDNS_SOURCE_SUBNET_ID=${COREDNS_POD_SUBNET_ID:-$COREDNS_NODE_SUBNET_ID}

# Effective node-NIC evidence, then explicit source-subnet NSG and UDR evidence
az network nic list-effective-nsg \
  --ids "$COREDNS_NODE_NIC_ID" -o json
az network nic show-effective-route-table \
  --ids "$COREDNS_NODE_NIC_ID" -o table
COREDNS_SUBNET_NSG_ID=$(az network vnet subnet show \
  --ids "$COREDNS_SOURCE_SUBNET_ID" \
  --query networkSecurityGroup.id -o tsv)
az network nsg show \
  --ids "$COREDNS_SUBNET_NSG_ID" \
  --query '{customOutbound:securityRules[?direction==`Outbound`],defaultOutbound:defaultSecurityRules[?direction==`Outbound`]}' \
  -o json
COREDNS_ROUTE_TABLE_ID=$(az network vnet subnet show \
  --ids "$COREDNS_SOURCE_SUBNET_ID" \
  --query routeTable.id -o tsv)
az network route-table show \
  --ids "$COREDNS_ROUTE_TABLE_ID" \
  --query 'routes[].{name:name,addressPrefix:addressPrefix,nextHopType:nextHopType,nextHopIpAddress:nextHopIpAddress}' \
  -o table
```

Repeat these checks for each node hosting a CoreDNS pod. For Azure CNI Pod Subnet, `COREDNS_SOURCE_SUBNET_ID` is the pod subnet; otherwise it is the CoreDNS node NIC subnet. If either NSG or route-table ID is empty, record that absence instead of running its dependent `show` command. Evaluate outbound rules and routes from the CoreDNS pod/node source to every configured upstream on both UDP and TCP destination port 53.

If the selected route has a `VirtualAppliance` next hop, run the exact policy or classic network-rule collection commands in [Mandatory Firewall or NVA branch when traversed](#3-mandatory-firewall-or-nva-branch-when-traversed), then query the matching DNS decisions:

```bash
az monitor log-analytics query \
  --workspace <log-analytics-workspace-id> \
  --timespan <incident-start-utc>/<incident-end-utc> \
  --analytics-query "union isfuzzy=true AZFWNetworkRule, AzureDiagnostics | where _ResourceId =~ '<firewall-resource-id>' | where (SourceIp in ('<coredns-pod-ip>','<coredns-node-ip>') and DestinationIp == '<custom-forwarder-ip>' and DestinationPort == 53 and Protocol in ('UDP','TCP')) or (Category == 'AzureFirewallNetworkRule' and (msg_s has '<coredns-pod-ip>' or msg_s has '<coredns-node-ip>') and msg_s has '<custom-forwarder-ip>' and msg_s has '53' and (msg_s has 'UDP' or msg_s has 'TCP')) | project TimeGenerated,Category,Action,Protocol,SourceIp,DestinationIp,DestinationPort,RuleCollection,Rule,msg_s"
```

For a custom NVA, collect equivalent network-rule and log evidence filtered to the same CoreDNS source, upstream destination, incident window, and UDP/TCP 53.

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

Use this path when a pod cannot reach Azure SQL or another Azure service. A diagnosis is incomplete until the source VMSS instance NIC, effective and subnet-associated NSGs, effective and configured routes, endpoint mode/DNS/reachability, and any present Firewall/NVA evidence are collected or marked unavailable.

### 1. Mandatory source and subnet identity

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
NODE_SUBNET_ID=$(az network nic show --ids "$NODE_NIC_ID" \
  --query 'ipConfigurations[0].subnet.id' -o tsv)
POD_SUBNET_ID=$(az aks nodepool show \
  --resource-group <cluster-resource-group> \
  --cluster-name <cluster-name> \
  --name "$SOURCE_POOL" \
  --query podSubnetId -o tsv)
SOURCE_SUBNET_ID=${POD_SUBNET_ID:-$NODE_SUBNET_ID}
```

For Azure CNI Pod Subnet, `SOURCE_SUBNET_ID` is the pod subnet. Otherwise it is the source node NIC subnet.

### 2. Mandatory NSG, route-table, and next-hop evidence

```bash
# Effective rules applied to the source node NIC
az network nic list-effective-nsg \
  --ids "$NODE_NIC_ID" -o json

# Explicit inbound and outbound rules on the source subnet-associated NSG
SUBNET_NSG_ID=$(az network vnet subnet show \
  --ids "$SOURCE_SUBNET_ID" \
  --query networkSecurityGroup.id -o tsv)
az network nsg show \
  --ids "$SUBNET_NSG_ID" \
  --query '{customInbound:securityRules[?direction==`Inbound`],customOutbound:securityRules[?direction==`Outbound`],defaultInbound:defaultSecurityRules[?direction==`Inbound`],defaultOutbound:defaultSecurityRules[?direction==`Outbound`]}' \
  -o json

# Effective routes plus configured UDRs and next-hop values
az network nic show-effective-route-table \
  --ids "$NODE_NIC_ID" -o table
ROUTE_TABLE_ID=$(az network vnet subnet show \
  --ids "$SOURCE_SUBNET_ID" \
  --query routeTable.id -o tsv)
az network route-table show \
  --ids "$ROUTE_TABLE_ID" \
  --query '{disableBgpRoutePropagation:disableBgpRoutePropagation,routes:routes[].{name:name,addressPrefix:addressPrefix,nextHopType:nextHopType,nextHopIpAddress:nextHopIpAddress}}' \
  -o json
```

If the source subnet has no associated NSG or route table, the corresponding ID is empty; record that absence instead of running the dependent `show` command. Evaluate the destination IP and port against both effective rules and explicit subnet inbound/outbound rules. In the route output, record the selected prefix, `nextHopType`, and `nextHopIpAddress`. `VirtualAppliance` identifies a UDR to an Azure Firewall or NVA; confirm the next-hop owner before inspecting its rules. `Internet`, `VirtualNetwork`, and `InterfaceEndpoint` represent different paths and must not be diagnosed as firewall paths.

### 3. Mandatory Firewall or NVA branch when traversed

Inspect Azure Firewall only when the selected effective/UDR next hop identifies a deployed Azure Firewall:

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

Preserve the Azure Firewall diagnostic destination and matching network/application rule decisions for the incident window:

```bash
FIREWALL_ID=$(az network firewall show \
  --resource-group <firewall-resource-group> \
  --name <firewall-name> --query id -o tsv)
az monitor diagnostic-settings list \
  --resource "$FIREWALL_ID" -o json
az monitor log-analytics query \
  --workspace <log-analytics-workspace-id> \
  --timespan <incident-start-utc>/<incident-end-utc> \
  --analytics-query "union isfuzzy=true AZFWNetworkRule, AZFWApplicationRule, AzureDiagnostics | where _ResourceId =~ '$FIREWALL_ID' | where isempty(Category) or Category in ('AzureFirewallNetworkRule','AzureFirewallApplicationRule') | project TimeGenerated,Category,Action,RuleCollection,Rule,msg_s,SourceIp,DestinationIp,DestinationPort,Fqdn"
```

For a custom NVA, preserve its selected route, health, vendor-specific network/application rule collections, and logs for the same incident window rather than substituting Azure Firewall commands.

### 4. Mandatory endpoint mode, configuration, DNS, and reachability

Always connect by `<server>.database.windows.net`; do not pin an Azure SQL gateway IP.

```bash
# DNS answer observed by the affected workload
kubectl exec <affected-pod> -n <ns> -- \
  nslookup <server>.database.windows.net
kubectl exec <affected-pod> -n <ns> -- \
  nc -vz -w <timeout-seconds> <server>.database.windows.net 1433

# Public endpoint evidence
az sql server show \
  --resource-group <sql-resource-group> \
  --name <server> \
  --query '{publicNetworkAccess:publicNetworkAccess,minimalTlsVersion:minimalTlsVersion}' \
  -o yaml
az sql server firewall-rule list \
  --resource-group <sql-resource-group> \
  --server <server> -o table

# Service endpoint evidence
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

- Run the `nc` check only if that client already exists in the affected pod. Otherwise preserve the application's connection error and mark the active probe unavailable; do not install packages or create a test pod.
- **Public endpoint:** the server FQDN resolves to a public address; evaluate SQL public network access/firewall rules and the cluster outbound path.
- **Service endpoint:** the FQDN remains public, while the source subnet advertises `Microsoft.Sql` and the SQL server has a matching virtual network rule.
- **Private endpoint:** the FQDN follows the `privatelink.database.windows.net` chain to the private endpoint IP; verify endpoint approval, the A record, the affected VNet link or conditional forwarder, and the effective route to that private IP.

Do not change SQL networking, DNS links/records, NSGs, UDRs, NetworkPolicy, NVA rules, or Azure Firewall policy until the failing path and blocking rule are identified and remediation is explicitly approved.

---

## Detailed Networking Guides

- [Load Balancer And Ingress Troubleshooting](load-balancer-and-ingress.md) for pending services, ingress controller state, backend routing, and TLS failures.
- [Network Policy Troubleshooting](network-policy.md) for default-deny checks, Azure NPM or Calico validation, and ingress or egress rule audits.
