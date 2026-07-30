# Changelog

All notable changes to AKS Skills are recorded here. Add an entry with each merged PR.

## [Unreleased] — public launch preparation

### Changed
- Restructured skills into a flat `aks-*` taxonomy; removed the `azure-kubernetes` skill name that collided with the Azure Skills plugin. Merged the SRE runbook and troubleshooting skills into a single `aks-troubleshooting`. Reframed cluster setup as `aks-cluster-setup`, a facade that delegates provisioning to Azure Skills.

### Added
- `aks-gpu-inference` — Day-2 operations for GPU and model-inference workloads (scheduling/quota, KAITO, cost/scaling, DCGM observability).
- Plugin manifests (`plugin.json`, `.mcp.json`, `.claude-plugin/`) so the repo installs on Claude Code, Copilot CLI, and Azure SRE Agent.
- The Skill Contract (`docs/skill-contract.md`), the Azure Skills boundary doc, `CONTRIBUTING.md`, `CODEOWNERS`, and a real README.
- `.github/workflows/scripts.yml` — shellcheck, no-`eval`/no-unpinned-image gates, and a packet-capture injection regression test (secret-free; runs on fork PRs).

### Security
- Removed the command-injection paths in `aks-network-capture`: no `eval`, validated inputs, least-privilege pods (NET_ADMIN/NET_RAW instead of privileged, no hostPID), and digest-pinned MCR images.
