#!/usr/bin/env node
/**
 * Self-test for the skill contract linter (lint-skills.js).
 *
 * Uses only Node's built-in test runner (node:test / node:assert) — no new
 * test framework or dependency. Run directly:
 *
 *   node lint-skills.test.js
 *
 * Most cases build a throwaway fixture skill tree under a temp directory,
 * call lintSkills() in-process, and assert the expected result. Subprocess
 * cases also prove the CLI exit codes used by CI. A final test runs
 * lintSkills() against the real skills/ tree and asserts it is error-free.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { lintSkills, lintProviderContracts } = require('./lint-skills.js');
const LINTER = path.join(__dirname, 'lint-skills.js');
const REPO_ROOT = path.join(__dirname, '..');
const PROVIDERS_DIR = path.join(REPO_ROOT, 'providers');

// --- Fixture helpers -------------------------------------------------------

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aks-skills-lint-test-'));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function validDescription(sibling = 'aks-fixture-sibling') {
  return 'Does fixture things for AKS clusters. '
    + 'WHEN: a fixture trigger phrase is present, or another fixture trigger phrase applies. '
    + `DO NOT USE FOR: an unrelated fixture case (use ${sibling}).`;
}

/** Contract-compliant front matter lines, in the declared order, as an array of lines. */
function validFrontMatterLines(name, overrides = {}) {
  const {
    license = 'MIT',
    author = 'Microsoft',
    version = '1.0.0',
    description = validDescription(),
    capabilityLines = [
      '  capabilities:',
      '    - id: azure.aks.cluster.read',
      '      mode: preferred',
    ],
  } = overrides;
  return [
    '---',
    `name: ${name}`,
    `license: ${license}`,
    'metadata:',
    `  author: ${author}`,
    `  version: "${version}"`,
    ...capabilityLines,
    `description: "${description}"`,
    '---',
    '',
    '# Fixture Skill',
    '',
    'Fixture body text for the contract linter self-test.',
    '',
  ];
}

function writeSkill(root, folderName, frontMatterLines) {
  const dir = path.join(root, 'skills', folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontMatterLines.join('\n'));
  return dir;
}

function writeTests(root, skillName, overrides = {}) {
  const {
    trigger = '- description: fixture trigger case\n  vars:\n    prompt: fixture prompt\n  assert: []\n',
    quality = '- description: fixture quality case\n  vars:\n    prompt: fixture prompt\n  assert: []\n',
  } = overrides;
  const dir = path.join(root, 'tests', skillName);
  fs.mkdirSync(dir, { recursive: true });
  if (trigger !== null) fs.writeFileSync(path.join(dir, 'trigger-tests.yaml'), trigger);
  if (quality !== null) fs.writeFileSync(path.join(dir, 'quality-tests.yaml'), quality);
}

function writePromptfooConfig(root, testEntries) {
  const body = ['tests:', ...testEntries.map(e => `  - ${e}`), ''].join('\n');
  fs.writeFileSync(path.join(root, 'promptfooconfig.yaml'), body);
}

/** Sets up a fully valid single-skill fixture tree (skill + tests + wiring). */
function setupValidScenario(root, skillName = 'aks-fixture-skill', frontMatterLines) {
  const lines = frontMatterLines || validFrontMatterLines(skillName);
  writeSkill(root, skillName, lines);
  writeTests(root, skillName);
  writePromptfooConfig(root, [`file://tests/${skillName}/quality-tests.yaml`]);
}

function runLint(root, overrides = {}) {
  return lintSkills({
    skillsDir: path.join(root, 'skills'),
    testsDir: path.join(root, 'tests'),
    promptfooConfigPath: path.join(root, 'promptfooconfig.yaml'),
    ...overrides,
  });
}

