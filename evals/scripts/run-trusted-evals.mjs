#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateCommit } from "./eval-contract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(EVALS_DIR, "..");
const PROMPTFOO = path.join(EVALS_DIR, "node_modules", ".bin", "promptfoo");
const REQUIRED_EVALUATIONS = Object.freeze([
  { id: "quality", config: "promptfooconfig.yaml" },
  { id: "routing", config: "promptfoo-routing.yaml" },
]);

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

function runEvaluation(evaluation) {
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
  };
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
  const executions = REQUIRED_EVALUATIONS.map(runEvaluation);

  const failures = requiredEvaluationFailures(executions);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`Required evaluation failed: ${failure}`);
    }
    throw new Error("required trusted evaluations failed");
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`run-trusted-evals: ${error.message}`);
    process.exitCode = 1;
  }
}
