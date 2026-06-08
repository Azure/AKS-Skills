# Skill Evaluations

Automated quality checks for AKS skills. Runs on every PR that touches `skills/` or `evals/`.

## What it does

- **Lint** — validates SKILL.md formatting (front matter, required fields, script shebangs, internal references). No API key needed.
- **Eval** — sends test prompts to an LLM with the skill loaded as context, then checks the response against assertions. Catches regressions in skill quality.

## Quick start

```bash
cd evals
npm ci

# Lint only (instant, no API key)
npm run lint

# Full eval (requires LLM credentials)
export AZURE_OPENAI_API_KEY="your-key"
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"
npm run eval
```

To view results in a browser after running eval:

```bash
npm run eval:view
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_OPENAI_API_KEY` | Yes* | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Yes* | Full endpoint URL (e.g. `https://my-resource.openai.azure.com`) — base URL only, no path suffix |
| `OPENAI_API_KEY` | Fallback | Used if Azure vars are not set |
| `EVAL_MODEL` | No | Model/deployment name (default: `gpt-5`). Set if your deployment is named differently. |

*Either Azure OpenAI or OpenAI credentials must be provided.

## Adding eval coverage for a new skill

1. Create a folder: `evals/tests/<your-skill-name>/`
2. Add test files following this format:

```yaml
# trigger-tests.yaml — does the skill respond to the right scenarios?
- description: "Short description of what this tests"
  vars:
    skill_path: "providers/azure/<your-skill-name>/SKILL.md"
    prompt: "The user question to test"
  assert:
    - type: icontains
      value: "keyword the response should contain"

# quality-tests.yaml — is the response actually good?
- description: "Validates response depth for scenario X"
  vars:
    skill_path: "providers/azure/<your-skill-name>/SKILL.md"
    prompt: "A detailed user scenario"
  assert:
    - type: g-eval
      value: "Description of what a good response looks like"
      threshold: 0.7
```

3. Add your test file paths to `promptfooconfig.yaml` under `tests:`:

```yaml
tests:
  - file://tests/<your-skill-name>/trigger-tests.yaml
  - file://tests/<your-skill-name>/quality-tests.yaml
```

## Assertion types

| Type | What it does | Cost |
|------|--------------|------|
| `icontains` | Checks if the response contains a keyword (case-insensitive) | Free |
| `not-icontains` | Checks the response does NOT contain a keyword | Free |
| `g-eval` | Chain-of-thought LLM judge that scores output 0–1 against criteria (pass if ≥ threshold) | 1 LLM call per assertion |
| `llm-rubric` | Binary pass/fail LLM judge against your criteria | 1 LLM call per assertion |

## Baseline comparison

To measure how much value a skill adds over the base model, run the baseline config after the default eval:

```bash
npx promptfoo eval                              # 13 tests with skill (default)
npx promptfoo eval -c promptfoo-baseline.yaml   # quality tests without skill
npx promptfoo view                              # compare scores side-by-side
```

This runs quality tests against a bare model (no SKILL.md loaded). Compare g-eval scores against the skill-loaded results from the default eval to quantify skill value. The baseline is not a pass/fail gate — it's a reporting metric.

## CI/CD

The GitHub Actions workflow (`.github/workflows/skill-eval.yml`) runs automatically on PRs:

1. **Lint** — fast-fails if SKILL.md format is invalid
2. **Eval** — runs all test assertions against the LLM (gates on skill provider only)
3. **Baseline comparison** — runs quality tests with/without skill, reports score delta
4. **PR comment** — posts results table and baseline delta on the pull request

## Running evals for a specific skill

```bash
npx promptfoo eval --filter-metadata skill=aks-sre
npx promptfoo eval --filter-metadata skill=network-troubleshoot
```

Each test case has a `metadata.skill` tag matching its skill name.
