// Custom judge provider for promptfoo's llm-rubric assertions.
// Needed because promptfoo's built-in azureopenai provider sends 'max_tokens'
// which newer Azure OpenAI model deployments reject.
//
// Upstream: https://github.com/promptfoo/promptfoo/issues/6153
// Their fix (#6154) only auto-detects reasoning models (o1/o3) by name —
// gpt-4o deployments still get max_tokens sent. Remove this provider once
// promptfoo handles max_completion_tokens for all Azure model deployments.

class AzureJudgeProvider {
  constructor(options) {
    this.config = options.config || {};
    this.id = () => 'azure-judge';
  }

  async callApi(prompt, context) {
    const azureKey = process.env.AZURE_OPENAI_API_KEY;
    const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const openaiKey = process.env.OPENAI_API_KEY;
    const model = process.env.EVAL_MODEL || 'gpt-5';
    const apiVersion = this.config.apiVersion || '2024-08-01-preview';

    let url, headers;
    const body = {
      messages: [{ role: 'user', content: prompt }],
    };

    if (azureKey && azureEndpoint) {
      const endpoint = azureEndpoint.replace(/\/$/, '');
      url = `${endpoint}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;
      headers = { 'Content-Type': 'application/json', 'api-key': azureKey };
    } else if (openaiKey) {
      url = 'https://api.openai.com/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` };
      body.model = model;
    } else {
      return { error: 'No LLM credentials configured. Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or OPENAI_API_KEY.' };
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { error: `Judge API error (${resp.status}): ${errText}` };
    }

    const data = await resp.json();
    const output = data.choices?.[0]?.message?.content || '';
    return {
      output,
      tokenUsage: {
        total: data.usage?.total_tokens || 0,
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
      },
    };
  }
}

module.exports = AzureJudgeProvider;
