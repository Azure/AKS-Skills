#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  invariant,
  parseCliArgs,
  readJson,
  validateCommit,
  validateGitBranch,
  validateGitHubUrl,
  validatePositiveIntegerString,
  validateRepository,
} from "./eval-contract.mjs";

const UPSTREAM_WORKFLOW = "Skill Evaluation";
const UPSTREAM_WORKFLOW_PATH = ".github/workflows/skill-eval.yml";
const MODEL_EVAL_PATHS = [
  "skills/",
  "evals/",
  ".github/workflows/",
];

function eventPullRequest(workflowRun) {
  const pullRequests = workflowRun?.pull_requests;
  invariant(
    Array.isArray(pullRequests) && pullRequests.length <= 1,
    "the completed validation run identified multiple pull requests",
  );
  return pullRequests[0] || null;
}

export function requiresModelEvaluation(changedFiles, declaredChangedFileCount) {
  invariant(Array.isArray(changedFiles), "pull request file list is required");
  if (
    !Number.isSafeInteger(declaredChangedFileCount) ||
    declaredChangedFileCount < 1 ||
    changedFiles.length !== declaredChangedFileCount
  ) {
    return true;
  }
  const seen = new Set();
  return changedFiles.some((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.filename !== "string" ||
      entry.filename.length === 0 ||
      seen.has(entry.filename)
    ) {
      return true;
    }
    seen.add(entry.filename);
    if (
      Object.hasOwn(entry, "previous_filename") &&
      (typeof entry.previous_filename !== "string" ||
        entry.previous_filename.length === 0)
    ) {
      return true;
    }
    const filenames = [entry?.filename, entry?.previous_filename].filter(
      (filename) => typeof filename === "string",
    );
    return filenames.some((filename) =>
      MODEL_EVAL_PATHS.some((candidate) =>
        candidate.endsWith("/")
          ? filename.startsWith(candidate)
          : filename === candidate,
      ),
    );
  });
}

export function validateTrustedTarget({
  event,
  target,
  candidatePullRequests,
  pullRequest,
  changedFiles,
  repository,
}) {
  validateRepository(repository, "GITHUB_REPOSITORY");
  invariant(event?.action === "completed", "workflow_run action must be completed");
  invariant(
    event?.repository?.full_name === repository,
    "workflow_run repository does not match GITHUB_REPOSITORY",
  );

  const workflowRun = event.workflow_run;
  invariant(workflowRun?.name === UPSTREAM_WORKFLOW, "unexpected upstream workflow");
  invariant(
    workflowRun?.path === UPSTREAM_WORKFLOW_PATH,
    "unexpected upstream workflow path",
  );
  invariant(
    workflowRun?.event === "pull_request",
    "trusted evaluation only accepts pull_request validation runs",
  );
  invariant(
    workflowRun?.conclusion === "success",
    "untrusted deterministic validation did not succeed",
  );
  const eventHeadRepository = validateRepository(
    workflowRun.head_repository?.full_name,
    "workflow_run.head_repository",
  );
  const eventHeadRef = validateGitBranch(
    workflowRun.head_branch,
    "workflow_run.head_branch",
  );
  validateCommit(workflowRun.head_sha, "workflow_run.head_sha");
  invariant(
    Array.isArray(candidatePullRequests),
    "workflow_run pull request candidates are required",
  );
  const currentCandidates = candidatePullRequests.filter(
    (candidate) =>
      candidate?.state === "open" &&
      candidate.head?.sha === workflowRun.head_sha &&
      candidate.head?.ref === eventHeadRef &&
      candidate.head?.repo?.full_name === eventHeadRepository &&
      candidate.base?.repo?.full_name === repository,
  );
  invariant(
    currentCandidates.length === 1,
    "workflow_run head does not identify exactly one current pull request",
  );
  const currentCandidate = currentCandidates[0];

  invariant(
    target?.schemaVersion === SCHEMA_VERSION,
    "validation target schemaVersion is unsupported",
  );
  invariant(target.repository === repository, "target repository mismatch");
  invariant(
    target.pullRequest === currentCandidate.number,
    "target pull request does not match the platform-resolved current head",
  );
  validateCommit(target.head?.sha, "target.head.sha");
  validateRepository(target.head?.repository, "target.head.repository");
  validateCommit(target.base?.sha, "target.base.sha");
  invariant(target.base?.repository === repository, "target base repository mismatch");
  validatePositiveIntegerString(target.workflow?.runId, "target.workflow.runId");
  validatePositiveIntegerString(
    target.workflow?.runAttempt,
    "target.workflow.runAttempt",
  );
  invariant(
    target.workflow.runId === String(workflowRun.id),
    "target came from a different workflow run",
  );
  invariant(
    target.workflow.runAttempt === String(workflowRun.run_attempt),
    "target came from a different workflow run attempt",
  );
  invariant(
    target.head.sha === workflowRun.head_sha,
    "target commit does not match workflow_run.head_sha",
  );

  const eventPr = eventPullRequest(workflowRun);
  if (eventPr) {
    invariant(
      Number(target.pullRequest) === Number(eventPr.number),
      "target pull request number does not match workflow_run",
    );
    invariant(
      target.head.sha === eventPr.head?.sha,
      "target commit does not match the workflow_run pull request head",
    );
  }
  if (workflowRun.head_repository?.full_name) {
    invariant(
      target.head.repository === workflowRun.head_repository.full_name,
      "target head repository does not match workflow_run",
    );
  }
  invariant(
    workflowRun.head_branch === target.head.ref,
    "target head ref does not match workflow_run",
  );

  invariant(
    pullRequest?.number === target.pullRequest &&
      pullRequest?.state === "open",
    "pull request is no longer open",
  );
  invariant(
    pullRequest.head?.sha === target.head.sha,
    "pull request head changed after deterministic validation",
  );
  invariant(
    pullRequest.head?.repo?.full_name === target.head.repository,
    "pull request head repository changed after deterministic validation",
  );
  invariant(
    pullRequest.head?.ref === target.head.ref,
    "pull request head ref changed after deterministic validation",
  );
  invariant(
    pullRequest.base?.repo?.full_name === repository,
    "pull request no longer targets this repository",
  );
  invariant(
    pullRequest.base?.ref === target.base.ref,
    "pull request base ref changed after deterministic validation",
  );

  const modelEvaluationRequired = requiresModelEvaluation(
    changedFiles,
    pullRequest.changed_files,
  );
  return {
    commitSha: target.head.sha,
    pullRequest: target.pullRequest,
    headRepository: target.head.repository,
    pullRequestUrl: validateGitHubUrl(pullRequest.html_url, "pull request URL"),
    modelEvaluationRequired,
  };
}

