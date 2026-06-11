const fs = require('fs');
const path = require('path');

/**
 * Custom promptfoo provider that loads a SKILL.md file and uses it as
 * system context when evaluating a user prompt against Azure OpenAI.
 *
 * Env vars (checked in order):
 *   AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT → Azure OpenAI
 *   OPENAI_API_KEY                                → OpenAI direct
 *
 * Test case vars:
 *   skill_path  — relative path from the skills/ directory to the SKILL.md file
 *   prompt      — the user prompt to evaluate
 */

const SKILLS_BASE = process.env.SKILLS_BASE || path.resolve(__dirname, '../../skills');

class SkillProvider {
  constructor(options) {
    this.providerId = options.id || 'skill-provider';
    this.config = options.config || {};
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const vars = context.vars || {};
    const skillPath = vars.skill_path;
    const userPrompt = vars.prompt;

    if (!skillPath) {
      return { error: 'Test case must define vars.skill_path' };
    }
    if (!userPrompt) {
      return { error: 'Test case must define vars.prompt' };
    }

    // Load the SKILL.md content
    const fullSkillPath = path.resolve(SKILLS_BASE, skillPath);
    const skillsBaseWithSep = SKILLS_BASE.endsWith(path.sep) ? SKILLS_BASE : SKILLS_BASE + path.sep;
    if (!fullSkillPath.startsWith(skillsBaseWithSep)) {
      return { error: `Invalid vars.skill_path (must stay under ${SKILLS_BASE}): ${skillPath}` };
    }
    let skillContent;
    try {
      skillContent = fs.readFileSync(fullSkillPath, 'utf-8');
    } catch (err) {
      return { error: `Failed to read skill file: ${fullSkillPath} — ${err.message}` };
    }

    // Build messages
    const systemMessage = [
      'You are an AKS SRE agent. Follow the skill instructions below to respond to the user.',
      '',
      '## Skill Instructions',
      '',
      skillContent,
    ].join('\n');

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
      // Azure OpenAI
      const apiVersion = '2024-12-01-preview';
      url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;
      headers = {
        'Content-Type': 'application/json',
        'api-key': azureKey,
      };
      body = JSON.stringify({
        messages,
      });
    } else if (openaiKey) {
      // OpenAI direct
      url = 'https://api.openai.com/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      };
      body = JSON.stringify({
        model,
        messages,
      });
    } else {
      return {
        error: 'No LLM credentials configured. Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or OPENAI_API_KEY.',
      };
    }

    // Make the API call
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

module.exports = SkillProvider;
