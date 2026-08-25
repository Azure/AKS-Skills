# AKS Support Benchmark Core

This directory contains a dependency-free, clean-room benchmark harness draft for
evaluating AKS support agents. It is infrastructure, not a published benchmark
distribution or a model leaderboard. The checked-in scenarios are **public
canary harness self-tests** only.

## Run locally

```bash
python3 benchmarks/aks-support/cli.py validate \
  benchmarks/aks-support/fixtures/canary.json
python3 benchmarks/aks-support/cli.py self-test --offline --no-model
python3 -m unittest discover -s benchmarks/aks-support/tests -p 'test_*.py'
```

The smoke command replays a recorded trajectory. It makes no network call and
produces no model-performance claim.

## Direct-context calibration pipeline

The calibration commands are artifact-only and make no model calls. They pin the
accepted `4e6a549` Git objects and external manifest, freeze all 46 registered
skill files (251,082 bytes), and preregister the exact 92-cell Copilot matrix:

```bash
python3 benchmarks/aks-support/cli.py calibration-prepare \
  --repo-root "$PWD" \
  --fixtures benchmarks/aks-support/fixtures/public-canaries \
  --output "$RESULT_ROOT/calibration-plan.json"
python3 benchmarks/aks-support/cli.py calibration-request \
  "$RESULT_ROOT/calibration-plan.json" CELL_ID \
  --output "$RESULT_ROOT/request.json"
python3 benchmarks/aks-support/cli.py calibration-preflight \
  "$RESULT_ROOT/calibration-plan.json" CELL_ID \
  --response "$RESULT_ROOT/normalized-response.json"
```

`calibration-ingest` accepts only the normalized one-shot response envelope and
seals sanitized output, trace, and outcome evidence. `calibration-report`
reapplies deterministic attempt and pair gates and regenerates a
track-separated `descriptive-pipeline-calibration` report. It makes no ranking,
uplift, superiority, confidence, skill-effect, or product-quality claim.
`agent-folder` remains blocked.

The optional raw-model transport is
`evals/providers/aks-support-raw-bridge.js`. It uses the existing
`llm-client.js`, sends the exact requested model without aliases, supplies no
tools, and returns only the normalized response envelope. With no configured
backend it returns a fail-closed `raw-model-unconfigured` result. A preflight is
`proven` only after an actual normalized host response establishes exact
requested/observed model identity, the observed prompt byte count and SHA-256, a
complete zero-tool trace, and acceptance of the full bundle-plus-case prompt.

## Concepts and non-claims

- A **benchmark suite** is a versioned, preregistered collection whose release,
  tasks, environments, verifiers, and analysis policy are content-addressed.
- The **harness** validates contracts, runs adapters, records trajectories,
  applies deterministic gates, scores artifacts, and regenerates reports.
- A **regression set** catches product regressions and is not automatically a
  representative benchmark.
- A **public canary** proves harness paths using public facts. The canaries here
  are deliberately minimal and are not a benchmark distribution.
- A **private calibration set** supports controlled calibration and remains
  outside this repository.
- A **brokered holdout** is supplied by an independent broker at run time and
  remains outside the repository and solver workspace.
- A **rotating post-cutoff challenge** is a separately governed set with a
  declared cutoff and rotation record; no cadence is assumed here.
- A **marketing demo** illustrates a workflow and must not be reported as an
  efficacy measurement.

This draft does not claim representativeness, support-case fidelity, production
readiness, model superiority, skill uplift, statistical power, or ranking
validity. It does not define case counts, repetitions, retries, model-family
minimums, thresholds, or token/time budgets. Those values must come from an
approved claim matrix and statistical plan. When uncertainty is inadequate,
the report remains `descriptive-preliminary` and contains no rankings.

## Execution and isolation

`direct-model-context` injects only explicitly selected file bytes and records
their hashes. `agent-folder` makes the complete registered skill folder
available and requires the host trajectory to identify files read and scripts
invoked. Missing content or missing trace is explicit; it is never interpreted
as a no-tool or no-skill run. Results from the two modes cannot be combined.

The registered intervention is the complete skill bundle, represented by its
full file manifest and bundle hash. Paired skill/no-skill runs keep task,
model/host, adapter, posture, tools, budgets, seed/config, retry policy, and
repetition constant. Only skill availability and the corresponding immutable
skill identity differ.

