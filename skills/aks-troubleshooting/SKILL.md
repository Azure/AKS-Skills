---
name: aks-troubleshooting
license: MIT
metadata:
  author: Microsoft
  version: "1.0.1"
  openclaw:
    emoji: "☸️"
    requires:
      anyBins:
        - kubectl
        - az
description: "Debug and root-cause live Azure Kubernetes Service (AKS) cluster incidents: pod crashes, node failures, DNS/networking, ingress/load-balancer errors, network policy, upgrade failures, and spot/zone disruptions. Runs a read-only, evidence-first investigation using Azure MCP Server metadata and diagnostics where available, plus az and kubectl, and produces a structured incident report. WHEN: CrashLoopBackOff, OOMKilled, ImagePullBackOff, node NotReady, pod Pending, DNS resolution failure, 502/503 from ingress, connectivity timeout, upgrade stuck, cordon/drain failure, spot eviction, SNAT exhaustion, expired certificate, 'investigate my AKS cluster'. DO NOT USE FOR: packet-level capture (use aks-network-capture); GPU or model-serving issues (use aks-gpu-inference); creating or provisioning a cluster (use aks-cluster-setup); cost/rightsizing (use aks-cost-optimization); a named, documented AKS error code or message with a known signature — e.g. VMCannotFitEphemeralOSDisk, LinkedAuthorizationFailed, NodePoolMcVersionIncompatible, a vmssCSE exit code (use aks-known-issues)."
---

# AKS Troubleshooting

Root-cause live AKS incidents with a read-only, evidence-first investigation. This skill covers the full Day-2 troubleshooting surface — workloads, nodes, networking, ingress, upgrades, and spot/zone disruptions — and produces a structured incident report.

## Operating rules

**Read-only by default.** Do not restart, delete, cordon, drain, scale, upgrade, or reconfigure any resource unless the user explicitly asks for remediation. Gather evidence, name the root cause, and propose the fix — but do not apply it uninvited.

**Evidence before conclusion.** Do not state a root cause without quoting the evidence that supports it. "Pod is Pending" and "node is NotReady" are symptoms, not causes — trace them to the specific selector, taint, exhausted resource, or Azure-side condition.

**Tool preference.** Inspect the host's available tools and advertised schemas. Azure MCP Server's AKS area can supply cluster and node-pool metadata. AppLens, Azure Monitor, and Resource Health are separate Azure MCP areas; use each only when its host-advertised schema fits the read. Never treat a specific prefix or spelling as an availability check, and do not invent a name-mapping layer. Use the portable `az` and `kubectl` flows for checks outside those surfaces or whenever the matching capability is unavailable. See [references/azure-mcp.md](references/azure-mcp.md).

**Evidence order.** Gather Azure-side state first (cluster state, resource health, recent operations, node-pool state, detector/monitoring output), then Kubernetes-side state (reachability, nodes, `kube-system`, events, the affected namespace, pod detail, logs). This ordering catches platform-level causes — a failed upgrade operation, a stopped cluster, a quota block — before you spend time inside the cluster.

## Route by symptom

| Symptom | Reference |
|---------|-----------|
| Broad investigation, unknown root cause | [general-diagnostics.md](general-diagnostics.md) |
| Pod crash, OOMKilled, ImagePullBackOff, Pending, readiness probe | [pod-failures.md](pod-failures.md) |
| Node NotReady, node pressure, node scaling / autoscaler not triggering | [node-issues.md](node-issues.md) |
| Service connectivity, DNS, pod-to-pod networking | [networking.md](networking.md) |
| Ingress 502/503, load-balancer health probe, external access | [load-balancer-and-ingress.md](load-balancer-and-ingress.md) |
| Network policy blocking traffic | [network-policy.md](network-policy.md) |
| Upgrade stuck, cordon/drain failure | [upgrade-operations.md](upgrade-operations.md) |
| Spot eviction, zone rebalance failure | [spot-and-zone-issues.md](spot-and-zone-issues.md) |
| Any symptom → exact commands, in order | [references/symptom-map.md](references/symptom-map.md) |

`references/symptom-map.md` is the fastest path: 16 symptom sections, each a self-contained block of the exact `kubectl`/`az` commands to run plus the common causes. Start there when the symptom is clear; use the topic files above for deeper investigation.

## Scripts

Both are POSIX `sh`, read-only, and safe to run at the start of any investigation. Invoke with `sh <script>` or `./<script>`.

