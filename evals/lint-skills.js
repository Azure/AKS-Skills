#!/usr/bin/env node
/**
 * Skill Schema Linter — validates SKILL.md formatting and structure.
 * Zero external dependencies (uses only Node.js built-ins).
 *
 * Checks:
 *  1. SKILL.md exists in each skill folder
 *  2. Valid YAML front matter (delimited by ---)
 *  3. Required fields: name, description
 *  4. name matches parent folder name
 *  5. Scripts have a shebang line
 *  6. Internal file references in SKILL.md resolve to real files
 *
 * Usage:
 *   node lint-skills.js [skills-dir]
 *   Default skills-dir: ../skills
 */

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'skills'));

let errors = [];
let warnings = [];
let skillCount = 0;

function addError(skillPath, msg) {
  errors.push(`ERROR [${path.relative(SKILLS_DIR, skillPath)}]: ${msg}`);
}

function addWarning(skillPath, msg) {
  warnings.push(`WARN  [${path.relative(SKILLS_DIR, skillPath)}]: ${msg}`);
}

/**
 * Minimal YAML front matter parser — handles the fields we care about.
 * Not a full YAML parser, but sufficient for name/description/metadata extraction.
 */
function parseFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};

  // Extract top-level scalar fields (name, description)
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim().replace(/^["']|["']$/g, '');

  const descMatch = yaml.match(/^description:\s*[>|]?\s*\n?([\s\S]*?)(?=\n\w|\n---)/m);
  if (descMatch) {
    result.description = descMatch[1].trim();
  } else {
    const inlineDesc = yaml.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    if (inlineDesc) result.description = inlineDesc[1].trim();
  }

  // Check for metadata.openclaw presence
  result.hasMetadata = /^metadata:/m.test(yaml);
  result.hasEmoji = /emoji:/m.test(yaml);

  return result;
}

/**
 * Find all skill folders (directories containing SKILL.md anywhere in the tree).
 */
function findSkillFolders(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const hasSkillMd = entries.some(e => e.isFile() && e.name === 'SKILL.md');
    if (hasSkillMd) {
      results.push(current);
      return; // Don't recurse into sub-folders of a skill
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        walk(path.join(current, entry.name));
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Check that scripts in a skill folder have shebangs.
 */
function checkScripts(skillDir) {
  const scriptsDir = path.join(skillDir, 'scripts');
  if (!fs.existsSync(scriptsDir)) return;

  const scripts = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.sh') || f.endsWith('.py'));
  for (const script of scripts) {
    const filePath = path.join(scriptsDir, script);
    const firstLine = fs.readFileSync(filePath, 'utf-8').split('\n')[0];
    if (!firstLine.startsWith('#!')) {
      addWarning(filePath, 'Script missing shebang (#!/bin/bash or #!/usr/bin/env python3)');
    }
  }
}

/**
 * Check that file references in SKILL.md (backtick-quoted paths) actually exist.
 */
function checkInternalRefs(skillDir, content) {
  // Match patterns like `scripts/foo.sh`, `references/bar.md`, `assets/baz.md`
  const refPattern = /`((?:scripts|references|assets)\/[^`]+)`/g;
  let match;
  while ((match = refPattern.exec(content)) !== null) {
    const refPath = match[1].split(' ')[0]; // handle `scripts/foo.sh <args>`
    const fullPath = path.join(skillDir, refPath);
    if (!fs.existsSync(fullPath)) {
      addError(path.join(skillDir, 'SKILL.md'), `References \`${refPath}\` but file does not exist`);
    }
  }
}

// --- Main ---

const skillFolders = findSkillFolders(SKILLS_DIR);

if (skillFolders.length === 0) {
  console.error(`No skills found in ${SKILLS_DIR}`);
  process.exit(1);
}

for (const skillDir of skillFolders) {
  skillCount++;
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const folderName = path.basename(skillDir);

  // Read and parse
  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const frontMatter = parseFrontMatter(content);

  if (!frontMatter) {
    addError(skillMdPath, 'Missing or malformed YAML front matter (must start with --- and end with ---)');
    continue;
  }

  // Required fields
  if (!frontMatter.name) {
    addError(skillMdPath, 'Missing required field: name');
  }
  if (!frontMatter.description) {
    addError(skillMdPath, 'Missing required field: description');
  }

  // Name/folder match
  if (frontMatter.name && frontMatter.name !== folderName) {
    addWarning(skillMdPath, `Front matter name "${frontMatter.name}" does not match folder name "${folderName}"`);
  }

  // Description quality
  if (frontMatter.description && frontMatter.description.split(/\s+/).length < 5) {
    addWarning(skillMdPath, 'Description is very short (< 5 words) — may not trigger well in skill routing');
  }

  // Metadata presence (warning, not error — not all skills need it)
  if (!frontMatter.hasMetadata) {
    addWarning(skillMdPath, 'No metadata section (consider adding metadata.openclaw with emoji and requires.anyBins)');
  }

  // Scripts
  checkScripts(skillDir);

  // Internal references
  checkInternalRefs(skillDir, content);
}

// --- Report ---

console.log(`\nSkill Lint: ${skillCount} skill(s) checked\n`);

if (warnings.length > 0) {
  console.log('Warnings:');
  warnings.forEach(w => console.log(`  ${w}`));
  console.log('');
}

if (errors.length > 0) {
  console.log('Errors:');
  errors.forEach(e => console.log(`  ${e}`));
  console.log(`\n✗ ${errors.length} error(s) found`);
  process.exit(1);
} else {
  console.log(`✓ All skills pass schema validation`);
  process.exit(0);
}
