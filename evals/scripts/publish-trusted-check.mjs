#!/usr/bin/env node

import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  invariant,
  parseCliArgs,
  validateCommit,
  validateGitBranch,
  validateGitHubUrl,
  validatePositiveIntegerString,
  validateRepository,
} from "./eval-contract.mjs";

export const TRUSTED_CHECK_NAME = "Trusted Skill Evaluation";
const UPSTREAM_WORKFLOW = "Skill Evaluation";
const UPSTREAM_WORKFLOW_PATH = ".github/workflows/skill-eval.yml";
const JOB_RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);

function validateRunUrl(runUrl) {
  return validateGitHubUrl(runUrl, "run URL");
}

export function validateWorkflowRunAnchor(event, repository) {
  validateRepository(repository, "repository");
  invariant(event?.action === "completed", "workflow_run action must be completed");
  invariant(
    event?.repository?.full_name === repository,
    "workflow_run repository mismatch",
  );
  const workflowRun = event.workflow_run;
  invariant(workflowRun?.name === UPSTREAM_WORKFLOW, "unexpected upstream workflow");
  invariant(
    workflowRun?.path === UPSTREAM_WORKFLOW_PATH,
    "unexpected upstream workflow path",
  );
  invariant(
    workflowRun?.event === "pull_request",
    "trusted checks only anchor pull_request validation runs",
  );
  const commit = validateCommit(
    workflowRun.head_sha,
    "workflow_run.head_sha",
  );
  const headRepository = validateRepository(
    workflowRun.head_repository?.full_name,
    "workflow_run.head_repository",
  );
  const headRef = validateGitBranch(
    workflowRun.head_branch,
    "workflow_run.head_branch",
  );
  const runId = validatePositiveIntegerString(
    String(workflowRun.id),
    "workflow_run.id",
  );
  const runAttempt = validatePositiveIntegerString(
    String(workflowRun.run_attempt),
    "workflow_run.run_attempt",
  );
  invariant(
    typeof workflowRun.conclusion === "string" &&
      workflowRun.conclusion.length > 0,
    "workflow_run conclusion is missing",
  );
  return {
    commit,
    headRef,
    headRepository,
    upstreamConclusion: workflowRun.conclusion,
    externalId: `trusted-skill-eval:${runId}:${runAttempt}`,
  };
}

export function buildAnchorCheckRequest({
  event,
  repository,
  runUrl,
}) {
  const anchor = validateWorkflowRunAnchor(event, repository);
  const [owner, repo] = repository.split("/");
  return {
    anchor,
    request: {
      owner,
      repo,
      name: TRUSTED_CHECK_NAME,
      head_sha: anchor.commit,
      status: "completed",
      conclusion: "failure",
      external_id: anchor.externalId,
      details_url: validateRunUrl(runUrl),
      output: {
        title: "Trusted evaluation is fail-closed",
        summary:
          "This check is anchored to the platform-supplied workflow_run head SHA and starts failed. It is promoted only after trusted target resolution and all required evaluation work succeed.",
      },
    },
  };
}

export function finalCheckConclusion({
  upstreamConclusion,
  resolveResult,
  evaluateResult,
  modelRequired,
}) {
  invariant(
    JOB_RESULTS.has(resolveResult),
    "resolve job result is invalid",
  );
  invariant(
    JOB_RESULTS.has(evaluateResult),
    "evaluate job result is invalid",
  );
  if (upstreamConclusion !== "success" || resolveResult !== "success") {
    return "failure";
  }
  if (modelRequired === false) {
    return "success";
  }
  return modelRequired === true && evaluateResult === "success"
    ? "success"
    : "failure";
}

export function validateAnchoredCheck(check, expected) {
  invariant(
    String(check?.id) === expected.checkId,
    "Checks API returned a different check ID",
  );
  invariant(check.name === TRUSTED_CHECK_NAME, "trusted check name mismatch");
  invariant(check.head_sha === expected.commit, "trusted check head SHA mismatch");
  invariant(
    check.external_id === expected.externalId,
    "trusted check external ID mismatch",
  );
  invariant(
    check.app?.slug === "github-actions",
    "trusted check was not created by GitHub Actions",
  );
  return check;
}

export function buildCheckUpdateRequest({
  upstreamConclusion,
  resolveResult,
  evaluateResult,
  modelRequired,
  runUrl,
}) {
  const conclusion = finalCheckConclusion({
    upstreamConclusion,
    resolveResult,
    evaluateResult,
    modelRequired,
  });
  const modelState =
    modelRequired === true
      ? "required"
      : modelRequired === false
        ? "not required"
        : "unresolved";
  return {
    status: "completed",
    conclusion,
    details_url: validateRunUrl(runUrl),
    output: {
      title:
        conclusion === "success"
          ? modelRequired
            ? "Trusted model evaluation passed"
            : "No model-sensitive paths changed"
          : "Trusted evaluation failed closed",
      summary:
        `Upstream=${upstreamConclusion}; resolve=${resolveResult}; ` +
        `model=${modelState}; evaluate=${evaluateResult}. ` +
        "The check remains failed unless every required trusted phase succeeds.",
    },
  };
}

