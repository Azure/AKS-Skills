---
name: holmesgpt-eval
description: "Run HolmesGPT evals (tests/llm/fixtures/test_ask_holmes) against the current agent itself (OpenClaw-native). For each case, run before_test, ask user_prompt using the agent’s own reasoning/tools, compare the agent output to expected_output (scoring rules below), always run after_test, and generate JSON + Markdown reports. Includes optional shell/HTTP backends for external agents."
---

HolmesGPT Eval — OpenClaw-Native First

Primary purpose
- Direct the current agent (OpenClaw) to evaluate itself against HolmesGPT’s eval fixtures.
- The agent should execute the full loop internally: run before_test, answer user_prompt using its own tools (e.g., kubectl), compare to expected_output, run after_test, and produce reports.

Quick start (OpenClaw-native)
1) Fetch fixtures (no local path required):
   - Run scripts/fetch_fixtures.sh (the agent can call it via exec) to clone/update HolmesGPT and return the path to tests/llm/fixtures/test_ask_holmes.
2) Iterate cases (agent internal loop):
   - For each case directory containing test_case.yaml:
     - exec the before_test block in that directory
     - Ask the agent itself the user_prompt (use the agent’s standard reply path so tools like kubectl are available)
     - Score the agent’s answer against expected_output (see Scoring Rules)
     - Always exec the after_test block
3) Write results to skills/holmesgpt-eval/results/<timestamp>/:
   - results.json (per-case details, scores)
   - report.md (human-readable summary)
   - latest-results.md updated to the newest report

Scoring rules (for the agent to apply)
- Two modes to mirror classifiers.py intent without external LLMs:
  1) strict (default): Pass only if ALL expected elements are sufficiently present in the output.
  2) loose: Pass if the output reasonably matches the expected content overall.
- “Sufficiently present” guidance:
  - Case-insensitive comparison; ignore trivial punctuation/whitespace differences.
  - Numeric normalization is acceptable (e.g., "14" vs "fourteen") when unambiguous.
  - Minor paraphrases are OK if the essence is clearly conveyed.
  - For list-like expectations, presence can span multiple sentences.
- Deterministic fallback (when in doubt): use substring presence as a conservative proxy — strict = all substrings found, loose = any substring found.

Kubernetes-aware fixtures
- Some before_test/after_test scripts apply and delete Kubernetes resources. The agent should run them in the case directory context so relative paths (e.g., manifests.yaml) work.

Optional external backends (fallbacks)
- If you prefer to test an external agent or wrapper instead of the current agent, use the provided runner scripts:
  - scripts/run.sh — convenience wrapper (supports --auto-fetch)
  - scripts/run_eval.py — Python runner (lightweight YAML parser)
- Modes:
  - shell: provide --ask-cmd to run any CLI agent; prompt is piped to stdin, answer read from stdout
  - http: provide --holmes-url for a POST-compatible endpoint ({"ask": str, "stream": false})

Examples (external backends)
- Shell:
  skills/holmesgpt-eval/scripts/run.sh --auto-fetch --mode shell --ask-cmd "my-agent-cli" --filter 01_how_many_pods
- HTTP:
  skills/holmesgpt-eval/scripts/run.sh --auto-fetch --mode http --holmes-url http://127.0.0.1:5050

Outputs
- results/<timestamp>/results.json — machine-readable results
- results/<timestamp>/report.md — human-readable summary
- latest-results.md — redirector to the latest report

Notes
- Default expectation: When this skill is loaded by OpenClaw, the agent should run the OpenClaw-native flow (no HTTP client needed). The HTTP client exists only for the optional external-backend mode.
- The agent may use isolated sub-agents (sessions_spawn) per case to avoid cross-case state contamination, but must still run before_test/after_test in the shared environment so cluster state is set/cleaned correctly.
- Keep reports concise and consistent with run_benchmarks_local.py style.
