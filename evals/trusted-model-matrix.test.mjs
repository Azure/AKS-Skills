import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import yaml from "js-yaml";

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const WORKFLOW_PATH = path.join(
  path.dirname(EVALS_DIR),
  ".github",
  "workflows",
  "trusted-skill-eval.yml",
);

async function trustedWorkflow() {
  const source = await readFile(WORKFLOW_PATH, "utf8");
  return { source, parsed: yaml.load(source) };
}

async function executeResultScript(script, cellId, env) {
  const root = await mkdtemp(path.join(tmpdir(), "aks-model-result-"));
  const resultDir = path.join(root, "results");
  try {
    await execFile("bash", ["-c", script], {
      env: {
        ...process.env,
        RESULT_DIR: resultDir,
        GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
        CELL_ID: cellId,
        ...env,
      },
    });
    return JSON.parse(
      await readFile(path.join(resultDir, `${cellId}.json`), "utf8"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("native matrix expands every deployable GPT-5.6 assignment independently", async () => {
  const { parsed } = await trustedWorkflow();
  const evaluate = parsed.jobs.evaluate;
  assert.equal(evaluate.strategy["fail-fast"], false);
  assert.deepEqual(evaluate.strategy.matrix.include, [
    {
      id: "gpt-5-6-sol",
      availability: "supported",
      generator_model: "gpt-5.6-sol",
      judge_model: "gpt-5.6-terra",
    },
    {
      id: "gpt-5-6-luna",
      availability: "supported",
      generator_model: "gpt-5.6-luna",
      judge_model: "gpt-5.6-terra",
    },
    {
      id: "gpt-5-6-terra",
      availability: "supported",
      generator_model: "gpt-5.6-terra",
      judge_model: "gpt-5.6-sol",
    },
  ]);
  assert.match(evaluate.name, /\$\{\{ matrix\.id \}\}/);
  assert.match(evaluate.concurrency.group, /\$\{\{ matrix\.id \}\}/);
});

test("every supported generator has an explicit distinct deployable judge", async () => {
  const { parsed } = await trustedWorkflow();
  const supported = parsed.jobs.evaluate.strategy.matrix.include;
  const deployable = new Set(supported.map((entry) => entry.generator_model));
  for (const entry of supported) {
    assert.notEqual(entry.generator_model, entry.judge_model, entry.id);
    assert.equal(deployable.has(entry.judge_model), true, entry.id);
  }
  assert.deepEqual(
    Object.fromEntries(
      supported.map((entry) => [entry.generator_model, entry.judge_model]),
    ),
    {
      "gpt-5.6-sol": "gpt-5.6-terra",
      "gpt-5.6-luna": "gpt-5.6-terra",
      "gpt-5.6-terra": "gpt-5.6-sol",
    },
  );
});

test("unprovisioned Opus deployments are classified instead of evaluated", async () => {
  const { parsed } = await trustedWorkflow();
  const unavailable = parsed.jobs.unavailable;
  assert.equal(unavailable.strategy["fail-fast"], false);
  assert.deepEqual(unavailable.permissions, {});
  assert.equal(Object.hasOwn(unavailable, "environment"), false);
  assert.deepEqual(unavailable.strategy.matrix.include, [
    {
      id: "claude-opus-5",
      availability: "unavailable",
      deployment_model: "claude-opus-5",
      reason: "not-provisioned",
    },
    {
      id: "claude-opus-4-8",
      availability: "unavailable",
      deployment_model: "claude-opus-4-8",
      reason: "not-provisioned",
    },
  ]);
  assert.equal(
    unavailable.steps.some((step) => step.uses?.startsWith("azure/login@")),
    false,
  );
});

test("each cell records identity and a typed advisory result", async () => {
  const { source, parsed } = await trustedWorkflow();
  const evaluate = parsed.jobs.evaluate;
  const run = evaluate.steps.find(
    (step) => step.name === "Run advisory quality and routing evaluations",
  );
  assert.equal(run.env.EVAL_PROVIDER, "foundry");
  assert.equal(run.env.EVAL_PROTOCOL, "openai");
  assert.equal(run.env.EVAL_MODEL, "${{ matrix.generator_model }}");
  assert.equal(run.env.EVAL_JUDGE_MODEL, "${{ matrix.judge_model }}");
  assert.equal(Object.hasOwn(run.env, "EVAL_JUDGE_PROVIDER"), false);
  assert.equal(Object.hasOwn(run.env, "EVAL_JUDGE_PROTOCOL"), false);

  const record = evaluate.steps.find(
    (step) => step.name === "Record advisory cell identity and result",
  );
  assert.equal(record.if, "always()");
  assert.match(record.run, /evaluation-failed/);
  assert.match(record.run, /infrastructure-error/);
  assert.match(record.run, /\["token", process\.env\.TOKEN_OUTCOME\]/);
  assert.match(record.run, /generatorModel/);
  assert.match(record.run, /judgeModel/);

  const upload = evaluate.steps.find(
    (step) => step.name === "Upload advisory cell result",
  );
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.name, "advisory-model-result-${{ matrix.id }}");
  assert.match(upload.with.path, /\$\{\{ matrix\.id \}\}\.json$/);

  const summary = parsed.jobs.advisory_summary;
  assert.deepEqual(summary.needs, ["resolve", "evaluate", "unavailable"]);
  assert.match(source, /result artifact missing or invalid/);
  assert.match(source, /evaluation failed/);
  assert.match(source, /infrastructure error/);
  assert.match(source, /unavailable/);
});

test("supported cell result script distinguishes eval and infrastructure failures", async (t) => {
  const { parsed } = await trustedWorkflow();
  const record = parsed.jobs.evaluate.steps.find(
    (step) => step.name === "Record advisory cell identity and result",
  );
  const base = {
    AVAILABILITY: "supported",
    GENERATOR_MODEL: "gpt-5.6-sol",
    JUDGE_MODEL: "gpt-5.6-terra",
    CONFIGURATION_OUTCOME: "success",
    CHECKOUT_OUTCOME: "success",
    SETUP_OUTCOME: "success",
    INSTALL_OUTCOME: "success",
    LOGIN_OUTCOME: "success",
    TOKEN_OUTCOME: "success",
  };
  const cases = [
    {
      name: "passing evaluation",
      env: { ...base, EVALUATION_OUTCOME: "success" },
      status: "passed",
    },
    {
      name: "failed evaluation",
      env: { ...base, EVALUATION_OUTCOME: "failure" },
      status: "evaluation-failed",
    },
    {
      name: "token infrastructure failure",
      env: {
        ...base,
        TOKEN_OUTCOME: "failure",
        EVALUATION_OUTCOME: "skipped",
      },
      status: "infrastructure-error",
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const result = await executeResultScript(
        record.run,
        "gpt-5-6-sol",
        fixture.env,
      );
      assert.equal(result.status, fixture.status);
      assert.equal(result.generatorModel, "gpt-5.6-sol");
      assert.equal(result.judgeModel, "gpt-5.6-terra");
    });
  }
});

test("unavailable cell result script records not-provisioned identity", async () => {
  const { parsed } = await trustedWorkflow();
  const record = parsed.jobs.unavailable.steps.find(
    (step) => step.name === "Record unavailable deployment",
  );
  const result = await executeResultScript(record.run, "claude-opus-5", {
    AVAILABILITY: "unavailable",
    DEPLOYMENT_MODEL: "claude-opus-5",
    REASON: "not-provisioned",
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    cellId: "claude-opus-5",
    availability: "unavailable",
    generatorModel: "claude-opus-5",
    judgeModel: null,
    status: "unavailable",
    detail: "not-provisioned",
  });
});

test("summary renders pass, eval failure, infrastructure, and unavailable separately", async () => {
  const { parsed } = await trustedWorkflow();
  const script = parsed.jobs.advisory_summary.steps.find(
    (step) => step.name === "Publish advisory matrix summary",
  ).with.script;
  const root = await mkdtemp(path.join(tmpdir(), "aks-model-summary-"));
  const results = [
    {
      schemaVersion: 1,
      cellId: "gpt-5-6-sol",
      availability: "supported",
      generatorModel: "gpt-5.6-sol",
      judgeModel: "gpt-5.6-terra",
      status: "passed",
      detail: "quality and routing evaluations passed",
    },
    {
      schemaVersion: 1,
      cellId: "gpt-5-6-luna",
      availability: "supported",
      generatorModel: "gpt-5.6-luna",
      judgeModel: "gpt-5.6-terra",
      status: "evaluation-failed",
      detail: "quality or routing evaluation failed",
    },
    {
      schemaVersion: 1,
      cellId: "claude-opus-5",
      availability: "unavailable",
      generatorModel: "claude-opus-5",
      judgeModel: null,
      status: "unavailable",
      detail: "not-provisioned",
    },
    {
      schemaVersion: 1,
      cellId: "claude-opus-4-8",
      availability: "unavailable",
      generatorModel: "claude-opus-4-8",
      judgeModel: null,
      status: "unavailable",
      detail: "not-provisioned",
    },
  ];
  try {
    await Promise.all(
      results.map((result) =>
        writeFile(
          path.join(root, `${result.cellId}.json`),
          `${JSON.stringify(result)}\n`,
        ),
      ),
    );
    const tables = [];
    const summary = {
      addHeading() {
        return this;
      },
      addRaw() {
        return this;
      },
      addTable(table) {
        tables.push(table);
        return this;
      },
      async write() {
        return this;
      },
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction("require", "core", "process", script)(
      require,
      { summary },
      {
        env: {
          RESULTS_ROOT: root,
          DOWNLOAD_OUTCOME: "success",
          SUPPORTED_JOB_RESULT: "failure",
          UNAVAILABLE_JOB_RESULT: "success",
        },
      },
    );
    const rows = Object.fromEntries(
      tables[0].slice(1).map((row) => [row[0], row]),
    );
    assert.equal(rows["gpt-5-6-sol"][4], "passed");
    assert.equal(rows["gpt-5-6-luna"][4], "evaluation failed");
    assert.equal(rows["gpt-5-6-terra"][4], "infrastructure error");
    assert.equal(rows["claude-opus-5"][4], "unavailable");
    assert.equal(
      rows["gpt-5-6-terra"][5],
      "result artifact missing or invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matrix evidence is advisory and omits the deleted manifest aggregator", async () => {
  const { source, parsed } = await trustedWorkflow();
  assert.equal(Object.hasOwn(parsed.jobs, "prepare"), false);
  assert.equal(Object.hasOwn(parsed.jobs, "aggregate"), false);
  assert.deepEqual(parsed.jobs.finalize.needs, [
    "anchor",
    "resolve",
    "advisory_summary",
  ]);
  const publish = parsed.jobs.finalize.steps.find(
    (step) => step.name === "Publish exact-SHA check result",
  );
  assert.equal(
    publish.env.ADVISORY_RESULT,
    "${{ needs.advisory_summary.result }}",
  );
  assert.match(publish.run, /--advisory-result "\$ADVISORY_RESULT"/);
  assert.doesNotMatch(
    source,
    /trusted-model-matrix\.json|matrix_sha256|TRUSTED_MATRIX|aggregate-trusted-results|create-run-manifest|run-manifest|five-of-five|5-of-5/,
  );
});