async function githubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${options.method || "GET"} ${new URL(url).pathname} returned ${response.status}`,
    );
  }
  return response;
}

function parseModelRequired(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  invariant(value === "unknown", "model-required value is invalid");
  return null;
}

async function main() {
  const args = parseCliArgs(
    process.argv.slice(2),
    new Set([
      "check-id",
      "commit",
      "external-id",
      "head-ref",
      "head-repository",
      "pr-number",
      "upstream-conclusion",
      "resolve-result",
      "evaluate-result",
      "model-required",
      "run-url",
    ]),
  );
  for (const key of [
    "check-id",
    "commit",
    "external-id",
    "head-ref",
    "head-repository",
    "pr-number",
    "upstream-conclusion",
    "resolve-result",
    "evaluate-result",
    "model-required",
    "run-url",
  ]) {
    invariant(args[key], `--${key} is required`);
  }

  const commit = validateCommit(args.commit, "commit");
  const token = process.env.GITHUB_TOKEN;
  const repository = validateRepository(
    process.env.GITHUB_REPOSITORY,
    "GITHUB_REPOSITORY",
  );
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  invariant(token, "GITHUB_TOKEN is required");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  invariant(eventPath, "GITHUB_EVENT_PATH is required");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const eventAnchor = validateWorkflowRunAnchor(event, repository);
  const headRepository = validateRepository(
    args["head-repository"],
    "head repository",
  );
  const headRef = validateGitBranch(args["head-ref"], "head ref");
  invariant(eventAnchor.commit === commit, "event anchor commit mismatch");
  invariant(
    eventAnchor.externalId === args["external-id"],
    "event anchor external ID mismatch",
  );
  invariant(
    eventAnchor.headRepository === headRepository &&
      eventAnchor.headRef === headRef,
    "event anchor head identity mismatch",
  );
  invariant(
    eventAnchor.upstreamConclusion === args["upstream-conclusion"],
    "event anchor conclusion mismatch",
  );
  const [owner, repo] = repository.split("/");
  const update = buildCheckUpdateRequest({
    upstreamConclusion: args["upstream-conclusion"],
    resolveResult: args["resolve-result"],
    evaluateResult: args["evaluate-result"],
    modelRequired: parseModelRequired(args["model-required"]),
    runUrl: args["run-url"],
  });
  if (args["check-id"] === "missing") {
    invariant(
      update.conclusion === "failure",
      "a missing anchor cannot be promoted",
    );
    const fallback = buildAnchorCheckRequest({
      event,
      repository,
      runUrl: args["run-url"],
    });
    invariant(fallback.anchor.commit === commit, "fallback anchor commit mismatch");
    invariant(
      fallback.anchor.externalId === args["external-id"],
      "fallback anchor external ID mismatch",
    );
    invariant(
      fallback.anchor.headRepository === args["head-repository"] &&
        fallback.anchor.headRef === args["head-ref"],
      "fallback anchor head identity mismatch",
    );
    const { owner: ignoredOwner, repo: ignoredRepo, ...body } = fallback.request;
    const response = await githubRequest(
      `${apiUrl}/repos/${owner}/${repo}/check-runs`,
      token,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    const check = await response.json();
    console.log(
      `Created fallback ${TRUSTED_CHECK_NAME} failure: ${check.html_url}`,
    );
    return;
  }

  const checkId = validatePositiveIntegerString(args["check-id"], "check ID");
  if (update.conclusion === "failure") {
    console.log(
      `${TRUSTED_CHECK_NAME} remains at its initial failure conclusion`,
    );
    return;
  }

  const pullRequestNumber = validatePositiveIntegerString(
    args["pr-number"],
    "pull request number",
  );
  const pullRequest = await (
    await githubRequest(
      `${apiUrl}/repos/${owner}/${repo}/pulls/${pullRequestNumber}`,
      token,
    )
  ).json();
  invariant(
    pullRequest?.state === "open" &&
      String(pullRequest.number) === pullRequestNumber &&
      pullRequest.head?.sha === commit &&
      pullRequest.head?.ref === headRef &&
      pullRequest.head?.repo?.full_name === headRepository &&
      pullRequest.base?.repo?.full_name === repository,
    "pull request head was superseded before trusted-check promotion",
  );

  const checkUrl = `${apiUrl}/repos/${owner}/${repo}/check-runs/${checkId}`;
  const existing = await (
    await githubRequest(checkUrl, token)
  ).json();
  validateAnchoredCheck(existing, {
    checkId,
    commit,
    externalId: args["external-id"],
  });

  const response = await githubRequest(checkUrl, token, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
  const check = await response.json();
  console.log(
    `Finalized ${TRUSTED_CHECK_NAME} as ${check.conclusion}: ${check.html_url}`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`publish-trusted-check: ${error.message}`);
    process.exitCode = 1;
  });
}
