#!/usr/bin/env node
/**
 * Lint self-test: a CRLF working tree (standard Windows checkout) must lint
 * identically to the LF tree CI sees. Zero external dependencies.
 *
 * Case 1: copy a real skill twice — once with LF endings, once with CRLF —
 *         and assert the linter's output is byte-identical (errors AND
 *         warnings), not merely that both exit 0.
 * Case 2: a skill with no front matter must still fail — normalization must
 *         not make the parser accept malformed files.
 * Case 3: nested skill Markdown must reject a hardcoded Azure MCP tool name.
 * Case 4: README must reject a hardcoded Azure MCP tool name.
 *
 * Usage: node lint-skills.test.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LINTER = path.join(__dirname, 'lint-skills.js');
// Small real skill whose eval coverage exists at evals/tests/<name>/, so the
// coverage gate (resolved relative to evals/, not the target dir) passes.
const SOURCE_SKILL = path.join(__dirname, '..', 'skills', 'aks-cost-optimization');

if (!fs.existsSync(SOURCE_SKILL)) {
  console.error(`✗ lint self-test: fixture skill not found at ${SOURCE_SKILL} — update SOURCE_SKILL after a skill rename/removal`);
  process.exit(1);
}

function runLinter(targetDir) {
  const result = spawnSync(process.execPath, [LINTER, targetDir], { encoding: 'utf-8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function copyWithEol(src, dest, eol) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyWithEol(from, to, eol);
    } else {
      const lf = fs.readFileSync(from, 'utf-8').replace(/\r\n?/g, '\n');
      fs.writeFileSync(to, eol === '\n' ? lf : lf.replace(/\n/g, eol));
    }
  }
}

const failures = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-selftest-'));

try {
  // Case 1: CRLF copy must lint byte-identically to an LF copy of the same
  // skill. The linter prints target-relative paths, so outputs are comparable.
  const skillName = path.basename(SOURCE_SKILL);
  const lfDir = path.join(tmpRoot, 'lf');
  const crlfDir = path.join(tmpRoot, 'crlf');
  copyWithEol(SOURCE_SKILL, path.join(lfDir, skillName), '\n');
  copyWithEol(SOURCE_SKILL, path.join(crlfDir, skillName), '\r\n');
  const lf = runLinter(lfDir);
  const crlf = runLinter(crlfDir);
  if (lf.status !== 0) {
    failures.push(`LF copy of ${skillName} failed lint (broken fixture?):\n${lf.output}`);
  } else if (crlf.status !== 0) {
    failures.push(`CRLF copy of ${skillName} failed lint:\n${crlf.output}`);
  } else if (crlf.output !== lf.output) {
    failures.push(`CRLF and LF copies of ${skillName} produced different lint output:\n--- LF ---\n${lf.output}\n--- CRLF ---\n${crlf.output}`);
  } else if (!crlf.output.includes('1 skill(s) checked')) {
    failures.push(`linter did not discover the skill copies:\n${crlf.output}`);
  }

  // Case 2: malformed front matter must still be rejected.
  const brokenDir = path.join(tmpRoot, 'broken', 'broken-skill');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'SKILL.md'), 'No front matter here.\r\n');
  const broken = runLinter(path.join(tmpRoot, 'broken'));
  if (broken.status === 0 || !broken.output.includes('malformed YAML front matter')) {
    failures.push(`malformed front matter was not rejected:\n${broken.output}`);
  }

  // Case 3: nested skill guidance must not depend on a host-assigned tool name.
  const skillPortabilityRoot = path.join(tmpRoot, 'skill-portability');
  const skillPortabilityDir = path.join(skillPortabilityRoot, 'skills');
  copyWithEol(SOURCE_SKILL, path.join(skillPortabilityDir, skillName), '\n');
  const referencesDir = path.join(skillPortabilityDir, skillName, 'references');
  fs.mkdirSync(referencesDir, { recursive: true });
  fs.writeFileSync(
    path.join(referencesDir, 'mcp.md'),
    'Call mcp_azure_mcp_aks_cluster_get before continuing.\n',
  );
  const skillPortability = runLinter(skillPortabilityDir);
  if (
    skillPortability.status === 0
    || !skillPortability.output.includes(
      'hardcoded Azure MCP tool name "mcp_azure_mcp_aks_cluster_get"',
    )
  ) {
    failures.push(`hardcoded Azure MCP name in skill Markdown was not rejected:\n${skillPortability.output}`);
  }

  // Case 4: top-level README guidance follows the same portability contract.
  const readmePortabilityRoot = path.join(tmpRoot, 'readme-portability');
  const readmeSkillsDir = path.join(readmePortabilityRoot, 'skills');
  copyWithEol(SOURCE_SKILL, path.join(readmeSkillsDir, skillName), '\n');
  fs.writeFileSync(
    path.join(readmePortabilityRoot, 'README.md'),
    'Call mcp_azure_mcp_aks_nodepool_get before continuing.\n',
  );
  const readmePortability = runLinter(readmeSkillsDir);
  if (
    readmePortability.status === 0
    || !readmePortability.output.includes(
      'hardcoded Azure MCP tool name "mcp_azure_mcp_aks_nodepool_get"',
    )
  ) {
    failures.push(`hardcoded Azure MCP name in README was not rejected:\n${readmePortability.output}`);
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  failures.forEach(f => console.error(`✗ lint self-test: ${f}`));
  process.exit(1);
}
console.log('✓ lint self-test: CRLF, malformed front matter, and Azure MCP name portability checks passed');
