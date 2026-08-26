const fs = require('fs');
const path = require('path');
const { chat } = require('./llm-client');

/**
 * Custom promptfoo provider that loads a SKILL.md file and uses it as
 * system context when evaluating a user prompt.
 *
 * Backend selection + credentials are handled by ./llm-client (foundry / azure /
 * openai / github). See its header for configuration.
 *
 * Test case vars:
 *   skill_path   — relative path from the skills/ directory to the root file
 *   skill_files  — optional files relative to that root file's skill directory
 *   prompt       — the user prompt to evaluate
 */

const SKILLS_BASE = process.env.SKILLS_BASE || path.resolve(__dirname, '../../skills');

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function loadSkillContext(vars) {
  const base = fs.realpathSync(SKILLS_BASE);
  const root = fs.realpathSync(path.resolve(base, vars.skill_path));
  if (!isInside(base, root) || !fs.statSync(root).isFile()) {
    throw new Error(`Invalid vars.skill_path (must name a file under ${base})`);
  }

  const requested = vars.skill_files;
  if (requested !== undefined && !Array.isArray(requested)) {
    throw new Error('vars.skill_files must be an array');
  }
  const skillDir = path.dirname(root);
  const seen = new Set([root]);
  const files = [{ path: vars.skill_path, content: fs.readFileSync(root, 'utf8') }];
  for (const [index, relative] of (requested || []).entries()) {
    const segments = typeof relative === 'string' ? relative.split('/') : [];
    if (
      segments.length === 0 ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..') ||
      path.isAbsolute(relative) ||
      relative.includes('\\')
    ) {
      throw new Error(`Invalid vars.skill_files[${index}]`);
    }
    const resolved = fs.realpathSync(path.resolve(skillDir, relative));
    if (!isInside(skillDir, resolved) || !fs.statSync(resolved).isFile() || seen.has(resolved)) {
      throw new Error(`Invalid or duplicate vars.skill_files[${index}]: ${relative}`);
    }
    seen.add(resolved);
    files.push({ path: relative, content: fs.readFileSync(resolved, 'utf8') });
  }
  return files;
}

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

    let skillFiles;
    try {
      skillFiles = loadSkillContext(vars);
    } catch (err) {
      return { error: `Failed to load skill context: ${err.message}` };
    }

    const systemMessage = [
      'You are an AKS SRE agent. Follow the skill instructions below to respond to the user.',
      ...skillFiles.flatMap((file, index) => [
        '',
        index === 0 ? '## Skill Instructions' : `## Loaded skill file: ${file.path}`,
        '',
        file.content,
      ]),
    ].join('\n');

    const result = await chat(systemMessage, userPrompt);
    if (result.error) {
      return { error: result.error };
    }
    return { output: result.output, tokenUsage: result.tokenUsage };
  }
}

module.exports = SkillProvider;
module.exports.loadSkillContext = loadSkillContext;
