import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildEnvelope,
  loadScenario,
  sha256Digest,
  validateEnvelope,
} from "./server.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(DIR, "server.mjs");
const OBSERVED_AT = "2026-08-21T00:00:00Z";
const RAW_SECRET = "fixture-token-do-not-emit";

function outcome(overrides = {}) {
  return {
    result: "success",
    identity_kind: "user",
    authorization: "allowed",
    approval: "not-required",
    target: {
      azure: {
        tenant: "tenant-digest",
        subscription: "subscription-digest",
        resource_group: "rg-safe",
        cluster: "cluster-safe",
      },
      kubernetes: {
        context: "context-digest",
        namespace: "default",
      },
    },
    window: null,
    redaction_profile: "aks-evidence-v1",
    raw: {
      status: "Succeeded",
      count: 2,
      token: RAW_SECRET,
      connectionString: `Endpoint=x;Password=${RAW_SECRET}`,
      subscriptionId: "00000000-1111-2222-3333-444444444444",
      secret: { data: { password: "raw-password" } },
      configMap: { data: { endpoint: "raw-config-map-value" } },
    },
    safe_excerpt_paths: [
      "status",
      "count",
      "subscriptionId",
      "secret.data.password",
      "configMap.data.endpoint",
    ],
    fallback: { reason: null, target: null },
    ...overrides,
  };
}

function tool(alias, overrides = {}) {
  return {
    alias,
    semantic_capability: "azure.aks.cluster.read",
    provider: {
      id: "azure-mcp",
      version: "3.0.0-beta.32",
      published_operation: "aks cluster get",
    },
    operation_class: "read",
    supported_target: "AKS cluster in resolved Azure scope",
    supported_context: "advertised-tool-schema and azure-scope",
    input_schema: {
      type: "object",
      properties: { cluster: { type: "string" } },
      required: ["cluster"],
      additionalProperties: false,
    },
    expected_arguments: { cluster: "cluster-safe" },
    outcome: outcome(),
    ...overrides,
  };
}

