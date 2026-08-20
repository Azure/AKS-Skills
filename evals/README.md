# Skill Evaluations

Automated quality and routing checks for AKS skills. Runs on every PR that touches `skills/` or `evals/`.

## What it does

- **Lint** — validates SKILL.md formatting (front matter, required fields, script shebangs, internal references). No API key needed.
- **Quality eval** — sends test prompts to the model with the skill loaded, then grades the response with `icontains` and `g-eval` assertions.
- **Trigger eval** — asks the model which skill should handle a query (router-provider), asserts with deterministic `equals`.
- **Baseline** — runs quality tests without the skill loaded to measure skill value-add (reporting only, not a gate).
- **Agentic eval** — runs the real GitHub Copilot agent against scenario prompts with the skill available, and grades the trajectory. Two tiers:
  - `tier: smoke` — fast routing gate: did the agent invoke the right skill (`skill-invocation`) and finish without crashing (`output-not-matches`). No cluster, cheap.
  - `tier: mock` — full investigation against a **fake-broken cluster**: `az`/`kubectl` are intercepted by shims that return canned fixtures, so the agent investigates a real fault with no live Azure resources. Grades the actual trajectory — required vs. disallowed tool calls (`tool-calls`), call budget (`tool-call-count`), and root-cause correctness via an LLM judge (`prompt` rubric).

  Uses the GitHub Copilot CLI, not Azure OpenAI.

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
npm install -g @github/copilot   # one-time, cross-platform (macOS/Linux/Windows)
# macOS alternative: brew install copilot-cli
copilot                          # launch the CLI, then run /login inside it for one-time auth

npm run lint:agentic                                                          # validate all eval.yaml specs (instant, no auth)
npm run eval:agentic -- --eval-spec tests/aks-troubleshooting/eval.yaml --tag tier=smoke  # one skill, routing tier only
npm run eval:agentic -- --eval-spec tests/aks-troubleshooting/eval.yaml                   # one skill, all tiers
npm run eval:mock                                                             # all mock-tier investigations (all skills)
```

Pass the skill's spec path with `--eval-spec`; add `--tag tier=smoke` for the fast routing checks, or use `npm run eval:mock` for the full fake-broken-cluster investigations.

> **Windows:** `npm run eval:mock` uses a POSIX `PATH=...` prefix to inject the shell shims, so run it from **WSL** (or macOS/Linux). The other commands work on native Windows.

#### Mock investigations (no cluster)

The mock tier proves the agent can *investigate*, not just route — without any live Azure resources. It works by intercepting the agent's shell calls:

- `evals/mocks/bin/{az,kubectl}` are shims placed first on `PATH` (the `eval:mock` script prepends `$PWD/mocks/bin`). They forward to `evals/mocks/lib/dispatch.mjs`.
- The dispatcher reads `.mocks/responses.json` from the scenario's working dir, matches the full command line against an ordered regex table, and returns the canned `stdout`/`stderr`/`exit`. Unmatched commands return empty with exit 0 — so the agent *can* wander, and that wandering stays visible in the trajectory.
- Each scenario lives at `evals/scenarios/<skill>/<fault>/responses.json` and is mounted into the run via the stimulus's `environment.files` (`dest: .mocks/responses.json`). Fixtures encode one real fault plus healthy *distractors* so the agent must reach the true root cause instead of stopping at the first red herring.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EVAL_PROVIDER` | No | Explicit backend override: `foundry` \| `azure` \| `openai` \| `github`. Takes precedence over every auto-detection rule below, including `OPENAI_BASE_URL`. Auto-detected if unset. |
| `AZURE_OPENAI_API_KEY` | Yes* | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Yes* | Full endpoint URL (e.g. `https://my-resource.openai.azure.com`) — base URL only, no path suffix |
| `OPENAI_API_KEY` | Fallback | Used if Azure vars are not set. Optional when `OPENAI_BASE_URL` points at a keyless self-hosted server. |
| `OPENAI_BASE_URL` | No | Point the `openai` backend at any OpenAI-compatible endpoint instead of `api.openai.com` — a self-hosted or local model server (llama.cpp / vLLM / Ollama) or a gateway. Default: `https://api.openai.com/v1`. Setting this is treated as explicit local/OpenAI-compatible intent during auto-detection: it selects the `openai` backend even if Azure credentials also happen to be present in the environment. |
| `EVAL_MODEL` | No | Model/deployment name (default: `gpt-5` for `azure`/`api.openai.com`). Set this for a custom `OPENAI_BASE_URL` server such as vLLM that requires a `model` field in the request body — servers that infer the model from what they have loaded (e.g. some llama.cpp/Ollama setups) can omit it. |

