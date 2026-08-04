/**
 * Shared LLM client for all eval providers.
 *
 * Every provider (skill, baseline, router, judge) needs the same thing: send a
 * system + user turn and get text back. Centralising that lets a skill be scored
 * against more than one model family.
 *
 * That matters because a skill's value is model-dependent. Guidance that helps
 * one model can be redundant — or actively conflicting — for another. Scoring on
 * a single model tells you a skill works there, not that it is durable.
 *
 * ---------------------------------------------------------------------------
 * Backends
 * ---------------------------------------------------------------------------
 *
 *   foundry   Microsoft Foundry. The CI backend. One endpoint fronts many model
 *             deployments, so adding a model to the durability matrix is a
 *             config change rather than a code change.
 *
 *   azure     Classic Azure OpenAI deployment path. Retained so existing setups
 *             keep working unchanged.
 *
 *   openai    OpenAI direct (api.openai.com). Retained as a fallback for setups
 *             that hold an OpenAI key rather than an Azure/Foundry resource.
 *
 *   github    GitHub Models. LOCAL DEVELOPMENT ONLY — see below.
 *
 * Foundry brokers several model families, but it does so at the billing and
 * governance layer, not the protocol layer: OpenAI-family deployments speak
 * chat/completions while Claude deployments speak the Anthropic Messages API.
 * Both are reachable from the same resource, so the protocol is selected
 * explicitly with EVAL_PROTOCOL rather than guessed from the model name.
 *
 * ---------------------------------------------------------------------------
 * Why GitHub Models is local-only
 * ---------------------------------------------------------------------------
 *
 * It is genuinely useful locally: no resource to provision, and `gh auth token`
 * is a credential contributors already have. But it is a different model pool
 * from the one CI gates on, so a number produced there is not comparable to a
 * number produced in CI. Set EVAL_REQUIRE_FOUNDRY=1 in CI to make that a hard
 * failure rather than a convention.
 *
 * It is also excluded from auto-detection unless the dedicated
 * GITHUB_MODELS_TOKEN is set, because Actions injects GITHUB_TOKEN into every
 * job — auto-detecting on it would silently reroute CI to a different model the
 * moment a Foundry secret expired, and the run would still look green.
 *
 * ---------------------------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------------------------
 *
 *   EVAL_PROVIDER          foundry | azure | openai | github. Auto-detected if unset.
 *   EVAL_MODEL             Deployment name (foundry/azure) or model id (openai/github).
 *   EVAL_PROTOCOL          openai | anthropic. Foundry only. Default: openai.
 *   EVAL_REQUIRE_FOUNDRY   Set to 1 in CI to reject non-Foundry backends.
 *
 *   FOUNDRY_ENDPOINT       https://<resource>.services.ai.azure.com
 *   FOUNDRY_ACCESS_TOKEN   Entra bearer token. Preferred, and required for
 *                          models that do not accept API keys.
 *   FOUNDRY_API_KEY        Key auth, where the deployment allows it.
 *   AZURE_OPENAI_API_KEY   + AZURE_OPENAI_ENDPOINT for the azure backend.
 *   OPENAI_API_KEY         for the openai backend.
 *
 * Prefer Entra over keys. CI should obtain a token via OIDC federated
 * credentials (azure/login with id-token: write, then
 * `az account get-access-token --resource https://cognitiveservices.azure.com`)
 * so no long-lived secret is stored, and so newer Claude deployments — which do
 * not accept API keys at all — work without a second auth path.
 *
 * The per-call model can be overridden with chat(system, user, { model }) — the
 * judge uses this to score with a fixed grader (EVAL_JUDGE_MODEL) while the model
 * under test (EVAL_MODEL) varies across a durability matrix.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const AZURE_API_VERSION = '2024-12-01-preview';
const GITHUB_MODELS_URL = 'https://models.github.ai/inference/chat/completions';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// Foundry's v1 surface keeps the model out of the URL, so one endpoint serves
// every deployment. Override if the resource is pinned to a different version.
const FOUNDRY_API_VERSION = process.env.FOUNDRY_API_VERSION || 'preview';

const BACKENDS = ['foundry', 'azure', 'openai', 'github'];

function foundryCredential() {
  const token = process.env.FOUNDRY_ACCESS_TOKEN;
  if (token) return { headers: { Authorization: `Bearer ${token}` } };
  const key = process.env.FOUNDRY_API_KEY;
  if (key) return { headers: { 'api-key': key } };
  return null;
}

function detectBackend() {
  const forced = (process.env.EVAL_PROVIDER || '').trim().toLowerCase();

  let backend;
  if (forced) {
    if (!BACKENDS.includes(forced)) {
      return { error: `Unknown EVAL_PROVIDER "${forced}". Use ${BACKENDS.join(', ')}.` };
    }
    backend = forced;
  } else if (process.env.FOUNDRY_ENDPOINT && foundryCredential()) {
    backend = 'foundry';
  } else if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
    backend = 'azure';
  } else if (process.env.OPENAI_API_KEY) {
    backend = 'openai';
  } else if (process.env.GITHUB_MODELS_TOKEN) {
    backend = 'github';
  } else {
    return {
      error:
        'No LLM credentials configured. Set FOUNDRY_ENDPOINT plus ' +
        'FOUNDRY_ACCESS_TOKEN or FOUNDRY_API_KEY (recommended), or ' +
        'AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or OPENAI_API_KEY, or ' +
        'GITHUB_MODELS_TOKEN for local development.',
    };
  }

  // A comparison is only meaningful against the pool CI gates on.
  if (process.env.EVAL_REQUIRE_FOUNDRY === '1' && backend !== 'foundry') {
    return {
      error:
        `EVAL_REQUIRE_FOUNDRY=1 but the resolved backend is "${backend}". ` +
        'CI must run against Foundry so results stay comparable across runs.',
    };
  }

  return { backend };
}

/** OpenAI-shaped chat/completions payload. Shared by foundry, azure, openai, github. */
function openAiBody(model, system, user) {
  // The judge grades a self-contained rubric prompt and passes no system turn.
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: user }]
    : [{ role: 'user', content: user }];
  return model ? { model, messages } : { messages };
}