function runFixture(scenario, requests) {
  const temp = mkdtempSync(path.join(tmpdir(), "aks-mcp-fixture-"));
  const scenarioPath = path.join(temp, "scenario.json");
  const logPath = path.join(temp, "nested", "invocations.jsonl");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const result = spawnSync(process.execPath, [SERVER], {
    encoding: "utf8",
    env: {
      ...process.env,
      AKS_SKILLS_MCP_SCENARIO_PATH: scenarioPath,
      AKS_SKILLS_MCP_INVOCATION_LOG_PATH: logPath,
    },
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
  });
  const responses = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const logs = (() => {
    try {
      return readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  })();
  rmSync(temp, { recursive: true, force: true });
  return { result, responses, logs };
}

function scenario(tools) {
  return { observed_at: OBSERVED_AT, tools };
}

function request(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

test("implements lifecycle, newline-delimited list, and call", () => {
  const advertised = tool("host_alias_7");
  const { result, responses } = runFixture(scenario([advertised]), [
    request(1, "initialize", { protocolVersion: "2024-11-05" }),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    request(2, "tools/list"),
    request(3, "tools/call", {
      name: advertised.alias,
      arguments: advertised.expected_arguments,
    }),
    request(4, "ping"),
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    responses.map(({ id }) => id),
    [1, 2, 3, 4],
  );
  assert.equal(responses[1].result.tools[0].name, "host_alias_7");
  assert.deepEqual(
    responses[1].result.tools[0].inputSchema,
    advertised.input_schema,
  );
  assert.match(
    responses[1].result.tools[0].description,
    /azure-mcp@3\.0\.0-beta\.32/,
  );
  assert.match(
    responses[1].result.tools[0].description,
    /Published operation: aks cluster get/,
  );
  assert.equal(responses[2].result.isError, false);
});

test("fails closed for unadvertised tools and non-exact arguments", () => {
  const advertised = tool("only_this_alias");
  const { responses, logs } = runFixture(scenario([advertised]), [
    request(1, "tools/call", {
      name: "missing_alias",
      arguments: advertised.expected_arguments,
    }),
    request(2, "tools/call", {
      name: advertised.alias,
      arguments: { cluster: "wrong-cluster" },
    }),
  ]);

  assert.equal(responses[0].result.isError, true);
  assert.equal(responses[1].result.isError, true);
  assert.match(responses[0].result.content[0].text, /unadvertised tool/);
  assert.match(responses[1].result.content[0].text, /did not exactly match/);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs, [
    {
      transport_alias: "missing_alias",
      semantic_capability: null,
      provider_id: null,
      provider_version: null,
      published_operation: null,
      accepted: false,
      arguments: null,
    },
    {
      transport_alias: "only_this_alias",
      semantic_capability: "azure.aks.cluster.read",
      provider_id: "azure-mcp",
      provider_version: "3.0.0-beta.32",
      published_operation: "aks cluster get",
      accepted: false,
      arguments: null,
    },
  ]);
});

test("rejected arguments never reach invocation logs", () => {
  const advertised = tool("reject_secret_alias");
  const { result, responses, logs } = runFixture(scenario([advertised]), [
    request(1, "tools/call", {
      name: advertised.alias,
      arguments: {
        cluster: "wrong-cluster",
        apiKey: "invalid-api-key-never-log",
        clientSecret: "invalid-client-secret-never-log",
        authorization: "Bearer invalid-token-never-log",
      },
    }),
  ]);

  const combined = `${result.stdout}\n${JSON.stringify(logs)}`;
  assert.equal(responses[0].result.isError, true);
  assert.doesNotMatch(combined, /invalid-api-key-never-log/);
  assert.doesNotMatch(combined, /invalid-client-secret-never-log/);
  assert.doesNotMatch(combined, /invalid-token-never-log/);
  assert.equal(logs[0].accepted, false);
  assert.equal(logs[0].arguments, null);
});

test("one-shot tools reject duplicate invocations", () => {
  const advertised = tool("one_shot_alias", { max_calls: 1 });
  const invocation = request(1, "tools/call", {
    name: advertised.alias,
    arguments: advertised.expected_arguments,
  });
  const { responses, logs } = runFixture(scenario([advertised]), [
    invocation,
    { ...invocation, id: 2 },
  ]);

  assert.equal(responses[0].result.isError, false);
  assert.equal(responses[1].result.isError, true);
  assert.match(responses[1].result.content[0].text, /invocation limit exceeded/);
  assert.equal(logs[0].accepted, true);
  assert.equal(logs[1].accepted, false);
  assert.equal(logs[1].arguments, null);
});

test("advertises scenario aliases without changing canonical provider metadata", () => {
  const first = tool("azure_mcp_randomized_11");
  const second = tool("host__generated__aks", {
    semantic_capability: "kubernetes.resources.read",
    provider: {
      id: "aks-mcp",
      version: "0.0.20",
      published_operation: "call_kubectl",
    },
    supported_context: "kubeconfig-context and namespace",
  });
  const { responses } = runFixture(scenario([first, second]), [
    request(1, "tools/list"),
  ]);

  const listed = responses[0].result.tools;
  assert.deepEqual(
    listed.map(({ name }) => name),
    ["azure_mcp_randomized_11", "host__generated__aks"],
  );
  assert.match(listed[0].description, /azure\.aks\.cluster\.read/);
  assert.match(listed[1].description, /aks-mcp@0\.0\.20/);
  assert.match(listed[1].description, /Published operation: call_kubectl/);
});

test("returns deterministic envelopes and distinct fail-closed outcomes", () => {
  const denied = tool("mutation_alias", {
    semantic_capability: "kubernetes.resources.write",
    provider: {
      id: "aks-mcp",
      version: "0.0.20",
      published_operation: "call_kubectl",
    },
    operation_class: "write",
    outcome: outcome({
      result: "denied",
      authorization: "denied",
      approval: "denied",
      fallback: { reason: "authorization-denied", target: null },
    }),
  });
  const mismatch = tool("wrong_scope_alias", {
    outcome: outcome({
      result: "error",
      authorization: "context-mismatch",
      fallback: { reason: "context-mismatch", target: null },
    }),
  });
  const { responses } = runFixture(scenario([denied, mismatch]), [
    request(1, "tools/call", {
      name: denied.alias,
      arguments: denied.expected_arguments,
    }),
    request(2, "tools/call", {
      name: mismatch.alias,
      arguments: mismatch.expected_arguments,
    }),
  ]);

  const deniedEnvelope = JSON.parse(responses[0].result.content[0].text);
  const mismatchEnvelope = JSON.parse(responses[1].result.content[0].text);
  assert.equal(responses[0].result.isError, true);
  assert.equal(responses[1].result.isError, true);
  assert.deepEqual(Object.keys(deniedEnvelope), [
    "contract_version",
    "semantic_capability",
    "provider",
    "operation_mode",
    "target",
    "identity_kind",
    "observation",
    "authorization",
    "approval",
    "result",
    "redaction_profile",
    "source",
    "fallback",
  ]);
  assert.equal(deniedEnvelope.contract_version, "1.0");
  assert.equal(deniedEnvelope.operation_mode, "write");
  assert.equal(deniedEnvelope.result, "denied");
  assert.equal(deniedEnvelope.fallback.reason, "authorization-denied");
  assert.equal(deniedEnvelope.observation.observed_at, OBSERVED_AT);
  assert.equal(mismatchEnvelope.result, "error");
  assert.equal(mismatchEnvelope.authorization, "context-mismatch");
  assert.equal(mismatchEnvelope.fallback.reason, "context-mismatch");
});

test("loads every catalog scenario and preserves alias-independent provider metadata", () => {
  const catalogPath = path.join(DIR, "scenarios.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const originalScenarioId = process.env.AKS_SKILLS_MCP_SCENARIO_ID;

  try {
    for (const scenarioId of Object.keys(catalog.scenarios)) {
      process.env.AKS_SKILLS_MCP_SCENARIO_ID = scenarioId;
      const loaded = loadScenario(catalogPath);
      assert.ok(Array.isArray(loaded.tools), scenarioId);
      for (const advertised of loaded.tools) {
        validateEnvelope(buildEnvelope(advertised, loaded.observed_at));
      }
    }

    process.env.AKS_SKILLS_MCP_SCENARIO_ID = "azure-only-alpha";
    const alpha = loadScenario(catalogPath);
    process.env.AKS_SKILLS_MCP_SCENARIO_ID = "azure-only-zeta";
    const zeta = loadScenario(catalogPath);
    assert.deepEqual(
      alpha.tools.map((item) => [
        item.semantic_capability,
        item.provider.id,
        item.provider.version,
        item.provider.published_operation,
      ]),
      zeta.tools.map((item) => [
        item.semantic_capability,
        item.provider.id,
        item.provider.version,
        item.provider.published_operation,
      ]),
    );
    assert.notDeepEqual(
      alpha.tools.map(({ alias }) => alias),
      zeta.tools.map(({ alias }) => alias),
    );
  } finally {
    if (originalScenarioId === undefined) {
      delete process.env.AKS_SKILLS_MCP_SCENARIO_ID;
    } else {
      process.env.AKS_SKILLS_MCP_SCENARIO_ID = originalScenarioId;
    }
  }
});

test("catalog selection and generic provider errors fail closed", () => {
  const catalogPath = path.join(DIR, "scenarios.json");
  const originalScenarioId = process.env.AKS_SKILLS_MCP_SCENARIO_ID;
  try {
    delete process.env.AKS_SKILLS_MCP_SCENARIO_ID;
    assert.throws(
      () => loadScenario(catalogPath),
      /AKS_SKILLS_MCP_SCENARIO_ID is required/,
    );
    process.env.AKS_SKILLS_MCP_SCENARIO_ID = "missing";
    assert.throws(
      () => loadScenario(catalogPath),
      /does not contain "missing"/,
    );
  } finally {
    if (originalScenarioId === undefined) {
      delete process.env.AKS_SKILLS_MCP_SCENARIO_ID;
    } else {
      process.env.AKS_SKILLS_MCP_SCENARIO_ID = originalScenarioId;
    }
  }

  const errored = tool("provider_error", {
    outcome: outcome({
      result: "error",
      authorization: "allowed",
      fallback: { reason: null, target: null },
      raw: {
        status: "Error",
        finding: "provider returned a deterministic internal error",
      },
    }),
  });
  const { responses } = runFixture(scenario([errored]), [
    request(1, "tools/call", {
      name: errored.alias,
      arguments: errored.expected_arguments,
    }),
  ]);
  const envelope = JSON.parse(responses[0].result.content[0].text);
  assert.equal(responses[0].result.isError, true);
  assert.equal(envelope.result, "error");
  assert.equal(envelope.fallback.reason, null);
});

test("redacts secrets from evidence and invocation logs", () => {
  const advertised = tool("secret_safe_alias", {
    expected_arguments: {
      apiKey: "argument-api-key",
      cluster: "cluster-safe",
      password: "argument-password",
    },
  });
  const expectedDigest = sha256Digest(advertised.outcome.raw);
  const directEnvelope = buildEnvelope(advertised, OBSERVED_AT);
  const { result, responses, logs } = runFixture(scenario([advertised]), [
    request(1, "tools/call", {
      name: advertised.alias,
      arguments: advertised.expected_arguments,
    }),
  ]);

  const combined = `${result.stdout}\n${JSON.stringify(logs)}`;
  assert.doesNotMatch(combined, /fixture-token-do-not-emit/);
  assert.doesNotMatch(combined, /raw-password/);
  assert.doesNotMatch(combined, /raw-config-map-value/);
  assert.doesNotMatch(combined, /00000000-1111-2222-3333-444444444444/);
  assert.doesNotMatch(combined, /argument-password/);
  assert.doesNotMatch(combined, /argument-api-key/);
  assert.equal(
    directEnvelope.source.excerpt,
    [
      '{"configMap.data.endpoint":"[REDACTED]","count":2,',
      '"secret.data.password":"[REDACTED]","status":"Succeeded",',
      '"subscriptionId":"[REDACTED]"}',
    ].join(""),
  );
  assert.equal(directEnvelope.source.digest, expectedDigest);
  assert.equal(
    JSON.parse(responses[0].result.content[0].text).source.digest,
    expectedDigest,
  );
  assert.deepEqual(logs[0].arguments, {
    apiKey: "[REDACTED]",
    cluster: "cluster-safe",
    password: "[REDACTED]",
  });
  assert.deepEqual(logs[0], {
    transport_alias: "secret_safe_alias",
    semantic_capability: "azure.aks.cluster.read",
    provider_id: "azure-mcp",
    provider_version: "3.0.0-beta.32",
    published_operation: "aks cluster get",
    accepted: true,
    arguments: {
      apiKey: "[REDACTED]",
      cluster: "cluster-safe",
      password: "[REDACTED]",
    },
  });
});
