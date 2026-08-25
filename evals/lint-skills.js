#!/usr/bin/env node
/**
 * Skill Contract Linter — validates registered skill bundles against docs/skill-contract.md.
 * Uses js-yaml for front-matter parsing and Git for index-mode checks.
 *
 * Checks (see docs/skill-contract.md for the authoritative rule):
 *  1. SKILL.md exists in each skill folder
 *  2. Valid contract-shaped YAML front matter
 *  3. Required fields present, in the contract's declared order:
 *     name, license, metadata.author, metadata.version, description
 *  4. name === folder name (error)
 *  5. metadata.version is valid semver
 *  6. license === "MIT", metadata.author === "Microsoft" (contract §2 exact values)
 *  7. description contains a WHEN: clause and a DO NOT USE FOR: clause that
 *     uses the parenthetical-redirect grammar ("(use X)" / "(see X)")
 *  8. description respects the contract's 1024-character maximum
 *  9. every skill has non-empty evals/tests/<skill>/{trigger,quality}-tests.yaml
 * 10. every skill's quality-tests.yaml is wired into evals/promptfooconfig.yaml
 * 11. every script-shaped file in scripts/ has a valid shebang and Git mode 100755
 * 12. internal file references in SKILL.md resolve to real files
 * 13. shipped guidance preserves Azure MCP host portability and product boundaries
 * 14. non-SKILL Markdown over 100 lines starts its topic sections with a TOC
 * 15. Markdown/shell commands avoid interactive stdin/TTY flags and execute only digest-pinned MCR images
 *
 * Usage:
 *   node lint-skills.js [skills-dir]
 *   Default skills-dir: ../skills
 *
 * Env overrides (used by lint-skills.test.js to point at fixture directories;
 * not needed for normal use — defaults match the real repo layout):
 *   LINT_TESTS_DIR            default: <repo>/evals/tests
 *   LINT_PROMPTFOO_CONFIG     default: <repo>/evals/promptfooconfig.yaml
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// --- Contract-declared exact values (docs/skill-contract.md §2) ---------
// Do not invent new thresholds here; these mirror the contract's own numbers.
const EXPECTED_LICENSE = 'MIT';
const EXPECTED_AUTHOR = 'Microsoft';
// Agent Skills-compatible hosts accept descriptions up to 1024 characters.
const MAX_DESCRIPTION_CHARS = 1024;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// Declared order from the contract's manifest example (§2).
const REQUIRED_TOP_LEVEL_ORDER = ['name', 'license', 'metadata', 'description'];
const REQUIRED_METADATA_ORDER = ['author', 'version'];
const REQUIRED_TOP_LEVEL_FIELDS = ['name', 'license', 'metadata', 'description'];
const VALID_SHEBANG_RE = /^#!\/\S+(?:\s+.*)?$/;
const SCRIPT_EXTENSIONS = new Set(['.sh', '.py']);
const MAX_REFERENCE_LINES_WITHOUT_TOC = 100;
const EXECUTABLE_COMMANDS = new Set(['eval', 'kubectl', 'docker', 'podman', 'nerdctl']);
const MCR_DIGEST_IMAGE_RE = /^mcr\.microsoft\.com\/[A-Za-z0-9._/-]+(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const SHELL_FENCE_LANGUAGES = new Set(['bash', 'console', 'sh', 'shell', 'zsh']);
const HARDCODED_AZURE_MCP_NAME_RE = /\bmcp_azure_mcp_[A-Za-z0-9_]+\b/i;
const AKS_MCP_PRODUCT_NAME_RE = /\bAKS[- ]MCP\b/i;
const EXPLICIT_AKS_MCP_PRODUCT_RE = /\bAzure\/aks-mcp\b/i;
const REMOVED_READINESS_API_PATTERNS = [
  {
    label: 'readiness discovery action',
    pattern: /\baction\s*[:=]\s*["']?discover\b/i,
  },
  {
    label: 'readiness polling action',
    pattern: /\bpollOperation\b/i,
  },
  {
    label: 'HTTP 202 readiness polling contract',
    pattern: /\bHTTP\s*-?\s*202\b/i,
  },
  {
    label: 'invented readiness response field',
    pattern: /\b(?:clusterConfiguration|totalWorkloads|overallStatus|suggestedPatch|remediationGuide)\b/,
  },
];

/**
 * Read a text file with line endings normalized to LF. Windows checkouts
 * materialize CRLF; lint must report the same results on every platform.
 */
function readText(filePath) {
  return fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n');
}

function parseYamlScalar(rawValue) {
  const value = rawValue.trim();
  if (value === '') return null;

  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw new Error('unterminated double-quoted scalar');
    try {
      return JSON.parse(value);
    } catch (e) {
      throw new Error(`invalid double-quoted scalar: ${e.message}`);
    }
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error('unterminated single-quoted scalar');
    return value.slice(1, -1).replace(/''/g, "'");
  }

  let quote = null;
  const stack = [];
  const pairs = { '[': ']', '{': '}' };
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (pairs[char]) {
      stack.push(pairs[char]);
    } else if (char === ']' || char === '}') {
      if (stack.pop() !== char) throw new Error(`unmatched "${char}"`);
    }
  }
  if (quote) throw new Error('unterminated quoted scalar');
  if (stack.length > 0) throw new Error(`unterminated "${stack[stack.length - 1]}" collection`);

  if (value === 'null' || value === '~') return null;
  if (value === '[]') return [];
  if (value === '{}') return {};
  return value;
}

/**
 * Parse SKILL.md front matter as YAML and retain source key order for the
 * contract's declared-order checks.
 */
function parseFrontMatter(rawFrontMatter) {
  // Load only when front matter is parsed so dependency-free policy helpers can
  // be exercised in minimal review environments without eval dependencies.
  const yaml = require('js-yaml');
  const value = yaml.load(rawFrontMatter);
  const isMapping = value !== null && typeof value === 'object' && !Array.isArray(value);
  const topLevelKeys = isMapping ? Object.keys(value) : [];
  const metadata = isMapping ? value.metadata : null;
  const metadataKeys = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? Object.keys(metadata)
    : [];

  return { value, topLevelKeys, metadataKeys };
}

