# autogen — candidate eval generator

Machine-drafts promptfoo quality + trigger tests for a skill from its `SKILL.md`
and `references/*` (Markdown + YAML), so eval coverage scales as skills grow. Output is a set of
**candidates for human review** (tagged `provenance: autogen`), never an auto-merge.

This is a portable, vendored copy of the generator developed in the private
`aks-skills-eval-lab`. It lives here so any maintainer can run it without that
lab or the author's environment. **Zero npm dependencies** — Node built-ins only.

## Files

| File | Role |
|------|------|
| `scaffold-eval.mjs` | Step 1. Bundles the skill (`skill-context.mjs`) and asks the model to propose quality test cases + routing/trigger cases. Writes `candidates.json`. |
| `baseline-gate.mjs` | Step 2. For each candidate, scores the prompt **with** vs **without** the skill (using **SKILL.md only**, matching `evals/providers/skill-provider.js`); runs the answer pair and judge pair concurrently; keeps only tests the skill flips fail→pass, auto-calibrates a g-eval threshold, and renders the YAML + a wiring snippet. |
| `skill-context.mjs` | Bundles `SKILL.md` + sibling `references/*.md` and `*.yaml` under a character budget (cost guard) so the **generation** step is grounded in the whole skill. |
| `prompts/quality.md` | Prompt for proposing behavior (quality) tests. |
| `prompts/trigger.md` | Prompt for routing positives + reciprocal boundary near-misses (expected route pulled from the skill's DO-NOT-USE-FOR section). |
| `lib/llm.mjs` | Minimal Azure OpenAI / OpenAI chat client. Credentials come from env at runtime. |

## Pipeline

```
scaffold-eval.mjs  →  <skill>.candidates.json  →  baseline-gate.mjs  →  *.autogen.yaml (+ wiring.md)
```

## Credentials (runtime env)

| Variable | Notes |
|----------|-------|
| `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` | Azure OpenAI (preferred) |
| `OPENAI_API_KEY` | OpenAI direct fallback |
| `AZURE_OPENAI_API_VERSION` | Optional (default `2024-12-01-preview`) |
| `EVAL_MODEL` | Optional deployment/model name (default `gpt-5`) |

The `--dry-run` flag on both scripts skips all model calls and emits fixed samples —
use it to test wiring/plumbing without LLM spend.

See the parent [evals/README.md](../README.md#autogen--draft-eval-coverage-from-a-skillmd)
for the maintainer workflow and end-to-end usage.