function runCli(root) {
  return spawnSync(process.execPath, [LINTER, path.join(root, 'skills')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LINT_TESTS_DIR: path.join(root, 'tests'),
      LINT_PROMPTFOO_CONFIG: path.join(root, 'promptfooconfig.yaml'),
      LINT_PROVIDERS_DIR: PROVIDERS_DIR,
    },
  });
}

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed:\n${result.stderr || result.stdout}`,
  );
}

function initializeGitRepo(root) {
  runGit(root, ['init', '--quiet']);
}

function stageWithMode(root, filePath, mode) {
  if (!fs.existsSync(path.join(root, '.git'))) initializeGitRepo(root);
  const relativePath = path.relative(root, filePath).split(path.sep).join('/');
  runGit(root, ['add', '--', relativePath]);
  runGit(root, [
    'update-index',
    mode === '100755' ? '--chmod=+x' : '--chmod=-x',
    '--',
    relativePath,
  ]);
}

function withTempRoot(fn) {
  const root = mkTempRoot();
  try {
    fn(root);
  } finally {
    cleanup(root);
  }
}

function rewriteTreeEol(root, eol) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      rewriteTreeEol(entryPath, eol);
    } else {
      const lf = fs.readFileSync(entryPath, 'utf-8').replace(/\r\n?/g, '\n');
      fs.writeFileSync(entryPath, lf.replace(/\n/g, eol));
    }
  }
}

function assertHasError(errors, re) {
  const found = errors.some(e => re.test(e));
  assert.ok(found, `expected an error matching ${re} in:\n${errors.join('\n')}`);
}

function assertHasWarning(warnings, re) {
  const found = warnings.some(w => re.test(w));
  assert.ok(found, `expected a warning matching ${re} in:\n${warnings.join('\n')}`);
}
// --- Baseline: the fixture harness itself produces a passing skill ---------

test('valid fixture skill passes with no errors', () => {
  withTempRoot((root) => {
    setupValidScenario(root);
    const { errors } = runLint(root);
    assert.deepEqual(errors, []);
  });
});

test('CLI exits zero for a valid fixture skill', () => {
  withTempRoot((root) => {
    setupValidScenario(root);
    const result = runCli(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /All skills pass schema validation/);
  });
});

test('CLI exits non-zero for an invalid fixture skill', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    const lines = validFrontMatterLines(name)
      .filter(line => !line.startsWith('description: '));
    setupValidScenario(root, name, lines);
    const result = runCli(root);
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Missing required field: description/);
  });
});

test('CLI exits non-zero when no skills are discovered', () => {
  withTempRoot((root) => {
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    writePromptfooConfig(root, []);
    const result = runCli(root);
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /No skills found/);
  });
});

test('CRLF fixtures produce the same errors and warnings as LF fixtures', () => {
  const lfRoot = mkTempRoot();
  const crlfRoot = mkTempRoot();
  try {
    setupValidScenario(lfRoot);
    setupValidScenario(crlfRoot);
    const skillName = 'aks-fixture-skill';
    fs.appendFileSync(path.join(lfRoot, 'skills', skillName, 'SKILL.md'), 'Be concise when answering.\n');
    fs.appendFileSync(path.join(crlfRoot, 'skills', skillName, 'SKILL.md'), 'Be concise when answering.\n');
    rewriteTreeEol(crlfRoot, '\r\n');

    assert.deepEqual(runLint(crlfRoot), runLint(lfRoot));
  } finally {
    cleanup(lfRoot);
    cleanup(crlfRoot);
  }
});

test('nested skill Markdown rejects a hardcoded Azure MCP tool name', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const referencesDir = path.join(root, 'skills', name, 'references');
    fs.mkdirSync(referencesDir, { recursive: true });
    fs.writeFileSync(
      path.join(referencesDir, 'mcp.md'),
      'Call mcp_azure_mcp_aks_cluster_get before continuing.\n',
    );
    const { errors } = runLint(root);
    assertHasError(errors, /hardcoded Azure MCP tool name "mcp_azure_mcp_aks_cluster_get"/);
  });
});

test('README rejects a hardcoded Azure MCP tool name', () => {
  withTempRoot((root) => {
    setupValidScenario(root);
    fs.writeFileSync(
      path.join(root, 'README.md'),
      'Call mcp_azure_mcp_aks_nodepool_get before continuing.\n',
    );
    const { errors } = runLint(root);
    assertHasError(errors, /hardcoded Azure MCP tool name "mcp_azure_mcp_aks_nodepool_get"/);
  });
});

// --- Manifest: required fields, presence and order (contract §2) ----------

const requiredFieldCases = [
  {
    label: 'name',
    remove: line => line.startsWith('name: '),
    error: /Missing required field: name/,
  },
  {
    label: 'license',
    remove: line => line.startsWith('license: '),
    error: /Missing required field: license/,
  },
  {
    label: 'metadata',
    remove: line => line === 'metadata:'
      || line.startsWith('  author:')
      || line.startsWith('  version:')
      || line.startsWith('  capabilities:')
      || line.startsWith('    - id:')
      || line.startsWith('      mode:')
      || line.startsWith('      when:'),
    error: /Missing required field: metadata/,
  },
  {
    label: 'metadata.author',
    remove: line => line.startsWith('  author:'),
    error: /Missing required field: metadata\.author/,
  },
  {
    label: 'metadata.version',
    remove: line => line.startsWith('  version:'),
    error: /Missing required field: metadata\.version/,
  },
  {
    label: 'metadata.capabilities',
    remove: line => line.startsWith('  capabilities:')
      || line.startsWith('    - id:')
      || line.startsWith('      mode:')
      || line.startsWith('      when:'),
    error: /Missing required field: metadata\.capabilities/,
  },
  {
    label: 'description',
    remove: line => line.startsWith('description: '),
    error: /Missing required field: description/,
  },
];

for (const requiredFieldCase of requiredFieldCases) {
  test(`missing required field (${requiredFieldCase.label}) is an error`, () => {
    withTempRoot((root) => {
      const name = 'aks-fixture-skill';
      const lines = validFrontMatterLines(name).filter(line => !requiredFieldCase.remove(line));
      writeSkill(root, name, lines);
      writeTests(root, name);
      writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
      const { errors } = runLint(root);
      assertHasError(errors, requiredFieldCase.error);
    });
  });
}

test('top-level front matter fields out of declared order is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    // metadata declared before license — violates name, license, metadata, description order.
    const lines = [
      '---',
      `name: ${name}`,
      'metadata:',
      '  author: Microsoft',
      '  version: "1.0.0"',
      '  capabilities: []',
      'license: MIT',
      `description: "${validDescription()}"`,
      '---',
      '',
    ];
    writeSkill(root, name, lines);
    writeTests(root, name);
    writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /front matter fields out of declared order/);
  });
});

test('metadata fields out of declared order is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    // version declared before author — violates the author, version order.
    const lines = [
      '---',
      `name: ${name}`,
      'license: MIT',
      'metadata:',
      '  version: "1.0.0"',
      '  author: Microsoft',
      '  capabilities: []',
      `description: "${validDescription()}"`,
      '---',
      '',
    ];
    writeSkill(root, name, lines);
    writeTests(root, name);
    writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /metadata fields out of declared order/);
  });
});

test('malformed YAML front matter is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    const lines = ['---', 'name: [unterminated', '---', ''];
    writeSkill(root, name, lines);
    writeTests(root, name);
    writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /Front matter is not valid YAML/);
  });
});

test('folded YAML description accepted by the written contract passes', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    const lines = [
      '---',
      `name: ${name}`,
      'license: MIT',
      'metadata:',
      '  author: Microsoft',
      '  version: "1.0.0"',
      '  capabilities: []',
      'description: >-',
      '  Does fixture things for AKS clusters.',
      '  WHEN: a fixture trigger phrase is present.',
      '  DO NOT USE FOR: an unrelated fixture case (use aks-fixture-sibling).',
      '---',
      '',
      '# Fixture Skill',
      '',
    ];
    setupValidScenario(root, name, lines);
    const { errors } = runLint(root);
    assert.deepEqual(errors, []);
  });
});

test('no front matter delimiters at all is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    const dir = path.join(root, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# No front matter here\n');
    writeTests(root, name);
    writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /Missing or malformed YAML front matter/);
  });
});

// --- name === folder (contract §2) -----------------------------------------

test('front matter name not matching folder name is an error', () => {
  withTempRoot((root) => {
    const folder = 'aks-fixture-folder';
    const lines = validFrontMatterLines('aks-different-name');
    writeSkill(root, folder, lines);
    writeTests(root, folder);
    writePromptfooConfig(root, [`file://tests/${folder}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /must equal folder name/);
  });
});