/** Anthropic Messages payload. `system` is top-level; max_tokens is required. */
function anthropicBody(model, system, user) {
  return {
    model,
    max_tokens: Number(process.env.EVAL_MAX_TOKENS) || 4096,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: user }],
  };
}

function buildFoundryRequest(system, user, model) {
  const endpoint = (process.env.FOUNDRY_ENDPOINT || '').replace(/\/$/, '');
  if (!endpoint) {
    return { error: 'EVAL_PROVIDER=foundry requires FOUNDRY_ENDPOINT (https://<resource>.services.ai.azure.com).' };
  }

  const cred = foundryCredential();
  if (!cred) {
    return {
      error:
        'EVAL_PROVIDER=foundry requires FOUNDRY_ACCESS_TOKEN (Entra, preferred) or FOUNDRY_API_KEY. ' +
        'Newer Claude deployments accept Entra only.',
    };
  }

  if (!model) {
    return { error: 'EVAL_MODEL is required for the foundry backend. Use the deployment name.' };
  }

  const protocol = (process.env.EVAL_PROTOCOL || 'openai').trim().toLowerCase();
  const headers = { 'Content-Type': 'application/json', ...cred.headers };

  if (protocol === 'anthropic') {
    return {
      protocol,
      url: `${endpoint}/anthropic/v1/messages`,
      headers: { ...headers, 'anthropic-version': ANTHROPIC_VERSION },
      body: anthropicBody(model, system, user),
    };
  }

  if (protocol !== 'openai') {
    return { error: `Unknown EVAL_PROTOCOL "${protocol}". Use openai or anthropic.` };
  }

  return {
    protocol,
    url: `${endpoint}/openai/v1/chat/completions?api-version=${FOUNDRY_API_VERSION}`,
    headers,
    body: openAiBody(model, system, user),
  };
}

function buildRequest(backend, system, user, model) {
  if (backend === 'foundry') return buildFoundryRequest(system, user, model);

  if (backend === 'azure') {
    const key = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    if (!key || !endpoint) {
      return { error: 'EVAL_PROVIDER=azure requires AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT.' };
    }
    const deployment = model || 'gpt-5';
    return {
      protocol: 'openai',
      url: `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`,
      headers: { 'Content-Type': 'application/json', 'api-key': key },
      body: openAiBody(null, system, user),
    };
  }

  if (backend === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return { error: 'EVAL_PROVIDER=openai requires OPENAI_API_KEY.' };
    }
    return {
      protocol: 'openai',
      url: OPENAI_URL,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: openAiBody(model || 'gpt-5', system, user),
    };
  }

  // github — local development only.
  const key = process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN;
  if (!key) {
    return { error: 'EVAL_PROVIDER=github requires GITHUB_MODELS_TOKEN or GITHUB_TOKEN.' };
  }
  return {
    protocol: 'openai',
    url: GITHUB_MODELS_URL,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: openAiBody(model || 'openai/gpt-5', system, user),
  };
}

function parseResponse(protocol, data) {
  if (protocol === 'anthropic') {
    const output = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const prompt = data.usage?.input_tokens;
    const completion = data.usage?.output_tokens;
    return {
      output,
      tokenUsage: {
        total: prompt != null && completion != null ? prompt + completion : undefined,
        prompt,
        completion,
      },
    };
  }

  return {
    output: data.choices?.[0]?.message?.content || '',
    tokenUsage: {
      total: data.usage?.total_tokens,
      prompt: data.usage?.prompt_tokens,
      completion: data.usage?.completion_tokens,
    },
  };
}

/**
 * Send a system + user turn to the configured backend.
 * `opts.model` overrides EVAL_MODEL for this call (e.g. the judge's fixed grader).
 * Resolves to { output, tokenUsage } or { error }.
 */
async function chat(system, user, opts = {}) {
  const detected = detectBackend();
  if (detected.error) return { error: detected.error };
  const backend = detected.backend;

  const model = opts.model !== undefined ? opts.model : process.env.EVAL_MODEL;

  const req = buildRequest(backend, system, user, model);
  if (req.error) return { error: req.error };

  try {
    const response = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      return { error: `LLM API error (${backend} ${response.status}): ${text}` };
    }

    return parseResponse(req.protocol, await response.json());
  } catch (err) {
    return { error: `LLM API call failed (${backend}): ${err.message}` };
  }
}

/** Backend name for logging and result labelling. */
function activeBackend() {
  const detected = detectBackend();
  if (detected.error) return 'unconfigured';
  if (detected.backend === 'foundry') {
    const protocol = (process.env.EVAL_PROTOCOL || 'openai').trim().toLowerCase();
    return `foundry(${protocol})`;
  }
  return detected.backend;
}

module.exports = { chat, activeBackend };
