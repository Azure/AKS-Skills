# Skill Evaluations

Deterministic validation and advisory model-backed evidence for AKS skills. Every PR gets the secret-free contracts; model-backed matrix cells run only after the protected trust boundary described below. Matrix evidence remains advisory until it is calibrated. The separate manual Autogen workflow produces non-authoritative candidates for review.

## What it does

- **Lint** — validates SKILL.md formatting (front matter, required fields, script shebangs, internal references). No API key needed.
- **Quality eval** — after explicit trust approval, sends test prompts through each deployable matrix generator with the root skill plus only the deep files declared by that case, then grades with deterministic assertions and that cell's distinct judge. A failed case fails that visible cell but does not gate the advisory summary.
- **Trigger eval** — after the same boundary, asks each deployable generator which skill should handle a query and asserts with deterministic `equals`. A failed case remains attributable to its cell while the other cells continue.
- **Baseline** — runs quality tests without the skill loaded to measure skill value-add (reporting only, not a gate).
- **Agentic eval** — runs the real GitHub Copilot agent against scenario prompts with the full AKS skill pool available, and grades the trajectory. Two tiers:
  - `tier: smoke` — competitive routing check: did the agent invoke the required skill, avoid the colliding skill (`skill-invocation`), and finish without crashing (`output-not-matches`)? No cluster.
  - `tier: mock` — investigation against a **canned cluster substrate**: `az`/`kubectl` are intercepted by shims that return fixtures, so the eval can grade required/disallowed tool calls and root-cause reasoning without live Azure resources. It proves trajectory behavior against those fixtures, not live AKS success.

  Uses the GitHub Copilot CLI, not Azure OpenAI. Agentic specs omit eval-level score thresholds so every configured grader must pass; a hard trajectory violation produces a non-zero process exit.

## Quick start

```bash
cd evals
npm ci

# Lint only (instant, no API key)
npm run lint

# Focused deterministic skill-context and network-script security checks
npm run test:deep-content

# Requires one supported model backend; Azure OpenAI example:
export AZURE_OPENAI_API_KEY="your-key"
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"
# Optional: pin a separate judge deployment. Otherwise the judge uses EVAL_MODEL.
export EVAL_JUDGE_MODEL="judge-deployment"

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
npm run eval:agentic -- --eval-spec tests/aks-troubleshooting/eval.yaml --tag tier=smoke  # one spec, routing tier only
npm run eval:agentic -- --eval-spec tests/aks-troubleshooting/eval.yaml                   # one spec, all tiers
npm run eval:mock                                                             # all mock-tier investigations (all skills)
```

Pass the skill's spec path with `--eval-spec`; add `--tag tier=smoke` for the fast routing checks, or use `npm run eval:mock` for the full fake-broken-cluster investigations.

> **Windows:** `npm run eval:mock` uses a POSIX `PATH=...` prefix to inject the shell shims, so run it from **WSL** (or macOS/Linux). The other commands work on native Windows.

#### Mock investigations (no cluster)

The mock tier proves the agent can *investigate*, not just route — without any live Azure resources. It works by intercepting the agent's shell calls:

- `evals/mocks/bin/{az,kubectl}` are shims placed first on `PATH` (the `eval:mock` script prepends `$PWD/mocks/bin`). They forward to `evals/mocks/lib/dispatch.mjs`.
- The dispatcher reads `.mocks/responses.json` from the scenario's working dir, matches the full command line against an ordered regex table, and returns the canned `stdout`/`stderr`/`exit`. Missing or malformed fixtures and unmatched commands fail non-zero, so absent canned evidence cannot masquerade as a successful tool call.
- Each scenario lives at `evals/scenarios/<skill>/<fault>/responses.json` and is mounted into the run via the stimulus's `environment.files` (`dest: .mocks/responses.json`). Fixtures encode one real fault plus healthy *distractors* so the agent must reach the true root cause instead of stopping at the first red herring.
- Mock results must be described as canned-substrate trajectory evidence. Live packet-capture behavior requires `evals/tests/aks-network-capture/smoke-live-cluster.sh`.

### Selective skill context

Promptfoo is an eval representation, not a runtime loader. `skill-provider.js` always loads the selected root `SKILL.md`; a quality case may then request one or more skill-relative files:

