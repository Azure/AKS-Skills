# AKS Skills vs. Azure Skills

AKS Skills is a focused AKS domain package. Azure Skills is the broad Azure package distributed from [GitHub Copilot for Azure](https://github.com/microsoft/GitHub-Copilot-for-Azure) (GHCP). They overlap today; they are not yet a functioning upstream/downstream pair.

GHCP originated the shared AKS troubleshooting tree, AKS-Skills imported it, and both copies evolved. GHCP does **not** currently consume AKS-Skills, and no reviewed trace proves Azure Portal consumes either repository's exact payload. The Agent Skills standard has description-driven discovery but no portable plugin dependency or priority field.

## TL;DR

| Need to… | Use |
| --- | --- |
| Troubleshoot, optimize cost, assess AKS Automatic readiness, operate GPU/inference, or capture packets on a **running** AKS cluster | **AKS Skills** (this repo) |
| Provision or deploy any Azure resource (AKS or otherwise) | **[Azure Skills](https://github.com/microsoft/azure-skills)** — the deployment engine |

Use AKS Skills for focused AKS operations and Azure Skills for broad Azure work and provisioning. If both are installed, the intended route is `aks-troubleshooting` for AKS incidents and `azure-diagnostics` for non-AKS or cross-service incidents, but that is not a support claim until the host passes paired routing tests.

## Why a separate repo?

AKS Skills is a dedicated repo, not a folder inside the all-up `azure-skills` plugin, for three reasons:

- **`azure-skills` is a read-only mirror** of the [GitHub Copilot for Azure](https://github.com/microsoft/GitHub-Copilot-for-Azure) plugin, synced and owned by that team. It's the right home for broad, **Day-0** provisioning across all Azure services — not a place the AKS team can own and iterate on deep **Day-2** operational skills.
- **Focus beats breadth for routing.** A host agent picks a skill from its description, and hosts cap how much skill text they load at once. Packing six deep AKS skills into a general multi-service plugin would compete for that budget and dilute routing; a dedicated, purpose-built plugin routes more reliably.
- **Ownership and cadence.** The AKS team validates skills here — with its own evals and CI — and ships on its own timeline. Any future GHCP consumption needs an explicit owner-approved integration; none exists today.

The packages can be used independently. Combined-install behavior remains host-owned and unproven without paired tests.

## How Azure SRE Agent loads these

Azure SRE Agent keeps a **maximum of five skills active at once** in a conversation; past that it auto-unloads the oldest and reactivates it on demand by re-reading the skill file ([SRE Agent skills limits](https://learn.microsoft.com/azure/sre-agent/skills#limits-and-constraints)). This runtime cap applies to *any* plugin — it is not an `azure-skills`-specific limit — and it's a further reason to keep a **focused, well-scoped** set of AKS skills rather than a sprawling catalog: the agent routes to the right skill and keeps the relevant few active.

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
| Troubleshooting | `azure-diagnostics` — broad Azure and cross-service triage with substantial AKS coverage. | `aks-troubleshooting` — deep AKS symptom→cause maps, host-neutral capability discovery, target-bound evidence, and read-only defaults. |
| Cost | `azure-cost` (mentions AKS) | `aks-cost-optimization` — AKS-specific autoscaler/spot/rightsizing. |
| AI/GPU setup | `airunway-aks-setup` (KAITO/vLLM enablement) | Not duplicated. `aks-gpu-inference` owns Day-2 GPU **operations** (troubleshoot/scale/cost); setup stays with `airunway-aks-setup`. |
| Packet capture | none | `aks-network-capture` — a differentiator. |

## Coordinating changes

`microsoft/azure-skills` is a **read-only mirror** synced from `microsoft/GitHub-Copilot-for-Azure`. Do not open PRs against it — they get clobbered. To coordinate a boundary change (e.g. the `azure-kubernetes` overlap), open an issue in `microsoft/GitHub-Copilot-for-Azure` (issue-first, owners `@microsoft/ghcp4a`).
