#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const SCENARIO_ENV = "AKS_SKILLS_MCP_SCENARIO_PATH";
export const SCENARIO_ID_ENV = "AKS_SKILLS_MCP_SCENARIO_ID";
export const INVOCATION_LOG_ENV = "AKS_SKILLS_MCP_INVOCATION_LOG_PATH";

const RESULTS = new Set(["success", "denied", "unsupported", "error"]);
const SENSITIVE_KEY = new RegExp(
  [
    "(^|[_.-])(api.?key|bearer|client.?secret|config.?map|",
    "connection.?string|credential|kubeconfig|password|private.?key|secret|token)([_.-]|$)",
    "|(^|[_.-])(object|subscription|tenant|resource)(.?id)?([_.-]|$)",
  ].join(""),
  "i",
);

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function getPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function collectSensitiveValues(
  value,
  key = "",
  values = new Set(),
  sensitiveAncestor = false,
) {
  const sensitive = sensitiveAncestor || SENSITIVE_KEY.test(key);
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveValues(item, key, values, sensitive);
  } else if (value && typeof value === "object") {
    const sensitiveResource =
      typeof value.kind === "string" &&
      /^(ConfigMap|Secret)$/i.test(value.kind);
    for (const [childKey, child] of Object.entries(value)) {
      const resourceData =
        sensitiveResource && ["data", "stringData"].includes(childKey);
      collectSensitiveValues(
        child,
        childKey,
        values,
        sensitive || resourceData,
      );
    }
  } else if (sensitive && typeof value === "string" && value) {
    values.add(value);
  }
  return values;
}

function sanitize(value, sensitiveValues, key = "", sensitiveAncestor = false) {
  const sensitive = sensitiveAncestor || SENSITIVE_KEY.test(key);
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitize(item, sensitiveValues, key, sensitive),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitize(child, sensitiveValues, childKey, sensitive),
      ]),
    );
  }
  if (
    typeof value === "string" &&
    (sensitive || sensitiveValues.has(value))
  ) {
    return "[REDACTED]";
  }
  return value;
}

function safeExcerpt(raw, paths, sensitiveValues) {
  const projected = {};
  for (const path of paths) {
    const value = getPath(raw, path);
    if (value !== undefined) projected[path] = sanitize(value, sensitiveValues, path);
  }
  return canonicalize(projected);
}

function describeTool(tool) {
  return [
    `Semantic capability: ${tool.semantic_capability}.`,
    `Canonical provider: ${tool.provider.id}@${tool.provider.version}.`,
    `Published operation: ${tool.provider.published_operation}.`,
    `Operation class: ${tool.operation_class}.`,
    `Supported target: ${canonicalize(tool.supported_target)}.`,
    `Supported context: ${canonicalize(tool.supported_context)}.`,
    "The host-assigned tool name is transport/debug metadata only.",
  ].join(" ");
}

function validateScenario(scenario) {
  if (!scenario || typeof scenario !== "object") {
    throw new Error("scenario must be an object");
  }
  if (typeof scenario.observed_at !== "string") {
    throw new Error("scenario observed_at must be a string");
  }
  if (!Array.isArray(scenario.tools)) {
    throw new Error("scenario tools must be an array");
  }

  const aliases = new Set();
  for (const [index, tool] of scenario.tools.entries()) {
    const label = `tool ${index}`;
    if (typeof tool?.alias !== "string" || !tool.alias) {
      throw new Error(`${label} alias must be a non-empty string`);
    }
    if (aliases.has(tool.alias)) throw new Error(`duplicate tool alias: ${tool.alias}`);
    aliases.add(tool.alias);
    if (typeof tool.semantic_capability !== "string") {
      throw new Error(`${label} semantic_capability must be a string`);
    }
    for (const field of ["id", "version", "published_operation"]) {
      if (typeof tool.provider?.[field] !== "string") {
        throw new Error(`${label} provider.${field} must be a string`);
      }
    }
    if (!["read", "write", "privileged"].includes(tool.operation_class)) {
      throw new Error(`${label} operation_class is invalid`);
    }
    if (
      tool.max_calls !== undefined &&
      (!Number.isInteger(tool.max_calls) || tool.max_calls < 1)
    ) {
      throw new Error(`${label} max_calls must be an integer >= 1`);
    }
    if (!tool.input_schema || typeof tool.input_schema !== "object") {
      throw new Error(`${label} input_schema must be an object`);
    }
    if (!tool.expected_arguments || typeof tool.expected_arguments !== "object") {
      throw new Error(`${label} expected_arguments must be an object`);
    }
    if (!RESULTS.has(tool.outcome?.result)) {
      throw new Error(`${label} outcome.result is invalid`);
    }
    for (const field of [
      "identity_kind",
      "authorization",
      "approval",
      "redaction_profile",
    ]) {
      if (typeof tool.outcome[field] !== "string") {
        throw new Error(`${label} outcome.${field} must be a string`);
      }
    }
    if (!tool.outcome.target || typeof tool.outcome.target !== "object") {
      throw new Error(`${label} outcome.target must be an object`);
    }
    if (!Array.isArray(tool.outcome.safe_excerpt_paths)) {
      throw new Error(`${label} outcome.safe_excerpt_paths must be an array`);
    }
    if (
      tool.supported_target === undefined ||
      tool.supported_context === undefined
    ) {
      throw new Error(`${label} supported target and context are required`);
    }
  }
  return scenario;
}

