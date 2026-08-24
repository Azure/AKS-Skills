#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const REPO_ROOT = path.join(__dirname, '..');
const GUIDE_PATH = path.join(REPO_ROOT, 'docs', 'provider-setup.md');
const ROOT_MCP_PATH = path.join(REPO_ROOT, '.mcp.json');
const AZURE_PROVIDER_PATH = path.join(REPO_ROOT, 'providers', 'azure-mcp.yaml');
const AKS_PROVIDER_PATH = path.join(REPO_ROOT, 'providers', 'aks-mcp.yaml');
const LINK_DOCUMENTS = [
  path.join(REPO_ROOT, 'README.md'),
  path.join(REPO_ROOT, 'CONTRIBUTING.md'),
  GUIDE_PATH,
];
const EXPECTED_PRIMARY_SOURCE_LINKS = [
  'https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server',
  'https://code.claude.com/docs/en/plugins-reference#mcp-servers',
  'https://developers.openai.com/codex/config-basic/',
  'https://developers.openai.com/codex/mcp/',
  'https://developers.openai.com/codex/skills/#where-codex-loads-local-skills',
  'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers',
  'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers',
  'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables',
  'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#mcp-server-trust-levels',
  'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#pluginjson',
  'https://github.com/Azure/aks-mcp/blob/8d28bece75d1f572293364d7f50a7e9d2e425efa/README.md#supported-deployment-model-and-security-considerations',
  'https://github.com/Azure/aks-mcp/blob/8d28bece75d1f572293364d7f50a7e9d2e425efa/internal/config/config.go#L37-L58',
  'https://github.com/Azure/aks-mcp/blob/8d28bece75d1f572293364d7f50a7e9d2e425efa/internal/server/server.go#L125-L131',
  'https://github.com/Azure/aks-mcp/releases/tag/v0.0.20',
  'https://github.com/HolmesGPT/holmesgpt/blob/87333f17b33985680a77525e1cc3a775eaf77b91/docs/data-sources/remote-mcp-servers.md#stdio',
  'https://github.com/HolmesGPT/holmesgpt/blob/87333f17b33985680a77525e1cc3a775eaf77b91/docs/reference/skills.md',
  'https://github.com/microsoft/mcp/blob/0fe54df28d473415d63c201b309b64eec0aa6587/core/Microsoft.Mcp.Core/src/Areas/Server/Options/ServerStartOptions.cs#L42-L47',
  'https://github.com/microsoft/mcp/blob/0fe54df28d473415d63c201b309b64eec0aa6587/core/Microsoft.Mcp.Core/src/Options/OptionAttribute.cs#L6-L24',
  'https://github.com/microsoft/mcp/blob/0fe54df28d473415d63c201b309b64eec0aa6587/docs/bug-bash/installation-testing.md',
  'https://learn.microsoft.com/azure/sre-agent/install-plugin-from-url',
  'https://learn.microsoft.com/azure/sre-agent/mcp-connector',
  'https://learn.microsoft.com/azure/sre-agent/plugin-marketplace#what-the-plugin-marketplace-does',
  'https://learn.microsoft.com/azure/sre-agent/tools#built-in-tools',
];
const VERSIONED_SETUP_FILES = [
  path.join(REPO_ROOT, 'README.md'),
  GUIDE_PATH,
  ROOT_MCP_PATH,
  path.join(REPO_ROOT, 'plugin.json'),
  path.join(REPO_ROOT, '.claude-plugin', 'plugin.json'),
  path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'),
];

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

function codeFences(markdown) {
  return [...markdown.matchAll(/```([a-z0-9_-]+)\n([\s\S]*?)```/gi)]
    .map(([, language, content]) => ({ language: language.toLowerCase(), content }));
}

function section(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const remainder = markdown.slice(start + heading.length + 4);
  const end = remainder.search(/^## /m);
  return end === -1 ? remainder : remainder.slice(0, end);
}

function markdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(([, target]) => target);
}