function parseNonEmptyYamlList(content) {
  const meaningful = content.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
  if (meaningful.length === 0 || meaningful[0] === '[]') return [];
  if (!meaningful[0].startsWith('-')) {
    throw new Error('top-level YAML value must be a list');
  }
  parseYamlScalar(meaningful[0].slice(1));
  return meaningful;
}

function parsePromptfooTests(content) {
  const lines = content.split('\n');
  const start = lines.findIndex(line => /^tests:\s*(?:#.*)?$/.test(line));
  if (start === -1) return [];

  const tests = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (/^[^\s]/.test(line)) break;
    const entry = line.match(/^\s+-\s+(.+?)\s*$/);
    if (entry) tests.push(parseYamlScalar(entry[1]));
  }
  return tests;
}

// Coaching lemmas: phrases that prescribe how to think/write/behave generally.
// A match is only flagged when the line carries NO AKS/Azure/K8s domain token and
// NO safety verb (see checkCoaching) — so durable tool/policy/safety lines pass.
const COACHING_LEMMAS = [
  'painfully concise', 'be concise', 'be thorough', 'step by step', 'step-by-step',
  'think carefully', 'think hard', 'bias towards', 'bias toward', "don't stop at",
  'do not stop at', 'always use tools', 'use tools first', 'proactively',
  'leave out', 'filler words', 'five whys', 'be brief', 'be professional',
];
// Domain tokens whose presence marks a line as durable (command/resource/error/field).
const DOMAIN_RE = /\b(az|kubectl|aks|nsg|cni|vnet|nodepool|kubelet|coredns|nvidia|gpu|dcgm|kaito|mcp|pvc|pdb|snat|vm|nic|udr|helm|tcpdump|bpf)\b|networkProfile|nvidia\.com|mcr\.microsoft|error code|`[^`]+`/i;
const SAFETY_RE = /\b(delete|drain|cordon|scale|restart|upgrade|reconfigure|read-only|readonly|do not|never)\b/i;

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
      // Keep recursing: a skill's own references/ and scripts/ subfolders hold no
      // SKILL.md, so they are never double-counted, and any genuinely nested skill
      // must still be discovered rather than silently skipped.
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

function findMarkdownFiles(target) {
  if (!fs.existsSync(target)) return [];

  const stat = fs.statSync(target);
  if (stat.isFile()) return target.endsWith('.md') ? [target] : [];

  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) return findMarkdownFiles(child);
    return entry.isFile() && entry.name.endsWith('.md') ? [child] : [];
  });
}

function countTextLines(content) {
  if (content === '') return 0;
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

function markdownHeadingAnchor(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function validateLeadingContents(content) {
  const headings = [];
  const anchorCounts = new Map();
  const lines = content.split('\n');
  let fence = null;

  for (const [index, line] of lines.entries()) {
    if (fence) {
      const closing = new RegExp(`^\\s{0,3}\\${fence.marker}{${fence.length},}\\s*$`);
      if (closing.test(line)) fence = null;
      continue;
    }
    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const baseAnchor = markdownHeadingAnchor(match[2]);
    const count = anchorCounts.get(baseAnchor) || 0;
    anchorCounts.set(baseAnchor, count + 1);
    headings.push({
      level: match[1].length,
      text: match[2],
      line: index + 1,
      anchor: count === 0 ? baseAnchor : `${baseAnchor}-${count}`,
    });
  }

  const contents = headings.find(heading => heading.level >= 2);
  if (!contents || !/^(?:Contents|Table of contents)$/i.test(contents.text)) {
    return 'must place a Contents or Table of contents section before its topic sections';
  }

  const contentsIndex = headings.indexOf(contents);
  const nextPeer = headings.slice(contentsIndex + 1)
    .find(heading => heading.level <= contents.level);
  const endLine = nextPeer ? nextPeer.line : lines.length + 1;
  const links = [];
  for (let index = contents.line; index < endLine - 1; index++) {
    const linkPattern = /\[[^\]]+\]\(#([^)]+)\)/g;
    let match;
    while ((match = linkPattern.exec(lines[index])) !== null) {
      links.push(match[1].toLowerCase());
    }
  }

  if (links.length === 0) {
    return 'Contents section must include at least one Markdown link to a real heading';
  }

  const realAnchors = new Set(headings
    .filter(heading => heading !== contents)
    .map(heading => heading.anchor));
  const invalid = links.find(anchor => !realAnchors.has(anchor));
  return invalid
    ? `Contents link "#${invalid}" does not resolve to a heading in this file`
    : null;
}

function stripShellComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function continuesShellLine(line) {
  const trimmed = line.trimEnd();
  let backslashes = 0;
  for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === '\\'; index--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function flattenShellSegments(segments) {
  let text = '';
  const lineMap = [];
  for (const segment of segments) {
    let value = stripShellComment(segment.text);
    if (continuesShellLine(value)) value = value.trimEnd().slice(0, -1);
    for (const char of value) {
      text += char;
      lineMap.push(segment.line);
    }
    text += ' ';
    lineMap.push(segment.line);
  }
  return { text, lineMap };
}

function tokenizeMappedShell(text, lineMap) {
  const tokens = [];
  let value = '';
  let start = -1;
  let quote = null;
  let escaped = false;

  function pushToken(end) {
    if (value === '') return;
    tokens.push({ value, line: lineMap[start], start, end });
    value = '';
    start = -1;
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      if (start === -1) start = index;
      value += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      if (start === -1) start = index;
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else value += char;
    } else if (char === '"' || char === "'") {
      if (start === -1) start = index;
      quote = char;
    } else if (/[;|&()]/.test(char)) {
      pushToken(index);
      const pair = text.slice(index, index + 2);
      const operator = pair === '&&' || pair === '||' ? pair : char;
      tokens.push({
        value: operator,
        line: lineMap[index],
        start: index,
        end: index + operator.length,
        operator: true,
      });
      if (operator.length === 2) index++;
    } else if (/\s/.test(char)) {
      pushToken(index);
    } else {
      if (start === -1) start = index;
      value += char;
    }
  }

  if (escaped || quote) return { tokens: null, text, lineMap };
  pushToken(text.length);
  return { tokens, text, lineMap };
}

function tokenizeShellSegments(segments) {
  const { text, lineMap } = flattenShellSegments(segments);
  return tokenizeMappedShell(text, lineMap);
}

function maskCommandSubstitutions(text, lineMap) {
  let masked = '';
  const maskedLineMap = [];
  const substitutions = [];
  let outerQuote = null;
  let outerEscaped = false;

  for (let index = 0; index < text.length;) {
    const outerChar = text[index];
    const startsSubstitution = !outerEscaped
      && outerQuote !== "'"
      && outerChar === '$'
      && text[index + 1] === '(';
    if (!startsSubstitution) {
      masked += outerChar;
      maskedLineMap.push(lineMap[index]);
      if (outerEscaped) {
        outerEscaped = false;
      } else if (outerChar === '\\' && outerQuote !== "'") {
        outerEscaped = true;
      } else if (outerQuote) {
        if (outerChar === outerQuote) outerQuote = null;
      } else if (outerChar === '"' || outerChar === "'") {
        outerQuote = outerChar;
      }
      index++;
      continue;
    }

    const start = index;
    let cursor = index + 2;
    let depth = 1;
    let quote = null;
    let escaped = false;
    while (cursor < text.length && depth > 0) {
      const char = text[cursor];
      if (escaped) {
        escaped = false;
      } else if (char === '\\' && quote !== "'") {
        escaped = true;
      } else if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
      }
      cursor++;
    }

    if (depth !== 0) {
      return {
        masked: null,
        maskedLineMap: null,
        substitutions,
        malformedLine: lineMap[start],
      };
    }

    const end = cursor - 1;
    substitutions.push({
      text: text.slice(start + 2, end),
      lineMap: lineMap.slice(start + 2, end),
    });
    const placeholder = 'SUBSTITUTION';
    masked += placeholder;
    maskedLineMap.push(...Array(placeholder.length).fill(lineMap[start]));
    index = cursor;
  }

  return {
    masked,
    maskedLineMap,
    substitutions,
    malformedLine: null,
  };
}

function hasCommandInvocation(text) {
  return /(?:^|[;&|]\s*|\$\(\s*|`)\s*(?:(?:if|then|do|while|until|!)\s+)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:(?:sudo|command)\s+)?(?:eval|kubectl|docker|podman|nerdctl)\b/.test(text);
}