Solver workspaces contain task inputs only. Answers, gold material, and
verifiers are resolved from a disjoint verifier path. Public development
fixtures may check in those materials in a separate directory. Private roots
and result roots must resolve outside the repository, including through
symlinks.

## Countability and scoring

Countability is derived from the recorded artifacts and trace:

- schema and integrity;
- contamination or exposure;
- capability equivalence;
- fixture and verifier integrity;
- prohibited actions;
- requested and matched tools;
- trace availability; and
- infrastructure failure.

Infrastructure-only failure is `uncountable`. Other failures that break
attribution are `non-attributable`. Countable paired scores derive `positive`,
`neutral`, or `negative` from their score vectors; no direction is preassigned.

The deterministic score vector covers outcome/root cause, decisive evidence,
distractor rejection, routing/escalation, safe remediation/prohibited mutation,
communication/uncertainty, tool efficiency, and infrastructure status.
State, artifact, and verifier checks are primary. An independent qualitative
assessment may be retained as advisory evidence but cannot override
correctness, safety, or countability.

## Identity, results, and release boundaries

Run identities bind hashes for benchmark, task, environment, verifier, model,
scaffold, prompt, skill, tools, budget, and retry policy. Results are JSONL and
append-only by result ID. Reports are regenerated only from result artifacts
and the preregistered claim plan. Claim assessments and rankings are partitioned
by execution mode. Only countable results with an explicit paired comparison
outcome can enter rankings; a missing outcome is not interpreted as neutral.

The publication scanner requires an explicit package file list, recognizes only
declared text formats, fails closed on unknown extensions, and rejects secrets,
private roots, internal hosts, resource identifiers, and local endpoints.

## Methodological provenance

The design uses methodology, not copied code or data, from these primary
sources. URLs were verified on 2026-08-24; no unsupported freshness expiry is
asserted.

| Source | Methodological contribution |
| --- | --- |
| [SWE-bench](https://github.com/SWE-bench/SWE-bench) | Real-task provenance and executable verification |
| [Terminal-Bench](https://github.com/laude-institute/terminal-bench) | Isolated verifier and rigorous acceptance |
| [tau2-bench](https://github.com/sierra-research/tau2-bench) | Policy, customer, tool interaction, and reliability |
| [AppWorld](https://github.com/StonyBrookNLP/appworld) | Stateful evaluation and collateral-effect checks |
| [ToolSandbox](https://github.com/apple/ToolSandbox) | Stateful milestones and tool-use traces |
| [METR Task Standard](https://github.com/METR/task-standard) | Human calibration, repeated trials, uncertainty, and claim wording |
| [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) | Structured logs and reproducible configuration |
| [HELM](https://github.com/stanford-crfm/helm) | Scenario configuration and raw-result transparency |
| [SREGym](https://github.com/SREGym/SREGym) | SRE evaluation methodology |
| [ITBench](https://github.com/itbench-hub/ITBench) | Interactive infrastructure-task methodology |
| [AIOpsLab](https://github.com/microsoft/AIOpsLab) | Reproducible operations-agent research environments |
| [OpenRCA](https://github.com/microsoft/OpenRCA) | Root-cause-analysis methodology |
| [RCAEval](https://github.com/NetManAIOps/RCAEval) | RCA evaluation dimensions |
| [HolmesGPT](https://github.com/HolmesGPT/holmesgpt) | Future baseline candidate |
| [K8sGPT](https://github.com/k8sgpt-ai/k8sgpt) | Future baseline candidate |
| [Robusta](https://github.com/robusta-dev/robusta) | Future baseline candidate |
| [ASSERT](https://github.com/ASSERT-KTH/ASSERT) | Agent-system evaluation methodology |
| [Chaos Mesh](https://github.com/chaos-mesh/chaos-mesh) | Future controlled-fault integration |
| [Litmus](https://github.com/litmuschaos/litmus) | Future controlled-fault integration |
| [Grafana o11y-bench](https://github.com/grafana/o11y-bench) | Observability methodology only, pending legal approval for reuse |

Cloud-OpsBench materials are not copied because its repository declares no
license. CRMArena-Pro and AgenticOpsEval materials are not reused because their
licenses are non-commercial. No source above is vendored or imported.

## Public canary sources

The quota canary is based on Microsoft Learn documentation for AKS
`QuotaExceeded` / `InsufficientVCPUQuota`. The DNS canary is based on Microsoft
Learn documentation describing custom NSG rules blocking UDP 53 between node
pools. Each case contract records its source URL and verification date.
