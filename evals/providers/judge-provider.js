// Custom judge provider for promptfoo's llm-rubric assertions.
// Needed because promptfoo's built-in azureopenai provider sends 'max_tokens'
// which newer Azure OpenAI model deployments reject.
//
// Upstream: https://github.com/promptfoo/promptfoo/issues/6153
// Their fix (#6154) only auto-detects reasoning models (o1/o3) by name —
// gpt-4o deployments still get max_tokens sent. Remove this provider once
// promptfoo handles max_completion_tokens for all Azure model deployments.
//
// Dispatch (backend selection, credentials, request shaping) is delegated to
// ./llm-client; this provider only pins the judge model and passes the rubric.

const { chat } = require('./llm-client');

class AzureJudgeProvider {
  constructor(options) {
    this.config = options.config || {};
    this.id = () => 'azure-judge';
  }

  async callApi(prompt, context) {
    // Decouple the judge from the model under test. Set EVAL_JUDGE_MODEL to a fixed
    // deployment so the grader stays constant while EVAL_MODEL varies across a
    // multi-model / cross-release matrix — otherwise every candidate grades itself
    // (self-preference bias) and scores are not comparable across models.
    const model = process.env.EVAL_JUDGE_MODEL || process.env.EVAL_MODEL;

    // The rubric is self-contained — pass it as the user turn with no system turn.
    const result = await chat(null, prompt, { model });
    if (result.error) {
      return { error: result.error };
    }
    return { output: result.output, tokenUsage: result.tokenUsage };
  }
}

module.exports = AzureJudgeProvider;
