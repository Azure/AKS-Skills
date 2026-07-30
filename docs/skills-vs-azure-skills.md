# AKS Skills vs. Azure Skills

Two skill packages work together with **distinct responsibilities**. This page draws the boundary so you know which to install for which task, and so contributors know what belongs here.

## TL;DR

| Need to… | Use |
| --- | --- |
| Troubleshoot, optimize cost, assess AKS Automatic readiness, operate GPU/inference, or capture packets on a **running** AKS cluster | **AKS Skills** (this repo) |
| Provision or deploy any Azure resource (AKS or otherwise) | **[Azure Skills](https://github.com/microsoft/azure-skills)** — the deployment engine |

You will usually install **both**: AKS Skills for deep AKS operations, Azure Skills as the provisioning engine underneath.

## The boundary

**AKS Skills is the deep Day-2 AKS operator.** It owns AKS-specific operational knowledge that a general Azure plugin does not: the symptom→cause maps for live incidents, the GPU/KAITO failure signatures, the cost-and-scaling levers, and AKS-specific design opinions. Its skills work standalone — troubleshooting, cost, and readiness need no other plugin.

**Azure Skills is the provisioning/lifecycle engine.** It stands up and configures Azure resources through the `azure-prepare` → `azure-validate` → `azure-deploy` workflow (backed by `azd`/Bicep/Terraform), across *all* Azure services.

The dividing line is the same one [Azure Functions Skills](https://github.com/Azure/azure-functions-skills/blob/main/docs/skills-vs-azure-skills.md) drew for Functions: **own the domain, delegate the generic provisioning execution.** For AKS, "provisioning execution" is standing up the cluster infrastructure.

## How `aks-cluster-setup` delegates

`aks-cluster-setup` is a **thin facade**. It makes the AKS-specific Day-0 design decisions (SKU, CNI model, API-server access, egress, node pools, zones), then hands the actual provisioning to Azure Skills:

```text
User: "Create a production AKS cluster"
  │
  ▼
aks-cluster-setup (this repo) — decides the AKS design
  │
  ▼
Azure Skills (install alongside):
  ├─ azure-prepare   → analyzes requirements, generates the infra plan
  ├─ azure-validate  → validates the plan, provisions a preview
  └─ azure-deploy    → runs azd up / az deployment to create the cluster
```

If Azure Skills is not installed, `aks-cluster-setup` still produces the full design and the exact `az aks create` command so the user can provision manually. It never provisions non-AKS resources — for those, use Azure Skills directly.

## Overlap map (and how we resolve each)

| Area | Azure Skills has… | AKS Skills position |
| --- | --- | --- |
| Cluster planning/creation | `azure-kubernetes` (hand-rolls `az aks create`) | `aks-cluster-setup` — same niche, but delegates provisioning to the azd engine and stays AKS-native. There is no `azure-kubernetes` skill in this repo (renamed to `aks-*` to avoid the name clash). |
| Troubleshooting | `azure-diagnostics` (shallow AKS coverage) | `aks-troubleshooting` — deep symptom→cause maps, MCP-first, read-only. |
| Cost | `azure-cost` (mentions AKS) | `aks-cost-optimization` — AKS-specific autoscaler/spot/rightsizing. |
| AI/GPU setup | `airunway-aks-setup` (KAITO/vLLM enablement) | Not duplicated. `aks-gpu-inference` owns Day-2 GPU **operations** (troubleshoot/scale/cost); setup stays with `airunway-aks-setup`. |
| Packet capture | none | `aks-network-capture` — a differentiator. |

## Coordinating changes

`microsoft/azure-skills` is a **read-only mirror** synced from `microsoft/GitHub-Copilot-for-Azure`. Do not open PRs against it — they get clobbered. To coordinate a boundary change (e.g. the `azure-kubernetes` overlap), open an issue in `microsoft/GitHub-Copilot-for-Azure` (issue-first, owners `@microsoft/ghcp4a`).
