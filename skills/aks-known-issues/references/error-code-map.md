# AKS known-issue and error-code catalog

The single source of truth for `aks-known-issues`. Each entry is a **named** AKS
failure with a documented cause and fix, and a Microsoft Learn reference that
proves it. Only add an entry when a public, documented source supports it — this
catalog exists so a match can always be verified before anyone changes a cluster.

Match on the **signature**: the error code/message *and* the operation class that
produced it. A generic symptom with no error code is not a catalog match — route
it to `aks-troubleshooting`.

Columns: **Signature** (what you'll see) · **Cause** · **Documented fix** ·
**Reference**.

## Node pool provisioning and lifecycle

| Signature | Cause | Documented fix | Reference |
|---|---|---|---|
| Node pool `provisioningState=Failed` | The backing VM scale set errored during provision / scale / update — insufficient capacity, quota limits, network issues, policy violations, or resource locks | Read the exact code with `az aks nodepool show`, then `az vmss show` / `az vmss list-instances`; inspect the Activity Log; resolve the underlying cause (quota, capacity, policy, lock) and reconcile with `az aks nodepool update` | [Node/VM failed state — Scenario 3](https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/availability-performance/cluster-node-virtual-machine-failed-state#scenario-3-node-pool-is-in-a-failed-state) |
| `VMCannotFitEphemeralOSDisk` | An ephemeral OS disk was requested or defaulted, but the OS disk doesn't fit the VM SKU's cache / temp storage | Choose a VM SKU whose cache/temp is ≥ the OS disk size, reduce `--node-osdisk-size`, or set `--node-osdisk-type Managed`. OS disk type/size can't be changed in place — create a new node pool and migrate | [Ephemeral OS disks in AKS](https://learn.microsoft.com/azure/aks/concepts-storage#ephemeral-os-disks-in-aks) |

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
