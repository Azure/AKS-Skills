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
 *   skill_path   — relative path from skills/ to the selected skill's SKILL.md
 *   skill_files  — optional array of files relative to that selected skill
 *   prompt       — the user prompt to evaluate
 *
 * `skill_files` models progressive disclosure for this eval only. It does not
 * change how any runtime discovers or loads skills.
 */

const SKILLS_BASE = process.env.SKILLS_BASE || path.resolve(__dirname, '../../skills');

function providerError(message) {
  const error = new Error(message);
  error.name = 'SkillProviderInputError';
  return error;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function validateRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw providerError(`${label} must be a non-empty string`);
  }
  if (value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) {
    throw providerError(`${label} must be a portable relative path`);
  }

  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw providerError(`${label} contains an empty, current-directory, or traversal segment: ${value}`);
  }
}

function resolveShippedFile(baseRealPath, relativePath, label) {
  validateRelativePath(relativePath, label);
  const candidate = path.resolve(baseRealPath, ...relativePath.split('/'));
  if (!isInside(baseRealPath, candidate)) {
    throw providerError(`${label} must stay inside ${baseRealPath}: ${relativePath}`);
  }

  let stat;
  let realPath;
  try {
    stat = fs.statSync(candidate);
    realPath = fs.realpathSync(candidate);
  } catch (error) {
    throw providerError(`${label} does not name a shipped file: ${relativePath} (${error.message})`);
  }
  if (!stat.isFile()) {
    throw providerError(`${label} must name a file, not a directory or special entry: ${relativePath}`);
  }
  if (!isInside(baseRealPath, realPath)) {
    throw providerError(`${label} resolves outside ${baseRealPath}: ${relativePath}`);
  }

  return { declaredPath: relativePath, fullPath: candidate, realPath };
}

/**
 * Resolve and read exactly the files declared by one quality test.
 *
 * The root SKILL.md is always first. Optional deep files retain declaration
 * order so the generated prompt is byte-for-byte deterministic. Duplicate
 * declarations and symlink aliases of an already loaded file fail closed
 * rather than silently changing precedence.
 */
function loadSkillContext(vars, options = {}) {
  const skillsBase = path.resolve(options.skillsBase || SKILLS_BASE);
  let skillsBaseReal;
  let skillsBaseStat;
  try {
    skillsBaseReal = fs.realpathSync(skillsBase);
    skillsBaseStat = fs.statSync(skillsBaseReal);
  } catch (error) {
    throw providerError(`Skills base is not readable: ${skillsBase} (${error.message})`);
  }
  if (!skillsBaseStat.isDirectory()) {
    throw providerError(`Skills base must be a directory: ${skillsBase}`);
  }

  const skillPath = vars && vars.skill_path;
  validateRelativePath(skillPath, 'vars.skill_path');
  const skillPathSegments = skillPath.split('/');
  if (skillPathSegments.length !== 2 || skillPathSegments[1] !== 'SKILL.md') {
    throw providerError('vars.skill_path must have the form <skill>/SKILL.md');
  }

  const root = resolveShippedFile(skillsBaseReal, skillPath, 'vars.skill_path');
  const skillDir = path.dirname(root.fullPath);
  const skillDirReal = path.dirname(root.realPath);
  if (!isInside(skillsBaseReal, skillDir) || !isInside(skillsBaseReal, skillDirReal)) {
    throw providerError(`Selected skill resolves outside ${skillsBaseReal}: ${skillPath}`);
  }
  if (skillDir !== skillDirReal) {
    throw providerError(`Selected skill directory may not be a symlink: ${skillPath}`);
  }

  const requested = vars.skill_files;
  if (requested !== undefined && !Array.isArray(requested)) {
    throw providerError('vars.skill_files must be an array of skill-relative file paths');
  }

  const files = [{ declaredPath: 'SKILL.md', fullPath: root.fullPath, realPath: root.realPath }];
  const declared = new Set(['SKILL.md']);
  const resolved = new Set([root.realPath]);

  for (const [index, relativePath] of (requested || []).entries()) {
    const label = `vars.skill_files[${index}]`;
    validateRelativePath(relativePath, label);
    if (declared.has(relativePath)) {
      throw providerError(`Duplicate skill file declaration: ${relativePath}`);
    }
    declared.add(relativePath);

    const file = resolveShippedFile(skillDirReal, relativePath, label);
    if (resolved.has(file.realPath)) {
      throw providerError(`Ambiguous skill file declaration resolves to an already loaded file: ${relativePath}`);
    }
    resolved.add(file.realPath);
    files.push(file);
  }

  return {
    skillDir: skillDirReal,
    files: files.map(file => ({
      path: file.declaredPath,
      content: fs.readFileSync(file.realPath, 'utf8'),
    })),
  };
}

function buildSystemMessage(files) {
  const sections = [
    'You are an AKS SRE agent. Follow the selected skill and only the explicitly loaded supporting files below.',
    '',
    '## Selected Skill',
    '',
    files[0].content,
  ];

  for (const file of files.slice(1)) {
    sections.push('', `## Loaded skill file: ${file.path}`, '', file.content);
  }
  return sections.join('\n');
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
    const userPrompt = vars.prompt;

    if (!vars.skill_path) {
      return { error: 'Test case must define vars.skill_path' };
    }
    if (!userPrompt) {
      return { error: 'Test case must define vars.prompt' };
    }

    let skillContext;
    try {
      skillContext = loadSkillContext(vars);
    } catch (error) {
      return { error: error.message };
    }

    const systemMessage = buildSystemMessage(skillContext.files);

    const result = await chat(systemMessage, userPrompt);
    if (result.error) {
      return { error: result.error };
    }
    return { output: result.output, tokenUsage: result.tokenUsage };
  }
}

module.exports = SkillProvider;
module.exports.loadSkillContext = loadSkillContext;
module.exports.buildSystemMessage = buildSystemMessage;
