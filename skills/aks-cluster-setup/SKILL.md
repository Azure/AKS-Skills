---
name: aks-cluster-setup
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
description: "Make the AKS-specific design decisions for a new production Azure Kubernetes Service (AKS) cluster — SKU (Automatic vs Standard), pod IP model (Azure CNI Overlay vs kubenet), API-server access, egress, identity, upgrades, node pools, and reliability — then delegate the actual provisioning to the Azure Skills deployment engine. WHEN: create AKS cluster, provision AKS environment, design AKS networking, choose AKS SKU, Day-0 AKS checklist, plan a production AKS cluster. DO NOT USE FOR: debugging a running cluster (use aks-troubleshooting); assessing an existing cluster for AKS Automatic (use aks-automatic-readiness); GPU / model-serving setup (see azure-skills airunway-aks-setup); generic non-AKS Azure resource deployment (use azure-skills azure-deploy directly)."
---

# AKS Cluster Setup

This skill owns the **AKS-specific design decisions** for standing up a production cluster and then hands the **provisioning execution** to the [Azure Skills](https://github.com/microsoft/azure-skills) deployment engine. It distinguishes **Day-0 decisions** (networking, API-server access — hard to change later) from **Day-1 features** (can be enabled post-creation). See [references/cli-reference.md](references/cli-reference.md) for the commands.

## How this works with Azure Skills

This is a **thin facade over provisioning**, following the same pattern as `azure-functions-deploy`: it does not run `azd` or `az deployment` itself. It enriches the request with AKS-specific design decisions, then delegates the generic provisioning workflow to Azure Skills.

```text
User: "Create a production AKS cluster"
  │
  ▼
aks-cluster-setup (this skill)
  │  Decides the AKS-specific design:
  │   - AKS Automatic vs Standard
  │   - Pod IP model (Azure CNI Overlay vs VNet-routable vs kubenet)
  │   - API-server access (public / private / authorized ranges)
  │   - Egress model, identity, node pools, upgrade strategy, zones
  │
  ▼
Hands off to Azure Skills (install alongside):
  ├─ azure-prepare   → analyzes requirements, generates the infra plan
  ├─ azure-validate  → validates the plan, provisions a preview
  └─ azure-deploy    → runs azd up / az deployment to create the cluster
```

Install **both**: `aks-cluster-setup` for the AKS design brain, Azure Skills as the deployment engine underneath. If Azure Skills is not present, this skill still produces the full design and the exact `az aks create` command in [references/cli-reference.md](references/cli-reference.md) so the user can provision manually. This skill never provisions non-AKS resources — for those, use Azure Skills directly.

## Rules

1. Start from the user's requirements for compute, networking, security, and scale.
2. When AKS-aware MCP tools are available, select `mcp_azure_mcp_aks` first to discover the exact AKS tools the client exposes; use the smallest tool that fits, and fall back to `az aks` only when the MCP surface does not expose the needed operation.
3. Default to **AKS Automatic** unless the user needs control not supported by Node Auto Provisioning. Standard is for full configurability at higher operational overhead.
4. Record the rationale for every Day-0 decision (networking, API-server access) — these are expensive or impossible to change after creation.

## Required inputs (ask only what is needed)

If the user is unsure, use the safe defaults below.

- Environment type: dev/test or production
- Region(s), availability zones, preferred node VM sizes
- Expected scale (node/cluster count, workload size)
- Networking requirements (API-server access, pod IP model, ingress/egress control)
- Security and identity requirements, including image registry
- Upgrade and observability preferences
- Cost constraints

## Design workflow

### 1. Cluster type

- **AKS Automatic** (default): a curated experience with pre-configured best practices for security, reliability, and performance. Use unless you need custom networking, autoscaling, or node-pool configuration not supported by Node Auto Provisioning (NAP).
- **AKS Standard**: full control over configuration, at additional setup and management overhead.

### 2. Networking (pod IP, egress, ingress, dataplane)

**Pod IP model** (key Day-0 decision):

- **Azure CNI Overlay** (recommended): pod IPs from a private overlay range, not VNet-routable; scales to large environments and suits most workloads.
- **Azure CNI (VNet-routable)**: pod IPs directly from the VNet (pod subnet or node subnet); use when pods must be addressable from the VNet or on-premises. Docs: https://learn.microsoft.com/azure/aks/azure-cni-overlay

**Dataplane & network policy**:

- **Azure CNI powered by Cilium** (recommended): eBPF-based, for high-performance packet processing, network policy, and observability.

**Egress**:

- **Static Egress Gateway** for stable, predictable outbound IPs.
- For restricted egress: UDR + Azure Firewall or an NVA.

**Ingress**:

- **App Routing add-on with Gateway API** — recommended default for HTTP/HTTPS workloads.
- **Istio service mesh with Gateway API** — advanced traffic management, mTLS, canary releases.
- **Application Gateway for Containers** — L7 load balancing with WAF integration.

**DNS**:

- Enable **LocalDNS** on all node pools for reliable, performant resolution.

### 3. Security

- Use **Microsoft Entra ID** everywhere (control plane, Workload Identity for pods, node access). Avoid static credentials.
- Azure Key Vault via the **Secrets Store CSI Driver** for secrets.
- Enable **Azure Policy** + **Deployment Safeguards**.
- Enable **encryption at rest** for etcd/API server and **in-transit** for node-to-node.
- Allow only signed, policy-approved images (Azure Policy + Ratify); prefer **Azure Container Registry**.
- **Isolation**: namespaces, network policies, scoped logging.

### 4. Observability

- Use **Managed Prometheus** and **Container Insights** with **Grafana** for logs and metrics.
- Enable **Diagnostic Settings** to collect control-plane and audit logs into a Log Analytics workspace.
- Complement with Application Insights, Resource Health, and AppLens detectors for troubleshooting.

### 5. Upgrades & patching

- Configure **Maintenance Windows** for controlled upgrade timing.
- Enable **auto-upgrade** for the control plane and node OS to stay current on security patches and Kubernetes versions.
- Consider **LTS versions** (2-year support, Premium tier) for enterprise stability.
- **Fleet upgrades**: use **AKS Fleet Manager** for staged rollout from test to production.

### 6. Performance

- Use **Ephemeral OS disks** (`--node-osdisk-type Ephemeral`) for faster node startup.
- Select **Azure Linux** as the node OS (smaller footprint, faster boot).
- Enable **KEDA** for event-driven autoscaling beyond HPA.

### 7. Node pools & compute

- **Dedicated system node pool**: at least 2 nodes, tainted `CriticalAddonsOnly` for system workloads.
- Enable **Node Auto Provisioning (NAP)** for cost savings and responsive scaling.
- Use **latest-generation SKUs (v5/v6)** for host-level optimizations.
- **Avoid B-series (burstable) VMs** — they cause performance and reliability issues.
- Use SKUs with **at least 4 vCPUs** for production.
- Set **topology spread constraints** to distribute pods across hosts/zones per SLO.

### 8. Reliability

- Deploy across **3 availability zones** (`--zones 1 2 3`).
- Use the **Standard tier** for a zone-redundant control plane and the 99.95% API-server SLA.
- Enable **Microsoft Defender for Containers** for runtime protection.
- Configure **PodDisruptionBudgets** for all production workloads.

### 9. Cost controls

- Use **Spot node pools** for batch/interruptible workloads (up to 90% savings). For ongoing spend reduction on a running cluster, use `aks-cost-optimization`.
- **Stop/Start** dev/test clusters: `az aks stop` / `az aks start`.
- Consider **Reserved Instances** or **Savings Plans** for steady-state workloads.

## Guardrails

- Do not request or output secrets (tokens, keys).
- Do not ask the user to paste subscription IDs. Resolve subscription and resource scope via MCP tools or `az account show` / `az account list`.
- For ambiguous Day-0 decisions, ask clarifying questions. For Day-1 features, propose 2–3 safe options with trade-offs and choose a conservative default.
- Do not promise zero downtime; advise workload safeguards (PDBs, probes, replicas) and staged upgrades.

## Error handling

| Error / symptom | Likely cause | Remediation |
|-----------------|--------------|-------------|
| MCP tool call fails or times out | Invalid credentials, subscription, or AKS context | Verify `az login`, confirm the active subscription with `az account show`, check the target resource group without echoing identifiers back |
| Quota exceeded | Regional vCPU or resource limits | Request a quota increase or select a different region / VM SKU |
| Networking conflict (IP exhaustion) | Pod subnet too small for the CNI/overlay model | Re-plan IP ranges; may require cluster recreation (Day-0) |
| Workload Identity not working | Missing OIDC issuer or federated credential | Enable `--enable-oidc-issuer --enable-workload-identity`, configure the federated identity |
