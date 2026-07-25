/**
 * Shared LLM client for all eval providers.
 *
 * Every provider (skill, baseline, router, judge) needs the same thing: send a
 * system + user message, get text back. This centralises backend selection so a
 * skill can be scored against more than one model family.
 *
 * That matters because a skill's value is model-dependent. Guidance that helps
 * one model can be redundant — or actively conflicting — for another. Scoring on
 * a single model tells you a skill works there, not that it is durable.
 *
 * Backend selection:
 *   EVAL_PROVIDER=azure|openai|anthropic|github   explicit override
 *   otherwise auto-detected in this order:
 *     AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT → azure
 *     OPENAI_API_KEY                               → openai
 *     ANTHROPIC_API_KEY                            → anthropic
 *     GITHUB_MODELS_TOKEN                          → github
 *
 * GitHub Models is deliberately excluded from auto-detection unless the
 * dedicated GITHUB_MODELS_TOKEN is set. GitHub Actions injects GITHUB_TOKEN into
 * every job, so auto-detecting on it would silently reroute CI to a different
 * model the moment an Azure secret expired.
 *
 * Model selection: EVAL_MODEL. Defaults to gpt-5 (azure/openai) and
 * openai/gpt-5 (github). Anthropic has no default — model ids are dated and a
 * stale guess fails as a confusing 404.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const AZURE_API_VERSION = '2024-12-01-preview';
const GITHUB_MODELS_URL = 'https://models.github.ai/inference/chat/completions';

function detectBackend() {
  const forced = (process.env.EVAL_PROVIDER || '').trim().toLowerCase();
  if (forced) {
    if (!['azure', 'openai', 'anthropic', 'github'].includes(forced)) {
      return { error: `Unknown EVAL_PROVIDER "${forced}". Use azure, openai, anthropic, or github.` };
    }
    return { backend: forced };
  }

  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) return { backend: 'azure' };
  if (process.env.OPENAI_API_KEY) return { backend: 'openai' };
  if (process.env.ANTHROPIC_API_KEY) return { backend: 'anthropic' };
  if (process.env.GITHUB_MODELS_TOKEN) return { backend: 'github' };

  return {
    error:
      'No LLM credentials configured. Set one of: ' +
      'AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, OPENAI_API_KEY, ' +
      'ANTHROPIC_API_KEY, or GITHUB_MODELS_TOKEN (or EVAL_PROVIDER=github with GITHUB_TOKEN).',
  };
}

function buildRequest(backend, system, user) {
  const model = process.env.EVAL_MODEL;
  // The judge grades a self-contained rubric prompt and passes no system turn.
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: user }]
    : [{ role: 'user', content: user }];

  if (backend === 'azure') {
    const key = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    if (!key || !endpoint) {
      return { error: 'EVAL_PROVIDER=azure requires AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT.' };
    }
    const deployment = model || 'gpt-5';
    return {
      url: `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`,
      headers: { 'Content-Type': 'application/json', 'api-key': key },
      body: { messages },
    };
  }

  if (backend === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { error: 'EVAL_PROVIDER=openai requires OPENAI_API_KEY.' };
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: { model: model || 'gpt-5', messages },
    };
  }

  if (backend === 'github') {
    const key = process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN;
    if (!key) {
      return { error: 'EVAL_PROVIDER=github requires GITHUB_MODELS_TOKEN or GITHUB_TOKEN.' };
    }
    return {
      url: GITHUB_MODELS_URL,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: { model: model || 'openai/gpt-5', messages },
    };
  }

  // anthropic
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'EVAL_PROVIDER=anthropic requires ANTHROPIC_API_KEY.' };
  if (!model) {
    return {
      error:
        'EVAL_MODEL is required for the anthropic backend (model ids are dated, e.g. ' +
        'claude-opus-4-1-20250805). Set EVAL_MODEL to the exact id you want to score against.',
    };
  }
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: {
      model,
      max_tokens: Number(process.env.EVAL_MAX_TOKENS) || 4096,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: user }],
    },
  };
}

function parseResponse(backend, data) {
  if (backend === 'anthropic') {
    const output = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const input = data.usage?.input_tokens;
    const outputTokens = data.usage?.output_tokens;
    return {
      output,
      tokenUsage: {
        total: input != null && outputTokens != null ? input + outputTokens : undefined,
        prompt: input,
        completion: outputTokens,
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
 * Resolves to { output, tokenUsage } or { error }.
 */
async function chat(system, user) {
  const detected = detectBackend();
  if (detected.error) return { error: detected.error };
  const backend = detected.backend;

  const req = buildRequest(backend, system, user);
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

    return parseResponse(backend, await response.json());
  } catch (err) {
    return { error: `LLM API call failed (${backend}): ${err.message}` };
  }
}

/** Backend name for logging and result labelling. */
function activeBackend() {
  const detected = detectBackend();
  return detected.error ? 'unconfigured' : detected.backend;
}

module.exports = { chat, activeBackend };