```yaml
metadata:
  case_id: my-deep-case
vars:
  skill_path: "my-skill/SKILL.md"
  skill_files:
    - "references/needed-causal-map.md"
    - "references/needed-command-flow.md"
```

Files are loaded root-first and then in declaration order. Missing files, directories, traversal/current-directory segments, cross-skill paths, duplicate declarations, symlink aliases of an already loaded file, and symlink escapes fail closed. Omit `skill_files` to preserve the root-only default.

Promptfoo treats string arrays as variable permutations unless the case sets `options.disableVarExpansion: true`. Every case with `skill_files` must set that option so the provider receives one ordered file list; the focused test enforces it, resolves every configured path, and rejects duplicate `case_id` values.

This proves that the selected files are loaded and available to the evaluation; it does not by itself prove that they change model behavior. Use a behavioral comparison when making that stronger claim. The same focused test also executes the real network-capture scripts to preserve the rendered manifest and argument-boundary security invariants without maintaining a mirror of every production script.

## Environment variables

### Local provider configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `EVAL_PROVIDER` | No | Explicit backend override: `foundry` \| `azure` \| `openai` \| `github`. Takes precedence over every auto-detection rule below, including `OPENAI_BASE_URL`. Auto-detected if unset. |
| `AZURE_OPENAI_API_KEY` | Yes* | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Yes* | Full endpoint URL (e.g. `https://my-resource.openai.azure.com`) — base URL only, no path suffix |
| `OPENAI_API_KEY` | Fallback | Used if Azure vars are not set. Optional when `OPENAI_BASE_URL` points at a keyless self-hosted server. |
| `OPENAI_BASE_URL` | No | Point the `openai` backend at any OpenAI-compatible endpoint instead of `api.openai.com` — a self-hosted or local model server (llama.cpp / vLLM / Ollama) or a gateway. Default: `https://api.openai.com/v1`. Setting this is treated as explicit local/OpenAI-compatible intent during auto-detection: it selects the `openai` backend even if Azure credentials also happen to be present in the environment. |
| `EVAL_MODEL` | No | Model/deployment name (default: `gpt-5` for `azure`/`api.openai.com`). Set this for a custom `OPENAI_BASE_URL` server such as vLLM that requires a `model` field in the request body — servers that infer the model from what they have loaded (e.g. some llama.cpp/Ollama setups) can omit it. |
| `EVAL_JUDGE_MODEL` | No | Optional judge deployment/model. Falls back to `EVAL_MODEL`, preserving the local single-endpoint flow. |

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

### Trusted CI configuration

| Variable | Trusted CI | Description |
|----------|------------|-------------|
| `EVAL_PROVIDER` | Fixed to `foundry` | Trusted runs cannot auto-detect a different backend. |
| `EVAL_PROTOCOL` | Fixed to `openai` | The currently deployable matrix entries all use the existing Foundry OpenAI protocol. |
| `EVAL_MODEL` | Derived from the matrix cell | Exact generator deployment/model identity. |
| `EVAL_JUDGE_MODEL` | Derived from the matrix cell | Exact distinct judge deployment/model identity. |
| `FOUNDRY_ENDPOINT` | Required environment variable | Foundry resource endpoint, without credentials. |
| `FOUNDRY_ACCESS_TOKEN` | Short-lived only | Acquired inside the approved job through Azure OIDC; never stored in repository or environment secrets. |

The shared client still supports explicit `azure`, `openai`, and `github` providers for local development. Trusted CI uses the same existing `EVAL_MODEL` and `EVAL_JUDGE_MODEL` interfaces, fixes `EVAL_PROVIDER=foundry`, and sets `EVAL_REQUIRE_FOUNDRY=1`, so it cannot auto-detect a fallback provider. It does not introduce separate judge provider/protocol overrides.

The native workflow matrix currently evaluates the three deployments provisioned in the selected environment: `gpt-5.6-sol`, `gpt-5.6-luna`, and `gpt-5.6-terra`. `claude-opus-5` and `claude-opus-4-8` are explicitly reported as `unavailable` / `not-provisioned`; they are not invoked and do not count as failures. Revalidate the environment's deployment list read-only before changing these classifications.

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
    case_id: <globally-unique-case-id>
  options:
    disableVarExpansion: true
  vars:
    skill_path: "<your-skill-name>/SKILL.md"
    skill_files:
      - "references/<only-the-file-needed-for-this-case>.md"
    prompt: "A detailed user scenario"
  assert:
    - type: g-eval
      value: "Description of what a good response looks like"
      threshold: 0.9
