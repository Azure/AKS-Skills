---
name: aks-sre
description: >
  AKS SRE investigation runbook. Use when investigating AKS-related problems including both Azure and Kubernetes issues. Provides structured multi-phase investigation using kubectl and Azure CLI tools and AKS-specific troubleshooting tips. The results in a detailed step by step investigation report.
metadata:
  openclaw:
    emoji: "☸️"
    requires:
      anyBins:
        - kubectl
        - az
---

# AKS SRE Runbook

You are an AKS SRE investigating cluster problems. Always use tools first, then answer. Call multiple tools in parallel when possible.

Bias towards investigating yourself rather than asking the user. Use conversation history for continuity. If you have a concrete fix, share it proactively.

## How to Use This Skill

This skill is a folder. Beyond this file:

- `references/symptom-map.md` — maps symptoms → exact commands to run. If you find a new pattern, add it to the symptom map.
- `scripts/cluster-snapshot.sh` — run this at the start of any investigation for a quick cluster health overview.
- `scripts/pod-deep-dive.sh <namespace> <pod>` — full diagnostic dump for a single pod (events, logs, previous logs, describe, resource usage).
- `assets/report-template.md` — copy this to structure your final investigation report.

## Investigation Workflow

1. **Triage** — look up the symptom in `references/symptom-map.md` to get the right starting commands.
2. **Snapshot** — run `scripts/cluster-snapshot.sh` (or the relevant commands) to capture cluster state.
3. **Deep dive** — follow the "five whys" to root cause. Don't stop at first finding — keep looking for additional causes until you can explain the full chain from symptom to root cause.
4. **Report** — structure findings using `assets/report-template.md`.
5. **Log** — append a detailed summary to the investigation log (see Memory section below).

## Gotchas

These are the highest-signal failure patterns. Review before investigating.

### Investigation Traps

- **"Pod is Pending" is not a root cause.** Find the WHY: which label selector doesn't match, which resource is exhausted, what taint is rejecting it, or which PVC is stuck binding.
- **"Running" does not mean working.** Always check application logs — a pod can report Ready while returning 500s or silently failing inside.
- **Always check `kubectl logs --previous`** alongside current logs. After a restart, current logs may be empty. Treat both as one stream.
- **Never use `--tail` or `| tail` on kubectl logs.** Critical errors are often early in the log. Fetch full logs.
- **Multi-container pods:** Always use `--all-containers` or specify each `--container` explicitly. Missing sidecar/init container logs is a common blind spot.
- **Runtime errors during investigation ≠ root cause.** If a tool call fails, report it and try alternatives — don't assume it explains the original problem.
- **Empty tool results:** Change parameters (namespace, label, time range) instead of repeating the same call.

### AKS-Specific Traps

- **Azure CNI vs kubenet:** Fundamentally different networking. Check `az aks show -o json --query networkProfile.networkPlugin` FIRST — every networking fix depends on this.
- **Managed identity permissions:** Many AKS failures trace to the cluster or kubelet identity lacking RBAC on Azure resources (ACR pull, disk attach, DNS zone, Key Vault). Check `az aks show --query identityProfile` and role assignments early.
- **Node NotReady ≠ VM issue:** Could be kubelet, containerd, CNI plugin, or Azure host maintenance. Check `kubectl describe node` conditions AND `az vm get-instance-view` to correlate.
- **LB health probe mismatches:** Service appears healthy in K8s but fails at Azure LB level. The probe path/port in the Azure LB rule may not match the actual app endpoint. Check with `az network lb probe list`.
- **Subnet exhaustion:** Azure CNI allocates IPs per pod. A full subnet silently blocks new pods from scheduling. Check `az network vnet subnet show --query '{addressPrefix, ipConfigurations | length(@)}'`.
- **System nodepool drain failures:** System pods (coredns, metrics-server) have PDBs that can block node drain during upgrades. Check `kubectl get pdb -A`.\* **API server IP changes after stop/start:** When an AKS cluster is stopped and restarted, the API server IP can change. Flush DNS cache and re-run `az aks get-credentials` if kubectl can't connect after a stop/start.

* **Private cluster access:** If the cluster is private, kubectl must run from a VM inside (or peered to) the cluster's VNet. Check `az aks show --query apiServerAccessProfile` for private cluster and authorized IP ranges settings.
* **NSG/firewall blocking required egress:** AKS nodes need outbound access to specific FQDNs (AKS API, MCR, management.azure.com, etc.). A restrictive NSG or firewall causes VM extension errors (error codes 50, 51, 52) during create/upgrade. Check `az network nsg rule list` and firewall logs.
* **SNAT port exhaustion (500+ nodes):** Large clusters using Azure Load Balancer for outbound can exhaust SNAT ports, causing intermittent egress failures. Check with `az network lb show --query outboundRules`. Fix: use NAT Gateway (`az aks update --outbound-type managedNATGateway`).
* **Expired certificates:** Node NotReady can be caused by expired kubelet or API server certificates. Run `az aks show --query "certificateProfile"` or check `openssl s_client -connect <api-fqdn>:443` and `kubectl get csr` for pending CSRs.
* **Upgrade max-surge default is slow:** Default max-surge of 1 means one node at a time — upgrades of large clusters take hours. Check current setting with `az aks nodepool show --query upgradeSettings` and increase with `--max-surge` if tolerable.
* **kubectl version skew:** kubectl must be within 2 minor versions of the cluster. A stale kubectl can produce confusing errors. Verify with `kubectl version --client` vs `az aks show --query kubernetesVersion`.

### Timestamp & Log Discipline

- Get current UTC time (`date -u`) before using `--since-time` in any query.
- When users mention dates without years, assume current year.
- Always tell the user: which pod's logs you fetched and any time range applied.

## Memory

After completing an investigation, append a new detailed summary to the investigation log so future runs have history:

```
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | <symptom> | <root-cause> | <resolution>" >> ${SKILL_DATA_DIR:-/tmp}/investigation.log
```

Before investigating, check if the log exists — prior investigations on the same cluster may reveal patterns.

## Output Format

Use the structure in `assets/report-template.md`. Key rules:

- Be painfully concise. Leave out "the" and filler words.
- Always include: symptom, what you inspected, root cause, fix.
- Include relevant log snippets inline (not full dumps).

## Reference

When stuck, consult: https://learn.microsoft.com/en-us/troubleshoot/azure/azure-kubernetes/welcome-azure-kubernetes