export function loadScenario(path) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  const scenarioId = process.env[SCENARIO_ID_ENV];
  if (document.scenarios) {
    if (!scenarioId) {
      throw new Error(`${SCENARIO_ID_ENV} is required for a scenario catalog`);
    }
    if (!document.scenarios[scenarioId]) {
      throw new Error(`scenario catalog does not contain "${scenarioId}"`);
    }
    const selected = document.scenarios[scenarioId];
    const defaults = document.defaults ?? {};
    const scenario = {
      observed_at: selected.observed_at ?? defaults.observed_at,
      tools: (selected.tools ?? []).map((entry) => {
        const templateName = entry.$template;
        const template = templateName
          ? document.tool_templates?.[templateName]
          : {};
        if (templateName && !template) {
          throw new Error(`unknown tool template "${templateName}"`);
        }
        const { $template: _template, ...overrides } = entry;
        return deepMerge(deepMerge(defaults.tool ?? {}, template), overrides);
      }),
    };
    return validateScenario(scenario);
  }
  if (scenarioId) {
    throw new Error(`${SCENARIO_ID_ENV} requires a scenario catalog`);
  }
  return validateScenario(document);
}

function deepMerge(base, override) {
  if (
    !base ||
    typeof base !== "object" ||
    Array.isArray(base) ||
    !override ||
    typeof override !== "object" ||
    Array.isArray(override)
  ) {
    return override === undefined ? base : override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge(base[key], value);
  }
  return merged;
}

export function validateEnvelope(envelope) {
  const required = [
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
  ];
  for (const field of required) {
    if (!(field in envelope)) throw new Error(`evidence envelope missing ${field}`);
  }
  for (const field of ["id", "version", "published_operation"]) {
    if (typeof envelope.provider?.[field] !== "string") {
      throw new Error(`evidence envelope provider.${field} must be a string`);
    }
  }
  if (!["read", "write", "privileged"].includes(envelope.operation_mode)) {
    throw new Error("evidence envelope operation_mode is invalid");
  }
  if (!RESULTS.has(envelope.result)) {
    throw new Error("evidence envelope result is invalid");
  }
  if (
    typeof envelope.observation?.observed_at !== "string" ||
    !("window" in envelope.observation)
  ) {
    throw new Error("evidence envelope observation is incomplete");
  }
  if (
    typeof envelope.source?.excerpt !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(envelope.source?.digest)
  ) {
    throw new Error("evidence envelope source is incomplete");
  }
  if (!("reason" in envelope.fallback) || !("target" in envelope.fallback)) {
    throw new Error("evidence envelope fallback is incomplete");
  }
  return envelope;
}