// --- semver / license / author exact values (contract §2) ------------------

test('non-semver metadata.version is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, { version: 'v1.0' }));
    const { errors } = runLint(root);
    assertHasError(errors, /is not valid semver/);
  });
});

test('semver metadata.version with a leading zero is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, { version: '01.0.0' }));
    const { errors } = runLint(root);
    assertHasError(errors, /is not valid semver/);
  });
});

test('license other than MIT is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, { license: 'Apache-2.0' }));
    const { errors } = runLint(root);
    assertHasError(errors, /must be "MIT"/);
  });
});

test('metadata.author other than Microsoft is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, { author: 'Contoso' }));
    const { errors } = runLint(root);
    assertHasError(errors, /must be "Microsoft"/);
  });
});

// --- description content rules (contract §2) --------------------------------

test('description missing WHEN: clause is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    const desc = 'Does fixture things. DO NOT USE FOR: an unrelated case (use aks-fixture-sibling).';
    setupValidScenario(root, name, validFrontMatterLines(name, { description: desc }));
    const { errors } = runLint(root);
    assertHasError(errors, /missing required "WHEN:" trigger clause/);
  });
});

test('description missing DO NOT USE FOR: clause is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    const desc = 'Does fixture things. WHEN: a fixture trigger phrase is present.';
    setupValidScenario(root, name, validFrontMatterLines(name, { description: desc }));
    const { errors } = runLint(root);
    assertHasError(errors, /missing required "DO NOT USE FOR:" boundary clause/);
  });
});

