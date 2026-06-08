/**
 * Baseline provider — identical to skill-provider but WITHOUT loading SKILL.md.
 * Sends only a generic system prompt + the user query.
 * Used to measure how much value the skill adds over the base model.
 *
 * Env vars (checked in order):
 *   AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT → Azure OpenAI
 *   OPENAI_API_KEY                                → OpenAI direct
 *
 * Test case vars:
 *   prompt — the user prompt to evaluate
 */

class BaselineProvider {
  constructor(options) {
    this.providerId = options.id || 'baseline-provider';
    this.config = options.config || {};
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const vars = context.vars || {};
    const userPrompt = vars.prompt;

    if (!userPrompt) {
      return { error: 'Test case must define vars.prompt' };
    }

    // Generic system prompt — no skill loaded
    const systemMessage = 'You are a helpful assistant with expertise in Azure Kubernetes Service (AKS) and Kubernetes operations.';

    const messages = [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userPrompt },
    ];

    // Determine which API to call
    const azureKey = process.env.AZURE_OPENAI_API_KEY;
    const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const openaiKey = process.env.OPENAI_API_KEY;
    const model = process.env.EVAL_MODEL || 'gpt-5';

    let url, headers, body;

    if (azureKey && azureEndpoint) {
      const apiVersion = '2024-08-01-preview';
      url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;
      headers = {
        'Content-Type': 'application/json',
        'api-key': azureKey,
      };
      body = JSON.stringify({ messages });
    } else if (openaiKey) {
      url = 'https://api.openai.com/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      };
      body = JSON.stringify({ model, messages });
    } else {
      return {
        error: 'No LLM credentials configured. Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or OPENAI_API_KEY.',
      };
    }

    try {
      const response = await fetch(url, { method: 'POST', headers, body });

      if (!response.ok) {
        const text = await response.text();
        return { error: `LLM API error ${response.status}: ${text}` };
      }

      const data = await response.json();
      const output = data.choices?.[0]?.message?.content;

      return {
        output: output || '',
        tokenUsage: {
          total: data.usage?.total_tokens,
          prompt: data.usage?.prompt_tokens,
          completion: data.usage?.completion_tokens,
        },
      };
    } catch (err) {
      return { error: `LLM API call failed: ${err.message}` };
    }
  }
}

module.exports = BaselineProvider;
