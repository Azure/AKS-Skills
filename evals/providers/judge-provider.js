// Custom judge provider for promptfoo's llm-rubric assertions.
// Needed because promptfoo's built-in azureopenai provider sends 'max_tokens'
// which newer Azure OpenAI model deployments reject.

class AzureJudgeProvider {
  constructor(options) {
    this.config = options.config || {};
    this.id = () => 'azure-judge';
  }

  async callApi(prompt, context) {
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || 'https://aks-aoai-eastus.openai.azure.com').replace(/\/$/, '');
    const model = this.config.model || 'gpt-4o';
    const apiVersion = this.config.apiVersion || '2024-08-01-preview';

    const url = `${endpoint}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;

    const body = {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
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
