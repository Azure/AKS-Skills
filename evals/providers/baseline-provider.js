const { chat } = require('./llm-client');

/**
 * Baseline provider — identical to skill-provider but WITHOUT loading SKILL.md.
 * Sends only a generic system prompt + the user query.
 * Used to measure how much value the skill adds over the base model.
 *
 * Backend selection + credentials are handled by ./llm-client (foundry / azure /
 * openai / github). See its header for configuration.
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

    const result = await chat(systemMessage, userPrompt);
    if (result.error) {
      return { error: result.error };
    }
    return { output: result.output, tokenUsage: result.tokenUsage };
  }
}

module.exports = BaselineProvider;
