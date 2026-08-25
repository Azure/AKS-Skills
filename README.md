# AKS Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Agent Skills](https://img.shields.io/badge/format-Agent%20Skills-5b9bff.svg)](https://agentskills.io)
[![Azure Kubernetes Service](https://img.shields.io/badge/Azure-Kubernetes%20Service-0078d4.svg)](https://learn.microsoft.com/azure/aks/)

Agent skills for operating **Azure Kubernetes Service (AKS)** clusters. AKS
Skills is the focused Day-2 AKS operator: troubleshoot live incidents, optimize
cost, assess AKS Automatic readiness, run GPU/inference workloads, and capture
packet-level evidence. The broader
[Azure Skills](https://github.com/microsoft/azure-skills) plugin distributes
Azure-wide provisioning and diagnostics, including its own AKS troubleshooting
surface.

The AKS troubleshooting content has shared lineage: GitHub Copilot for Azure
(GHCP) originated the common tree, AKS-Skills imported it in June 2026, and both
copies evolved. This repository now carries the reconciled, host-neutral source
bundle. GHCP does **not** currently consume it, and no Portal consumption claim
is made. See
**[docs/skills-vs-azure-skills.md](docs/skills-vs-azure-skills.md)** for current
and intended boundaries.

A "skill" is a folder with a `SKILL.md` (YAML front matter + guidance) plus
optional `references/` and `scripts/`. A host reads descriptions, selects a
skill, then progressively loads references or runs scripts. The open
[Agent Skills standard](https://agentskills.io) makes the source portable, but
each host still owns routing, model, identity, authorization, tools, transport,
retention, tracing, and UX.

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
| **Azure SRE Agent** | Install from URL: `https://github.com/Azure/AKS-Skills` (reads `plugin.json` + `skills/`) |
| **Any Agent Skills host** | `npx skills add https://github.com/Azure/AKS-Skills --all` (installs the skills; `.mcp.json` wiring is not applied on this path — skills fall back to `az`/`kubectl`) |

For deployment/provisioning, use
[Azure Skills](https://github.com/microsoft/azure-skills). Do not assume that
installing both packages gives deterministic routing: no portable cross-plugin
priority exists. Until a host has paired routing tests, ship the focused package
for AKS-only work or the broad package for Azure-wide work rather than exposing
a coin flip.

## Source and downstream contract

`skills/aks-troubleshooting/bundle.source.json` enumerates the canonical,
self-contained troubleshooting payload. The dependency-free exporter under
`evals/` materializes an explicit source ref and emits a strict file manifest
plus provenance lock.

The owner-dependent target is for GHCP to build from an exact AKS-Skills commit
and canonical tree hash with no manual edits or runtime fetch. If that mechanism
is rejected, the fallback is consolidation into GHCP, not a permanent
hand-maintained fork. Current broad-only, focused-only, focused-absent, and
both-installed behavior is documented in the boundary guide; combined-install
support remains unproven until each host passes paired tests.

## Prerequisites

- **`kubectl`** and the **Azure CLI (`az`)** on `PATH`, authenticated to the
  explicit cluster/subscription target.
- When a host exposes Azure diagnostic capabilities, the skills discover their
  schemas and select the smallest matching read. They never assume a rendered
  wrapper name and fall back explicitly to `az`/`kubectl`.
- Skills default to **read-only** operations and ask before making changes.

## Contributing

Contributions are welcome. AKS Skills accepts **deep, AKS-specific Day-2 operational knowledge and AKS-specific design opinions** — not generic Azure provisioning, generic Kubernetes any model already knows, or cross-resource workflows (those belong in Azure Skills). Every skill must meet the [Skill Contract](docs/skill-contract.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
