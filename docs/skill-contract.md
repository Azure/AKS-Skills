# The AKS Skill Contract

Every skill in this repo must meet this contract. It is runtime-agnostic — a skill that satisfies it works across Claude Code, GitHub Copilot, Azure SRE Agent, openclaw, and other [Agent Skills](https://agentskills.io) hosts. CI enforces the mechanical parts; a human owner reviews the judgment parts.

The contract exists because **content decays and the contract compounds.** A skill's prose ages with each model release; the bar every contributing team meets is what makes this repo durable and makes AKS Skills the pattern other Azure teams follow.

## 1. What belongs here

**Accept:** deep, AKS-specific Day-2 operational knowledge and AKS-specific design opinions — symptom→cause maps, exact `az`/`kubectl` commands, error-code and condition maps, AKS quirks, and org conventions a frontier model cannot infer.

**Reject:** generic Azure provisioning (belongs in Azure Skills), generic Kubernetes any capable model already knows, and cross-resource workflows. When a skill overlaps Azure Skills, it must delegate or draw an explicit boundary (see [skills-vs-azure-skills.md](skills-vs-azure-skills.md)).

**Scope:** this contract governs the complete bundle under every registered `skills/<skill>/` directory — `SKILL.md`, every shipped Markdown instruction, and every executable command or script. The skill inventory is what `plugin.json` registers and the router presents. A `SKILL.md` anywhere else in the repo (for example `evals/holmesgpt-eval/`) is an internal harness fixture: not registered as a skill, not routed, and outside the lint walk (see [evals/README.md](../evals/README.md)).

## 2. Manifest (front matter)

Required, in this order:

```yaml
---
name: <skill-id>            # MUST equal the folder name
license: MIT
metadata:
  author: Microsoft
  version: "X.Y.Z"         # semver
description: "<one lead sentence: what it does>. WHEN: <trigger phrases and quoted user utterances>. DO NOT USE FOR: <cases> (use <other-skill>)."
---
```

- **`metadata`** follows the Agent Skills string-to-string contract. Host-specific nested metadata is not part of the portable contract.
- **`description`** carries the routing surface. It must include `WHEN:` triggers **and** a `DO NOT USE FOR:` boundary that names the sibling skill to use instead (the parenthetical-redirect grammar). No two skills may share a description or have one subsume another.
- **Budget:** the front-matter `description` must be 1024 characters or fewer to remain portable across Agent Skills-compatible hosts. As first-party authoring guidance, Anthropic recommends keeping the `SKILL.md` body **under 500 lines** and moving deep material into progressively disclosed files; CI does not add a separate 500/501-line gate. Push command catalogs, symptom maps, and per-topic detail into files inside the same skill, loaded only when needed. Do not flatten every file into every prompt.
- **Runtime hints are additive, never conflicting:** the repo-root `plugin.json` + `.mcp.json` supplies SRE Agent / marketplace install without changing the portable skill front matter.

## 3. Content rules

- **Durability.** A sentence that prescribes *how to think, write, or generally behave* — with no AKS/Azure/Kubernetes token, no tool/resource identifier, and no safety verb — is decaying coaching; drop it. Instructions that encode an **org policy**, a **tool contract**, or a **safety boundary** the model cannot infer are durable; keep them. (The coaching-phrase lint flags candidates as a warning; a human decides.)
- **Long-reference navigation.** Anthropic's current [Skill authoring best practice for longer reference files](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#structure-longer-reference-files-with-table-of-contents) requires reference files longer than 100 lines to put a `Contents` or `Table of contents` section at the top. AKS Skills additionally hardens that rule mechanically: the section must contain navigable links that resolve to real headings in the file.
- **Read-only by default.** Any skill that can mutate a cluster MUST state the read-only guardrail: *do not restart, delete, cordon, drain, scale, upgrade, or reconfigure unless the user explicitly asks.*
- **No host coupling in the body.** No "OpenClaw UI will render…", no `/home/<user>/...` paths, no host-specific assumptions.
- **MCP product names and boundaries.** **Azure MCP Server** means `@azure/mcp`, which this repository configures through `.mcp.json`. The **AKS MCP server** means the separate `Azure/aks-mcp` product, which this repository does not configure or support. Never shorten Azure MCP Server to "AKS MCP" or "AKS-MCP." Azure MCP Server's AKS area is limited to cluster and node-pool metadata; AppLens, Azure Monitor, and Resource Health are separate areas. Select operations from host-advertised capabilities and schemas, and retain direct CLI/Kubernetes fallbacks.

## 4. Executable shell command and script rules

- Script-shaped files under `scripts/`, plus shell scripts anywhere in a registered skill bundle, have a valid shebang and executable bit. Shell scripts are **shellcheck-clean** at warning level and POSIX where practical.
- The shell-command policy below applies to executable shell contexts in Markdown and shell scripts. Non-shell executables under `scripts/` still receive shebang/executable checks; this policy does not claim interpreter-independent `eval`, TTY, or image parsing.
- **No shell `eval`.** No unquoted interpolation of user input into an executable Markdown shell command, shell script, or privileged manifest.
- Every input that reaches a privileged pod is validated/allowlisted; filters are passed as argv/env, never as shell strings.
- Container images executed by Markdown commands, applied Markdown/script heredocs, or scripts are **MCR-hosted and digest-pinned**. Docker Hub/public images and tag-only MCR images are not allowed in executable paths.
- No interactive stdin or TTY flags (`-i`, `-t`, short-option clusters containing either flag, `--stdin`, `--interactive`, or `--tty`) in agent-run Markdown shell commands or shell scripts.
- Commands that create debug or test pods retain an explicit user-approval gate.

## 5. Required tests

Per skill:
- **Routing tests** (`evals/tests/<skill>/trigger-tests.yaml`) — should / should-not trigger prompts, run against the full router pool.
- **Quality tests** (`evals/tests/<skill>/quality-tests.yaml`) — at least one, wired into `evals/promptfooconfig.yaml`.
- Any script change ships a regression test (e.g. the packet-capture injection test).

For a quality case that needs supporting content beyond `SKILL.md`, list only the
needed skill-relative paths under `vars.skill_files` and set
`options.disableVarExpansion: true`. The eval provider loads the root first and
then those files in declaration order. Focused tests ensure configured paths
resolve safely, the expansion guard is present, and quality `case_id` values are
unique.

Loading a file proves only that its content is available to the evaluation. A
claim that the content changes model behavior needs behavioral evidence, such as
an appropriate comparison, rather than loader or inventory accounting.

Live packet capture and node host mounts remain a pre-production operator gate.
`evals/tests/aks-network-capture/smoke-live-cluster.sh` exercises the live
create/retrieve pcap round trip. Deterministic tests retain the rendered
least-privilege manifest and argument-boundary security invariants without
claiming live integration.

CI fails if a skill has no tests or if the configured skill context is invalid.

## 6. Review checklist (human)

- [ ] Fits section 1 (deep AKS Day-2 / AKS-specific design); does not duplicate Azure Skills.
- [ ] Description has `WHEN:` + `DO NOT USE FOR:`; no collision with an existing skill or with Azure Skills.
- [ ] Durable content; coaching-lint warnings resolved or justified.
- [ ] Read-only guardrail present if the skill can mutate.
- [ ] Every shipped Markdown instruction and executable path was reviewed; shell command/script changes have no interactive stdin/TTY flags or shell `eval`, validate inputs, use digest-pinned MCR images, preserve debug/test pod approval gates, and remain shellcheck-clean where applicable.
- [ ] Tests exist and are wired; claimed behavior is supported by behavioral evidence; token budget respected.
- [ ] A named owner in `CODEOWNERS` approved.

## 7. What CI enforces automatically

- `evals/lint-skills.js` — front matter, `name == folder`, reference resolution, long-reference navigation, bundle-wide Markdown shell-command and recursively discovered shell-script safety, script shebang/executable checks, coverage gate, coaching-phrase warnings, and Azure MCP product/portability rules across README, docs, skills, and plugin manifests. Line endings are normalized before parsing; `evals/bundle-policy.test.js` covers the command/TOC parsers without external dependencies, and `evals/lint-skills.test.js` includes that suite while keeping CRLF (Windows) checkouts linting identically.
- `evals/skill-context.test.mjs` — ordered selective loading, path and symlink safety, configured path resolution, expansion guards, and unique case IDs.
- `evals/network-script-security.test.mjs` — rendered capture-manifest least privilege and traffic-generator argument boundaries.
- `.github/workflows/scripts.yml` — shellcheck, no `eval`, no unpinned/Docker Hub images, injection regression test (no secrets, so it runs on fork PRs too).
- `.github/workflows/skill-eval.yml` — routing + quality evals (requires Azure OpenAI secrets).