test('all machine-readable host snippets parse', () => {
  const snippets = codeFences(read(GUIDE_PATH));
  const machineReadable = snippets.filter(({ language }) => (
    language === 'json' || language === 'yaml' || language === 'toml'
  ));
  assert.ok(machineReadable.length > 0, 'expected machine-readable setup snippets');

  for (const { language, content } of machineReadable) {
    if (language === 'json') {
      assert.doesNotThrow(() => JSON.parse(content));
    } else if (language === 'yaml') {
      assert.doesNotThrow(() => yaml.load(content));
    } else {
      const result = spawnSync(
        'python3',
        ['-c', 'import sys, tomllib; tomllib.loads(sys.stdin.read())'],
        { input: content, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  }
});

test('documented provider versions match exact provider maps', () => {
  const guide = read(GUIDE_PATH);
  const azureProvider = yaml.load(read(AZURE_PROVIDER_PATH));
  const aksProvider = yaml.load(read(AKS_PROVIDER_PATH));
  const azureVersions = [...guide.matchAll(/@azure\/mcp@([0-9A-Za-z.-]+)/g)]
    .map(([, version]) => version);

  assert.ok(azureVersions.length > 0, 'guide must include the Azure MCP package pin');
  assert.deepEqual(new Set(azureVersions), new Set([String(azureProvider.provider.version)]));
  assert.match(guide, new RegExp(`Azure/aks-mcp\` v${aksProvider.provider.version.replaceAll('.', '\\.')}`));
  for (const filePath of VERSIONED_SETUP_FILES) {
    assert.doesNotMatch(read(filePath), /\blatest\b/i);
  }
});

test('root MCP config is Azure-only, exact-pinned, and read-only', () => {
  const config = JSON.parse(read(ROOT_MCP_PATH));
  const azureProvider = yaml.load(read(AZURE_PROVIDER_PATH));
  const expectedArgs = [
    '-y',
    `@azure/mcp@${azureProvider.provider.version}`,
    'server',
    'start',
    '--read-only',
  ];

  assert.deepEqual(Object.keys(config), ['mcpServers']);
  assert.deepEqual(Object.keys(config.mcpServers), ['azure']);
  assert.equal(config.mcpServers.azure.command, 'npx');
  assert.deepEqual(config.mcpServers.azure.args, expectedArgs);
  assert.doesNotMatch(read(ROOT_MCP_PATH), /\blatest\b/i);
});

test('host guidance preserves unsupported runtime boundaries', () => {
  const guide = read(GUIDE_PATH);
  const cloud = section(guide, 'GitHub Copilot cloud agent');
  const codex = section(guide, 'Codex CLI');
  const sre = section(guide, 'Azure SRE Agent');
  const holmes = section(guide, 'HolmesGPT');
  const portal = section(guide, 'Azure Portal');

  assert.match(cloud, /does not reach a developer-workstation process/);
  assert.match(cloud, /non-wildcard read-only allowlist/);
  assert.match(codex, /Do not\s+commit a universal user configuration/);
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, '.codex', 'config.toml')));
  assert.match(sre, /No current primary source proves that Azure SRE Agent hosts or consumes/);
  assert.match(sre, /pending\s+owner\/runtime confirmation/);
  assert.match(holmes, /Do not apply that pattern/);
  assert.match(holmes, /cannot reach a developer-workstation\s+process/);
  assert.match(holmes, /HolmesGPT 0\.26\.0 or newer/);
  assert.match(portal, /No current primary source proves/);
  assert.match(portal, /publishes no Portal installation or hosting instructions/);

  for (const { language, content } of codeFences(guide)) {
    if (!['json', 'yaml', 'toml'].includes(language)) continue;
    if (/aks_local|aks-local/.test(content)) {
      assert.doesNotMatch(content, /\b(?:url|endpoint)\s*[:=]/i);
      assert.doesNotMatch(content, /\b(?:http|sse|gateway|proxy|helm)\b/i);
    }
  }

  assert.doesNotMatch(guide, /\bmcp__[A-Za-z0-9_-]+/i);
  assert.doesNotMatch(guide, /\bmcp_azure_mcp_[A-Za-z0-9_]+/i);
});

test('canonical setup links use the verified source registry and valid local paths', () => {
  const failures = [];
  const primarySourceLinks = markdownLinks(read(GUIDE_PATH))
    .filter(target => target.startsWith('https://'));

  for (const documentPath of LINK_DOCUMENTS) {
    const markdown = read(documentPath);
    for (const target of markdownLinks(markdown)) {
      if (target.startsWith('#')) continue;

      if (/^https:\/\//.test(target)) {
        continue;
      }

      const localTarget = target.split('#', 1)[0];
      if (localTarget === '') continue;
      const resolved = path.resolve(path.dirname(documentPath), localTarget);
      if (!fs.existsSync(resolved)) failures.push(`${target}: local target missing`);
    }
  }

  assert.deepEqual(
    [...new Set(primarySourceLinks)].sort(),
    [...EXPECTED_PRIMARY_SOURCE_LINKS].sort(),
  );
  assert.deepEqual(failures, []);
});