- `scripts/cluster-snapshot.sh` — quick cluster-health overview (nodes, system pods, recent events, node-pool state).
- `scripts/pod-deep-dive.sh <namespace> <pod>` — full diagnostic dump for one pod: describe, events, current and previous logs across all containers, resource usage.

## AKS-specific gotchas

The highest-signal failure patterns that are specific to AKS — a frontier model will not reliably know these. Review before investigating.

- **Azure CNI vs kubenet is a fork in every networking fix.** Check `az aks show -o json --query networkProfile.networkPlugin` **first** — the plugin (kubenet, Azure CNI, CNI Overlay, Cilium) changes how pod IPs, routes, and network policy behave.
- **Managed-identity RBAC is behind a large share of AKS failures.** ACR pull, disk attach, private DNS, and Key Vault access all depend on the cluster or kubelet identity having a role assignment. Check `az aks show --query identityProfile` and the relevant role assignments early.
- **Node NotReady is not always a VM problem.** It can be kubelet, containerd, the CNI plugin, Azure host maintenance, or an expired kubelet/API-server certificate. Correlate `kubectl describe node` conditions with `az vm get-instance-view`, and check `kubectl get csr` for pending certificate requests.
- **The Azure LB health probe can disagree with Kubernetes.** A Service can look healthy in-cluster but fail at the Azure load balancer because the LB rule's probe path/port does not match the app endpoint. Check `az network lb probe list`.
- **Subnet exhaustion silently blocks scheduling.** Azure CNI allocates a VNet IP per pod; a full pod subnet stops new pods scheduling with no obvious error. Check `az network vnet subnet show --query '{addressPrefix: addressPrefix, used: ipConfigurations | length(@)}'`.
- **System-pool PodDisruptionBudgets block drains during upgrades.** CoreDNS and metrics-server ship PDBs that can stall a node drain. Check `kubectl get pdb -A`.
- **The API server IP can change after stop/start.** When a cluster is stopped and restarted, the API server IP may change; flush DNS and re-run `az aks get-credentials` if `kubectl` cannot connect afterward.
- **Private clusters need in-VNet access.** `kubectl` must run from a VM inside — or peered to — the cluster VNet. Check `az aks show --query apiServerAccessProfile` for private-cluster and authorized-IP-range settings.
- **NSG/firewall egress blocks surface as VM extension errors.** AKS nodes need outbound access to required FQDNs (AKS API, MCR, `management.azure.com`, and others). A restrictive NSG or firewall causes VM extension errors during create/upgrade — error codes 50 (`OutboundConnFailVMExtensionError`), 51 (`K8SAPIServerConnFailVMExtensionError`), 52 (`K8SAPIServerDNSLookupFailVMExtensionError`). Check `az network nsg rule list` and firewall logs.
- **SNAT port exhaustion appears past a few hundred nodes.** Large clusters using the Azure Load Balancer for outbound can exhaust SNAT ports, causing intermittent egress failures. Check `az network lb show --query outboundRules`; fix by moving to a NAT gateway (`az aks update --outbound-type managedNATGateway`).
- **Upgrade `max-surge` defaults to one node at a time.** Large-cluster upgrades take hours at the default. Check `az aks nodepool show --query upgradeSettings` and raise `--max-surge` if the workload tolerates it.
- **`kubectl` must be within two minor versions of the cluster.** A stale client produces confusing errors. Compare `kubectl version --client` with `az aks show --query kubernetesVersion`.

## Log discipline

- Always fetch `kubectl logs --previous` alongside current logs — after a restart the current stream may be empty.
- Do not truncate logs with `--tail` or `| tail`; the causal error is often early.
- For multi-container pods, use `--all-containers` (or name each `--container`) so sidecar and init-container logs are not missed.
- Get current UTC time with `date -u` before using `--since-time`.

## Deep diagnostics

When standard checks do not reveal a root cause, use **Inspektor Gadget** for real-time, low-level node and pod observability (DNS traces, TCP traces, process and file-access snapshots). See [references/inspektor-gadget.md](references/inspektor-gadget.md) for the gadget catalog and symptom-to-gadget mapping. Inspektor Gadget runs a privileged debug pod — get explicit user approval before invoking it. Additional MCP-driven investigation modes are in [references/structured-input-modes.md](references/structured-input-modes.md) and [references/command-flows.md](references/command-flows.md).

## Report

Structure the final incident report using [references/report-template.md](references/report-template.md): symptom and impact, evidence gathered, failure domain, root cause with supporting evidence, confidence, remediation, and escalation. Quote relevant log snippets inline rather than pasting full dumps.

## Reference

Microsoft's AKS troubleshooting hub: https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/welcome-azure-kubernetes
