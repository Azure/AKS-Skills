/**
 * Baseline provider — identical to skill-provider but WITHOUT loading SKILL.md.
 * Sends only a generic system prompt + the user query.
 * Used to measure how much value the skill adds over the base model.
 *
 * Backend and model are resolved by ./llm-client (EVAL_PROVIDER / EVAL_MODEL).
 * The baseline must run on the same backend as the skill run, or the delta
 * measures the model difference rather than the skill's contribution.
 *
 * Test case vars:
 *   prompt — the user prompt to evaluate
 */

const { chat } = require('./llm-client');

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

    return chat(systemMessage, userPrompt);
  }
}

module.exports = BaselineProvider;