```

3. Add quality tests to `promptfooconfig.yaml` under `tests:`. Trigger tests are auto-discovered via glob (`file://tests/*/trigger-tests.yaml`).
4. If the case needs supporting files, add only those paths under `skill_files`, keep `disableVarExpansion: true`, assign a unique `case_id`, and run `npm run test:deep-content`.
5. (Optional) Add an agentic spec at `evals/tests/<your-skill-name>/eval.yaml`. It is auto-discovered — no config edits. Point `environment.skills` at the full competing skill pool and follow the routing (`tier: smoke`) + investigation (`tier: mock`) shape used by the existing specs:

```yaml
# eval.yaml — does the agent invoke the skill and respond well?
name: <your-skill-name>-agentic-eval
environment:
  skills:
    - ../../../skills/<your-skill-name>
    - ../../../skills/<colliding-skill-name>
defaults:
  runs: 1
  executor: copilot-sdk
  model: claude-sonnet-4.6
stimuli:
  - name: "Routing: <scenario>"
    prompt: "A user question that should route to this skill"
    tags: { tier: smoke, area: routing }
    graders:
      - type: skill-invocation
        config:
          required: [<your-skill-name>]
          disallowed: [<colliding-skill-name>]
```

For a `tier: mock` investigation, also add a fixture at `evals/scenarios/<your-skill-name>/<fault>/responses.json` (an ordered list of `{ match, stdout, stderr, exit }` regex entries — one real fault plus healthy distractors), mount it via the stimulus `environment.files` (`dest: .mocks/responses.json`), and grade both skill invocation and required/disallowed tool calls. Add a call, token, turn, or time limit only when an existing product or platform contract supplies that exact value. See `tests/aks-troubleshooting/eval.yaml` for complete examples.

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

The gate makes real LLM calls per candidate, so this is **opt-in and manual by design** — it is not a background watcher. This workflow uses its own `AZURE_OPENAI_*` repository secrets; the pull-request `Skill Evaluation` workflow remains secret-free, and the Autogen artifact is not an authoritative trusted-eval result. Set `dry_run: true` to exercise the pipeline with no LLM spend (emits fixed samples).

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
| `promptfooconfig.yaml` | Quality — response depth/accuracy | skill-provider (root plus case-declared deep files) | `icontains`, `g-eval` | Required after trusted approval |
| `promptfoo-routing.yaml` | Trigger — skill selection | router-provider (presents all skills) | `equals` | Required after trusted approval |
| `promptfoo-baseline.yaml` | Baseline — model without skill | baseline-provider (no SKILL.md) | `g-eval` | No (report only) |
| `tests/<skill>/eval.yaml` | Agentic — competitive routing (smoke) + canned-substrate investigation (mock) | Vally `copilot-sdk` executor | `skill-invocation`, `tool-calls`, `prompt`, `output-matches` | Manual; failed graders exit non-zero |

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

`Skill Evaluation` runs on every `pull_request`, including forks, with `contents: read` only. It checks out `pull_request.head.sha`, runs `npm run lint` and `npm run lint:agentic`, and uploads one inert `target.json` artifact named with that workflow run ID. It never references model/Azure secrets or executes model evaluation.

The default-branch-only `Trusted Skill Evaluation` workflow reacts through `workflow_run`. The trigger selects the display name, but the anchor, resolver, and final publisher each also require the platform-supplied path to be exactly `.github/workflows/skill-eval.yml`; a PR-added workflow that reuses the `Skill Evaluation` name cannot establish trust. Before reading any artifact, the anchor creates `Trusted Skill Evaluation` on the platform-supplied `workflow_run.head_sha` with a failure conclusion. The finalizer always runs, and a missing anchor can create only another failure check.

The resolver identifies exactly one open PR from the platform-supplied head repository/ref/SHA, then requires the inert artifact's PR number and commit/repository/ref/run identity to match that current PR and `workflow_run`. It compares the complete Pull Files enumeration with the live `pullRequest.changed_files` count before classifying paths; GitHub's 3,000-file enumeration cap, duplicate/invalid entries, or any count mismatch therefore requires model evaluation rather than producing a non-model success. Changes under `skills/`, `evals/`, or any file in `.github/workflows/` are model-sensitive, including a newly added workflow.

