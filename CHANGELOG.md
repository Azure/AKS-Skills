# Changelog

All notable changes to AKS Skills are recorded here. Add an entry with each merged PR.

## [Unreleased] — public launch preparation

### Changed
- Restructured skills into a flat `aks-*` taxonomy; removed the `azure-kubernetes` skill name that collided with the Azure Skills plugin. Merged the SRE runbook and troubleshooting skills into a single `aks-troubleshooting`. Reframed cluster setup as `aks-cluster-setup`, a facade that delegates provisioning to Azure Skills.
- Eval providers (skill, baseline, router, judge) now share a common `evals/providers/llm-client.js` dispatch supporting foundry/azure/openai/github backends, so skills can be checked against more than one model family instead of a single hardcoded one.
- Regenerated `evals/package-lock.json` against the public npm registry (fixing an internal-feed leak); scoped eval dependencies as `devDependencies` and added Dependabot config.
- Added optimization-framework question phrasings to `aks-cost-optimization`'s routing triggers (e.g. workload efficiency, cost visibility, spot vs. on-demand) so those customer questions route cleanly.
- Network-capture scripts default to a neutral `./aks-network-captures` workspace path instead of an internal host path (overridable via `WORKSPACE_DIR`), and Azure CLI-calling scripts now stamp `AZURE_HTTP_USER_AGENT` for traffic attribution.
- Reworded eval docs to describe quality/trigger evals as advisory rather than gates, matching `skill-eval.yml`'s actual hard gates (lint, shellcheck, injection test); README install guidance was cleaned up (dropped the non-functional openclaw path, clarified that `npx skills add --all` installs skills only).
- Bumped GitHub Actions (`all-actions` group) used by the CodeQL, scripts, and skill-eval workflows.
- CODEOWNERS: added co-owners, then removed a departed reviewer.

### Added
- `aks-gpu-inference` — Day-2 operations for GPU and model-inference workloads (scheduling/quota, KAITO, cost/scaling, DCGM observability).
- `aks-known-issues` — a Day-2 skill that maps a specific, documented AKS error code or message to its Microsoft-documented cause and fix, backed by a curated `references/error-code-map.md` and Learn citations; includes reciprocal trigger tests so open-ended issues still fall to `aks-troubleshooting`.
- Plugin manifests (`plugin.json`, `.mcp.json`, `.claude-plugin/`) so the repo installs on Claude Code, Copilot CLI, and Azure SRE Agent.
- The Skill Contract (`docs/skill-contract.md`), the Azure Skills boundary doc, `CONTRIBUTING.md`, `CODEOWNERS`, and a real README.
- `docs/skills-vs-azure-skills.md` — explains why AKS Skills is a separate repo and how Azure SRE Agent's 5-active-skill runtime cap applies (a per-runtime limit, not specific to any one plugin).
- `CODE_OF_CONDUCT.md` (Microsoft Open Source Code of Conduct).
- `.github/workflows/scripts.yml` — shellcheck, no-`eval`/no-unpinned-image gates, and a packet-capture injection regression test (secret-free; runs on fork PRs).
- `.github/workflows/codeql.yml` — CodeQL analysis (Continuous SDL / S360).
- Mock-tier agentic evals (Vally): run the real GitHub Copilot agent against fake-broken-cluster fixtures for `aks-troubleshooting`, grading tool calls, call budget, and root-cause correctness via an LLM judge; retired the earlier full-cluster tier.
- A committable eval report generator (`evals/scripts/generate-report.mjs`) and `evals/history/` archive for weekly (CI) and manual eval runs.

### Fixed
- Fixed the silently-broken baseline eval config, which pointed at pre-restructure `tests/aks-sre` and `tests/network-troubleshoot` directories; it now points at the six real `aks-*` quality-test directories, restoring the skill-lift-over-base-model comparison.
- `aks-automatic-readiness` was routing to skill ids that don't exist in this repo, azure-skills, or upstream; it now routes to the correct siblings (`aks-troubleshooting`, `aks-cluster-setup`).
- Fixed a broken `providers/azure/<skill>` path template and stale `aks-sre`/`network-troubleshoot` skill ids in `evals/README.md`, and a self-referential path in the `holmesgpt-eval` skill.
- Clarified the foundry eval error message shown when a required model isn't configured.

### Security
- Removed the command-injection paths in `aks-network-capture`: no `eval`, validated inputs, least-privilege pods (NET_ADMIN/NET_RAW instead of privileged, no hostPID), and digest-pinned MCR images.
- Hardened `retrieve-captures.sh` to match its already-hardened sibling script: RFC 1123 validation on `--name`, constrained/absolute `--output-path` checks, and quoted `kubectl` pod-name arguments.
- Bumped `@hono/node-server` in the evals lockfile to resolve a flagged eval-harness dependency advisory.
