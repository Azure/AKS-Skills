import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import {
  TRUSTED_CHECK_NAME,
  buildAnchorCheckRequest,
  buildCheckUpdateRequest,
  finalCheckConclusion,
  validateAnchoredCheck,
  validateWorkflowRunAnchor,
} from "./scripts/publish-trusted-check.mjs";
import { requiredEvaluationFailures } from "./scripts/run-trusted-evals.mjs";
import {
  requiresModelEvaluation,
  validateTrustedTarget,
} from "./scripts/trusted-eval-policy.mjs";

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(EVALS_DIR);

async function workflow(name) {
  const source = await readFile(
    path.join(REPO_DIR, ".github", "workflows", name),
    "utf8",
  );
  return { source, parsed: yaml.load(source) };
}

function assertPinnedActions(parsed) {
  for (const job of Object.values(parsed.jobs || {})) {
    for (const step of job.steps || []) {
      if (!step.uses) continue;
      assert.match(
        step.uses,
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/,
        `${step.uses} must be pinned to an immutable full commit SHA`,
      );
    }
  }
}

function assertNoActionsExpressionsInRun(parsed, workflowName) {
  for (const [jobName, job] of Object.entries(parsed.jobs || {})) {
    for (const step of job.steps || []) {
      if (!step.run) continue;
      assert.doesNotMatch(
        step.run,
        /\$\{\{/,
        `${workflowName}:${jobName}:${step.name || "(unnamed)"} must pass Actions values through env`,
      );
    }
  }
}

function trustedFixtures() {
  const sha = "a".repeat(40);
  const target = {
    schemaVersion: 1,
    repository: "Azure/AKS-Skills",
    pullRequest: 68,
    head: {
      sha,
      ref: "feature",
      repository: "contributor/AKS-Skills",
    },
    base: {
      sha: "b".repeat(40),
      ref: "main",
      repository: "Azure/AKS-Skills",
    },
    workflow: { runId: "101", runAttempt: "1" },
  };
  const event = {
    action: "completed",
    repository: { full_name: "Azure/AKS-Skills" },
    workflow_run: {
      id: 101,
      run_attempt: 1,
      head_sha: sha,
      name: "Skill Evaluation",
      path: ".github/workflows/skill-eval.yml",
      event: "pull_request",
      conclusion: "success",
      head_branch: "feature",
      head_repository: { full_name: "contributor/AKS-Skills" },
      pull_requests: [],
    },
  };
  const pullRequest = {
    number: 68,
    state: "open",
    changed_files: 1,
    html_url: "https://github.com/Azure/AKS-Skills/pull/68",
    head: {
      sha,
      ref: "feature",
      repo: { full_name: "contributor/AKS-Skills" },
    },
    base: {
      ref: "main",
      repo: { full_name: "Azure/AKS-Skills" },
    },
  };
  return {
    target,
    event,
    candidatePullRequests: [structuredClone(pullRequest)],
    pullRequest,
    changedFiles: [{ filename: "evals/promptfooconfig.yaml" }],
  };
}

function resolveTarget(fixtures) {
  return validateTrustedTarget({
    ...fixtures,
    repository: "Azure/AKS-Skills",
  });
}

test("untrusted pull requests remain deterministic and secret-free", async () => {
  const { source, parsed } = await workflow("skill-eval.yml");
  assert.equal(parsed.name, "Skill Evaluation");
  assert.ok(Object.hasOwn(parsed.on, "pull_request"));
  assert.deepEqual(parsed.permissions, { contents: "read" });
  assertPinnedActions(parsed);
  assertNoActionsExpressionsInRun(parsed, "skill-eval.yml");
  assert.doesNotMatch(source, /\bsecrets\./);
  assert.doesNotMatch(
    source,
    /AZURE_OPENAI|FOUNDRY_(?:API_KEY|ACCESS_TOKEN)|OPENAI_API_KEY|promptfoo eval/,
  );
  assert.doesNotMatch(source, /pull_request_target|continue-on-error|\|\| true/);
  assert.match(source, /record-validation-target\.mjs/);
  assert.match(source, /github\.event\.pull_request\.head\.sha/);
  assert.match(
    source,
    /name: validation-target-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
});

test("trusted workflow keeps the approval, OIDC, exact-SHA, and fail-closed boundaries", async () => {
  const { source, parsed } = await workflow("trusted-skill-eval.yml");
  assert.deepEqual(parsed.on.workflow_run.workflows, ["Skill Evaluation"]);
  assert.deepEqual(parsed.on.workflow_run.types, ["completed"]);
  assert.deepEqual(parsed.permissions, {});
  assertPinnedActions(parsed);
  assertNoActionsExpressionsInRun(parsed, "trusted-skill-eval.yml");

  const { anchor, resolve, evaluate, finalize } = parsed.jobs;
  assert.deepEqual(anchor.permissions, { checks: "write" });
  assert.match(
    anchor.steps[0].with.script,
    /run\?\.path !== '\.github\/workflows\/skill-eval\.yml'/,
  );
  assert.match(anchor.steps[0].with.script, /head_sha: run\.head_sha/);
  assert.match(anchor.steps[0].with.script, /conclusion: 'failure'/);
  assert.equal(resolve.needs, "anchor");
  assert.deepEqual(resolve.permissions, {
    actions: "read",
    contents: "read",
    "pull-requests": "read",
  });
  assert.match(
    source,
    /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/,
  );
  assert.match(
    source,
    /name: validation-target-\$\{\{ github\.event\.workflow_run\.id \}\}-\$\{\{ github\.event\.workflow_run\.run_attempt \}\}/,
  );

  assert.equal(evaluate.environment.name, "trusted-skill-eval");
  assert.deepEqual(evaluate.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.match(
    source,
    /repository: \$\{\{ needs\.resolve\.outputs\.head_repository \}\}/,
  );
  assert.match(source, /ref: \$\{\{ needs\.resolve\.outputs\.commit_sha \}\}/);
  const trustedSetupNode = evaluate.steps.find(
    (step) => step.name === "Setup Node.js",
  );
  assert.deepEqual(trustedSetupNode.with, { "node-version": "22" });
  assert.equal(Object.hasOwn(trustedSetupNode.with, "cache"), false);
  assert.match(
    source,
    /az account get-access-token --scope https:\/\/ai\.azure\.com\/\.default/,
  );
  assert.match(source, /EVAL_PROVIDER: foundry/);
  assert.match(source, /EVAL_REQUIRE_FOUNDRY: '1'/);
  assert.match(source, /run-trusted-evals\.mjs/);
  assert.doesNotMatch(
    source,
    /create-run-manifest|run-manifest|generate-report|trusted-skill-eval-\$\{\{|EVAL_JUDGE_PROVIDER|EVAL_JUDGE_PROTOCOL|generator and judge models must be distinct/,
  );

  assert.equal(finalize.if, "always()");
  assert.deepEqual(finalize.needs, ["anchor", "resolve", "evaluate"]);
  assert.deepEqual(finalize.permissions, {
    checks: "write",
    contents: "read",
    "pull-requests": "read",
  });
  assert.match(source, /publish-trusted-check\.mjs/);
  assert.doesNotMatch(source, /pull_request_target|\bsecrets\./);
});

test("a decoy workflow with the Skill Evaluation display name is rejected everywhere", async () => {
  const fixtures = trustedFixtures();
  fixtures.event.workflow_run.path = ".github/workflows/decoy.yml";

  const { parsed } = await workflow("trusted-skill-eval.yml");
  const anchorScript = parsed.jobs.anchor.steps[0].with.script;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await assert.rejects(
    new AsyncFunction("github", "context", "core", anchorScript)(
      {
        rest: {
          checks: {
            create: async () => {
              throw new Error("decoy reached Checks API");
            },
          },
        },
      },
      {
        payload: fixtures.event,
        repo: { owner: "Azure", repo: "AKS-Skills" },
        serverUrl: "https://github.com",
        runId: 999,
      },
      { setOutput() {} },
    ),
    /cannot establish a trusted pull-request head/,
  );

  assert.throws(() => resolveTarget(fixtures), /unexpected upstream workflow path/);
  assert.throws(
    () => validateWorkflowRunAnchor(fixtures.event, "Azure/AKS-Skills"),
    /unexpected upstream workflow path/,
  );
});

test("all workflow files are model-sensitive, including additions and renames", () => {
  assert.equal(
    requiresModelEvaluation(
      [{ filename: ".github/workflows/decoy.yml" }],
      1,
    ),
    true,
  );
  assert.equal(
    requiresModelEvaluation(
      [
        {
          filename: "docs/retired-workflow.md",
          previous_filename: ".github/workflows/retired.yml",
        },
      ],
      1,
    ),
    true,
  );
  assert.equal(
    requiresModelEvaluation([{ filename: "docs/skill-contract.md" }], 1),
    false,
  );
  assert.equal(
    requiresModelEvaluation([{ filename: "docs/only.md" }], 2),
    true,
    "an incomplete file enumeration must fail closed",
  );
});

test("target resolution binds the exact run, PR, repository, ref, and commit", () => {
  const valid = trustedFixtures();
  const resolved = resolveTarget(valid);
  assert.equal(resolved.commitSha, valid.target.head.sha);
  assert.equal(resolved.pullRequest, 68);
  assert.equal(resolved.headRepository, "contributor/AKS-Skills");
  assert.equal(resolved.modelEvaluationRequired, true);

  const wrongRun = trustedFixtures();
  wrongRun.target.workflow.runId = "102";
  assert.throws(() => resolveTarget(wrongRun), /different workflow run/);

  const wrongPr = trustedFixtures();
  wrongPr.target.pullRequest = 99;
  assert.throws(
    () => resolveTarget(wrongPr),
    /platform-resolved current head/,
  );

  const wrongCommit = trustedFixtures();
  wrongCommit.target.head.sha = "c".repeat(40);
  assert.throws(
    () => resolveTarget(wrongCommit),
    /workflow_run\.head_sha/,
  );

  const stalePr = trustedFixtures();
  stalePr.pullRequest.head.sha = "d".repeat(40);
  assert.throws(() => resolveTarget(stalePr), /head changed/);

  const ambiguous = trustedFixtures();
  ambiguous.candidatePullRequests.push(
    structuredClone(ambiguous.candidatePullRequests[0]),
  );
  assert.throws(
    () => resolveTarget(ambiguous),
    /exactly one current pull request/,
  );
});

test("pull request URLs are validated before becoming workflow output", () => {
  const valid = resolveTarget(trustedFixtures());
  assert.equal(
    valid.pullRequestUrl,
    "https://github.com/Azure/AKS-Skills/pull/68",
  );

  const newline = trustedFixtures();
  newline.pullRequest.html_url =
    "https://github.com/Azure/AKS-Skills/pull/68\nrequires_model_eval=false";
  assert.throws(() => resolveTarget(newline), /pull request URL is invalid/);

  const external = trustedFixtures();
  external.pullRequest.html_url = "https://example.com/Azure/AKS-Skills/pull/68";
  assert.throws(() => resolveTarget(external), /pull request URL is invalid/);
});

test("trusted checks start failed and promote only complete valid outcomes", () => {
  const fixtures = trustedFixtures();
  const { anchor, request } = buildAnchorCheckRequest({
    event: fixtures.event,
    repository: "Azure/AKS-Skills",
    runUrl: "https://github.com/Azure/AKS-Skills/actions/runs/123",
  });
  assert.equal(request.name, TRUSTED_CHECK_NAME);
  assert.equal(request.head_sha, fixtures.event.workflow_run.head_sha);
  assert.equal(request.conclusion, "failure");
  assert.equal(request.external_id, "trusted-skill-eval:101:1");
  assert.equal(anchor.commit, fixtures.event.workflow_run.head_sha);

  const failures = [
    {
      upstreamConclusion: "failure",
      resolveResult: "skipped",
      evaluateResult: "skipped",
      modelRequired: null,
    },
    {
      upstreamConclusion: "success",
      resolveResult: "failure",
      evaluateResult: "skipped",
      modelRequired: null,
    },
    {
      upstreamConclusion: "success",
      resolveResult: "success",
      evaluateResult: "failure",
      modelRequired: true,
    },
    {
      upstreamConclusion: "success",
      resolveResult: "success",
      evaluateResult: "cancelled",
      modelRequired: true,
    },
    {
      upstreamConclusion: "success",
      resolveResult: "success",
      evaluateResult: "skipped",
      modelRequired: true,
    },
  ];
  for (const outcome of failures) {
    assert.equal(finalCheckConclusion(outcome), "failure");
  }

  assert.equal(
    finalCheckConclusion({
      upstreamConclusion: "success",
      resolveResult: "success",
      evaluateResult: "success",
      modelRequired: true,
    }),
    "success",
  );
  assert.equal(
    finalCheckConclusion({
      upstreamConclusion: "success",
      resolveResult: "success",
      evaluateResult: "skipped",
      modelRequired: false,
    }),
    "success",
  );

  const failedUpdate = buildCheckUpdateRequest({
    ...failures[2],
    runUrl: "https://github.com/Azure/AKS-Skills/actions/runs/123",
  });
  assert.equal(failedUpdate.conclusion, "failure");
});

test("final promotion validates the original check identity", () => {
  const expected = {
    checkId: "123",
    commit: "d".repeat(40),
    externalId: "trusted-skill-eval:101:1",
  };
  const check = {
    id: 123,
    name: TRUSTED_CHECK_NAME,
    head_sha: expected.commit,
    external_id: expected.externalId,
    app: { slug: "github-actions" },
  };
  assert.equal(validateAnchoredCheck(check, expected), check);
  assert.throws(
    () =>
      validateAnchoredCheck(
        { ...check, head_sha: "e".repeat(40) },
        expected,
      ),
    /head SHA mismatch/,
  );
  assert.throws(
    () =>
      validateAnchoredCheck(
        { ...check, external_id: "attacker-selected" },
        expected,
      ),
    /external ID mismatch/,
  );
});

test("required quality and routing failures remain blocking", () => {
  const passing = [
    { id: "quality", exitCode: 0 },
    { id: "routing", exitCode: 0 },
  ];
  assert.deepEqual(requiredEvaluationFailures(passing), []);
  assert.deepEqual(
    requiredEvaluationFailures([{ id: "quality", exitCode: 1 }, passing[1]]),
    ["quality: promptfoo exited 1"],
  );
  assert.deepEqual(
    requiredEvaluationFailures([passing[0]]),
    ["routing: no execution record"],
  );
});

test("package wiring and providers omit deleted provenance and judge mandates", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(EVALS_DIR, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["test:ci-policy"],
    "node --test workflow-policy.test.mjs",
  );
  assert.equal(packageJson.scripts.lint, "node lint-skills.js");
  assert.equal(packageJson.scripts["lint:selftest"], "node lint-skills.test.js");
  const { parsed: skillEval } = await workflow("skill-eval.yml");
  const runCommands = skillEval.jobs.eval.steps
    .map((step) => step.run)
    .filter(Boolean);
  assert.equal(runCommands.filter((run) => run === "npm run lint").length, 1);
  assert.equal(
    runCommands.filter((run) => run === "npm run lint:selftest").length,
    1,
  );
  assert.equal(
    runCommands.filter((run) => run === "npm run test:ci-policy").length,
    1,
  );
  for (const removed of [
    "test:report-provenance",
    "test:provider-adapter",
    "lint:promptfoo",
  ]) {
    assert.equal(Object.hasOwn(packageJson.scripts, removed), false);
  }
  for (const removedPath of [
    "provider-adapter.test.mjs",
    "report-provenance.test.mjs",
    "scripts/create-run-manifest.mjs",
  ]) {
    assert.equal(existsSync(path.join(EVALS_DIR, removedPath)), false);
  }

  const [judge, client] = await Promise.all([
    readFile(path.join(EVALS_DIR, "providers", "judge-provider.js"), "utf8"),
    readFile(path.join(EVALS_DIR, "providers", "llm-client.js"), "utf8"),
  ]);
  assert.match(
    judge,
    /process\.env\.EVAL_JUDGE_MODEL \|\| process\.env\.EVAL_MODEL/,
  );
  assert.doesNotMatch(judge, /EVAL_JUDGE_PROVIDER|EVAL_JUDGE_PROTOCOL|resolveJudgeIdentity/);
  assert.doesNotMatch(client, /opts\.provider|opts\.protocol|providerOverride|protocolOverride/);
  assert.match(client, /https:\/\/ai\.azure\.com\/\.default/);
});

test("simple report renderer keeps backslash-before-pipe escaping", async () => {
  const source = await readFile(
    path.join(EVALS_DIR, "scripts", "generate-report.mjs"),
    "utf8",
  );
  const backslashEscape = source.indexOf(".replace(/\\\\/g, '\\\\\\\\')");
  const pipeEscape = source.indexOf(".replace(/\\|/g, '\\\\|')");
  assert.notEqual(backslashEscape, -1);
  assert.notEqual(pipeEscape, -1);
  assert.ok(backslashEscape < pipeEscape);
  assert.doesNotMatch(source, /run-manifest|skill_files|sha256File/);
});

test("retained workflows use immutable actions and least permissions", async () => {
  const workflowNames = (
    await readdir(path.join(REPO_DIR, ".github", "workflows"))
  ).filter((name) => name.endsWith(".yml"));
  for (const name of workflowNames) {
    const { parsed } = await workflow(name);
    assertPinnedActions(parsed);
  }
  const scripts = await workflow("scripts.yml");
  assert.deepEqual(scripts.parsed.permissions, { contents: "read" });
});
