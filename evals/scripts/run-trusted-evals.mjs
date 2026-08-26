#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateCommit } from "./eval-contract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(EVALS_DIR, "..");
const PROMPTFOO = path.join(EVALS_DIR, "node_modules", ".bin", "promptfoo");
const REQUIRED_EVALUATIONS = Object.freeze([
  { id: "quality", config: "promptfooconfig.yaml", output: "quality.json" },
  { id: "routing", config: "promptfoo-routing.yaml", output: "routing.json" },
]);
const ADVISORY_FAILURE_EXIT = 10;

function checkedOutCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function requiredEvaluationFailures(executions) {
  const failures = [];
  for (const evaluation of REQUIRED_EVALUATIONS) {
    const execution = executions.find((entry) => entry.id === evaluation.id);
    if (!execution) {
      failures.push(`${evaluation.id}: no execution record`);
      continue;
    }
    if (execution.exitCode !== 0) {
      failures.push(`${evaluation.id}: promptfoo exited ${execution.exitCode}`);
    }
  }
  return failures;
}

function runEvaluation(evaluation, resultsDir) {
  const resultPath = path.join(resultsDir, evaluation.output);
  rmSync(resultPath, { force: true });
  const result = spawnSync(
    PROMPTFOO,
    [
      "eval",
      "-c",
      evaluation.config,
      "--no-progress-bar",
      "--no-cache",
      "--no-share",
      "--no-write",
      // Exact-head runs throttled at Promptfoo's default of four concurrent calls.
      "--max-concurrency",
      "1",
      "-o",
      resultPath,
    ],
    {
      cwd: EVALS_DIR,
      env: {
        ...process.env,
        PROMPTFOO_DISABLE_TELEMETRY: "1",
      },
      stdio: "inherit",
    },
  );

  return {
    id: evaluation.id,
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    error: result.error?.message,
    resultPath,
  };
}

function validateResultEvidence(execution) {
  if (!existsSync(execution.resultPath)) {
    throw new Error(`${execution.id}: result evidence is missing`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(execution.resultPath, "utf8"));
  } catch (error) {
    throw new Error(`${execution.id}: result evidence is invalid JSON (${error.message})`);
  }
  const rows = parsed?.results?.results;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${execution.id}: result evidence contains no test rows`);
  }
  return rows;
}

function main() {
  if (!existsSync(PROMPTFOO)) {
    throw new Error("promptfoo is not installed; run npm ci first");
  }

  const evaluatedCommit = validateCommit(
    process.env.EVALUATED_COMMIT,
    "EVALUATED_COMMIT",
  );
  if (checkedOutCommit() !== evaluatedCommit) {
    throw new Error("checked-out HEAD does not match EVALUATED_COMMIT");
  }
  const resultsDir = process.env.TRUSTED_EVAL_RESULTS_DIR;
  if (!resultsDir || !path.isAbsolute(resultsDir)) {
    throw new Error("TRUSTED_EVAL_RESULTS_DIR must be an absolute path");
  }
  mkdirSync(resultsDir, { recursive: true });
  const executions = REQUIRED_EVALUATIONS.map((evaluation) =>
    runEvaluation(evaluation, resultsDir),
  );
  for (const execution of executions) {
    validateResultEvidence(execution);
  }

  const failures = requiredEvaluationFailures(executions);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`Required evaluation failed: ${failure}`);
    }
    return false;
  }
  return true;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    if (!main()) {
      process.exitCode = ADVISORY_FAILURE_EXIT;
    }
  } catch (error) {
    console.error(`run-trusted-evals: ${error.message}`);
    process.exitCode = 1;
  }
}
