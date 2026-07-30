# AKS Skills

Agent skills for operating **Azure Kubernetes Service (AKS)** clusters. AKS Skills is the deep Day-2 AKS operator — troubleshoot live incidents, optimize cost, assess AKS Automatic readiness, run GPU/inference workloads, and capture packet-level evidence. It complements the broader [Azure Skills](https://github.com/microsoft/azure-skills) plugin (the provisioning engine); install both. See **[docs/skills-vs-azure-skills.md](docs/skills-vs-azure-skills.md)** for the boundary.

A "skill" is a folder with a `SKILL.md` (YAML front matter + guidance) plus optional `references/` and `scripts/`. A host agent reads the skill descriptions, picks the relevant one, loads its `SKILL.md`, and progressively reads references or runs scripts. The format is the open [Agent Skills standard](https://agentskills.io), so these skills run across Claude Code, GitHub Copilot, Azure SRE Agent, openclaw, and other compatible hosts.

## Skills

| Skill | What it does |
| --- | --- |
| [`aks-troubleshooting`](skills/aks-troubleshooting) | Root-cause live AKS incidents: pod crashes, node failures, DNS/networking, ingress, upgrades, spot/zone disruptions. Read-only, evidence-first. |
| [`aks-cost-optimization`](skills/aks-cost-optimization) | Reduce AKS spend: rightsizing, autoscaler tuning, spot pools, cost visibility, anomaly detection. |
| [`aks-automatic-readiness`](skills/aks-automatic-readiness) | Assess workloads and clusters for AKS Automatic compatibility; generate fixes; guide migration. |
| [`aks-gpu-inference`](skills/aks-gpu-inference) | Day-2 GPU and model-inference operations: scheduling/quota, KAITO Workspaces, GPU cost/scaling, DCGM observability. |
| [`aks-network-capture`](skills/aks-network-capture) | Packet-level evidence: bounded, distributed capture and Azure-side network analysis. Escalation tool. |
| [`aks-cluster-setup`](skills/aks-cluster-setup) | Make AKS-specific cluster design decisions, then delegate provisioning to Azure Skills. |

## Install

| Host | Install |
| --- | --- |
| **Claude Code** | `/plugin marketplace add Azure/AKS-Skills`, then `/plugin install aks@aks-skills` |
| **GitHub Copilot CLI** | `/plugin marketplace add Azure/AKS-Skills`, then `/plugin install aks@aks-skills` |
| **Azure SRE Agent** | Install from URL: `https://github.com/Azure/AKS-Skills` (reads `plugin.json` + `skills/`) |
| **openclaw** | `openclaw skills install https://github.com/Azure/AKS-Skills` |
| **Any Agent Skills host** | `npx skills add https://github.com/Azure/AKS-Skills` |

For deployment/provisioning, also install [Azure Skills](https://github.com/microsoft/azure-skills).

## Prerequisites

- **`kubectl`** and the **Azure CLI (`az`)** on `PATH`, authenticated to your cluster/subscription (`az login`, `az aks get-credentials`).
- The **Azure MCP server** (`@azure/mcp`) is wired via [`.mcp.json`](.mcp.json); skills prefer the AKS MCP tools and fall back to `az`/`kubectl`.
- Skills default to **read-only** operations and ask before making changes.

## Contributing

Contributions are welcome. AKS Skills accepts **deep, AKS-specific Day-2 operational knowledge and AKS-specific design opinions** — not generic Azure provisioning, generic Kubernetes any model already knows, or cross-resource workflows (those belong in Azure Skills). Every skill must meet the [Skill Contract](docs/skill-contract.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