test('description DO NOT USE FOR: clause without parenthetical-redirect grammar is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    const desc = 'Does fixture things. WHEN: a fixture trigger phrase is present. '
      + 'DO NOT USE FOR: an unrelated case, see the other skill instead.';
    setupValidScenario(root, name, validFrontMatterLines(name, { description: desc }));
    const { errors } = runLint(root);
    assertHasError(errors, /parenthetical-redirect grammar/);
  });
});

test('description exceeding the ~2000 char routing budget is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    const filler = 'A'.repeat(2100);
    const desc = `${filler} WHEN: a fixture trigger phrase is present. `
      + 'DO NOT USE FOR: an unrelated case (use aks-fixture-sibling).';
    setupValidScenario(root, name, validFrontMatterLines(name, { description: desc }));
    const { errors } = runLint(root);
    assertHasError(errors, /exceeds the contract's routing budget of ~2000 chars/);
  });
});

// --- Provider-neutral capability contract ----------------------------------

test('an empty capability list keeps an offline skill valid', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, {
      capabilityLines: ['  capabilities: []'],
    }));
    const { errors } = runLint(root);
    assert.deepEqual(errors, []);
  });
});

test('an unknown semantic capability ID is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, {
      capabilityLines: [
        '  capabilities:',
        '    - id: azure.aks.invented.read',
        '      mode: preferred',
      ],
    }));
    const { errors } = runLint(root);
    assertHasError(errors, /is not a known semantic capability/);
  });
});

test('an unknown capability requirement mode is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, {
      capabilityLines: [
        '  capabilities:',
        '    - id: azure.aks.cluster.read',
        '      mode: optional',
      ],
    }));
    const { errors } = runLint(root);
    assertHasError(errors, /is not a valid requirement mode/);
  });
});

test('a conditional capability without a condition is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, {
      capabilityLines: [
        '  capabilities:',
        '    - id: azure.compute.quota.read',
        '      mode: conditional',
      ],
    }));
    const { errors } = runLint(root);
    assertHasError(errors, /\.when is required for conditional capabilities/);
  });
});

test('a provider-specific tool name in a skill declaration is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, {
      capabilityLines: [
        '  capabilities:',
        '    - id: azure.aks.cluster.read',
        '      mode: preferred',
        '      tool: call_az',
      ],
    }));
    const { errors } = runLint(root);
    assertHasError(errors, /contains provider-specific tool name "call_az"/);
  });
});