Workflow `run:` blocks never interpolate `${{ }}` values. Event, PR, artifact, and job-output strings enter step environment variables and are passed as quoted shell variables, so valid Git refs containing shell metacharacters remain inert. Branch values are also checked with `git check-ref-format --branch` without imposing a narrower repository naming convention.

Model-sensitive changes expand into native GitHub Actions matrices with `fail-fast: false`. Supported cells enter the `trusted-skill-eval` environment, where GitHub enforces human approval before the exact recorded fork commit is checked out. Each supported cell records its generator deployment, distinct judge deployment, and typed result (`passed`, `evaluation-failed`, or `infrastructure-error`). Unprovisioned cells run without Azure access and record `unavailable` / `not-provisioned`. The job does not enable `setup-node` caching after fork checkout. It uses Azure OIDC for a short-lived Foundry token and runs quality and routing evaluations with Promptfoo caching and result writes disabled.

**Accepted residual risk:** approval intentionally authorizes fork-authored code (`npm ci`, providers, configs, and eval scripts) to run while an inference credential is present. The control is the human gate plus an identity restricted to inference on the single Foundry resource; this design does not sandbox or attest away arbitrary fork-code execution. Approvers must verify the PR head SHA before approving. Do not grant this identity content, deployment, or broad management permissions.

The summary distinguishes evaluation failures from infrastructure errors and unavailable deployments. Matrix results are advisory: a failed supported cell remains visible and attributable but does not turn the collected summary into a quality gate. The final publisher revalidates the same workflow file path, event anchor, live PR head/repository/ref, original check ID, head SHA, external run identity, check name, and GitHub Actions app before recording that the advisory summary was collected. Upstream failure, target/API failure, approval rejection, cancellation before summary collection, or an unresolved summary leaves the exact-SHA check failed.

### Trusted CI boundary and required repository configuration

This branch does not modify repository settings, and the resolver deliberately does not duplicate GitHub's environment-policy enforcement. Configure and verify every setting below before treating the trusted check as authoritative:

1. Create the `trusted-skill-eval` environment. Add at least one required reviewer, enable **Prevent self-review**, disable administrator bypass, and select **Protected branches only**. GitHub enforces this gate; repository code does not duplicate the environment-policy audit.
2. Add environment variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, and `FOUNDRY_ENDPOINT`. Generator and judge deployments are committed per matrix cell; the workflow does not read environment-level `EVAL_MODEL`, `EVAL_PROTOCOL`, `EVAL_JUDGE_MODEL`, or judge provider/protocol overrides. No long-lived model or Azure secret is required.
3. Configure an Azure federated identity credential for subject `repo:Azure/AKS-Skills:environment:trusted-skill-eval`. Assign only inference data actions at the specific Foundry resource. For partner/MaaS models, the role must include the required `Microsoft.CognitiveServices/accounts/MaaS/*` data action; avoid content, deployment, subscription, and broad management roles.
4. Keep the stable `eval` job under `Skill Evaluation` as the deterministic required context. `Trusted Skill Evaluation` is published onto the exact validated PR head SHA, but remains advisory while the matrix is uncalibrated and must not be added as a required quality gate. Existing path-scoped `shellcheck` and `injection-test` jobs under `Script Security` remain hard failures when their workflow runs, but must not be made globally required while their path filters remain.
5. Enable the repository or organization Actions policy **Require actions to be pinned to a full-length commit SHA**. All actions used by these workflows are already pinned.

The trusted `workflow_run` path cannot execute until this workflow exists on the default branch. Pull-request CI therefore proves only the untrusted workflow and deterministic policy tests; the first post-merge run must confirm the live default-branch trigger and deployment policy.

Authoritative platform behavior: [events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [secure use of reference actions](https://docs.github.com/en/actions/reference/security/secure-use), [artifact storage and digests](https://docs.github.com/en/actions/tutorials/store-and-share-data), and [Azure OIDC federation](https://learn.microsoft.com/azure/developer/github/connect-from-azure-openid-connect).

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
