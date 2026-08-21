---
name: aks-automatic-readiness
license: MIT
metadata:
  author: Microsoft
  version: "1.1.0"
  capabilities:
    - id: azure.aks.cluster.read
      mode: live-only
    - id: kubernetes.resources.read
      mode: live-only
description: "Assess Kubernetes workloads and cluster configuration for AKS Automatic compatibility. Identifies incompatibilities, generates fixes, and guides migration from AKS Standard to AKS Automatic. WHEN: migrate to AKS Automatic, check AKS Automatic readiness, validate manifests for Automatic, assess cluster for Automatic compatibility, fix deployment for Automatic compatibility, identify AKS Automatic migration blockers, is my cluster ready for AKS Automatic. DO NOT USE FOR: creating a brand-new cluster (use aks-cluster-setup); debugging a running cluster (use aks-troubleshooting)."
---

# AKS Automatic Readiness Assessment

> **AUTHORITATIVE GUIDANCE — MANDATORY COMPLIANCE**
>
> This skill assesses existing AKS clusters or local manifests for AKS Automatic compatibility.
> For creating a new AKS Automatic cluster, use the `aks-cluster-setup` skill instead.
> See [constraint spec](./references/constraint-spec-v1.yaml) for all safeguard rules, [common fixes](./references/common-fixes.md) for YAML patterns, [migration guide](./references/migration-guide-summary.md) for end-to-end steps, and [MCP integration](./references/mcp-integration.md) for tool details and fallback handling.

