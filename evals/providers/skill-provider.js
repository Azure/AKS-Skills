const fs = require('fs');
const path = require('path');
const { chat } = require('./llm-client');

/**
 * Custom promptfoo provider that loads a SKILL.md file and uses it as
 * system context when evaluating a user prompt.
 *
 * Backend and model are resolved by ./llm-client (EVAL_PROVIDER / EVAL_MODEL).
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

    return chat(systemMessage, userPrompt);
  }
}

module.exports = SkillProvider;
