// llm.mjs — minimal chat client for Azure OpenAI (or OpenAI direct).
//
// Mirrors the credential + request contract of the public repo's skill-provider.js
// so responses generated here match what the eval harness would produce:
//   AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT  → Azure OpenAI
//   OPENAI_API_KEY                                 → OpenAI direct
//   EVAL_MODEL (default "gpt-5")                    → deployment / model name
//
// The Azure body intentionally sends only { messages } (no temperature /
// max_tokens) to match the provider and stay compatible with gpt-5.

const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview";

/**
 * Resolve credentials from the environment.
 * @returns {{ kind: "azure"|"openai", key: string, endpoint?: string, model: string }}
 * @throws if no credentials are configured
 */
export function resolveCreds(env = process.env) {
  const model = env.EVAL_MODEL || "gpt-5";
  if (env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT) {
    return { kind: "azure", key: env.AZURE_OPENAI_API_KEY, endpoint: env.AZURE_OPENAI_ENDPOINT, model };
  }
  if (env.OPENAI_API_KEY) {
    return { kind: "openai", key: env.OPENAI_API_KEY, model };
  }
  throw new Error(
    "No LLM credentials. Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or OPENAI_API_KEY."
  );
}

/**
 * Send a chat completion and return the assistant text + token usage.
 *
 * @param {object} opts
 * @param {string} opts.system   system message
 * @param {string} opts.user     user message
 * @param {object} [opts.creds]  override resolveCreds() (e.g. for tests)
 * @param {typeof fetch} [opts.fetchImpl]  injectable fetch (for tests)
 * @returns {Promise<{ text: string, tokens: {total?:number,prompt?:number,completion?:number}|null }>}
 */
export async function chat({ system, user, creds, fetchImpl }) {
  const c = creds || resolveCreds();
  const doFetch = fetchImpl || fetch;

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let url, headers, body;
  if (c.kind === "azure") {
    url = `${c.endpoint.replace(/\/$/, "")}/openai/deployments/${c.model}/chat/completions?api-version=${AZURE_API_VERSION}`;
    headers = { "Content-Type": "application/json", "api-key": c.key };
    body = JSON.stringify({ messages });
  } else {
    url = "https://api.openai.com/v1/chat/completions";
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` };
    body = JSON.stringify({ model: c.model, messages });
  }

  const res = await doFetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${detail.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage
    ? { total: data.usage.total_tokens, prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
    : null;
  return { text, tokens: usage };
}

/**
 * Parse a JSON payload from an LLM response, tolerating ```json fences and
 * surrounding prose.
 * @param {string} text
 * @returns {any}
 */
export function parseJsonLoose(text) {
  if (!text) throw new Error("empty LLM response");
  // strip code fences
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(s);
  } catch {
    // fall back to the first {...} or [...] block
    const match = s.match(/[[{][\s\S]*[\]}]/);
    if (match) return JSON.parse(match[0]);
    throw new Error("could not parse JSON from LLM response");
  }
}
