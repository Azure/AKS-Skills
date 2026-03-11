---
name: holmesgpt-eval
description: "Run HolmesGPT evals (tests/llm/fixtures/test_ask_holmes) against the current agent itself (agent-native). The agent must answer the prompts itself (no external wrapper) using its own tools, run before_test/after_test around each case, compare the answer to expected_output using the scoring rules here, and generate JSON + Markdown reports. This skill focuses exclusively on the agent-native flow."
---

HolmesGPT Eval — Agent-Native (Self-Answer)

Primary purpose
- Evaluate the current agent against HolmesGPT’s eval fixtures by having the agent answer each user_prompt itself.
- No HTTP bridge or shell wrapper for answering — the agent’s own tools should be used to produce the answer string that gets scored.

Agent-native flow (what the agent should do)
1) Fetch fixtures automatically (no local path needed):
   - Call scripts/fetch_fixtures.sh via exec to clone/update HolmesGPT and return tests/llm/fixtures/test_ask_holmes.
2) Iterate each case directory containing test_case.yaml:
   - Parse test_case.yaml and determine case controls before executing anything:
     - If evaluation.correctness.expected_score == 0 → SKIP this case entirely (do not run before_test/after_test). Record as skipped with reason.
     - Determine evaluation mode for this case (see Scoring Rules → Mode selection).
   - For non-skipped cases:
     - Run before_test in that directory (exec with cwd so relative paths work).
     - Ask the agent itself the user_prompt:
       - Preferred isolation: spawn an isolated sub-agent (sessions_spawn) per case to avoid cross-case state.
       - Send the user_prompt to that sub-agent (sessions_send) and collect the assistant’s textual reply (sessions_history).
       - Alternatively, answer inline in the current session if isolation isn’t needed.
     - Score the agent’s answer against expected_output.
     - Always run after_test in that directory to clean up.
3) Write results under skills/holmesgpt-eval/results/<timestamp>:
   - results.json — array of case results (prompt, expected, output, pass/fail, skipped, details)
   - report.md — concise summary (pass/fail/skip counts; per-case status, expected list, output, missing elements if any)
   - latest-results.md — points to the latest report

Scoring rules for the agent
- Mode selection (per-case):
  - Default to strict mode.
  - If the test_case.yaml contains evaluation.correctness.type, use that value to set the mode for this case.
    - Supported values (case-insensitive): strict, loose
    - Unknown/absent values: fall back to strict
  - Example YAML snippet:
    
    evaluation:
      correctness:
        type: loose

- Modes:
  - strict: pass only if ALL expected elements are sufficiently present in the output
  - loose: pass if the output reasonably matches the expected content overall

- “Sufficiently present” guidance:
  - Case-insensitive; ignore trivial punctuation/whitespace differences
  - Numeric normalization OK when unambiguous (e.g., 14 vs fourteen)
  - Minor paraphrases allowed if the essence is clear; elements may span multiple sentences

- Deterministic baseline when unsure:
  - strict = all expected substrings present (case-insensitive)
  - loose = any expected substring present

Skipping cases
- If evaluation.correctness.expected_score is present and equals 0, skip the case entirely and record it as skipped.
- Skipped cases should not execute before_test/after_test or scoring.
- Record in results.json: { skipped: true, skip_reason: "expected_score == 0" }

Kubernetes-aware fixtures
- before_test/after_test often apply and delete Kubernetes manifests; run them with cwd set to the case directory so relative paths (e.g., manifests.yaml) resolve.

External runners
- External shell/HTTP runners have been removed. This skill focuses exclusively on the agent-native flow described above.

Report format
- Keep it concise and consistent:
  - Title, date, summary: X passed, Y failed, Z skipped
  - Per-case: status (PASSED/FAILED/SKIPPED), prompt, expected elements, agent output, missing elements (if any)
  - Record the evaluation mode used per case (strict or loose)

Notes
- Sub-agents are recommended per case (sessions_spawn) to keep reasoning isolated, but before_test/after_test must run in the shared environment to properly mutate/clean cluster state.
- Avoid leaking prior-case context into the next case; clear or isolate as needed.