test('a provider-specific tool name embedded in a condition is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, {
      capabilityLines: [
        '  capabilities:',
        '    - id: azure.aks.cluster.read',
        '      mode: conditional',
        '      when: call_az is available',
      ],
    }));
    const { errors } = runLint(root);
    assertHasError(errors, /contains provider-specific tool name "call_az"/);
  });
});

test('a host-rendered alias in a skill declaration is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name, validFrontMatterLines(name, {
      capabilityLines: [
        '  capabilities:',
        '    - id: azure.aks.cluster.read',
        '      mode: conditional',
        '      when: mcp__plugin_aks_azure__cluster_get is available',
      ],
    }));
    const { errors } = runLint(root);
    assertHasError(errors, /contains forbidden host alias/);
  });
});

function withProviderFixture(fn) {
  withTempRoot((root) => {
    const providersDir = path.join(root, 'providers');
    fs.cpSync(PROVIDERS_DIR, providersDir, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, '.mcp.json'), path.join(root, '.mcp.json'));
    fn({ root, providersDir });
  });
}

function lintProviderFixture(root, providersDir) {
  return lintProviderContracts({ providersDir, repoRoot: root });
}

test('the checked-in provider maps pass the compatibility contract', () => {
  assert.deepEqual(lintProviderContracts({
    providersDir: PROVIDERS_DIR,
    repoRoot: REPO_ROOT,
  }), []);
});

test('a floating provider version is an error', () => {
  withProviderFixture(({ root, providersDir }) => {
    const mapPath = path.join(providersDir, 'azure-mcp.yaml');
    const content = fs.readFileSync(mapPath, 'utf8')
      .replace('version: 3.0.0-beta.32', 'version: latest');
    fs.writeFileSync(mapPath, content);
    assertHasError(lintProviderFixture(root, providersDir), /must be exact tested version/);
  });
});

test('an unpublished provider operation is an error', () => {
  withProviderFixture(({ root, providersDir }) => {
    const mapPath = path.join(providersDir, 'azure-mcp.yaml');
    const content = fs.readFileSync(mapPath, 'utf8')
      .replace('published_operation: aks cluster get', 'published_operation: aks cluster assess');
    fs.writeFileSync(mapPath, content);
    assertHasError(lintProviderFixture(root, providersDir), /is not published for azure\.aks\.cluster\.read/);
  });
});

test('a published operation mapped to the wrong capability is an error', () => {
  withProviderFixture(({ root, providersDir }) => {
    const mapPath = path.join(providersDir, 'azure-mcp.yaml');
    const content = fs.readFileSync(mapPath, 'utf8')
      .replace('published_operation: aks cluster get', 'published_operation: aks nodepool get');
    fs.writeFileSync(mapPath, content);
    assertHasError(lintProviderFixture(root, providersDir), /is not published for azure\.aks\.cluster\.read/);
  });
});

test('provider schema drift is an error', () => {
  withProviderFixture(({ root, providersDir }) => {
    const mapPath = path.join(providersDir, 'aks-mcp.yaml');
    const content = fs.readFileSync(mapPath, 'utf8')
      .replace('        - command\n', '        - args\n');
    fs.writeFileSync(mapPath, content);
    assertHasError(lintProviderFixture(root, providersDir), /tested_schema does not match/);
  });
});

test('a missing tested capability mapping is an error', () => {
  withProviderFixture(({ root, providersDir }) => {
    const mapPath = path.join(providersDir, 'azure-mcp.yaml');
    const content = fs.readFileSync(mapPath, 'utf8')
      .replace(/\n  - id: azure\.aks\.nodepool\.read[\s\S]*?(?=\nunsupported:)/, '');
    fs.writeFileSync(mapPath, content);
    assertHasError(lintProviderFixture(root, providersDir), /exact tested provider surface/);
  });
});

test('a host-rendered alias in a provider map is an error', () => {
  withProviderFixture(({ root, providersDir }) => {
    const mapPath = path.join(providersDir, 'azure-mcp.yaml');
    fs.appendFileSync(mapPath, 'debug_alias: mcp__plugin_aks_azure__cluster_get\n');
    assertHasError(lintProviderFixture(root, providersDir), /host-rendered alias/);
  });
});