*Either Azure OpenAI or OpenAI credentials must be provided, unless `EVAL_PROVIDER=openai` with `OPENAI_BASE_URL` set to a keyless endpoint.

### Evaluating a local or self-hosted model

To measure how well the skills perform on a non-frontier, local, or disconnected model, point the `openai` backend at any OpenAI-compatible server — no Azure or OpenAI credentials needed. Setting `OPENAI_BASE_URL` is enough for auto-detection to pick the `openai` backend (it wins over ambient Azure credentials); set `EVAL_PROVIDER=openai` too if you want that choice to be explicit and provider-independent regardless of what else is configured in the shell:

```bash
# e.g. a local llama.cpp / vLLM / Ollama server exposing /v1/chat/completions
export OPENAI_BASE_URL="http://localhost:8080/v1"
export EVAL_MODEL="my-local-model"      # set for servers (e.g. vLLM) that require a model field
# OPENAI_API_KEY is optional for a keyless local server

npm run eval            # quality
npm run eval:trigger    # routing
```

Local runs are a development signal, not a CI gate — like the GitHub Models backend, results aren't directly comparable to the frontier CI pool.

The judge and the model under test share one endpoint per run today, so a local run is graded by a model on that same endpoint. Grading a small local model with a separate frontier judge in a single run (a cross-endpoint model-tier matrix) is a natural next step, not yet wired.

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
    skill_path: "<your-skill-name>/SKILL.md"
    prompt: "A detailed user scenario"
  assert:
    - type: g-eval
      value: "Description of what a good response looks like"
      threshold: 0.9
```

3. Add quality tests to `promptfooconfig.yaml` under `tests:`. Trigger tests are auto-discovered via glob (`file://tests/*/trigger-tests.yaml`).
4. (Optional) Add an agentic spec at `evals/tests/<your-skill-name>/eval.yaml`. It is auto-discovered — no config edits. Point `environment.skills` at the skill and follow the routing (`tier: smoke`) + investigation (`tier: mock`) shape used by the existing specs:

