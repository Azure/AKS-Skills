# Skill Evaluations

Automated quality and routing checks for AKS skills. Runs on every PR that touches `skills/` or `evals/`.

## What it does

- **Lint** — validates SKILL.md formatting (front matter, required fields, script shebangs, internal references). No API key needed.
- **Quality eval** — sends test prompts to the model with the skill loaded, then grades the response with `icontains` and `g-eval` assertions.
- **Trigger eval** — asks the model which skill should handle a query (router-provider), asserts with deterministic `equals`.
- **Baseline** — runs quality tests without the skill loaded to measure skill value-add (reporting only, not a gate).
- **Agentic eval** — runs the real GitHub Copilot agent against scenario prompts with the skill available, and grades the trajectory: did it invoke the right skill (`skill-invocation`), did the output match/avoid expected patterns (`output-matches` / `output-not-matches`), did it finish cleanly (`completed`). Uses the GitHub Copilot CLI, not Azure OpenAI.

## Quick start

```bash
cd evals
npm ci

# Lint only (instant, no API key)
npm run lint

# Requires LLM credentials
export AZURE_OPENAI_API_KEY="your-key"
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"

npm run eval              # quality tests → results.json
npm run eval:trigger      # trigger/routing tests → routing-results.json
npm run eval:baseline     # baseline comparison → baseline-results.json
npm run eval:all          # quality + trigger
npm run eval:view         # open results in browser
```

### Agentic evals

Run the real Copilot agent against a skill's scenarios. Requires the GitHub Copilot CLI (not the Azure vars above):

```bash
brew install copilot-cli   # one-time
copilot /login             # one-time auth

npm run lint:agentic                                                          # validate all eval.yaml specs (instant, no auth)
npm run eval:agentic -- --eval-spec tests/aks-sre/eval.yaml --tag tier=smoke  # one skill, routing tier
npm run eval:agentic -- --eval-spec tests/aks-sre/eval.yaml                   # one skill, all stimuli
```

Pass the skill's spec path with `--eval-spec`; add `--tag tier=smoke` to run only the fast routing checks.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_OPENAI_API_KEY` | Yes* | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Yes* | Full endpoint URL (e.g. `https://my-resource.openai.azure.com`) — base URL only, no path suffix |
| `OPENAI_API_KEY` | Fallback | Used if Azure vars are not set |
| `EVAL_MODEL` | No | Model/deployment name (default: `gpt-5`). Set if your deployment is named differently. |

*Either Azure OpenAI or OpenAI credentials must be provided.

Agentic evals don't use these variables — they authenticate via the GitHub Copilot CLI (`copilot /login`).

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
4. (Optional) Add an agentic spec at `evals/tests/<your-skill-name>/eval.yaml`. It is auto-discovered — no config edits. Point `environment.skills` at the skill and follow the routing (`tier: smoke`) + output (`tier: full`) shape used by the existing specs:

```yaml
# eval.yaml — does the agent invoke the skill and respond well?
name: <your-skill-name>-agentic-eval
environment:
  skills:
    - ../../../skills/providers/azure/<your-skill-name>
defaults:
  runs: 1
  timeout: "5m"
  executor: copilot-sdk
  model: claude-sonnet-4.6
scoring:
  threshold: 0.8
stimuli:
  - name: "Routing: <scenario>"
    prompt: "A user question that should route to this skill"
    tags: { tier: smoke, area: routing }
    graders:
      - type: skill-invocation
        config: { required: [<your-skill-name>] }
    constraints:
      expect_skills: [<your-skill-name>]
```

## Configs

| Config | What it tests | Provider | Assertions | Gate |
|--------|---------------|----------|------------|------|
| `promptfooconfig.yaml` | Quality — response depth/accuracy | skill-provider (loads SKILL.md) | `icontains`, `g-eval` | Yes (with retry) |
| `promptfoo-routing.yaml` | Trigger — skill selection | router-provider (presents all skills) | `equals` | Yes |
| `promptfoo-baseline.yaml` | Baseline — model without skill | baseline-provider (no SKILL.md) | `g-eval` | No (report only) |
| `tests/<skill>/eval.yaml` | Agentic — real agent invokes skill + output quality | Vally `copilot-sdk` executor | `skill-invocation`, `output-matches`, `output-not-matches`, `completed` | No (run manually) |

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
