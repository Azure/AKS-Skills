# Skill Evaluations

Automated quality and routing checks for AKS skills. Runs on every PR that touches `skills/` or `evals/`.

## What it does

- **Lint** — validates SKILL.md formatting (front matter, required fields, script shebangs, internal references). No API key needed.
- **Quality eval** — sends test prompts to the model with the skill loaded, then grades the response with `icontains` and `g-eval` assertions.
- **Trigger eval** — asks the model which skill should handle a query (router-provider), asserts with deterministic `equals`.
- **Baseline** — runs quality tests without the skill loaded to measure skill value-add (reporting only, not a gate).

## Quick start

```bash
cd evals
npm ci

# Lint only (instant, no API key)
npm run lint

# Requires LLM credentials — Microsoft Foundry
export FOUNDRY_ENDPOINT="https://your-resource.services.ai.azure.com"
export FOUNDRY_ACCESS_TOKEN="$(az account get-access-token \
  --resource https://cognitiveservices.azure.com --query accessToken -o tsv)"
export EVAL_MODEL="your-deployment-name"

npm run eval              # quality tests → results.json
npm run eval:trigger      # trigger/routing tests → routing-results.json
npm run eval:baseline     # baseline comparison → baseline-results.json
npm run eval:all          # quality + trigger
npm run eval:view         # open results in browser
```

## Environment variables

Pick one backend. Foundry is what CI runs against.

| Variable | Backend | Description |
|----------|---------|-------------|
| `FOUNDRY_ENDPOINT` | foundry | `https://<resource>.services.ai.azure.com` |
| `FOUNDRY_ACCESS_TOKEN` | foundry | Entra bearer token. Preferred, and required for deployments that don't accept keys. |
| `FOUNDRY_API_KEY` | foundry | Key auth, where the deployment allows it. |
| `AZURE_OPENAI_API_KEY` | azure | Azure OpenAI key |
| `AZURE_OPENAI_ENDPOINT` | azure | Base URL only, no path suffix |
| `GITHUB_MODELS_TOKEN` | github | **Local development only** — see below |
| `EVAL_PROVIDER` | any | `foundry` \| `azure` \| `github`. Auto-detected if unset. |
| `EVAL_MODEL` | any | Deployment name (foundry/azure) or model id (github) |
| `EVAL_PROTOCOL` | foundry | `openai` (default) or `anthropic` for Claude deployments |
| `EVAL_REQUIRE_FOUNDRY` | any | Set to `1` in CI to reject non-Foundry backends |

### Why two protocols

Foundry fronts several model families from one resource, but it brokers them at
the billing and governance layer, not the protocol layer. OpenAI-family
deployments speak `chat/completions`; Claude deployments speak the Anthropic
Messages API. Set `EVAL_PROTOCOL=anthropic` when scoring against a Claude
deployment.

### Why GitHub Models is local-only

It needs no resource and works with a token contributors already have, which
makes it good for iterating. But it is a different model pool from the one CI
gates on, so its numbers are not comparable to CI numbers and should not be
quoted in a decision. `EVAL_REQUIRE_FOUNDRY=1` makes that a hard failure in CI
rather than a convention. It is also excluded from auto-detection unless
`GITHUB_MODELS_TOKEN` is set explicitly — Actions injects `GITHUB_TOKEN` into
every job, so auto-detecting on it would silently reroute CI to a different
model if a Foundry secret expired, and the run would still look green.

## Adding eval coverage for a new skill

1. Create a folder: `evals/tests/<your-skill-name>/`
2. Add test files following this format:

```yaml
# trigger-tests.yaml — does the router select the right skill?
# Auto-discovered by promptfoo-routing.yaml via glob.
- description: "Query X should trigger my-skill"
  metadata:
    skill: <your-skill-name>
    type: trigger
  vars:
    prompt: "The user question to test"
  assert:
    - type: equals
      value: "<your-skill-name>"

# quality-tests.yaml — is the response actually good?
# Must be added to promptfooconfig.yaml tests list.
- description: "Validates response depth for scenario X"
  metadata:
    skill: <your-skill-name>
    type: quality
  vars:
    skill_path: "providers/azure/<your-skill-name>/SKILL.md"
    prompt: "A detailed user scenario"
  assert:
    - type: g-eval
      value: "Description of what a good response looks like"
      threshold: 0.9
```

3. Add quality tests to `promptfooconfig.yaml` under `tests:`. Trigger tests are auto-discovered via glob (`file://tests/*/trigger-tests.yaml`).

## Configs

| Config | What it tests | Provider | Assertions | Gate |
|--------|---------------|----------|------------|------|
| `promptfooconfig.yaml` | Quality — response depth/accuracy | skill-provider (loads SKILL.md) | `icontains`, `g-eval` | Yes (with retry) |
| `promptfoo-routing.yaml` | Trigger — skill selection | router-provider (presents all skills) | `equals` | Yes |
| `promptfoo-baseline.yaml` | Baseline — model without skill | baseline-provider (no SKILL.md) | `g-eval` | No (report only) |

## Assertion types

| Type | What it does | Cost |
|------|--------------|------|
| `icontains` | Checks if the response contains a keyword (case-insensitive) | Free |
| `not-icontains` | Checks the response does NOT contain a keyword | Free |
| `equals` | Exact string match (used in trigger tests) | Free |
| `g-eval` | LLM judge that scores output 0–1 against criteria (pass if ≥ threshold) | 1 LLM call |

## Baseline comparison

```bash
npm run eval              # quality tests with skill
npm run eval:baseline     # same tests without skill
npm run eval:view         # compare scores side-by-side
```

Compare g-eval scores between skill-loaded and baseline to quantify skill value. The baseline is not a pass/fail gate — it's a reporting metric.

## CI/CD

The GitHub Actions workflow (`.github/workflows/skill-eval.yml`) runs automatically on PRs:

1. **Lint** — fast-fails if SKILL.md format is invalid
2. **Quality eval** — runs quality tests with skill loaded (gates, retries failing tests up to 2x)
3. **Trigger eval** — runs routing tests via router-provider (gates)
4. **Baseline comparison** — quality tests without skill, reports score delta
5. **PR comment** — posts results table with g-eval scores and baseline delta

## Filtering evals

Filter by skill or test type using `--filter-metadata`:

```bash
# Quality tests for one skill
npm run eval -- --filter-metadata skill=aks-sre

# Trigger tests for one skill
npm run eval:trigger -- --filter-metadata skill=network-troubleshoot

# Single test by description pattern
npm run eval -- --filter-pattern "CrashLoopBackOff"
npm run eval:trigger -- --filter-pattern "Egress"
```