export function buildEnvelope(tool, observedAt) {
  const raw = tool.outcome.raw ?? null;
  const sensitiveValues = collectSensitiveValues(raw);
  for (const value of tool.outcome.secret_values ?? []) {
    if (typeof value === "string" && value) sensitiveValues.add(value);
  }

  const envelope = {
    contract_version: "1.0",
    semantic_capability: tool.semantic_capability,
    provider: {
      id: tool.provider.id,
      version: tool.provider.version,
      published_operation: tool.provider.published_operation,
      host_alias_debug: tool.alias,
    },
    operation_mode: tool.operation_class,
    target: {
      azure: tool.outcome.target?.azure ?? null,
      kubernetes: tool.outcome.target?.kubernetes ?? null,
    },
    identity_kind: tool.outcome.identity_kind,
    observation: {
      observed_at: observedAt,
      window: tool.outcome.window ?? null,
    },
    authorization: tool.outcome.authorization,
    approval: tool.outcome.approval,
    result: tool.outcome.result,
    redaction_profile: tool.outcome.redaction_profile,
    source: {
      excerpt: safeExcerpt(
        raw,
        tool.outcome.safe_excerpt_paths,
        sensitiveValues,
      ),
      digest: sha256Digest(raw),
    },
    fallback: {
      reason: tool.outcome.fallback?.reason ?? null,
      target: tool.outcome.fallback?.target ?? null,
    },
  };
  return validateEnvelope(sanitize(envelope, sensitiveValues));
}

function toolError(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function appendInvocation(logPath, tool, alias, args, accepted) {
  const raw = tool?.outcome?.raw ?? null;
  const sensitiveValues = collectSensitiveValues(raw);
  for (const value of tool?.outcome?.secret_values ?? []) {
    if (typeof value === "string" && value) sensitiveValues.add(value);
  }
  for (const [key, value] of Object.entries(args ?? {})) {
    if (/authorization/i.test(key) && typeof value === "string" && value) {
      sensitiveValues.add(value);
    }
  }
  const entry = {
    transport_alias: alias ?? null,
    semantic_capability: tool?.semantic_capability ?? null,
    provider_id: tool?.provider?.id ?? null,
    provider_version: tool?.provider?.version ?? null,
    published_operation: tool?.provider?.published_operation ?? null,
    accepted,
    arguments: accepted ? sanitize(args ?? null, sensitiveValues) : null,
  };
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
}

export function createHandler(scenario, logPath) {
  const tools = new Map(scenario.tools.map((tool) => [tool.alias, tool]));
  const invocationCounts = new Map();

  return function handle(request) {
    if (request?.method === "notifications/initialized") return undefined;
    if (request?.method === "initialize") {
      return {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "aks-skills-mcp-fixture", version: "1.0.0" },
      };
    }
    if (request?.method === "ping") return {};
    if (request?.method === "tools/list") {
      return {
        tools: scenario.tools.map((tool) => ({
          name: tool.alias,
          description: describeTool(tool),
          inputSchema: tool.input_schema,
        })),
      };
    }
    if (request?.method === "tools/call") {
      const alias = request.params?.name;
      const args = request.params?.arguments ?? {};
      const tool = tools.get(alias);
      if (!tool) {
        appendInvocation(logPath, tool, alias, null, false);
        return toolError("unadvertised tool");
      }
      if (canonicalize(args) !== canonicalize(tool.expected_arguments)) {
        appendInvocation(logPath, tool, alias, null, false);
        return toolError("arguments did not exactly match the scenario");
      }
      const invocationCount = invocationCounts.get(alias) ?? 0;
      if (tool.max_calls !== undefined && invocationCount >= tool.max_calls) {
        appendInvocation(logPath, tool, alias, null, false);
        return toolError("tool invocation limit exceeded");
      }
      invocationCounts.set(alias, invocationCount + 1);
      appendInvocation(logPath, tool, alias, args, true);
      const envelope = buildEnvelope(tool, scenario.observed_at);
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        isError: envelope.result !== "success",
      };
    }
    throw Object.assign(new Error("method not found"), { code: -32601 });
  };
}

export function runServer({
  scenarioPath = process.env[SCENARIO_ENV],
  logPath = process.env[INVOCATION_LOG_ENV],
} = {}) {
  if (!scenarioPath) throw new Error(`${SCENARIO_ENV} is required`);
  if (!logPath) throw new Error(`${INVOCATION_LOG_ENV} is required`);

  const scenario = loadScenario(scenarioPath);
  const handle = createHandler(scenario, logPath);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  lines.on("line", (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        })}\n`,
      );
      return;
    }

    try {
      const result = handle(request);
      if (request.id === undefined || result === undefined) return;
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
      );
    } catch (error) {
      if (request.id === undefined) return;
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: Number.isInteger(error.code) ? error.code : -32603,
            message: Number.isInteger(error.code)
              ? "method not found"
              : "internal error",
          },
        })}\n`,
      );
    }
  });
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    runServer();
  } catch (error) {
    process.stderr.write(`Unable to start MCP fixture: ${error.message}\n`);
    process.exitCode = 1;
  }
}