test('authorization denial cannot authorize provider fallback', () => {
  withProviderFixture(({ root, providersDir }) => {
    const mapPath = path.join(providersDir, 'aks-mcp.yaml');
    const content = fs.readFileSync(mapPath, 'utf8')
      .replace(
        '  allowed_reasons:\n    - absent\n    - unsupported',
        '  allowed_reasons:\n    - absent\n    - unsupported\n    - authorization-denied',
      );
    fs.writeFileSync(mapPath, content);
    assertHasError(lintProviderFixture(root, providersDir), /allowed_reasons must be exactly/);
  });
});

test('context mismatch must remain a stop reason', () => {
  withProviderFixture(({ root, providersDir }) => {
    const mapPath = path.join(providersDir, 'azure-mcp.yaml');
    const content = fs.readFileSync(mapPath, 'utf8')
      .replace('  stop_reasons:\n    - authorization-denied\n    - context-mismatch', '  stop_reasons:\n    - authorization-denied');
    fs.writeFileSync(mapPath, content);
    assertHasError(lintProviderFixture(root, providersDir), /stop_reasons must be exactly/);
  });
});

test('AKS MCP access level cannot be treated as authorization', () => {
  withProviderFixture(({ root, providersDir }) => {
    const mapPath = path.join(providersDir, 'aks-mcp.yaml');
    const content = fs.readFileSync(mapPath, 'utf8')
      .replace('access_level_authorizes: false', 'access_level_authorizes: true');
    fs.writeFileSync(mapPath, content);
    assertHasError(lintProviderFixture(root, providersDir), /access_level_authorizes must be false/);
  });
});

// --- Required tests (contract §5) -------------------------------------------

test('missing trigger-tests.yaml is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    writeSkill(root, name, validFrontMatterLines(name));
    writeTests(root, name, { trigger: null });
    writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /missing required evals\/tests\/\.\.\.\/trigger-tests\.yaml/);
  });
});

test('missing quality-tests.yaml is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    writeSkill(root, name, validFrontMatterLines(name));
    writeTests(root, name, { quality: null });
    writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /missing required evals\/tests\/\.\.\.\/quality-tests\.yaml/);
  });
});

test('empty (non-list) trigger-tests.yaml is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    writeSkill(root, name, validFrontMatterLines(name));
    writeTests(root, name, { trigger: '# no cases yet\n' });
    writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /trigger-tests\.yaml must be a non-empty list of test cases/);
  });
});

test('empty ([]) quality-tests.yaml is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    writeSkill(root, name, validFrontMatterLines(name));
    writeTests(root, name, { quality: '[]\n' });
    writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /quality-tests\.yaml must be a non-empty list of test cases/);
  });
});

test('malformed quality-tests.yaml is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    writeSkill(root, name, validFrontMatterLines(name));
    writeTests(root, name, { quality: '- [unterminated\n' });
    writePromptfooConfig(root, [`file://tests/${name}/quality-tests.yaml`]);
    const { errors } = runLint(root);
    assertHasError(errors, /quality-tests\.yaml is not valid YAML/);
  });
});

test('quality-tests.yaml not wired into promptfooconfig.yaml is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    writeSkill(root, name, validFrontMatterLines(name));
    writeTests(root, name);
    writePromptfooConfig(root, []); // no tests: entries at all
    const { errors } = runLint(root);
    assertHasError(errors, /is not wired into evals\/promptfooconfig\.yaml/);
  });
});

// --- Scripts: shebang + executable bit (contract §4) ------------------------

test('script missing a shebang is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const scriptsDir = path.join(root, 'skills', name, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'fixture');
    fs.writeFileSync(scriptPath, 'echo hi\n');
    stageWithMode(root, scriptPath, '100755');
    const { errors } = runLint(root);
    assertHasError(errors, /Script missing a valid shebang line/);
    assert.ok(!errors.some(error => /Script is not executable/.test(error)));
  });
});

test('script with a non-absolute shebang interpreter is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const scriptsDir = path.join(root, 'skills', name, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'fixture.sh');
    fs.writeFileSync(scriptPath, '#!env bash\necho hi\n');
    stageWithMode(root, scriptPath, '100755');
    const { errors } = runLint(root);
    assertHasError(errors, /Script missing a valid shebang line/);
  });
});