function hasLeadingCommandInvocation(text) {
  return /^\s*(?:(?:if|then|do|while|until|!)\s+)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:(?:sudo|command)\s+)?(?:eval|kubectl|docker|podman|nerdctl)\b/.test(text);
}

function parseShellUnits(content, startLine = 1) {
  const lines = content.split('\n');
  const units = [];

  for (let index = 0; index < lines.length;) {
    const first = lines[index].replace(/^\s*\$\s+/, '');
    if (/^\s*(?:#|$)/.test(first)) {
      index++;
      continue;
    }

    const segments = [];
    let current = first;
    do {
      segments.push({ text: current, line: startLine + index });
      index++;
      if (!continuesShellLine(current) || index >= lines.length) break;
      current = lines[index];
    } while (true);

    const flattened = flattenShellSegments(segments).text;
    const heredocs = [];
    const heredocPattern = /<<(-)?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
    let heredocMatch;
    while ((heredocMatch = heredocPattern.exec(flattened)) !== null) {
      const delimiter = heredocMatch[3];
      const allowTabs = Boolean(heredocMatch[1]);
      const payload = [];
      let terminated = false;
      while (index < lines.length) {
        const candidate = allowTabs ? lines[index].replace(/^\t+/, '') : lines[index];
        if (candidate === delimiter) {
          terminated = true;
          index++;
          break;
        }
        payload.push({ text: lines[index], line: startLine + index });
        index++;
      }
      heredocs.push({ delimiter, payload, terminated });
    }

    if (heredocs.length > 0 && index < lines.length && /^\s*\)/.test(lines[index])) {
      segments.push({ text: lines[index], line: startLine + index });
      index++;
    }
    units.push({ segments, heredocs });
  }

  return units;
}