```yaml
# eval.yaml — does the agent invoke the skill and respond well?
name: <your-skill-name>-agentic-eval
environment:
  skills:
    - ../../../skills/<your-skill-name>
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

For a `tier: mock` investigation, also add a fixture at `evals/scenarios/<your-skill-name>/<fault>/responses.json` (an ordered list of `{ match, stdout, stderr, exit }` regex entries — one real fault plus healthy distractors), mount it via the stimulus `environment.files` (`dest: .mocks/responses.json`), and grade the trajectory with `tool-calls` (required + disallowed), `tool-call-count`, and a `prompt` rubric. See `tests/aks-troubleshooting/eval.yaml` for a complete example.

## Autogen — draft eval coverage from a SKILL.md

`evals/autogen/` can propose the quality + trigger tests above instead of hand-writing them. It reads a skill's **full authoring context** (SKILL.md *and* its `references/*.md`), asks the model to propose behavior tests and routing cases, then filters them through a bare-model **baseline gate** — keeping only tests the skill's presence actually flips from fail→pass (no tautological tests any vague answer would satisfy). Output matches the golden shape above, tagged `provenance: autogen`.

**It produces *candidates for review*, not truth.** A maintainer vets them, merges with any hand-written cases, and wires them in. Generated files use an `.autogen.yaml` suffix so they never clobber curated tests.

### Maintainer toggle (recommended)

Run the **Autogen Evals** workflow from the Actions tab (`workflow_dispatch`), passing a skill directory name (e.g. `aks-known-issues`). It generates candidates and publishes them as a downloadable **artifact** (`autogen-<skill>-<run_id>`, on the run page) containing:

- `quality-tests.autogen.yaml` — behavior tests kept by the gate
- `trigger-tests.autogen.yaml` — routing positives + reciprocal boundary near-misses
- `autogen-wiring.md` — the promptfoo wiring lines to add once vetted
- `gate-report.json` — per-candidate keep/drop decisions, scores, and margins

The workflow only **reads** the repo (`contents: read`) — it never writes or opens a PR. Download the artifact, review it, drop the YAML into `evals/tests/<skill>/`, rename the `.autogen.yaml` files to the curated `quality-tests.yaml` / `trigger-tests.yaml` (merging with any hand-written cases), apply the wiring, and open the PR yourself.

The gate makes real LLM calls per candidate, so this is **opt-in and manual by design** — it is not a background watcher. It reuses the same `AZURE_OPENAI_*` secrets as `skill-eval.yml`. Set `dry_run: true` to exercise the pipeline with no LLM spend (emits fixed samples).

### Local run

```bash
cd evals/autogen                        # zero npm deps — node built-ins only
export AZURE_OPENAI_API_KEY="your-key"
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"

# 1. Propose candidates from the skill bundle
node scaffold-eval.mjs \
  --skill ../../skills/<skill>/SKILL.md \
  --skill-path <skill>/SKILL.md --system <skill> \
  --out /tmp/<skill>.candidates.json          # add --dry-run for a no-LLM smoke test

# 2. Gate + render the candidate YAML (+ wiring)
node baseline-gate.mjs \
  --candidates /tmp/<skill>.candidates.json \
  --skill ../../skills/<skill>/SKILL.md \
  --out ../tests/<skill>/quality-tests.autogen.yaml \
  --trigger-out ../tests/<skill>/trigger-tests.autogen.yaml \
  --wiring-out ../tests/<skill>/autogen-wiring.md
```

Then review, rename the `.autogen.yaml` files into the curated `quality-tests.yaml` / `trigger-tests.yaml`, and apply the wiring. The generator is a portable copy of the private `aks-skills-eval-lab` tooling — see `evals/autogen/README.md` for internals.

## Configs

| Config | What it tests | Provider | Assertions | Gate |
|--------|---------------|----------|------------|------|
| `promptfooconfig.yaml` | Quality — response depth/accuracy | skill-provider (loads SKILL.md) | `icontains`, `g-eval` | No (advisory — retries 2x, reports only) |
| `promptfoo-routing.yaml` | Trigger — skill selection | router-provider (presents all skills) | `equals` | No (advisory — reports only) |
| `promptfoo-baseline.yaml` | Baseline — model without skill | baseline-provider (no SKILL.md) | `g-eval` | No (report only) |
| `tests/<skill>/eval.yaml` | Agentic — real agent routes to skill (smoke) + investigates a fake-broken cluster (mock) | Vally `copilot-sdk` executor | `skill-invocation`, `tool-calls`, `tool-call-count`, `prompt`, `output-matches` | No (run manually) |

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

## holmesgpt-eval (internal harness — not a registered skill)

`evals/holmesgpt-eval/` benchmarks the current agent against the public eval fixtures from [HolmesGPT](https://github.com/HolmesGPT/holmesgpt). It uses the SKILL.md format because the harness instructions are consumed by the agent at eval time — but it is **not part of the skill inventory**: `plugin.json` registers skills from `./skills/` only, the router never presents it, and `lint-skills.js` does not walk it. Any SKILL.md outside `skills/` is an internal fixture, per the [skill contract](../docs/skill-contract.md). (The files do still travel in the plugin payload — the marketplace packages the repo root — which is one more reason the fixture fetch below is pinned.)

`holmesgpt-eval/scripts/fetch_fixtures.sh` fetches the fixtures pinned to an upstream commit. The pin is a supply-chain control, not just reproducibility: fixture cases contain `before_test`/`after_test` shell blocks that the harness executes. To move the pin, review the upstream diff and update `REF` in the script.

## CI/CD

The GitHub Actions workflow (`.github/workflows/skill-eval.yml`) runs automatically on PRs:

1. **Lint** — fast-fails if SKILL.md format is invalid (a hard gate, alongside shellcheck and the injection test)
2. **Quality eval** — runs quality tests with skill loaded (advisory — retries failing tests up to 2x, reports but does not block merge)
3. **Trigger eval** — runs routing tests via router-provider (advisory — reports but does not block merge)
4. **Baseline comparison** — quality tests without skill, reports score delta
5. **PR comment** — posts results table with g-eval scores and baseline delta

## Filtering evals

Filter by skill or test type using `--filter-metadata`:

```bash
# Quality tests for one skill
npm run eval -- --filter-metadata skill=aks-troubleshooting

# Trigger tests for one skill
npm run eval:trigger -- --filter-metadata skill=aks-network-capture

# Single test by description pattern
npm run eval -- --filter-pattern "CrashLoopBackOff"
npm run eval:trigger -- --filter-pattern "Egress"
```

Manual `Skill Evaluation` workflow runs apply the `skill` input to the quality,
routing, baseline, and retry passes. Pull-request runs continue to evaluate every
skill.