test('script with Git index mode 100644 is an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const scriptsDir = path.join(root, 'skills', name, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'fixture.sh');
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hi\n');
    fs.chmodSync(scriptPath, 0o755);
    stageWithMode(root, scriptPath, '100644');
    const { errors } = runLint(root);
    assertHasError(errors, /Script is not executable/);
  });
});

test('script with Git index mode 100755 passes even when filesystem mode is not executable', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const scriptsDir = path.join(root, 'skills', name, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'fixture.sh');
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hi\n');
    fs.chmodSync(scriptPath, 0o644);
    stageWithMode(root, scriptPath, '100755');
    const { errors } = runLint(root);
    assert.deepEqual(errors, []);
  });
});

test('non-script artifacts under scripts are ignored', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const scriptsDir = path.join(root, 'skills', name, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'README.md'), '# Helper documentation\n');
    fs.writeFileSync(path.join(scriptsDir, 'allowlist.json'), '{"allowed":[]}\n');
    const { errors, warnings } = runLint(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });
});

test('untracked script reports that Git index mode cannot be verified', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    initializeGitRepo(root);
    const scriptsDir = path.join(root, 'skills', name, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'fixture.sh'), '#!/bin/sh\necho hi\n');
    const { errors, warnings } = runLint(root);
    assert.deepEqual(errors, []);
    assertHasWarning(warnings, /file is untracked or has no stage-0 index entry/);
  });
});

test('missing Git executable reports that index mode cannot be verified', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const scriptsDir = path.join(root, 'skills', name, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'fixture.sh'), '#!/bin/sh\necho hi\n');
    const { errors, warnings } = runLint(root, {
      gitCommand: path.join(root, 'missing-git'),
    });
    assert.deepEqual(errors, []);
    assertHasWarning(warnings, /Git executable is unavailable/);
  });
});

// --- Preserved behavior: references and durability warnings -----------------

test('missing internal file reference remains an error', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const skillPath = path.join(root, 'skills', name, 'SKILL.md');
    fs.appendFileSync(skillPath, 'Read `references/missing.md` for details.\n');
    const { errors } = runLint(root);
    assertHasError(errors, /References `references\/missing\.md` but file does not exist/);
  });
});

test('generic coaching phrase remains a durability warning', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const skillPath = path.join(root, 'skills', name, 'SKILL.md');
    fs.appendFileSync(skillPath, 'Be concise when answering.\n');
    const { errors, warnings } = runLint(root);
    assert.deepEqual(errors, []);
    assert.ok(warnings.some(w => /coaching phrase "be concise"/.test(w)));
  });
});

// --- Host portability --------------------------------------------------------

test('hardcoded Azure MCP tool names in skill Markdown are errors', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    const referencesDir = path.join(root, 'skills', name, 'references');
    fs.mkdirSync(referencesDir, { recursive: true });
    fs.writeFileSync(
      path.join(referencesDir, 'mcp.md'),
      'Call mcp_azure_mcp_aks_cluster_get before continuing.\n',
    );

    const { errors } = runLint(root);
    assertHasError(errors, /hardcoded Azure MCP tool name "mcp_azure_mcp_aks_cluster_get"/);
  });
});

test('hardcoded Azure MCP tool names in README are errors', () => {
  withTempRoot((root) => {
    setupValidScenario(root);
    fs.writeFileSync(
      path.join(root, 'README.md'),
      'Call mcp_azure_mcp_aks_nodepool_get before continuing.\n',
    );

    const { errors } = runLint(root);
    assertHasError(errors, /hardcoded Azure MCP tool name "mcp_azure_mcp_aks_nodepool_get"/);
  });
});

test('hardcoded Azure MCP tool names in docs are errors', () => {
  withTempRoot((root) => {
    setupValidScenario(root);
    const docsDir = path.join(root, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, 'integration.md'),
      'Call mcp_azure_mcp_monitor_metrics_query before continuing.\n',
    );

    const { errors } = runLint(root);
    assertHasError(errors, /hardcoded Azure MCP tool name "mcp_azure_mcp_monitor_metrics_query"/);
  });
});

