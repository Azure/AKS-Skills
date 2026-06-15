const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Router provider — tests skill selection, not response quality.
 * Presents all skill descriptions to the model and asks which skill
 * (if any) should handle the user's query. Returns just the skill id.
 *
 * Auto-discovers skills by walking skills/providers/ for SKILL.md files,
 * or accepts an explicit list via config.skills.
 *
 * Env vars:
 *   AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT → Azure OpenAI
 *   OPENAI_API_KEY                                → OpenAI direct
 *
 * Config (optional):
 *   skills: [{id, description}] — explicit skill list (overrides auto-discovery)
 *
 * Test case vars:
 *   prompt — the user query to route
 */

const SKILLS_BASE = process.env.SKILLS_BASE || path.resolve(__dirname, '../../skills');

function discoverSkills() {
  const skills = [];
  const providersDir = path.join(SKILLS_BASE, 'providers');

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === 'SKILL.md') {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const match = content.match(/^---\n([\s\S]*?)\n---/);
          if (match) {
            const frontmatter = yaml.load(match[1]);
            if (frontmatter.name && frontmatter.description) {
              skills.push({
                id: frontmatter.name,
                description: frontmatter.description.trim(),
              });
            }
          }
        } catch (e) { /* skip unreadable files */ }
      }
    }
  }

  walk(providersDir);
  return skills;
}

class RouterProvider {
  constructor(options) {
    this.providerId = options.id || 'router-provider';
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

    // Get skill pool — config override or auto-discover
    const skills = this.config.skills || discoverSkills();
    if (skills.length === 0) {
      return { error: 'No skills discovered. Check skills/providers/ directory or pass config.skills.' };
    }

    const skillList = skills.map(s => `- ${s.id}: ${s.description}`).join('\n');

    const systemMessage = [
      'You are a skill router. Given the user query below, decide which skill (if any) should handle it.',
      '',
      'Available skills:',
      skillList,
      '',
      'Rules:',
      '- Reply with ONLY the skill id (e.g. "aks-sre") if the query matches a skill.',
      '- Reply with ONLY "none" if no skill is appropriate.',
      '- Do not explain your reasoning. Output only the skill id or "none".',
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
      const apiVersion = '2024-12-01-preview';
      url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;
      headers = { 'Content-Type': 'application/json', 'api-key': azureKey };
      body = JSON.stringify({ messages });
    } else if (openaiKey) {
      url = 'https://api.openai.com/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` };
      body = JSON.stringify({ model, messages });
    } else {
      return { error: 'No LLM credentials configured. Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or OPENAI_API_KEY.' };
    }

    try {
      const response = await fetch(url, { method: 'POST', headers, body });
      if (!response.ok) {
        const text = await response.text();
        return { error: `LLM API error ${response.status}: ${text}` };
      }
      const data = await response.json();
      const raw = data.choices?.[0]?.message?.content || '';
      // Normalize: lowercase, trim, strip quotes/punctuation
      const output = raw.toLowerCase().trim().replace(/['"`.]/g, '');

      return {
        output,
        tokenUsage: {
          total: data.usage?.total_tokens,
          prompt: data.usage?.prompt_tokens,
          completion: data.usage?.completion_tokens,
        },
      };
    } catch (err) {
      return { error: `Request failed: ${err.message}` };
    }
  }
}

module.exports = RouterProvider;
