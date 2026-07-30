# Contributing to AKS Skills

Thanks for helping AKS customers operate their clusters. This repo is public and Microsoft-branded, so contributions meet a defined bar: the **[Skill Contract](docs/skill-contract.md)**. Read it first — it defines what belongs here, the manifest and content rules, and what CI enforces.

## Before you open a PR

1. **Check the scope.** AKS Skills accepts deep, AKS-specific Day-2 operational knowledge and AKS-specific design opinions. Generic Azure provisioning, generic Kubernetes, and cross-resource workflows belong in [Azure Skills](https://github.com/microsoft/azure-skills), not here. If your change overlaps Azure Skills, it must delegate or draw an explicit boundary (see [docs/skills-vs-azure-skills.md](docs/skills-vs-azure-skills.md)).
2. **Open an issue first** for a new skill or a boundary change, so an owner can confirm scope before you invest.

## Adding or changing a skill

- Put it at `skills/<skill-id>/SKILL.md` (`name` must equal the folder). Follow the front-matter and content rules in the Contract.
- Add `evals/tests/<skill-id>/trigger-tests.yaml` and `quality-tests.yaml`, and wire the quality tests into `evals/promptfooconfig.yaml`. CI fails a skill with no tests.
- Keep `SKILL.md` under the token budget; put depth in `references/`.

## Scripts

Scripts get extra scrutiny because they run against customer clusters:

- No `eval`; validate/allowlist all inputs; pass user data as argv/env, never shell strings.
- Digest-pinned MCR images only; no Docker Hub `:latest`; no interactive flags in agent-run paths.
- Must be shellcheck-clean (warning level) and carry the executable bit.
- Ship a regression test for the behavior you're securing.

## Running the checks locally

```bash
cd evals && npm ci
node lint-skills.js                                 # front matter, coverage, coaching lint
find ../skills -name '*.sh' -exec shellcheck -S warning {} +
bash tests/aks-network-capture/injection.test.sh    # script security regression
npm run eval && npm run eval:trigger                 # quality + routing (needs Azure OpenAI env)
```

The quality/routing evals need `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`. Fork PRs run the secret-free gates (lint, shellcheck, injection test) automatically; a maintainer runs the LLM evals.

## Commit and review

- One focused change per PR. Every PR touching a `SKILL.md`, `references/`, or `scripts/` gets a human owner's review (see [CODEOWNERS](CODEOWNERS)).
- By contributing you agree to the [Microsoft CLA](https://cla.opensource.microsoft.com) and the project [Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
