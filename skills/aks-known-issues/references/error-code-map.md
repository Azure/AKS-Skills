# AKS known-issue and error-code catalog

The single source of truth for `aks-known-issues`. Each entry is a **named** AKS
failure with a documented cause and fix, and a Microsoft Learn reference that
proves it. Only add an entry when a public, documented source supports it — this
catalog exists so a match can always be verified before anyone changes a cluster.

Match on the **signature**: the error code/message *and* the operation class that
produced it. A generic symptom with no error code is not a catalog match — route
it to `aks-troubleshooting`. Compare error codes as exact values, not substrings:
`ZonalAllocationFailed` is distinct from `AllocationFailed`.

Columns: **Signature** (what you'll see) · **Cause** · **Documented fix** ·
**Reference**.

## VM extension and CSE provisioning

The outer `VMExtensionProvisioningError` wrapper and a numeric exit code alone
aren't deterministic. Match the nested signature only in AKS `vmssCSE` / CSE
output.

| Signature | Cause | Documented fix | Reference |
|---|---|---|---|
| AKS `vmssCSE` / `VMExtensionProvisioningError` containing `VMExtensionError_OutboundConnFail`, `OutboundConnFailVMExtensionError`, `ERR_OUTBOUND_CONN_FAIL`, or exit **50** | The CSE couldn't establish outbound connectivity to obtain node-provisioning packages | Test `mcr.microsoft.com:443`; inspect the firewall, proxy, NSG, UDR, and required AKS FQDN/port rules. For a private cluster with custom DNS, verify Azure DNS `168.63.129.16` is an upstream resolver | [VMExtensionError_OutboundConnFail (exit 50)](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/vmextensionerror-outboundconnfail) |
| AKS `vmssCSE` / `VMExtensionProvisioningError` containing `VMExtensionError_K8SAPIServerConnFail`, `K8SAPIServerConnFailVMExtensionError`, `ERR_K8S_API_SERVER_CONN_FAIL`, or exit **51** | The node couldn't connect to the AKS API-server endpoint on TCP 443 | Test `<api-server-fqdn>:443`; inspect NSG, UDR, firewall/proxy, authorized IP ranges, private-endpoint status, and TLS inspection. Retry or reconcile only for the documented transient connection-refused case | [VMExtensionError_K8SAPIServerConnFail (exit 51)](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/vmextensionerror-k8sapiserverconnfail) |
| AKS `vmssCSE` / `VMExtensionProvisioningError` containing `VMExtensionError_K8SAPIServerDNSLookupFail`, `K8SAPIServerDNSLookupFailVMExtensionError`, `ERR_K8S_API_SERVER_DNS_LOOKUP_FAIL`, or exit **52** | The node couldn't resolve the cluster API-server FQDN | Resolve the cluster FQDN with `nslookup` or `dig`; verify DNS reachability on port 53 and forwarders. For private clusters, also verify the private-zone VNet link and A record; for private custom DNS, forward `privatelink.<region>.azmk8s.io` to `168.63.129.16` | [VMExtensionError_K8SAPIServerDNSLookupFail (exit 52)](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/vmextensionerror-k8sapiserverdnslookupfail) |

## Node pool provisioning and lifecycle

| Signature | Cause | Documented fix | Reference |
|---|---|---|---|
| Node pool `provisioningState=Failed` | The backing VM scale set errored during provision / scale / update — insufficient capacity, quota limits, network issues, policy violations, or resource locks | Read the exact code with `az aks nodepool show`, then `az vmss show` / `az vmss list-instances`; inspect the Activity Log; resolve the underlying cause (quota, capacity, policy, lock) and reconcile with `az aks nodepool update` | [Node/VM failed state — Scenario 3](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/availability-performance/cluster-node-virtual-machine-failed-state#scenario-3-node-pool-is-in-a-failed-state) |
| `VMCannotFitEphemeralOSDisk` | An ephemeral OS disk was requested or defaulted, but the OS disk doesn't fit the VM SKU's cache / temp storage | Choose a VM SKU whose cache/temp is ≥ the OS disk size, reduce `--node-osdisk-size`, or set `--node-osdisk-type Managed`. OS disk type/size can't be changed in place — create a new node pool and migrate | [Ephemeral OS disks in AKS](https://learn.microsoft.com/azure/aks/concepts-storage#ephemeral-os-disks-in-aks) |
| AKS node-pool `SkuNotAvailable`: `The requested size for resource '<resource ID>' is currently not available in location '<location>' zones '<zones>' for subscription '<subscription ID>'` | The VM SKU is unavailable for the subscription in that region/zone; Spot capacity is another documented cause | Inspect restrictions with `az vm list-skus --location <region> --size <partial-size> --all --output table`; select another size, zone, or region, or submit a SKU request if that placement is required. The SKU list isn't a real-time capacity guarantee, and this code doesn't prove quota exhaustion | [SkuNotAvailable](https://learn.microsoft.com/azure/azure-resource-manager/troubleshooting/error-sku-not-available) |
| AKS `ZonalAllocationFailed`: `Allocation failed. We do not have sufficient capacity for the requested VM size in this zone` | Azure lacks capacity for the requested VM size in the specified availability zone; an associated proximity placement group can also constrain the VMSS | Use another SKU, zone, region, or node pool. Check whether a proximity placement group is associated before attributing the failure to one. During an upgrade only, `maxUnavailable > 0` with `maxSurge=0` avoids requesting surge capacity | [AKS ZonalAllocationFailed](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/zonalallocation-allocationfailed-error) · [Customize unavailable nodes](https://learn.microsoft.com/azure/aks/upgrade-aks-node-pools-rolling#customize-unavailable-nodes) |
| AKS node-pool `OverconstrainedAllocationRequest`: `Allocation failed. VM(s) with the following constraints cannot be allocated, because the condition is too restrictive` | The combination of constraints listed in the message can't be allocated. Documented constraints include SKU, accelerated networking, IPv6, zone, ephemeral disk, and proximity placement group | Read the listed constraints, then relax the named constraint or use another SKU, zone, region, or node pool. If a proximity placement group is associated, create a node pool without it. During upgrades only, `maxUnavailable > 0` with `maxSurge=0` avoids requesting surge capacity | [AKS allocation errors](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/zonalallocation-allocationfailed-error) · [Customize unavailable nodes](https://learn.microsoft.com/azure/aks/upgrade-aks-node-pools-rolling#customize-unavailable-nodes) |
| AKS `AllocationFailed`: `The VM allocation failed due to an internal error. Please retry later or try deploying to a different location` | The documented AKS form is an internal allocation error | Retry later or deploy to another location; don't recast this exact message as quota or capacity exhaustion | [AKS AllocationFailed](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/zonalallocation-allocationfailed-error) |
| AKS / backing VMSS `AllocationFailed`: `We do not have sufficient capacity for the requested VM size in this region` | Azure lacks capacity for the requested placement | Retry later or use another SKU, zone, region, or node pool. During an AKS upgrade, reduce surge or use `maxUnavailable`; don't apply upgrade-only advice to create or scale failures | [VMSS allocation failures](https://learn.microsoft.com/troubleshoot/azure/virtual-machine-scale-sets/deploy/allocationfailed-or-zonalallocationfailed) · [AKS allocation errors](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/zonalallocation-allocationfailed-error) · [Customize unavailable nodes](https://learn.microsoft.com/azure/aks/upgrade-aks-node-pools-rolling#customize-unavailable-nodes) |

## Node images, snapshots, and upgrades

| Signature | Cause | Documented fix | Reference |
|---|---|---|---|
| `NodeImageVersion '...' is not accepted. NodeImageVersion can only be current version '...' or 'latest'` | A node pool created from a snapshot (or under rollback) is being set to a node-image version that is neither its current pinned version nor `latest` | Move the pool to the latest supported image with `az aks nodepool upgrade --node-image-only` (omit `--snapshot-id`); node images can't be downgraded, and a snapshot-based pool keeps its pinned image across scale ops until upgraded | [Node pool snapshot](https://learn.microsoft.com/azure/aks/node-pool-snapshot#upgrading-a-node-pool-to-a-snapshot) · [Upgrade node images](https://learn.microsoft.com/azure/aks/upgrade-node-image) |
| `NodePoolMcVersionIncompatible` | Upgrading only the control plane pushed (or would push) a node pool more than three minor versions behind it | Upgrade the node pool with `az aks nodepool upgrade -k <version>` to a version ≤ the control-plane version; don't skip minor versions | [NodePoolMcVersionIncompatible](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/nodepoolmcversionincompatible-error) |
| Upgrade blocked — target version not allowed / unsupported | The target Kubernetes version is unsupported in the region, or the upgrade skips a minor version | Pick a supported version and upgrade one minor version at a time (see the version-skew policy) | [AKS upgrade blocked](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/aks-upgrade-blocked#cause) |

## Identity, ACR, and network isolation

| Signature | Cause | Documented fix | Reference |
|---|---|---|---|
| `LinkedAuthorizationFailed` | The AKS deployment identity (managed identity or service principal) lacks the required role assignment on a **linked** resource named in the error (for example `Microsoft.Network/.../join/action` on a subnet or DDoS plan) | Grant the identity the exact action from the error at the **linked** resource scope; confirm role-assignment propagation and that the linked resource still exists and is reachable from the target subscription | [LinkedAuthorizationFailed](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/linkedauthorizationfailed-error) |
| `OrasPullUnauthorizedVMExtensionError` / `vmssCSE` exit **212** ("Bootstrap Container Registry authorization failed") | On a network-isolated cluster (outbound type `none` or `block`), the kubelet identity can't pull bootstrap images from the private ACR cache | Ensure the kubelet identity has `AcrPull` (or `Container Registry Repository Reader` on ABAC-enabled registries) on the bootstrap ACR and is bound to the VM instance | [OrasPullUnauthorized (exit 212)](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/error-codes/vmextensionerror-oraspullunauthorized) |
| `401 Unauthorized` pulling from ACR (`failed to authorize: ... 401`) | The cluster's kubelet identity (or SP) lacks pull authorization on the registry, or the ACR integration role assignment is missing | Create the correct ACR role for the kubelet identity (`AcrPull`, or the repository-reader role on ABAC registries), or attach the registry with `az aks update --attach-acr` | [Cannot pull image from ACR](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/connectivity/cannot-pull-image-from-acr-to-aks-cluster#cause-1-%60401-unauthorized%60-error) |
| Network-isolated cluster image pull fails after enabling isolation or changing the ACR ID | Expected behavior — the kubelet config in the Container Service Extension (CSE) is stale after the change | Reimage the node to refresh the kubelet config; for BYO ACR verify cache rules and private endpoints, for AKS-managed ACR reconcile the cluster | [Network-isolated cluster issues](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/extensions/troubleshoot-network-isolated-cluster) |

## How to extend this catalog

Add a row only when **all** of the following hold:

1. The failure has a **specific, stable signature** — an error code, a message
   string, or an extension exit code — not just a symptom.
2. There is a **public Microsoft-documented** cause and fix to cite (a Learn
   troubleshoot page, an AKS doc, or a release note). No public source → it does
   not belong here; it belongs in a live investigation.
3. The fix is stated as **read-only-first**: what to check, then the change to
   propose (never an unattended mutation).

Keep the newest, most general form of each error. When an entry's fix becomes a
platform default (the bug is fixed upstream), move it to a short "historical"
note rather than deleting it, so recurrences on older node images still match.