function extractMarkdownShellSources(content) {
  const sources = [];
  const errors = [];
  const lines = content.split('\n');
  let fence = null;

  function activeFence(current) {
    const body = current.lines.join('\n');
    const language = current.info.toLowerCase().split(/\s+/, 1)[0];
    if (SHELL_FENCE_LANGUAGES.has(language)) return true;
    if (language !== '') return false;
    return parseShellUnits(body, current.startLine)
      .some(unit => hasCommandInvocation(flattenShellSegments(unit.segments).text));
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      const closing = new RegExp(`^\\s{0,3}\\${fence.marker}{${fence.length},}\\s*$`);
      if (closing.test(line)) {
        if (activeFence(fence)) {
          sources.push({ content: fence.lines.join('\n'), startLine: fence.startLine });
        }
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^`~]*)$/);
    if (opening) {
      fence = {
        marker: opening[1][0],
        length: opening[1].length,
        info: opening[2].trim(),
        openingLine: index + 1,
        startLine: index + 2,
        lines: [],
      };
      continue;
    }

    const candidate = line.replace(/^\s*(?:>\s*)?(?:[-*+]\s+)?(?:\$\s*)?/, '');
    if (!hasLeadingCommandInvocation(candidate)) continue;
    const sourceLines = [candidate];
    const sourceStart = index + 1;
    while (continuesShellLine(sourceLines[sourceLines.length - 1]) && index + 1 < lines.length) {
      sourceLines.push(lines[++index]);
    }
    const commandText = sourceLines.join(' ');
    const heredoc = commandText.match(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (heredoc) {
      const delimiter = heredoc[2];
      while (index + 1 < lines.length) {
        const payloadLine = lines[++index];
        sourceLines.push(payloadLine);
        if (payloadLine.replace(/^\t+/, '') === delimiter) break;
      }
    }
    sources.push({ content: sourceLines.join('\n'), startLine: sourceStart });
  }

  if (fence && activeFence(fence)) {
    errors.push({
      line: fence.openingLine,
      message: 'starts an unterminated executable shell code block; command safety cannot be verified',
    });
  }
  return { sources, errors };
}

function collectShellAssignments(units) {
  const assignments = new Map();
  for (const unit of units) {
    const text = flattenShellSegments(unit.segments).text.trim();
    const match = text.match(/^([A-Z_][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))$/);
    if (match) assignments.set(match[1], match[2] ?? match[3] ?? match[4]);
  }
  return assignments;
}

function resolveShellValue(value, assignments, seen = new Set()) {
  let resolved = value.replace(/^["']|["']$/g, '');
  const variable = resolved.match(/^\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))$/);
  if (!variable) return resolved;
  const name = variable[1] || variable[2];
  if (seen.has(name) || !assignments.has(name)) return null;
  seen.add(name);
  return resolveShellValue(assignments.get(name), assignments, seen);
}

function commandSegments(tokens) {
  const segments = [];
  const clauses = [];
  let start = 0;
  for (let index = 0; index <= tokens.length; index++) {
    if (index === tokens.length || tokens[index].operator) {
      if (index > start) clauses.push(tokens.slice(start, index));
      start = index + 1;
    }
  }

  for (const clause of clauses) {
    let index = 0;
    while (index < clause.length
      && /^(?:!|if|then|do|else|elif|while|until|\{)$/.test(clause[index].value)) {
      index++;
    }
    while (index < clause.length
      && /^[A-Za-z_][A-Za-z0-9_]*=/.test(clause[index].value)) {
      index++;
    }
    while (index < clause.length && /^(?:sudo|command|env)$/.test(clause[index].value)) {
      const wrapper = clause[index++].value;
      while (index < clause.length && clause[index].value.startsWith('-')) {
        const option = clause[index++].value;
        if (wrapper === 'sudo' && /^(?:-u|-g|-h|-p|-r|-t|-C|-D|-T)$/.test(option)) index++;
        if (wrapper === 'env' && /^(?:-u|--unset|-C|--chdir|-S|--split-string)$/.test(option)) index++;
      }
      while (index < clause.length
        && /^[A-Za-z_][A-Za-z0-9_]*=/.test(clause[index].value)) {
        index++;
      }
    }

    const commandToken = clause[index];
    if (!commandToken || !EXECUTABLE_COMMANDS.has(commandToken.value)) continue;
    segments.push({ command: commandToken.value, tokens: clause.slice(index) });
  }
  return segments;
}

function findTtyViolation(segment) {
  const values = segment.tokens.map(token => token.value);
  const ttyCapable = segment.command === 'kubectl'
    ? values.some(value => /^(?:attach|debug|exec|run)$/.test(value))
    : /^(?:docker|podman|nerdctl)$/.test(segment.command)
      && values.some(value => /^(?:exec|run)$/.test(value));
  if (!ttyCapable) return null;

  for (const token of segment.tokens.slice(1)) {
    if (/^--(?:interactive|stdin|tty)(?:=.*)?$/.test(token.value)) return token;
    const short = token.value.match(/^-([A-Za-z]+)(?:=.*)?$/);
    if (!short) continue;
    if (/[it]/.test(short[1])) return token;
  }
  return null;
}

function extractDockerRunImage(segment) {
  const values = segment.tokens.map(token => token.value);
  const runIndex = values.indexOf('run');
  if (runIndex === -1) return { image: null, malformed: false };

  const booleanLong = new Set([
    '--detach', '--disable-content-trust', '--init', '--interactive',
    '--oom-kill-disable', '--privileged', '--publish-all', '--read-only',
    '--rm', '--sig-proxy', '--tty',
  ]);
  const valueLong = new Set([
    '--add-host', '--annotation', '--attach', '--cap-add', '--cap-drop',
    '--cgroup-parent', '--cidfile', '--cpus', '--device', '--dns',
    '--dns-option', '--dns-search', '--entrypoint', '--env', '--env-file',
    '--expose', '--gpus', '--group-add', '--health-cmd', '--health-interval',
    '--health-retries', '--health-start-period', '--health-timeout',
    '--hostname', '--ipc', '--label', '--label-file', '--log-driver',
    '--log-opt', '--mac-address', '--memory', '--memory-reservation',
    '--memory-swap', '--mount', '--name', '--network', '--network-alias',
    '--pid', '--platform', '--publish', '--restart', '--runtime',
    '--security-opt', '--shm-size', '--stop-signal', '--stop-timeout',
    '--storage-opt', '--sysctl', '--tmpfs', '--ulimit', '--user',
    '--userns', '--uts', '--volume', '--volume-driver', '--workdir',
  ]);
  const valueShort = new Set(['-a', '-c', '-e', '-h', '-l', '-m', '-p', '-u', '-v', '-w']);

  for (let index = runIndex + 1; index < segment.tokens.length; index++) {
    const token = segment.tokens[index];
    const value = token.value;
    if (value === '--') {
      return segment.tokens[index + 1]
        ? { image: segment.tokens[index + 1], malformed: false }
        : { image: null, malformed: true, line: token.line };
    }
    if (booleanLong.has(value) || /^-[ditPq]+$/.test(value)) continue;
    if (valueLong.has(value) || valueShort.has(value)) {
      if (!segment.tokens[index + 1]) return { image: null, malformed: true, line: token.line };
      index++;
      continue;
    }
    if (value.startsWith('--') && value.includes('=')) continue;
    if ([...valueShort].some(option => value.startsWith(option) && value.length > option.length)) continue;
    if (value.startsWith('-')) return { image: null, malformed: true, line: token.line };
    return { image: token, malformed: false };
  }

  return { image: null, malformed: true, line: segment.tokens[runIndex].line };
}

function extractKubectlImages(segment) {
  const images = [];
  let malformedLine = null;
  for (let index = 1; index < segment.tokens.length; index++) {
    const token = segment.tokens[index];
    if (token.value === '--image') {
      const image = segment.tokens[index + 1];
      if (!image || image.value.startsWith('-')) malformedLine = token.line;
      else images.push(image);
    } else if (token.value.startsWith('--image=')) {
      const value = token.value.slice('--image='.length);
      if (value === '') malformedLine = token.line;
      else images.push({ value, line: token.line });
    }
  }

  const values = segment.tokens.map(token => token.value);
  const setIndex = values.indexOf('set');
  if (setIndex !== -1 && values[setIndex + 1] === 'image') {
    for (const token of segment.tokens.slice(setIndex + 2)) {
      if (token.value.startsWith('-')) continue;
      const assignment = token.value.match(/^[^=]+=([^=].*)$/);
      if (assignment) images.push({ value: assignment[1], line: token.line });
    }
  }
  return { images, malformedLine };
}

function inspectShellSource(content, { startLine = 1 } = {}) {
  const units = parseShellUnits(content, startLine);
  const assignments = collectShellAssignments(units);
  const findings = [];

  function addImageFinding(image, line) {
    const resolved = resolveShellValue(image, assignments);
    if (!resolved) {
      findings.push({
        line,
        kind: 'malformed-image',
        message: `cannot resolve executable container image "${image}" to a fixed value`,
      });
    } else if (!MCR_DIGEST_IMAGE_RE.test(resolved)) {
      findings.push({
        line,
        kind: 'image',
        message: `executes container image "${resolved}"; executable images must be MCR-hosted and pinned by sha256 digest`,
      });
    }
  }

  function inspectMappedCommand(text, lineMap) {
    const substitutionResult = maskCommandSubstitutions(text, lineMap);
    if (substitutionResult.malformedLine !== null) {
      findings.push({
        line: substitutionResult.malformedLine,
        kind: 'malformed-command',
        message: 'has an unterminated command substitution; command safety cannot be verified',
      });
      return [];
    }

    const parsed = tokenizeMappedShell(
      substitutionResult.masked,
      substitutionResult.maskedLineMap,
    );
    if (!parsed.tokens) {
      if (hasCommandInvocation(parsed.text)) {
        findings.push({
          line: lineMap[0],
          kind: 'malformed-command',
          message: 'has malformed shell quoting; command safety cannot be verified',
        });
      }
      return [];
    }

    const segments = commandSegments(parsed.tokens);
    for (const segment of segments) {
      if (!EXECUTABLE_COMMANDS.has(segment.command)) continue;
      if (segment.command === 'eval') {
        findings.push({
          line: segment.tokens[0].line,
          kind: 'eval',
          message: 'uses eval in an agent-run command',
        });
        continue;
      }

      const tty = findTtyViolation(segment);
      if (tty) {
        findings.push({
          line: tty.line,
          kind: 'tty',
          message: 'uses an interactive stdin or TTY flag in an agent-run command',
        });
      }

      if (segment.command === 'kubectl') {
        const { images, malformedLine } = extractKubectlImages(segment);
        if (malformedLine !== null) {
          findings.push({
            line: malformedLine,
            kind: 'malformed-image',
            message: 'has a malformed executable image argument; command safety cannot be verified',
          });
        }
        for (const image of images) addImageFinding(image.value, image.line);
      } else {
        const runtimeImage = extractDockerRunImage(segment);
        if (runtimeImage.malformed) {
          findings.push({
            line: runtimeImage.line,
            kind: 'malformed-image',
            message: 'has ambiguous container runtime options; executable image provenance cannot be verified',
          });
        } else if (runtimeImage.image) {
          addImageFinding(runtimeImage.image.value, runtimeImage.image.line);
        }
      }
    }

    const nestedSegments = [];
    for (const substitution of substitutionResult.substitutions) {
      nestedSegments.push(...inspectMappedCommand(substitution.text, substitution.lineMap));
    }
    return [...segments, ...nestedSegments];
  }

  for (const unit of units) {
    const { text, lineMap } = flattenShellSegments(unit.segments);
    const segments = inspectMappedCommand(text, lineMap);
    const appliesYaml = segments.some((segment) => {
      if (segment.command !== 'kubectl') return false;
      return segment.tokens.some(token => /^(?:apply|create|replace)$/.test(token.value));
    });
    if (!appliesYaml) continue;
    for (const heredoc of unit.heredocs) {
      if (!heredoc.terminated) {
        findings.push({
          line: unit.segments[0].line,
          kind: 'malformed-command',
          message: `has an unterminated "${heredoc.delimiter}" heredoc; command safety cannot be verified`,
        });
        continue;
      }
      for (const payloadLine of heredoc.payload) {
        const image = payloadLine.text.match(/^\s*(?:-\s*)?image:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
        if (image) addImageFinding(image[1] || image[2] || image[3], payloadLine.line);
      }
    }
  }
  return findings;
}

function checkAzureMcpGuidanceContract(skillsDir, addError) {
  const repoRoot = path.dirname(skillsDir);
  const manifestPaths = [
    path.join(repoRoot, '.mcp.json'),
    path.join(repoRoot, 'plugin.json'),
    path.join(repoRoot, '.claude-plugin', 'plugin.json'),
    path.join(repoRoot, '.claude-plugin', 'marketplace.json'),
  ].filter(filePath => fs.existsSync(filePath));
  const guidanceFiles = [
    ...findMarkdownFiles(path.join(repoRoot, 'README.md')),
    ...findMarkdownFiles(path.join(repoRoot, 'docs')),
    ...findMarkdownFiles(skillsDir),
    ...manifestPaths,
  ];
  const readinessRoot = path.join(skillsDir, 'aks-automatic-readiness');

  for (const filePath of guidanceFiles) {
    const content = readText(filePath);
    const hardcodedName = content.match(HARDCODED_AZURE_MCP_NAME_RE);
    if (hardcodedName) {
      addError(
        filePath,
        `hardcoded Azure MCP tool name "${hardcodedName[0]}" is host-assigned; use capability discovery instead`,
      );
    }

    for (const [index, line] of content.split('\n').entries()) {
      if (AKS_MCP_PRODUCT_NAME_RE.test(line) && !EXPLICIT_AKS_MCP_PRODUCT_RE.test(line)) {
        addError(
          filePath,
          `line ${index + 1} uses "AKS MCP" without naming the separate Azure/aks-mcp product; call @azure/mcp "Azure MCP Server"`,
        );
      }
    }

    const isReadinessGuidance = filePath === readinessRoot
      || filePath.startsWith(`${readinessRoot}${path.sep}`)
      || /\b(?:AKS Automatic|readiness assessment|readiness API)\b/i.test(content);
    if (isReadinessGuidance) {
      for (const { label, pattern } of REMOVED_READINESS_API_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          addError(
            filePath,
            `${label} "${match[0]}" belongs to the removed fictional MCP readiness API; collect sanitized evidence and evaluate it locally`,
          );
        }
      }
    }
  }
}

/**
 * Extract the raw YAML front matter block (text between the --- delimiters).
 * Returns null if the file has no recognizable front matter block at all —
 * This only detects the boundaries; parseFrontMatter() parses the extracted
 * block with js-yaml.
 */
function extractFrontMatterBlock(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match ? match[1] : null;
}

/**
 * Order-check helper: given the keys as they actually appear in the parsed
 * document and a contract-declared required order, verify that whichever of
 * the required keys ARE present appear in the declared relative order.
 * Keys that are missing entirely are reported by the required-field check,
 * not here, so the two checks never double-report the same defect.
 */
function checkDeclaredOrder(actualKeys, requiredOrder) {
  const present = actualKeys.filter(k => requiredOrder.includes(k));
  const expected = requiredOrder.filter(k => present.includes(k));
  if (present.join(',') === expected.join(',')) return null;
  return { found: present, expected };
}

function isScriptShaped(filePath, firstLine) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '' || SCRIPT_EXTENSIONS.has(extension) || firstLine.startsWith('#!');
}

function isShellScript(filePath, firstLine) {
  return path.extname(filePath).toLowerCase() === '.sh'
    || /^#!.*\b(?:ba|z|da|k)?sh(?:\s|$)/.test(firstLine);
}

/**
 * Read the executable mode from Git's index, which is stable across filesystems
 * and platforms. A null mode means the index cannot authoritatively answer.
 */
function readGitIndexMode(filePath, gitCommand) {
  const options = { encoding: 'utf8', windowsHide: true };
  const rootResult = spawnSync(
    gitCommand,
    ['-C', path.dirname(filePath), 'rev-parse', '--show-toplevel'],
    options,
  );

  if (rootResult.error) {
    const reason = rootResult.error.code === 'ENOENT'
      ? 'Git executable is unavailable'
      : `Git could not be executed: ${rootResult.error.message}`;
    return { mode: null, reason };
  }
  if (rootResult.status !== 0) {
    return { mode: null, reason: 'file is not inside a Git work tree' };
  }

  const repoRoot = fs.realpathSync(rootResult.stdout.trim());
  const nativeRelativePath = path.relative(repoRoot, fs.realpathSync(filePath));
  if (nativeRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(nativeRelativePath)) {
    return { mode: null, reason: 'file is outside the discovered Git work tree' };
  }
  const relativePath = nativeRelativePath.split(path.sep).join('/');

  const indexResult = spawnSync(
    gitCommand,
    ['-C', repoRoot, 'ls-files', '--stage', '--', relativePath],
    options,
  );
  if (indexResult.error) {
    return { mode: null, reason: `Git index could not be read: ${indexResult.error.message}` };
  }
  if (indexResult.status !== 0) {
    return { mode: null, reason: 'Git index could not be read' };
  }

  const entry = indexResult.stdout.match(/^(\d{6}) [0-9a-f]+ 0\t/);
  if (!entry) {
    return { mode: null, reason: 'file is untracked or has no stage-0 index entry' };
  }
  return { mode: entry[1], reason: null };
}

/**
 * Run the full contract lint against a skills directory.
 * Returns { errors, warnings, skillCount } — does not print or exit, so it
 * can be called in-process by tests against fixture directories.
 */
function lintSkills({
  skillsDir,
  testsDir,
  promptfooConfigPath,
  gitCommand = 'git',
}) {
  const errors = [];
  const warnings = [];
  let skillCount = 0;

  function addError(skillPath, msg) {
    errors.push(`ERROR [${path.relative(skillsDir, skillPath)}]: ${msg}`);
  }
  function addWarning(skillPath, msg) {
    warnings.push(`WARN  [${path.relative(skillsDir, skillPath)}]: ${msg}`);
  }

  // Load evals/promptfooconfig.yaml once so every skill's quality-tests.yaml
  // wiring can be checked against it (contract §5 "wired into promptfooconfig.yaml").
  let promptfooTests = null; // null = could not read/parse; array = tests: list
  if (fs.existsSync(promptfooConfigPath)) {
    try {
      promptfooTests = parsePromptfooTests(readText(promptfooConfigPath));
    } catch (e) {
      addError(promptfooConfigPath, `could not parse promptfooconfig.yaml as YAML: ${e.message}`);
    }
  } else {
    addError(promptfooConfigPath, 'promptfooconfig.yaml not found — cannot verify quality-test wiring (contract §5)');
  }

  /**
   * Every shipped skill must have non-empty trigger-tests.yaml AND
   * quality-tests.yaml (contract §5). "Non-empty" means it parses to a YAML
   * list with at least one test case, not merely a non-empty file.
   */
  function checkYamlListFile(filePath, skillMdPath, label) {
    if (!fs.existsSync(filePath)) {
      addError(skillMdPath, `missing required evals/tests/.../${label} (contract §5)`);
      return false;
    }
    let parsed;
    try {
      parsed = parseNonEmptyYamlList(readText(filePath));
    } catch (e) {
      addError(skillMdPath, `${label} is not valid YAML: ${e.message}`);
      return false;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      addError(skillMdPath, `${label} must be a non-empty list of test cases (contract §5)`);
      return false;
    }
    return true;
  }

  function checkTestCoverage(skillName, skillMdPath) {
    const triggerPath = path.join(testsDir, skillName, 'trigger-tests.yaml');
    const qualityPath = path.join(testsDir, skillName, 'quality-tests.yaml');
    checkYamlListFile(triggerPath, skillMdPath, 'trigger-tests.yaml');
    const qualityOk = checkYamlListFile(qualityPath, skillMdPath, 'quality-tests.yaml');

    if (!qualityOk) return; // already errored above; don't pile on a wiring error too

    if (promptfooTests === null) return; // config itself unreadable; already errored once

    const expectedEntry = `file://tests/${skillName}/quality-tests.yaml`;
    if (!promptfooTests.includes(expectedEntry)) {
      addError(
        skillMdPath,
        `quality-tests.yaml is not wired into evals/promptfooconfig.yaml (expected a "${expectedEntry}" entry under tests:) (contract §5)`,
      );
    }
  }

  /**
   * Check script-shaped files under scripts/ and shell scripts anywhere in the
   * registered skill bundle for a valid shebang and Git index mode 100755.
   * Shared shell-command policy applies only where the interpreter is a shell.
   */
  function checkScripts(skillDir) {
    const scriptsDir = path.join(skillDir, 'scripts');
    const scripts = [];
    function walk(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (entry.isFile()) {
          const firstLine = readText(entryPath).split('\n')[0];
          const underScripts = entryPath === scriptsDir
            || entryPath.startsWith(`${scriptsDir}${path.sep}`);
          const shell = isShellScript(entryPath, firstLine);
          if ((underScripts && isScriptShaped(entryPath, firstLine)) || shell) {
            scripts.push({ filePath: entryPath, firstLine, shell });
          }
        }
      }
    }
    walk(skillDir);

    for (const { filePath, firstLine, shell } of scripts) {
      if (!VALID_SHEBANG_RE.test(firstLine)) {
        addError(filePath, 'Script missing a valid shebang line (e.g. #!/bin/bash, #!/usr/bin/env python3) (contract §4)');
      }
      const { mode, reason } = readGitIndexMode(filePath, gitCommand);
      if (mode === null) {
        addWarning(filePath, `Cannot verify script executable bit from Git index: ${reason} (contract §4)`);
      } else if (mode !== '100755') {
        addError(filePath, 'Script is not executable (git mode must be 100755 — run `chmod +x` and re-stage) (contract §4)');
      }

      if (shell) {
        for (const finding of inspectShellSource(readText(filePath))) {
          addError(filePath, `line ${finding.line} ${finding.message} (contract §4)`);
        }
      }
    }
  }

  function checkBundleMarkdown(skillDir) {
    for (const filePath of findMarkdownFiles(skillDir).sort()) {
      const content = readText(filePath);
      if (path.basename(filePath) !== 'SKILL.md'
        && countTextLines(content) > MAX_REFERENCE_LINES_WITHOUT_TOC) {
        const contentsError = validateLeadingContents(content);
        if (contentsError) {
          addError(
            filePath,
            `Markdown reference is longer than ${MAX_REFERENCE_LINES_WITHOUT_TOC} lines and ${contentsError} (contract §3)`,
          );
        }
      }

      const { sources, errors: extractionErrors } = extractMarkdownShellSources(content);
      for (const extractionError of extractionErrors) {
        addError(
          filePath,
          `line ${extractionError.line} ${extractionError.message} (contract §4)`,
        );
      }
      for (const source of sources) {
        for (const finding of inspectShellSource(source.content, { startLine: source.startLine })) {
          addError(filePath, `line ${finding.line} ${finding.message} (contract §4)`);
        }
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

  /**
   * Coaching-phrase lint (advisory). Flags second-person coaching that fights the host
   * model's trained posture, so a reviewer can decide whether it still earns its place.
   * Never errors — durability is a judgment call, not a hard gate.
   */
  function checkCoaching(skillDir, content) {
    const body = content.replace(/^---\n[\s\S]*?\n---/, ''); // skip front matter
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      const lemma = COACHING_LEMMAS.find(l => lower.includes(l));
      if (!lemma) continue;
      if (DOMAIN_RE.test(line) || SAFETY_RE.test(line)) continue; // durable — tool/policy/safety
      addWarning(path.join(skillDir, 'SKILL.md'),
        `coaching phrase "${lemma}" (durability: does this fight the host model's default posture? drop unless it encodes a policy/tool/safety rule)`);
    }
  }

  // --- Main per-skill loop ---

  checkAzureMcpGuidanceContract(skillsDir, addError);
  const skillFolders = findSkillFolders(skillsDir);

  for (const skillDir of skillFolders) {
    skillCount++;
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const folderName = path.basename(skillDir);

    const content = readText(skillMdPath);
    checkBundleMarkdown(skillDir);
    const rawFrontMatter = extractFrontMatterBlock(content);

    if (rawFrontMatter === null) {
      addError(skillMdPath, 'Missing or malformed YAML front matter (must start with --- and end with ---)');
      continue;
    }

    let fm;
    let topLevelKeys;
    let metadataKeys;
    try {
      const parsed = parseFrontMatter(rawFrontMatter);
      fm = parsed.value;
      topLevelKeys = parsed.topLevelKeys;
      metadataKeys = parsed.metadataKeys;
    } catch (e) {
      addError(skillMdPath, `Front matter is not valid YAML: ${e.message}`);
      continue;
    }

    if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
      addError(skillMdPath, 'Front matter must be a YAML mapping (object)');
      continue;
    }

    // --- Required fields, present ---
    const hasField = f => Object.prototype.hasOwnProperty.call(fm, f)
      && fm[f] !== null && fm[f] !== undefined && fm[f] !== '';

    for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
      if (!hasField(field)) {
        addError(skillMdPath, `Missing required field: ${field}`);
      }
    }

    const hasMetadataObject = hasField('metadata') && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata);
    if (hasField('metadata') && !hasMetadataObject) {
      addError(skillMdPath, 'metadata must be a YAML mapping (object)');
    }

    if (hasMetadataObject) {
      const hasMetaField = f => Object.prototype.hasOwnProperty.call(fm.metadata, f)
        && fm.metadata[f] !== null && fm.metadata[f] !== undefined && fm.metadata[f] !== '';
      if (!hasMetaField('author')) addError(skillMdPath, 'Missing required field: metadata.author');
      if (!hasMetaField('version')) addError(skillMdPath, 'Missing required field: metadata.version');
      for (const [key, value] of Object.entries(fm.metadata)) {
        if (typeof value !== 'string') {
          addError(
            skillMdPath,
            `metadata.${key} must be a string (Agent Skills metadata values are string-to-string)`,
          );
        }
      }
    }

    // --- Declared ordering (contract §2) ---
    const topOrder = checkDeclaredOrder(topLevelKeys, REQUIRED_TOP_LEVEL_ORDER);
    if (topOrder) {
      addError(
        skillMdPath,
        `front matter fields out of declared order: found [${topOrder.found.join(', ')}], contract requires [${topOrder.expected.join(', ')}]`,
      );
    }
    if (hasMetadataObject) {
      const metaOrder = checkDeclaredOrder(metadataKeys, REQUIRED_METADATA_ORDER);
      if (metaOrder) {
        addError(
          skillMdPath,
          `metadata fields out of declared order: found [${metaOrder.found.join(', ')}], contract requires [${metaOrder.expected.join(', ')}]`,
        );
      }
    }

    // --- name === folder (error, not a warning — the contract states this as a MUST) ---
    if (hasField('name') && fm.name !== folderName) {
      addError(skillMdPath, `front matter name "${fm.name}" must equal folder name "${folderName}"`);
    }

    // --- license / author exact values (contract §2) ---
    if (hasField('license') && fm.license !== EXPECTED_LICENSE) {
      addError(skillMdPath, `license "${fm.license}" must be "${EXPECTED_LICENSE}" (contract §2)`);
    }
    if (hasMetadataObject && Object.prototype.hasOwnProperty.call(fm.metadata, 'author')
      && fm.metadata.author !== EXPECTED_AUTHOR) {
      addError(skillMdPath, `metadata.author "${fm.metadata.author}" must be "${EXPECTED_AUTHOR}" (contract §2)`);
    }

    // --- version semver (contract §2) ---
    if (hasMetadataObject && Object.prototype.hasOwnProperty.call(fm.metadata, 'version')
      && fm.metadata.version !== null && fm.metadata.version !== undefined) {
      const v = String(fm.metadata.version);
      if (!SEMVER_RE.test(v)) {
        addError(skillMdPath, `metadata.version "${v}" is not valid semver (expected "X.Y.Z") (contract §2)`);
      }
    }

    // --- description content rules (contract §2) ---
    if (hasField('description')) {
      if (typeof fm.description !== 'string') {
        addError(skillMdPath, 'description must be a string');
      } else {
        const desc = fm.description;

        if (desc.length > MAX_DESCRIPTION_CHARS) {
          addError(
            skillMdPath,
            `description is ${desc.length} characters, exceeds the contract's maximum of ${MAX_DESCRIPTION_CHARS} characters (contract §2 "Budget")`,
          );
        }

        if (!/\bWHEN:/.test(desc)) {
          addError(skillMdPath, 'description missing required "WHEN:" trigger clause (contract §2)');
        }

        const dnuIndex = desc.search(/\bDO NOT USE FOR:/);
        if (dnuIndex === -1) {
          addError(skillMdPath, 'description missing required "DO NOT USE FOR:" boundary clause (contract §2)');
        } else {
          const tail = desc.slice(dnuIndex);
          if (!/\((?:use|see)\s+[^)]+\)/i.test(tail)) {
            addError(
              skillMdPath,
              'description "DO NOT USE FOR:" clause must name a sibling skill via the parenthetical-redirect grammar, e.g. "(use <skill>)" or "(see <skill>)" (contract §2)',
            );
          }
        }

        if (desc.split(/\s+/).filter(Boolean).length < 5) {
          addWarning(skillMdPath, 'Description is very short (< 5 words) — may not trigger well in skill routing');
        }
      }
    }

    // Scripts
    checkScripts(skillDir);

    // Internal references
    checkInternalRefs(skillDir, content);

    // Eval coverage (error if a skill is missing or has empty trigger/quality tests,
    // or a quality-tests.yaml that isn't wired into promptfooconfig.yaml)
    checkTestCoverage(folderName, skillMdPath);

    // Durability: coaching-phrase lint (warning only)
    checkCoaching(skillDir, content);
  }

  return { errors, warnings, skillCount };
}

