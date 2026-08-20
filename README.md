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
| [`aks-known-issues`](skills/aks-known-issues) | Match a specific AKS error code or message to the documented cause and fix, with a Microsoft Learn citation. Deterministic lookup, not an investigation. |
| [`aks-cost-optimization`](skills/aks-cost-optimization) | Reduce AKS spend: rightsizing, autoscaler tuning, spot pools, cost visibility, anomaly detection. |
| [`aks-automatic-readiness`](skills/aks-automatic-readiness) | Assess workloads and clusters for AKS Automatic compatibility; generate fixes; guide migration. |
| [`aks-gpu-inference`](skills/aks-gpu-inference) | Day-2 GPU and model-inference operations: scheduling/quota, KAITO Workspaces, GPU cost/scaling, DCGM observability. |
| [`aks-network-capture`](skills/aks-network-capture) | Packet-level evidence: bounded, distributed capture and Azure-side network analysis. Escalation tool. |
| [`aks-cluster-setup`](skills/aks-cluster-setup) | Make AKS-specific cluster design decisions, then delegate provisioning to Azure Skills. |

## Try it

Once installed, just describe the problem in natural language — the host agent picks the right skill by its description. For example:

- *"A pod in my `payments` namespace is stuck in CrashLoopBackOff — investigate."* → `aks-troubleshooting`
- *"My node pool create failed with `VMCannotFitEphemeralOSDisk` — is this a known issue, and how do I fix it?"* → `aks-known-issues`
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
| **Azure SRE Agent** | [Install from URL](https://learn.microsoft.com/azure/sre-agent/install-plugin-from-url): `https://github.com/Azure/AKS-Skills` (reads `plugin.json` + `skills/`) |
| **Any Agent Skills host** | `npx skills add https://github.com/Azure/AKS-Skills --all` (installs the skills; `.mcp.json` wiring is not applied on this path — skills fall back to `az`/`kubectl`) |

For deployment/provisioning, also install [Azure Skills](https://github.com/microsoft/azure-skills).

## MCP product glossary

- **Azure MCP Server** is the `@azure/mcp` package. This repository's [`.mcp.json`](.mcp.json) configures only Azure MCP Server.
- **AKS MCP server** is the separate [`Azure/aks-mcp`](https://github.com/Azure/aks-mcp) product. This repository does not install, configure, or claim support for that runtime.

## Prerequisites

- **CLI-backed hosts:** install **`kubectl`**, **`jq`**, and the **Azure CLI (`az`)** on `PATH`, then authenticate to the target cluster/subscription (`az login`, `az aks get-credentials`). The readiness skill uses `jq` to project live manifests into a secret-safe assessment record before model ingestion. Hosts with built-in Azure and Kubernetes operations can use equivalent field projection instead.
- [`.mcp.json`](.mcp.json) declares the **Azure MCP Server** (`@azure/mcp`) requirement to plugin-aware hosts. Each host assigns its own tool names, so the skills discover Azure MCP capabilities from the host's available tools rather than requiring a particular prefix or spelling. Azure MCP Server's AKS area supplies cluster and node-pool metadata; AppLens, Azure Monitor, and Resource Health are separate Azure MCP areas used when their advertised schemas fit the investigation. The skills retain explicit `az`/`kubectl` and offline fallbacks when the needed capability is unavailable.
- **Azure SRE Agent:** built-in Azure operations, diagnostics, Monitor, and `kubectl` tools use the agent's managed identity and require no connector. Plugin installation records the external MCP requirement but does not provision the connector. If you want the external `@azure/mcp` surface and the plugin shows **Connector setup required**, use **Add as connector** from the plugin details (or add the MCP server under **Builder > Connectors**), complete authentication, wait for **Connected**, and select the Azure MCP tools for the agent. See the official [built-in tools](https://learn.microsoft.com/azure/sre-agent/tools), [plugin marketplace behavior](https://learn.microsoft.com/azure/sre-agent/plugin-marketplace#what-the-plugin-marketplace-does), and [MCP connector setup](https://learn.microsoft.com/azure/sre-agent/mcp-connector).
- Skills default to **read-only** operations and ask before making changes.

## Disconnected, self-hosted, and non-frontier use

The skills are plain text with a deterministic `az`/`kubectl` fallback: they don't require internet egress or a specific vendor API, so nothing structurally prevents running them against a smaller, self-hosted, or non-frontier model. Whether such a model actually *follows* a given skill reliably is a separate, empirical question — the skills aren't tuned or validated against non-frontier models today, and the eval harness below is the tool for measuring that gap, not a claim that it's already closed. If you're running in an air-gapped, sovereign, or self-hosted setup — for example a small local model in an Arc-based investigator — a few things already work today:

- **No Azure MCP Server required.** The [`.mcp.json`](.mcp.json) wiring is a convenience; every skill falls back to `az`/`kubectl`, so an agent with only the local CLIs still works. Azure MCP Server is **pinned to an exact `@azure/mcp` version** (not `@latest`), so a disconnected host can pre-cache that one package — or skip it entirely and rely on the fallback.
- **Local / offline install.** No GitHub connection is needed at runtime. Clone the repo and point your host at the local copy — in Claude Code, `/plugin marketplace add <path-to-local-clone>` (the marketplace declares a local `source`), or point the agent directly at the local `skills/` folder. The install rows above that reference `Azure/AKS-Skills` or `npx skills add <url>` need network; the local path does not.
- **Evaluate any model against the skills.** The eval harness can target any OpenAI-compatible endpoint — a hosted deployment or a local model server (llama.cpp, vLLM, Ollama) — by setting `OPENAI_BASE_URL` (and `EVAL_MODEL`). This is how you measure how well the skills perform on a smaller, self-hosted, or non-frontier model, not just frontier ones. See [evals/README.md](evals/README.md).
- **Air-gapped clusters.** A few skills run debug/capture pods that pull images from `mcr.microsoft.com`. In a cluster with no registry egress, mirror those images into your private registry first.
- **Product integration boundary.** Local/non-frontier model support makes the skill contract portable; it does not define a separate AKS troubleshooting experience or replace HolmesGPT. Runtime selection and reconnect handoff belong to the consuming product.

## Contributing

Contributions are welcome. AKS Skills accepts **deep, AKS-specific Day-2 operational knowledge and AKS-specific design opinions** — not generic Azure provisioning, generic Kubernetes any model already knows, or cross-resource workflows (those belong in Azure Skills). Every skill must meet the [Skill Contract](docs/skill-contract.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