async function githubRequest(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${new URL(url).pathname} returned ${response.status}; trusted evaluation remains blocked`,
    );
  }
  return response;
}

async function githubGet(apiUrl, repository, resource, token) {
  return (
    await githubRequest(`${apiUrl}/repos/${repository}${resource}`, token)
  ).json();
}

async function githubGetAll(apiUrl, repository, resource, token) {
  // GitHub's documented REST maximum is 100 per page. The Pull Files endpoint
  // can still stop at its platform-wide 3,000-file cap, so the caller reconciles
  // this enumeration with pullRequest.changed_files before allowing a skip.
  let url = `${apiUrl}/repos/${repository}${resource}${resource.includes("?") ? "&" : "?"}per_page=100`;
  const values = [];
  while (url) {
    const response = await githubRequest(url, token);
    const page = await response.json();
    invariant(Array.isArray(page), `${resource} did not return a list`);
    values.push(...page);
    const links = response.headers.get("link") || "";
    const next = links
      .split(",")
      .map((entry) => entry.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/))
      .find((entry) => entry?.[2] === "next");
    url = next?.[1] || "";
  }
  return values;
}

async function main() {
  const args = parseCliArgs(
    process.argv.slice(2),
    new Set(["target"]),
  );
  if (!args.target) {
    throw new Error("--target is required");
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const outputPath = process.env.GITHUB_OUTPUT;
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  invariant(eventPath, "GITHUB_EVENT_PATH is required");
  invariant(outputPath, "GITHUB_OUTPUT is required");
  invariant(token, "GITHUB_TOKEN is required");

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const workflowRun = event.workflow_run;
  invariant(event?.action === "completed", "workflow_run action must be completed");
  invariant(
    event?.repository?.full_name === repository,
    "workflow_run repository does not match GITHUB_REPOSITORY",
  );
  invariant(workflowRun?.name === UPSTREAM_WORKFLOW, "unexpected upstream workflow");
  invariant(
    workflowRun?.path === UPSTREAM_WORKFLOW_PATH,
    "unexpected upstream workflow path",
  );
  invariant(
    workflowRun?.event === "pull_request",
    "trusted evaluation only accepts pull_request validation runs",
  );
  const eventHeadSha = validateCommit(
    workflowRun.head_sha,
    "workflow_run.head_sha",
  );
  const eventHeadRepository = validateRepository(
    workflowRun.head_repository?.full_name,
    "workflow_run.head_repository",
  );
  const eventHeadRef = validateGitBranch(
    workflowRun.head_branch,
    "workflow_run.head_branch",
  );
  const headOwner = eventHeadRepository.split("/")[0];
  const headFilter = encodeURIComponent(`${headOwner}:${eventHeadRef}`);
  const candidatePullRequests = await githubGetAll(
    apiUrl,
    repository,
    `/pulls?state=open&head=${headFilter}`,
    token,
  );
  const currentCandidates = candidatePullRequests.filter(
    (candidate) =>
      candidate?.state === "open" &&
      candidate.head?.sha === eventHeadSha &&
      candidate.head?.ref === eventHeadRef &&
      candidate.head?.repo?.full_name === eventHeadRepository &&
      candidate.base?.repo?.full_name === repository,
  );
  invariant(
    currentCandidates.length === 1,
    "workflow_run head does not identify exactly one current pull request",
  );

  const target = await readJson(args.target, "validation target");
  const prNumber = Number(target.pullRequest);
  invariant(Number.isSafeInteger(prNumber) && prNumber > 0, "invalid pull request number");
  invariant(
    prNumber === currentCandidates[0].number,
    "validation target selected a different pull request",
  );

  const [pullRequest, changedFiles] = await Promise.all([
    githubGet(apiUrl, repository, `/pulls/${prNumber}`, token),
    githubGetAll(
      apiUrl,
      repository,
      `/pulls/${prNumber}/files`,
      token,
    ),
  ]);
  const resolved = validateTrustedTarget({
    event,
    target,
    candidatePullRequests,
    pullRequest,
    changedFiles,
    repository,
  });
  await appendFile(
    outputPath,
    [
      `commit_sha=${resolved.commitSha}`,
      `pr_number=${resolved.pullRequest}`,
      `head_repository=${resolved.headRepository}`,
      `pr_url=${resolved.pullRequestUrl}`,
      `requires_model_eval=${resolved.modelEvaluationRequired}`,
      "",
    ].join("\n"),
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`trusted-eval-policy: ${error.message}`);
    process.exitCode = 1;
  });
}