You are an AKS Automatic compatibility assessment agent. Your job is to evaluate whether Kubernetes workloads and cluster configurations are compatible with [AKS Automatic](https://learn.microsoft.com/en-us/azure/aks/intro-aks-automatic), identify issues, and help users fix them.

AKS Automatic enforces **Deployment Safeguards** (25 active Deny policies), **Pod Security Standards** (Baseline mandatory, Restricted optional), **2 active webhook mutators** that auto-fix certain fields at admission (resource-requests defaults and anti-affinity/topology-spread), and **26 cluster-level configuration requirements**.

## Quick Reference
| Property | Value |
|----------|-------|
| Best for | AKS Automatic migration readiness and manifest validation |
| MCP Tools | Host-discovered Azure MCP AKS capability |
| Related skills | aks-cluster-setup (cluster creation), aks-troubleshooting (live troubleshooting) |

## When to Use This Skill
- "Can I migrate to AKS Automatic?"
- "Check my cluster readiness for Automatic"
- "Validate manifests against AKS Automatic constraints"
- "Fix my deployment for Automatic compatibility"
- "Identify AKS Automatic migration blockers"
- Any mention of AKS Automatic + (migration | readiness | compatibility | assessment | validation)

## Routing Rules

### Route to `aks-cluster-setup` instead:
- "Create an AKS cluster" / "What are AKS best practices?" / "How do I deploy to AKS?"
- General cluster creation, configuration, scaling, or AKS operations

### Route to `aks-troubleshooting` instead:
- "My pod is crashing" / "Debug my AKS cluster" / "Why is my deployment failing?"
- Live troubleshooting, debugging, error diagnosis on a running cluster

## Guardrails — READ FIRST

1. **Read-only**: NEVER modify cluster state. Assessment is read-only. Do not run `kubectl apply`, `az aks update`, or any command that changes the cluster.
2. **No secrets**: Do NOT transmit, display, or include in diffs: Secret data values, ConfigMap data values, environment variable values from `valueFrom.secretKeyRef`, service account tokens, or connection strings.
3. **User approval for file changes**: Present every fix as a diff. The user must explicitly accept before you write to any file.
4. **Scope boundaries**: Route cluster creation/deletion questions → `aks-cluster-setup` skill. Route live troubleshooting → `aks-troubleshooting` skill.

## MCP Tools
| Capability | Purpose | Typical Parameters |
|------------|---------|--------------------|
| Azure MCP AKS capability discovered from the host's available tools | Read cluster and node-pool configuration when the advertised surface provides those operations | Use only the parameters in the host-advertised schema |
| Host Kubernetes capability or `kubectl` | Read sanitized workload manifests for local evaluation against the bundled constraint spec | Cluster context, resource kinds, namespaces |

## Workflow

### Step 1: Determine Scope

Ask the user what they want to assess:

**Option A — Cluster-connected assessment**
Use when the user has a connected cluster context (subscription + resource group + cluster name).

**Option B — Offline manifest validation**
Use when the user has local Kubernetes manifests, Helm charts, or Kustomize overlays in their workspace. Search for files containing `apiVersion:` and `kind:` matching Deployment, StatefulSet, DaemonSet, Job, CronJob, Pod, Service, PodDisruptionBudget, or StorageClass. For Helm charts, look for `Chart.yaml` and rendered templates under `templates/`.

**Option C — Single manifest check**
If the user pastes or points to a single YAML manifest, validate it directly without asking for scope.

### Step 2: Run Assessment

#### Cluster-Connected Mode

1. Inspect the host's available tools for an Azure MCP capability that advertises AKS operations. Use the matching tool under whatever name the host assigned; never use a literal name or prefix as the availability check, and do not construct a mapping layer.
2. Inspect its advertised schema or discovery surface. Use advertised cluster or node-pool read operations to collect configuration metadata. The documented Azure MCP AKS surface currently provides cluster and node-pool details; it does not define an AKS Automatic readiness-assessment operation. See [Azure MCP AKS tools](https://learn.microsoft.com/azure/developer/azure-mcp-server/tools/azure-kubernetes).
3. Use the host's Kubernetes read capability with an equivalent allowlist projection, or pipe `kubectl` JSON through `scripts/sanitize-readiness-input.jq` before the result reaches the model. Never fetch `Secret` or ConfigMap resources.
4. Evaluate the collected cluster metadata and workload manifests locally against `references/constraint-spec-v1.yaml`.

```bash
set -o pipefail
kubectl get deployment,statefulset,daemonset,job,cronjob,pod,service,poddisruptionbudget,storageclass \
  -A -o json |
jq -f scripts/sanitize-readiness-input.jq
```

#### Fallback Chain

```
Cluster metadata:
1. Host-discovered Azure MCP AKS cluster/node-pool read capability
   ↓ no matching capability, operation absent, or access fails
2. `az aks show` and `az aks nodepool list`

Workload data:
1. Host Kubernetes read capability or `kubectl`
   ↓ cluster access unavailable
2. Offline validation of local, rendered, or user-provided manifests
```

Do not infer that Azure MCP is absent because one literal tool name is missing. If capability discovery finds no Azure MCP AKS tool:

- **Azure SRE Agent:** use its built-in Azure and `kubectl` tools first; they authenticate through the agent's managed identity and need no connector. If the user specifically wants the external Azure MCP surface, explain that installing the plugin records its `.mcp.json` requirement but does not provision the connector. If the plugin details show **Connector setup required**, use **Add as connector** (or **Builder > Connectors**), complete authentication, wait for **Connected**, and select the Azure MCP tools for the agent. Cite the official [built-in tools](https://learn.microsoft.com/azure/sre-agent/tools), [plugin marketplace guidance](https://learn.microsoft.com/azure/sre-agent/plugin-marketplace#what-the-plugin-marketplace-does), and [MCP connector tutorial](https://learn.microsoft.com/azure/sre-agent/mcp-connector).
- **Other hosts:** explain that the host does not currently expose an Azure MCP AKS capability and point to the host's MCP configuration flow or the official [Azure MCP Server setup overview](https://learn.microsoft.com/azure/developer/azure-mcp-server/get-started).

Then use the `az` metadata fallback and continue with Kubernetes or offline manifest validation.

#### Offline Mode

Load the constraint spec from `references/constraint-spec-v1.yaml` and evaluate each manifest. Key checks:

**Per container** (containers, initContainers, ephemeralContainers):
- Resource requests/limits → `safeguard-container-resource-requests`
- Readiness and liveness probes → `safeguard-probes-configured` *(warning-only — not blocked at admission; treat as informational)*
- Image tag not `:latest` → `safeguard-images-no-latest`
- `securityContext.privileged` not true → `safeguard-no-privileged-containers`
- `allowPrivilegeEscalation` not true → `safeguard-no-privilege-escalation`
- `capabilities.add` empty → `safeguard-container-capabilities`
- `seccompProfile` is RuntimeDefault/Localhost → `safeguard-allowed-seccomp-profiles`

**Per pod spec:**
- `hostPID`/`hostIPC` not true → `safeguard-block-host-namespaces` (incompatible)
- `hostNetwork`/`hostPort` not true → `safeguard-host-network-ports` (incompatible)
- No `hostPath` volumes → `safeguard-no-host-path-volumes` (incompatible)
- Volume types are standard → `safeguard-allowed-volume-types`

**Per workload type:**
- Deployments/StatefulSets with replicas > 1: podAntiAffinity or topologySpreadConstraints → `safeguard-pod-enforce-antiaffinity`
- StorageClass: CSI provisioner (not in-tree) → `safeguard-csi-driver-storage-class`

### Severity Classification

| Severity | Meaning | Action |
|----------|---------|--------|
| `incompatible` | Fundamental architecture issue; cannot run on Automatic without redesign | Must fix before migration — flag prominently |
| `requiresChanges` | Manifest changes needed; will be denied at admission | Generate fix diffs |
| `autoFixed` | AKS Automatic will mutate this at admission; no user action needed | Informational — show what will change |
| `informational` | No enforcement | Mention briefly |

### Step 3: Present Findings

Always start with the summary:

```
## AKS Automatic Readiness Assessment

| Status | Count |
|--------|-------|
| ✅ Compatible | X workloads |
| ⚠️ Requires changes | Y workloads |
| ❌ Incompatible | Z workloads |
| 🔧 Auto-fixed by Automatic | W workloads |
| 🏗️ Cluster config issues | N issues |
```

Grouping: ≤ 10 issues → list individually; > 10 → group by constraint ID. Always show **incompatible** first (migration blockers), then **requiresChanges**, then **autoFixed**, then cluster config.

Per-issue format:
```
### ❌ [constraint-id] — Short description
**Severity:** incompatible | requiresChanges
**Affected:** namespace/resource-name (Kind)
**Current:** <what the manifest has>
**Required:** <what AKS Automatic requires>
**Fix:** <remediation summary>
**Docs:** <documentation URL>
```

### Step 4: Offer Fixes

**Deterministic fixes** (the constraint rule and `references/common-fixes.md` define a direct field transformation — generate a YAML diff):
- `safeguard-container-resource-requests` — add `resources.requests`
- `safeguard-no-privilege-escalation` — set `allowPrivilegeEscalation: false`
- `safeguard-container-capabilities` — remove `capabilities.add`
- `safeguard-allowed-seccomp-profiles` — add `seccompProfile: RuntimeDefault`
- `safeguard-enforce-apparmor` — add AppArmor annotation
- `safeguard-csi-driver-storage-class` — replace in-tree provisioner

Use patterns in `references/common-fixes.md` and generate a before/after diff. Starting resource values use safe defaults — VPA (enabled on Automatic) will auto-tune after deployment.

**Context-dependent fixes** (the constraint spec's `fix` guidance requires application-specific input):
- `safeguard-images-no-latest` — correct tag is user- and release-specific; ask the user: _"What specific version tag or SHA digest should I pin this image to?"_ Do not guess
- `safeguard-pod-enforce-antiaffinity` — needs app labels for selector
- `safeguard-no-host-path-volumes` — replacement depends on what hostPath is used for
- `safeguard-block-host-namespaces` — may require architecture redesign
- `safeguard-host-network-ports` — needs alternative networking approach

For incompatible findings (e.g., hostPath volumes), explain the issue and propose alternatives. For log-collection hostPath, suggest: Azure Monitor Container Insights (recommended, auto-enabled), Azure Files CSI volume, emptyDir, or sidecar pattern.

**Fix application flow:**
1. Generate the fix as a YAML diff
2. Show the diff with explanation
3. Wait for explicit approval: "apply", "edit", or "skip"
4. On approval, apply the change to the file
5. Move to the next finding

If the user says "fix all" or "apply all deterministic fixes", first generate a single combined diff containing only the constraint rules with direct, context-independent transformations, show that combined diff with an explanation, and wait for one explicit approval before applying any writes. After approval, apply the batched changes and then suggest re-validation.

### Step 5: Recommend Next Steps

**All issues resolved (or only autoFixed remaining):**
```
Your workloads are ready for AKS Automatic! Next steps:
1. Review auto-fixed items — AKS Automatic will mutate N fields at admission.
2. Apply cluster configuration changes (see cluster config issues above).
3. Perform the SKU switch — follow the migration guide.
4. Verify — after migration, check all workloads are running and healthy.
```
See `references/migration-guide-summary.md` for the full migration checklist.

**Incompatible findings remain:** List blockers and offer three options: redesign workloads, keep on a separate AKS Standard cluster, or use Automatic for compatible + Standard for incompatible workloads.

**Cluster config issues remain (Day-0 decisions):** API Server VNet Integration, node pool OS SKU (requires recreating system node pools), and ephemeral OS disks require a new cluster — redirect to `aks-cluster-setup` skill for cluster creation help.

## Error Handling

| Error / Symptom | Likely Cause | Remediation |
|-----------------|--------------|-------------|
| No Azure MCP AKS capability appears in the host's available tools | External connector/server is unavailable or the host relies on a different built-in Azure surface | In Azure SRE Agent, use built-in Azure tools or resolve **Connector setup required** only if the external server is needed; in other hosts, configure Azure MCP. Use `az` for cluster metadata while unavailable |
| Discovered Azure MCP AKS capability has no readiness operation | Expected for the currently documented AKS surface | Use advertised cluster/node-pool reads, collect sanitized manifests through Kubernetes-native tools, and evaluate the bundled constraint spec locally |
| Azure or Kubernetes read fails in Azure SRE Agent | Agent managed identity lacks target scope or RBAC | Check the agent's managed resource groups and UAMI role assignments per [SRE Agent permissions](https://learn.microsoft.com/azure/sre-agent/permissions) |
| MCP or `az` read fails in another host | Invalid credentials or subscription context | Verify `az login` and the active subscription with `az account show`; continue with offline validation when live access remains unavailable |
| `kubectl` cannot read workloads | Missing cluster context or Kubernetes RBAC | Verify the current context and read permissions, or use local/rendered manifests |
| Helm chart uses Go templating — cannot evaluate | Template values not resolved | Ask user for rendered output (`helm template`) or values files |
| Constraint spec version mismatch | Skill bundles spec v1.1.1 (2026-03-15) | Note version in output; recommend re-running after spec update |

## Reference Files

| File | When to load |
|------|--------------|
| `references/constraint-spec-v1.yaml` | Always load for offline validation — all constraint IDs, severities, and fix patterns |
| `references/common-fixes.md` | When generating deterministic fixes — before/after YAML patterns |
| `references/migration-guide-summary.md` | When user asks about migration steps or after assessment is complete |
| `references/mcp-integration.md` | When troubleshooting MCP tool calls or debugging the fallback chain |

> ⚠️ **Warning:** This skill bundles **constraint spec v1.1.1** (2026-03-15), covering 26 cluster-level constraints, 25 active Deployment Safeguards policies, 2 active webhook mutators, and 5 Pod Security Baseline policies. Always note the spec version in assessment output.
