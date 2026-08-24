#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  parseCliArgs,
  validateCommit,
  validateGitBranch,
  validatePositiveIntegerString,
  validateRepository,
} from "./eval-contract.mjs";

export function buildValidationTarget(env = process.env) {
  const pullRequest = validatePositiveIntegerString(
    env.PR_NUMBER,
    "PR_NUMBER",
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    repository: validateRepository(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
    pullRequest: Number(pullRequest),
    head: {
      sha: validateCommit(env.PR_HEAD_SHA, "PR_HEAD_SHA"),
      ref: validateGitBranch(env.PR_HEAD_REF, "PR_HEAD_REF"),
      repository: validateRepository(
        env.PR_HEAD_REPOSITORY,
        "PR_HEAD_REPOSITORY",
      ),
    },
    base: {
      sha: validateCommit(env.PR_BASE_SHA, "PR_BASE_SHA"),
      ref: validateGitBranch(env.PR_BASE_REF, "PR_BASE_REF"),
      repository: validateRepository(
        env.PR_BASE_REPOSITORY,
        "PR_BASE_REPOSITORY",
      ),
    },
    workflow: {
      runId: validatePositiveIntegerString(
        env.GITHUB_RUN_ID,
        "GITHUB_RUN_ID",
      ),
      runAttempt: validatePositiveIntegerString(
        env.GITHUB_RUN_ATTEMPT,
        "GITHUB_RUN_ATTEMPT",
      ),
    },
  };
}

export async function writeValidationTarget(output, env = process.env) {
  const target = buildValidationTarget(env);
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(target, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporary, resolved);
  return target;
}

async function main() {
  const args = parseCliArgs(
    process.argv.slice(2),
    new Set(["output"]),
  );
  if (!args.output) {
    throw new Error("--output is required");
  }
  await writeValidationTarget(args.output);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`record-validation-target: ${error.message}`);
    process.exitCode = 1;
  });
}