test('hardcoded Azure MCP tool names in plugin manifests are errors', () => {
  withTempRoot((root) => {
    setupValidScenario(root);
    fs.writeFileSync(
      path.join(root, 'plugin.json'),
      '{"description":"Call mcp_azure_mcp_aks_cluster_get"}\n',
    );

    const { errors } = runLint(root);
    assertHasError(errors, /hardcoded Azure MCP tool name "mcp_azure_mcp_aks_cluster_get"/);
  });
});

test('configuring an unqualified AKS MCP runtime is an error', () => {
  withTempRoot((root) => {
    setupValidScenario(root);
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      '{"mcpServers":{"aks":{"command":"aks-mcp"}}}\n',
    );

    const { errors } = runLint(root);
    assertHasError(errors, /uses "AKS MCP" without naming the separate Azure\/aks-mcp product/);
  });
});

test('unqualified AKS MCP product names are errors', () => {
  withTempRoot((root) => {
    const name = 'aks-fixture-skill';
    setupValidScenario(root, name);
    fs.appendFileSync(
      path.join(root, 'skills', name, 'SKILL.md'),
      'Use the AKS-MCP tools for cluster diagnostics.\n',
    );

    const { errors } = runLint(root);
    assertHasError(errors, /uses "AKS MCP" without naming the separate Azure\/aks-mcp product/);
  });
});

test('explicit references to the separate Azure aks-mcp product are allowed', () => {
  withTempRoot((root) => {
    setupValidScenario(root);
    fs.writeFileSync(
      path.join(root, 'README.md'),
      'Azure MCP Server is `@azure/mcp`; the AKS MCP server is the separate `Azure/aks-mcp` product.\n',
    );

    const { errors } = runLint(root);
    assert.deepEqual(errors, []);
  });
});

const removedReadinessApiCases = [
  ['discover action', 'Invoke the readiness API with action: "discover".\n', /readiness discovery action/],
  ['polling action', 'Call pollOperation until the assessment completes.\n', /readiness polling action/],
  ['HTTP polling contract', 'Large assessments return HTTP 202 and a polling URL.\n', /HTTP 202 readiness polling contract/],
  ['invented response field', 'Read clusterConfiguration from the response.\n', /invented readiness response field/],
];

for (const [label, guidance, expectedError] of removedReadinessApiCases) {
  test(`removed MCP readiness ${label} is an error`, () => {
    withTempRoot((root) => {
      const name = 'aks-automatic-readiness';
      setupValidScenario(root, name);
      fs.appendFileSync(path.join(root, 'skills', name, 'SKILL.md'), guidance);

      const { errors } = runLint(root);
      assertHasError(errors, expectedError);
    });
  });
}

test('removed MCP readiness identifiers in shared docs are errors', () => {
  withTempRoot((root) => {
    setupValidScenario(root);
    const docsDir = path.join(root, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, 'readiness.md'),
      'For an AKS Automatic readiness assessment, call action: "discover".\n',
    );

    const { errors } = runLint(root);
    assertHasError(errors, /readiness discovery action/);
  });
});

test('host capability discovery wording remains allowed for readiness guidance', () => {
  withTempRoot((root) => {
    const name = 'aks-automatic-readiness';
    setupValidScenario(root, name);
    fs.appendFileSync(
      path.join(root, 'skills', name, 'SKILL.md'),
      'Inspect the host-advertised Azure MCP capability and schema, then collect sanitized evidence for local evaluation.\n',
    );

    const { errors } = runLint(root);
    assert.deepEqual(errors, []);
  });
});

// --- Regression: the real repo must still pass in full ---------------------

test('real repo skills pass the full contract lint with zero errors', () => {
  const { errors, skillCount } = lintSkills({
    skillsDir: path.join(REPO_ROOT, 'skills'),
    testsDir: path.join(__dirname, 'tests'),
    promptfooConfigPath: path.join(__dirname, 'promptfooconfig.yaml'),
    providersDir: PROVIDERS_DIR,
  });
  assert.ok(skillCount > 0, 'expected at least one shipped skill to be discovered');
  assert.deepEqual(errors, []);
});
