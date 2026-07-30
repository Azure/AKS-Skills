# The AKS Skill Contract

Every skill in this repo must meet this contract. It is runtime-agnostic — a skill that satisfies it works across Claude Code, GitHub Copilot, Azure SRE Agent, openclaw, and other [Agent Skills](https://agentskills.io) hosts. CI enforces the mechanical parts; a human owner reviews the judgment parts.

The contract exists because **content decays and the contract compounds.** A skill's prose ages with each model release; the bar every contributing team meets is what makes this repo durable and makes AKS Skills the pattern other Azure teams follow.

## 1. What belongs here

**Accept:** deep, AKS-specific Day-2 operational knowledge and AKS-specific design opinions — symptom→cause maps, exact `az`/`kubectl` commands, error-code and condition maps, AKS quirks, and org conventions a frontier model cannot infer.

**Reject:** generic Azure provisioning (belongs in Azure Skills), generic Kubernetes any capable model already knows, and cross-resource workflows. When a skill overlaps Azure Skills, it must delegate or draw an explicit boundary (see [skills-vs-azure-skills.md](skills-vs-azure-skills.md)).

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

- **`description`** carries the routing surface. It must include `WHEN:` triggers **and** a `DO NOT USE FOR:` boundary that names the sibling skill to use instead (the parenthetical-redirect grammar). No two skills may share a description or have one subsume another.
- **Budget:** `SKILL.md` ≤ 500 tokens, `references/**/*.md` ≤ 1000 tokens (host description budgets truncate long skills). Offload depth to `references/`.
- **Runtime hints are additive, never conflicting:** `metadata.openclaw.requires.anyBins` (openclaw gating, harmless elsewhere); the repo-root `plugin.json` + `.mcp.json` for SRE Agent / marketplace install.

## 3. Content rules

- **Durability.** A sentence that prescribes *how to think, write, or generally behave* — with no AKS/Azure/Kubernetes token, no tool/resource identifier, and no safety verb — is decaying coaching; drop it. Instructions that encode an **org policy**, a **tool contract**, or a **safety boundary** the model cannot infer are durable; keep them. (The coaching-phrase lint flags candidates as a warning; a human decides.)
- **Read-only by default.** Any skill that can mutate a cluster MUST state the read-only guardrail: *do not restart, delete, cordon, drain, scale, upgrade, or reconfigure unless the user explicitly asks.*
- **No host coupling in the body.** No "OpenClaw UI will render…", no `/home/<user>/...` paths, no host-specific assumptions.

## 4. Script rules

- Executable bit set; **shellcheck-clean** at warning level; POSIX where practical.
- **No `eval`.** No unquoted interpolation of user input into a command or a privileged manifest.
- Every input that reaches a privileged pod is validated/allowlisted; filters are passed as argv/env, never as shell strings.
- Container images are **MCR-hosted and digest-pinned**. No Docker Hub `:latest`.
- No interactive flags (`-it`) in agent-run paths.

## 5. Required tests

Per skill:
- **Routing tests** (`evals/tests/<skill>/trigger-tests.yaml`) — should / should-not trigger prompts, run against the full router pool.
- **Quality tests** (`evals/tests/<skill>/quality-tests.yaml`) — at least one, wired into `evals/promptfooconfig.yaml`.
- Any script change ships a regression test (e.g. the packet-capture injection test).

CI fails if a skill has no tests (the coverage gate).

## 6. Review checklist (human)

- [ ] Fits section 1 (deep AKS Day-2 / AKS-specific design); does not duplicate Azure Skills.
- [ ] Description has `WHEN:` + `DO NOT USE FOR:`; no collision with an existing skill or with Azure Skills.
- [ ] Durable content; coaching-lint warnings resolved or justified.
- [ ] Read-only guardrail present if the skill can mutate.
- [ ] Any `scripts/` change had a security review (no `eval`, validated inputs, pinned images, shellcheck-clean).
- [ ] Tests exist and are wired; token budget respected.
- [ ] A named owner in `CODEOWNERS` approved.

## 7. What CI enforces automatically

- `evals/lint-skills.js` — front matter, `name == folder`, reference resolution, coverage gate, coaching-phrase warnings.
- `.github/workflows/scripts.yml` — shellcheck, no `eval`, no unpinned/Docker Hub images, injection regression test (no secrets, so it runs on fork PRs too).
- `.github/workflows/skill-eval.yml` — routing + quality evals (requires Azure OpenAI secrets).
