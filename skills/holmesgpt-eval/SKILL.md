---
name: holmesgpt-eval
description: "Run HolmesGPT evals (tests/llm/fixtures/test_ask_holmes) against the current agent itself (agent-native). The agent must answer the prompts itself (no external wrapper) using its own tools, run before_test/after_test around each case, compare the answer to expected_output using the scoring rules here, and generate JSON + Markdown reports. This skill focuses exclusively on the agent-native flow. Supports bulk run (all tests) and individual run (specific test case). Supports filtering tests by tags."
---

HolmesGPT Eval — Agent-Native (Self-Answer)

Primary purpose
- Evaluate the current agent against HolmesGPT's eval fixtures by having the agent answer each user_prompt itself.
- No HTTP bridge or shell wrapper for answering — the agent's own tools should be used to produce the answer string that gets scored.
- Supports two modes: bulk run (all or filtered tests) and individual run (single specific test case).

Agent-native flow (what the agent should do)
1) Check for existing fixtures:
   - If vendor/holmesgpt/tests/llm/fixtures/test_ask_holmes exists, skip fetch and use existing fixtures.
   - Otherwise, call scripts/fetch_fixtures.sh via exec to download/unzip HolmesGPT and return tests/llm/fixtures/test_ask_holmes.
2) Determine run mode:
   - Bulk run: If no specific test case is specified, iterate through all case directories (optionally filtered by tags).
   - Individual run: If a specific test case is specified (e.g., "01_how_many_pods", "09_crashpod"), run only that single test.
3) Iterate each case directory containing test_case.yaml:
   - Parse test_case.yaml and determine case controls before executing anything:
     - If tags are specified for the run, check if the test_case.yaml contains a matching tag in its tags field. If not, ignore this case completely (do not record, process, or report it).
     - If evaluation.correctness.expected_score == 0 → SKIP this case entirely (do not run before_test/after_test). Record as skipped with reason.
     - Determine evaluation mode for this case (see Scoring Rules → Mode selection).
   - For non-skipped cases:
     - Run before/after as bash scripts (materialize then execute):
       - Write the before_test block verbatim to .before.sh in the case directory.
       - Write the after_test block verbatim to .after.sh in the case directory.
       - Execute with a non-interactive shell and strict flags from the case directory:
         - before: bash --noprofile --norc -eo pipefail ./.before.sh
         - after:  bash --noprofile --norc -eo pipefail ./.after.sh
       - Always set cwd to the case directory so relative paths resolve.
       - Capture stdout, stderr, and exit code for both before and after.
     - Ask the agent itself the user_prompt (inline in the current session) and capture the raw textual reply.
       - The agent MUST answer the prompt directly without creating script files (.py, .sh, etc.) unless explicitly required by the test case.
       - The agent should use available tools to investigate and provide answers in the current session.
       - If the test runs longer than 5 minutes, stop the test immediately and mark it as failed with reason "timeout_exceeded".
     - Score the agent's answer against expected_output.
     - Always run after_test (as above) to clean up, even if before/ask/score failed.
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
- If tags are specified for the run and the test_case.yaml does not contain a matching tag, ignore the case completely (do not record or report it anywhere).
- If evaluation.correctness.expected_score is present and equals 0, skip the case entirely and record it as skipped.
- Skipped cases should not execute before_test/after_test or scoring.
- Record skipped cases in results.json: { skipped: true, skip_reason: "expected_score == 0" }

Environment preparation and cleanup (before_test/after_test)
- before_test and after_test are arbitrary shell snippets to prepare and clean up the test environment (they are not Kubernetes-specific).
- Always materialize these blocks into .before.sh/.after.sh and run them with bash --noprofile --norc -eo pipefail from the case directory.
- Always set cwd to the case directory so relative paths resolve correctly (files, scripts, manifests, etc.).
- Record stdout, stderr, and exit codes; if before_test fails, mark the case accordingly but still run after_test.

Shell execution hygiene (avoid interactive prompts)
- Use non-interactive shells to execute scripts: bash --noprofile --norc -eo pipefail <script>.
- Do not use login shells (-l) which may source profile files and trigger interactive prompts.
- Capture stdout/stderr/exit code for both before and after scripts, and record them in case results.

Gold-blind answering (prevent peeking at expected_output)
- Fixtures are preprocessed during fetch: expected_output is split into a separate gold.json under skills/holmesgpt-eval/_gold, and a solver YAML (test_case.solver.yaml) is generated without expected_output.
- The runner loads user_prompt and before/after from test_case.solver.yaml, answers, then reads expected_output from gold.json for scoring.
- Record audit details per case: timestamps (answered_at < scored_at) and working directory used during answer.

Report format
- Keep it concise and consistent:
  - Title, date, summary: X passed, Y failed, Z skipped
  - Per-case: status (PASSED/FAILED/SKIPPED), prompt, expected elements, Agent output (verbatim), missing elements (if any), mode
  - Agent output requirements:
    - Always include the agent’s raw textual answer in the report for each case
    - Truncate to ~2000 characters if very long; add “(truncated)” marker
    - Redact common secrets (bearer tokens, AKV/ARN/AK/SK patterns) if detected
  - Record the evaluation mode used per case (strict or loose)

Run modes
- Bulk run: Run all tests or filter by tags. Generate comprehensive report with summary statistics.
- Individual run: Run a single specified test case. Generate focused report for that test only.
- Examples:
  - "Run all evals" → bulk run (all tests)
  - "Run evals tagged 'easy'" → bulk run (filtered by tag)
  - "Run eval 09_crashpod" → individual run (single test)
  - "Run eval test 01_how_many_pods" → individual run (single test)

Notes
- Avoid leaking prior-case context into the next case; clear or isolate as needed.
- Tag filtering: When invoked with specific tags (e.g., "easy", "kubernetes", "bash"), only run tests that have at least one matching tag in their test_case.yaml tags field. Tests that don't match are completely ignored (not recorded, processed, or reported).
- Tag matching is case-insensitive and supports multiple tags (run if ANY tag matches).
- Individual runs take precedence: if a specific test case is mentioned, run only that test regardless of tag filters.