// --- CLI entry point ---

if (require.main === module) {
  const SKILLS_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'skills'));
  const TESTS_DIR = path.resolve(process.env.LINT_TESTS_DIR || path.join(__dirname, 'tests'));
  const PROMPTFOO_CONFIG = path.resolve(process.env.LINT_PROMPTFOO_CONFIG || path.join(__dirname, 'promptfooconfig.yaml'));

  const { errors, warnings, skillCount } = lintSkills({
    skillsDir: SKILLS_DIR,
    testsDir: TESTS_DIR,
    promptfooConfigPath: PROMPTFOO_CONFIG,
  });

  if (skillCount === 0) {
    console.error(`No skills found in ${SKILLS_DIR}`);
    process.exit(1);
  }

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
    console.log('✓ All skills pass schema validation');
    process.exit(0);
  }
}

module.exports = {
  lintSkills,
  findSkillFolders,
  extractFrontMatterBlock,
  checkDeclaredOrder,
  extractMarkdownShellSources,
  inspectShellSource,
  validateLeadingContents,
  EXPECTED_LICENSE,
  EXPECTED_AUTHOR,
  MAX_DESCRIPTION_CHARS,
  MAX_REFERENCE_LINES_WITHOUT_TOC,
  SEMVER_RE,
  REQUIRED_TOP_LEVEL_ORDER,
  REQUIRED_METADATA_ORDER,
};
