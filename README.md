# AKS Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Agent Skills](https://img.shields.io/badge/format-Agent%20Skills-5b9bff.svg)](https://agentskills.io)
[![Azure Kubernetes Service](https://img.shields.io/badge/Azure-Kubernetes%20Service-0078d4.svg)](https://learn.microsoft.com/azure/aks/)

Agent skills for operating **Azure Kubernetes Service (AKS)** clusters. AKS Skills is the deep Day-2 AKS operator — troubleshoot live incidents, optimize cost, assess AKS Automatic readiness, run GPU/inference workloads, and capture packet-level evidence. It complements the broader [Azure Skills](https://github.com/microsoft/azure-skills) plugin (the provisioning engine); install both.

This is a **dedicated repo**, not a folder inside the all-up Azure Skills plugin, so it can go deep on AKS Day-2 operations without bloating the general Azure plugin, and ship on the AKS team's own cadence. See **[docs/skills-vs-azure-skills.md](docs/skills-vs-azure-skills.md)** for the boundary and why.

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

## Try it

Once installed, just describe the problem in natural language — the host agent picks the right skill by its description. For example:

- *"A pod in my `payments` namespace is stuck in CrashLoopBackOff — investigate."* → `aks-troubleshooting`
- *"My AKS bill jumped this month; help me rightsize and find idle nodes."* → `aks-cost-optimization`
- *"Is my cluster ready to move to AKS Automatic? What needs to change?"* → `aks-automatic-readiness`
- *"My GPU pod is Pending with 'Insufficient nvidia.com/gpu' and the KAITO workspace never becomes ready."* → `aks-gpu-inference`
- *"Egress to Azure SQL fails but pod-to-pod works — I want packet-level proof of where it drops."* → `aks-network-capture`
- *"Design and stand up a production AKS cluster with a private API server."* → `aks-cluster-setup`

Skills default to **read-only** investigation and ask before changing anything.

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

## Telemetry

When installed as a plugin, AKS Skills emits anonymous usage telemetry — which skill or tool was invoked, the skill version, and a session id; **no code, prompts, file contents, or resource data** — via the Azure MCP server's `plugin-telemetry`, the same mechanism the [Azure Skills](https://github.com/microsoft/azure-skills) plugin uses. It helps the AKS team see which skills are useful and where they fall short.

Opt out any time by setting `AZURE_MCP_COLLECT_TELEMETRY=false` in your environment. The hook fails silently and never blocks or delays a tool call.

## Contributing

Contributions are welcome. AKS Skills accepts **deep, AKS-specific Day-2 operational knowledge and AKS-specific design opinions** — not generic Azure provisioning, generic Kubernetes any model already knows, or cross-resource workflows (those belong in Azure Skills). Every skill must meet the [Skill Contract](docs/skill-contract.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
