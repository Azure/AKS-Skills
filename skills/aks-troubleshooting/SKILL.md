---
name: aks-troubleshooting
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
  openclaw:
    emoji: "☸️"
    requires:
      anyBins:
        - kubectl
        - az
description: "Debug and root-cause live Azure Kubernetes Service (AKS) cluster incidents: pod crashes, node failures, DNS/networking, ingress/load-balancer errors, network policy, upgrade failures, and spot/zone disruptions. Runs a read-only, evidence-first investigation using discovered Azure/AKS read capabilities, az, and kubectl, and produces a structured incident report. WHEN: CrashLoopBackOff, OOMKilled, ImagePullBackOff, node NotReady, pod Pending, DNS resolution failure, 502/503 from ingress, connectivity timeout, upgrade stuck, cordon/drain failure, spot eviction, SNAT exhaustion, expired certificate, 'investigate my AKS cluster'. DO NOT USE FOR: packet capture (use aks-network-capture); GPU/model serving (use aks-gpu-inference); provisioning (use aks-cluster-setup); cost (use aks-cost-optimization); non-AKS or cross-service Azure incidents (use azure-diagnostics)."
---

# AKS Troubleshooting

Root-cause live AKS incidents with a read-only, evidence-first investigation. This skill covers the full Day-2 troubleshooting surface — workloads, nodes, networking, ingress, upgrades, and spot/zone disruptions — and produces a structured incident report.

## Operating rules

**Read-only by default.** Do not restart, delete, cordon, drain, scale, upgrade, or reconfigure any resource unless the user explicitly asks for remediation. Gather evidence, name the root cause, and propose the fix — but do not apply it uninvited.

**Evidence before conclusion.** Do not state a root cause without quoting the evidence that supports it. "Pod is Pending" and "node is NotReady" are symptoms, not causes — trace them to the specific selector, taint, exhausted resource, or Azure-side condition.

**Tool preference.** Ask the host to enumerate connected capabilities and schemas. Select the smallest discovered read capability whose schema matches the AKS check; do not assume a rendered wrapper name. Fall back explicitly to `az` for Azure-side reads and `kubectl` for Kubernetes-side reads when no discovered capability fits. Default every capable provider to read-only access. See [references/aks-mcp.md](references/aks-mcp.md).

**Evidence order.** Gather Azure-side state first (cluster state, resource health, recent operations, node-pool state, detector/monitoring output), then Kubernetes-side state (reachability, nodes, `kube-system`, events, the affected namespace, pod detail, logs). This ordering catches platform-level causes — a failed upgrade operation, a stopped cluster, a quota block — before you spend time inside the cluster.

**Package boundary.** This focused skill is the intended owner for deep AKS incidents. `azure-diagnostics` is the intended broad entry point for non-AKS and cross-service Azure incidents. No portable cross-plugin dependency or priority exists, and combined-install routing is not claimed until a host passes paired routing tests. If the host cannot prove that route, ship one package rather than expose a coin flip. See [references/provenance-and-boundary.md](references/provenance-and-boundary.md).

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

The Bash and PowerShell collectors require an explicit subscription, resource group, cluster, kube context, and empty artifact directory. They prove that the kube context endpoint matches the named AKS resource before any cluster data read. Raw artifacts stay in the selected directory; stdout is an allowlisted, redacted projection.

- `scripts/aks-baseline.sh` / `scripts/aks-baseline.ps1` — ordered Azure-then-Kubernetes cluster baseline.
- `scripts/pod-evidence.sh` / `scripts/pod-evidence.ps1` — invariant pod status, state, events, current/previous logs, resources, and usage.
- `scripts/run-ig.sh` / `scripts/run-ig.ps1` — validated, digest-pinned Inspektor Gadget execution; real runs require explicit privileged approval and a caller-supplied deadline.
- `scripts/cluster-snapshot.sh` and `scripts/pod-deep-dive.sh` — compatibility entry points to the safe Bash collectors.

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

- Use `pod-evidence` so current and previous streams are collected together, raw output remains outside model context, and the visible projection uses the shared redaction contract.
- Preserve the upstream default of 50 lines per stream unless the incident owner selects another positive value; do not paste raw customer logs into model context.
- For multi-container pods, preserve container prefixes so sidecar and init-container evidence remains attributable.
- Get current UTC time with `date -u` before using `--since-time`.

## Deep diagnostics

When standard checks do not reveal a root cause, use **Inspektor Gadget** for real-time, low-level node and pod observability (DNS traces, TCP traces, process and file-access snapshots). Invoke only through `run-ig`, which pins the verified multi-architecture image digest, validates the gadget and filters, requires explicit approval and a finite deadline, and requests cleanup of the exact debug pod. Additional provider-driven investigation modes are in [references/structured-input-modes.md](references/structured-input-modes.md) and [references/command-flows.md](references/command-flows.md).

## Report

Structure the final incident report using [references/report-template.md](references/report-template.md): symptom and impact, evidence gathered, failure domain, root cause with supporting evidence, confidence, remediation, and escalation. Quote relevant log snippets inline rather than pasting full dumps.

## Reference

Microsoft's AKS troubleshooting hub: https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/welcome-azure-kubernetes
