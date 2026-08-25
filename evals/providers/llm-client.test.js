#!/usr/bin/env node
/**
 * Deterministic regression test for ./llm-client's backend auto-detection.
 * Zero external dependencies (Node built-ins only) — mirrors ../lint-skills.js.
 *
 * Makes no network calls: it only exercises detectBackend() (via the exported
 * activeBackend()) against synthetic env vars, so it is safe to run as a hard
 * CI gate with no credentials.
 *
 * Regression covered: auto-detection used to check ambient
 * AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT before OPENAI_BASE_URL, so a
 * user who explicitly set OPENAI_BASE_URL to reach a local/self-hosted model
 * on a box that also happened to have Azure credentials in its environment
 * was silently routed to Azure instead — a confusing 404 at best, a run
 * scored against the wrong model at worst. An explicitly set OPENAI_BASE_URL
 * must now win over ambient Azure credentials during auto-detection, while
 * an explicit EVAL_PROVIDER continues to override everything.
 *
 * Usage: node llm-client.test.js
 */

const assert = require('assert');

// Env vars detectBackend()/activeBackend() read. Saved and restored around
// every case so cases can't leak into one another or into the host shell.
const ENV_KEYS = [
  'EVAL_PROVIDER',
  'EVAL_REQUIRE_FOUNDRY',
  'FOUNDRY_ENDPOINT',
  'FOUNDRY_ACCESS_TOKEN',
  'FOUNDRY_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GITHUB_MODELS_TOKEN',
  'GITHUB_TOKEN',
];

function withEnv(vars, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const key of ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
    }
  }
}

async function withEnvAsync(vars, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const key of ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
    }
  }
}

// detectBackend() reads process.env fresh on every call (no module-level
// caching), so one require is enough — each case just swaps env around it.
const { activeBackend, rawOneShot } = require('./llm-client');

let fails = 0;
function check(desc, vars, expected) {
  const actual = withEnv(vars, activeBackend);
  try {
    assert.strictEqual(actual, expected);
    console.log(`  ok: ${desc}`);
  } catch (err) {
    fails += 1;
    console.error(`  FAIL: ${desc} — expected "${expected}", got "${actual}"`);
  }
}

console.log('== llm-client backend auto-detection tests ==');

check(
  'OPENAI_BASE_URL alone selects openai',
  { OPENAI_BASE_URL: 'http://localhost:8000/v1' },
  'openai',
);

check(
  'OPENAI_BASE_URL plus ambient Azure credentials still selects openai',
  {
    OPENAI_BASE_URL: 'http://localhost:8000/v1',
    AZURE_OPENAI_API_KEY: 'fake-azure-key',
    AZURE_OPENAI_ENDPOINT: 'https://fake.openai.azure.com',
  },
  'openai',
);

check(
  'explicit EVAL_PROVIDER=azure still selects azure even with OPENAI_BASE_URL set',
  {
    EVAL_PROVIDER: 'azure',
    OPENAI_BASE_URL: 'http://localhost:8000/v1',
    AZURE_OPENAI_API_KEY: 'fake-azure-key',
    AZURE_OPENAI_ENDPOINT: 'https://fake.openai.azure.com',
  },
  'azure',
);

check(
  'explicit EVAL_PROVIDER=openai still selects openai (unaffected by this fix)',
  {
    EVAL_PROVIDER: 'openai',
    AZURE_OPENAI_API_KEY: 'fake-azure-key',
    AZURE_OPENAI_ENDPOINT: 'https://fake.openai.azure.com',
  },
  'openai',
);

check(
  'default Azure auto-detection is unchanged without OPENAI_BASE_URL',
  {
    AZURE_OPENAI_API_KEY: 'fake-azure-key',
    AZURE_OPENAI_ENDPOINT: 'https://fake.openai.azure.com',
  },
  'azure',
);

check(
  'OPENAI_API_KEY alone (no base URL) still selects openai',
  { OPENAI_API_KEY: 'fake-openai-key' },
  'openai',
);

check('no credentials at all reports unconfigured', {}, 'unconfigured');

function rawRequest(model = 'claude-opus-5') {
  return {
    protocol_version: 'aks-support-one-shot/v1',
    request_id: 'raw-preflight',
    model,
    input: { messages: [{ role: 'user', content: '{"case":"test"}' }] },
    context: { fresh: true, persist: false },
    execution: {
      mode: 'direct-model-context',
      track: 'raw-model',
      environment: 'llm-client',
    },
    tools: [],
    trace: { required: true, include_all_events: true },
  };
}

async function testRawBridge() {
  const blocked = await withEnvAsync({}, () => rawOneShot(rawRequest()));
  assert.strictEqual(blocked.failure.code, 'raw-model-unconfigured');
  assert.strictEqual(blocked.observed_model, null);
  assert.deepStrictEqual(blocked.events.map((event) => event.category), [
    'lifecycle',
    'lifecycle',
  ]);

  let sentBody;
  const savedFetch = global.fetch;
  try {
    global.fetch = async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          model: 'claude-opus-5',
          choices: [{ message: { content: '{"diagnosis.txt":"ok"}' } }],
          usage: {},
        }),
      };
    };
    const response = await withEnvAsync(
      { EVAL_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:8000/v1' },
      () => rawOneShot(rawRequest()),
    );
    assert.strictEqual(sentBody.model, 'claude-opus-5');
    assert.strictEqual(Object.hasOwn(sentBody, 'tools'), false);
    assert.strictEqual(response.observed_model, 'claude-opus-5');
    assert.strictEqual(response.failure, null);

    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        model: 'claude-sonnet-5',
        choices: [{ message: { content: '{"diagnosis.txt":"ok"}' } }],
        usage: {},
      }),
    });
    const mismatch = await withEnvAsync(
      { EVAL_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:8000/v1' },
      () => rawOneShot(rawRequest()),
    );
    assert.strictEqual(mismatch.failure.code, 'model-identity-mismatch');
    assert.strictEqual(mismatch.observed_model, 'claude-sonnet-5');
  } finally {
    global.fetch = savedFetch;
  }
}

testRawBridge()
  .then(() => {
    console.log();
    if (fails === 0) {
      console.log('All llm-client tests passed.');
      process.exit(0);
    }
    console.error(`${fails} llm-client test(s) FAILED.`);
    process.exit(1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
