// Judge provider for promptfoo's llm-rubric / g-eval assertions.
//
// Originally written because promptfoo's built-in azureopenai provider sends
// 'max_tokens', which newer Azure OpenAI model deployments reject.
// Upstream: https://github.com/promptfoo/promptfoo/issues/6153
// Their fix (#6154) only auto-detects reasoning models (o1/o3) by name —
// gpt-4o deployments still get max_tokens sent.
//
// It now also keeps the judge on the same backend selection as the providers
// under test (see ./llm-client), so a multi-model run does not silently grade
// every model's output with a different judge.

const { chat } = require('./llm-client');

class JudgeProvider {
  constructor(options) {
    this.config = (options && options.config) || {};
    this.id = () => 'skill-eval-judge';
  }

  async callApi(prompt) {
    // The rubric prompt is self-contained; no system turn.
    return chat(null, prompt);
  }
}

module.exports = JudgeProvider;
