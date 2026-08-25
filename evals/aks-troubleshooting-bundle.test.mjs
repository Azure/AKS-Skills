import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalBytes } from './export-aks-troubleshooting-bundle.mjs';

const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVALS_DIR, '..');
const TOOL = join(EVALS_DIR, 'export-aks-troubleshooting-bundle.mjs');
const SOURCE_BUNDLE = join(REPO_ROOT, 'skills', 'aks-troubleshooting');
const FIXED_GHCP = '22f96fd93fa85814b7a8ffdfe5356a5bab96a096';
const FIXED_BASE = 'a1cab4852d3e6cdb20e06b171400117379cbd90c';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  return result;
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

function git(repository, ...args) {
  return mustRun('git', ['-C', repository, ...args]).stdout.trim();
}

function commitAll(repository, message) {
  git(repository, 'add', '--all');
  git(repository, 'commit', '-q', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

function createRepository(root) {
  const repository = join(root, 'repo');
  const destination = join(repository, 'skills', 'aks-troubleshooting');
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(SOURCE_BUNDLE, destination, { recursive: true, preserveTimestamps: true });
  for (const script of [
    'aks-baseline.sh',
    'cluster-snapshot.sh',
    'evidence-common.sh',
    'pod-deep-dive.sh',
    'pod-evidence.sh',
    'run-ig.sh',
  ]) {
    chmodSync(join(destination, 'scripts', script), 0o755);
  }
  mustRun('git', ['init', '-q', '-b', 'main', repository]);
  git(repository, 'config', 'user.email', 'fixture@example.invalid');
  git(repository, 'config', 'user.name', 'Fixture');
  const commit = commitAll(repository, 'fixture bundle');
  return { repository, commit, destination };
}

function invokeTool(operation, repository, sourceRef, output) {
  return run(process.execPath, [
    TOOL,
    operation,
    '--repository',
    repository,
    '--source-ref',
    sourceRef,
    '--output',
    output,
  ]);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'aks-bundle-test-'));
  try {
    return callback(root, createRepository(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('source manifest records complete reconciliation and intended unverified routing', () => {
  const manifest = JSON.parse(readFileSync(join(SOURCE_BUNDLE, 'bundle.source.json'), 'utf8'));
  assert.equal(manifest.reconciliation.ghcp_source.commit, FIXED_GHCP);
  assert.equal(manifest.reconciliation.aks_skills_source.base_commit, FIXED_BASE);
  assert.equal(manifest.reconciliation.shared_preserved.length, 5);
  assert.equal(manifest.reconciliation.shared_reconciled.length, 7);
  for (const entry of manifest.reconciliation.shared_preserved) {
    const blob = mustRun('git', ['hash-object', join(SOURCE_BUNDLE, entry.path)]).stdout.trim();
    assert.equal(blob, entry.aks_base_blob, `${entry.path} no longer matches the #72 base blob`);
  }
  assert.deepEqual(manifest.reconciliation.focused_only, [
    'references/report-template.md',
    'references/symptom-map.md',
    'scripts/cluster-snapshot.sh',
    'scripts/pod-deep-dive.sh',
  ]);
  assert.equal(manifest.routing.status, 'intended-unverified');
  assert.equal(manifest.tree_semantics.completeness, 'payload-is-the-exact-file-set');
  assert.equal(manifest.tree_semantics.symlinks, 'forbidden');
  assert.equal(manifest.materialization.mode, 'build-time-only');
  assert.equal(manifest.materialization.generated_payload_editable, false);
  assert.equal(manifest.materialization.runtime_fetch, false);
});

test('bundle contains no host-rendered Azure MCP wrappers', () => {
  const manifest = JSON.parse(readFileSync(join(SOURCE_BUNDLE, 'bundle.source.json'), 'utf8'));
  for (const relative of manifest.payload) {
    const content = readFileSync(join(SOURCE_BUNDLE, relative), 'utf8');
    assert.doesNotMatch(content, /\bmcp_azure_mcp_[A-Za-z0-9_]+\b/i, relative);
  }
});

test('reconciliation preserves the accepted PR 71 and PR 72 evidence anchors', () => {
  const networking = readFileSync(join(SOURCE_BUNDLE, 'networking.md'), 'utf8');
  const nodes = readFileSync(join(SOURCE_BUNDLE, 'node-issues.md'), 'utf8');
  assert.match(networking, /sourceNode=inaccessible/);
  assert.match(networking, /outboundIdentity=unknown/);
  assert.match(networking, /union isfuzzy=true/);
  assert.match(networking, /firewallLogEvidence=incomplete/);
  assert.match(nodes, /az account list/);
  assert.match(nodes, /\.spec\.providerID/);
  assert.match(nodes, /az vmss get-instance-view/);
  assert.match(nodes, /Privileged and service mutation boundary/);
});

test('export is deterministic and emits the strict PR 95 skill-bundle shape', () => {
  withFixture((root, { repository, commit }) => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const firstRun = invokeTool('export', repository, commit, first);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const secondRun = invokeTool('export', repository, 'main', second);
    assert.equal(secondRun.status, 0, secondRun.stderr);

    const firstManifestBytes = readFileSync(join(first, 'manifest.json'));
    const secondManifestBytes = readFileSync(join(second, 'manifest.json'));
    const firstLockBytes = readFileSync(join(first, 'source-lock.json'));
    assert.deepEqual(firstManifestBytes, secondManifestBytes);
    assert.deepEqual(firstLockBytes, readFileSync(join(second, 'source-lock.json')));

    const manifest = JSON.parse(firstManifestBytes);
    assert.deepEqual(Object.keys(manifest), [
      'contract_version',
      'kind',
      'bundle_id',
      'root',
      'files',
      'bundle_hash',
    ]);
    assert.equal(manifest.contract_version, 'aks-support-benchmark/v1');
    assert.equal(manifest.kind, 'skill-bundle');
    assert.equal(manifest.bundle_id, 'aks-troubleshooting');
    assert.equal(manifest.root, 'aks-troubleshooting');
    assert.ok(manifest.files.length > 0);
    assert.deepEqual(
      manifest.files.map(entry => entry.path),
      [...manifest.files.map(entry => entry.path)].sort(),
    );
    for (const entry of manifest.files) {
      assert.deepEqual(Object.keys(entry), ['path', 'sha256', 'size']);
      assert.match(entry.sha256, /^sha256:[0-9a-f]{64}$/);
      assert.ok(Number.isInteger(entry.size) && entry.size >= 0);
    }
    assert.equal(manifest.bundle_hash, sha256(canonicalBytes(manifest.files)));

    const lock = JSON.parse(firstLockBytes);
    assert.equal(lock.source_commit, commit);
    assert.equal(lock.canonical_tree_hash, manifest.bundle_hash);
    assert.equal(lock.mapping_version, 'identity/v1');
    assert.equal(lock.materialized_manifest_sha256, sha256(firstManifestBytes));

    const verify = invokeTool('verify', repository, commit, first);
    assert.equal(verify.status, 0, verify.stderr);
    const mode = run('git', [
      '-C',
      repository,
      'ls-tree',
      commit,
      'skills/aks-troubleshooting/scripts/aks-baseline.sh',
    ]).stdout;
    assert.match(mode, /^100755 /);
  });
});

test('canonical hashing matches the unchanged PR 95 fixture', () => {
  const entries = [
    {
      path: 'SKILL.md',
      sha256: 'sha256:a45d85c7b13aa55eea96435239a0b814af7ce68732402bbeea3ccef16e762724',
      size: 235,
    },
    {
      path: 'references/checklist.md',
      sha256: 'sha256:e08056274dd689b91d367da007cb7fa227b05ca558bf0c7f4ee8ed2ff62135fd',
      size: 144,
    },
  ];
  assert.equal(
    sha256(canonicalBytes(entries)),
    'sha256:c34e0df7abb06a3131641c154ab684f8541cc8e61820c37186b34410db7c524d',
  );
});

test('symlinked exporter invocation still executes the CLI', () => {
  withFixture((root, { repository, commit }) => {
    const linkedTool = join(root, 'linked-exporter.mjs');
    const output = join(root, 'symlink-output');
    symlinkSync(TOOL, linkedTool);
    const result = run(process.execPath, [
      linkedTool,
      'export',
      '--repository',
      repository,
      '--source-ref',
      commit,
      '--output',
      output,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.bundle_id, 'aks-troubleshooting');
  });
});

test('verify rejects materialized content and file-set drift', () => {
  withFixture((root, { repository, commit }) => {
    const output = join(root, 'output');
    assert.equal(invokeTool('export', repository, commit, output).status, 0);
    const skill = join(output, 'aks-troubleshooting', 'SKILL.md');
    writeFileSync(skill, `${readFileSync(skill, 'utf8')}\ndrift\n`);
    const changed = invokeTool('verify', repository, commit, output);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /content drift/);

    const clean = join(root, 'clean');
    assert.equal(invokeTool('export', repository, commit, clean).status, 0);
    writeFileSync(join(clean, 'unexpected.txt'), 'extra');
    const extra = invokeTool('verify', repository, commit, clean);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /file set drift/);
  });
});

test('export rejects missing files and broken reference closure', () => {
  withFixture((root, fixture) => {
    unlinkSync(join(fixture.destination, 'general-diagnostics.md'));
    const missingCommit = commitAll(fixture.repository, 'remove declared file');
    const missing = invokeTool('export', fixture.repository, missingCommit, join(root, 'missing'));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /source manifest drift/);
  });

  withFixture((root, fixture) => {
    const skill = join(fixture.destination, 'SKILL.md');
    writeFileSync(skill, `${readFileSync(skill, 'utf8')}\n[missing](references/not-there.md)\n`);
    const brokenCommit = commitAll(fixture.repository, 'break reference');
    const broken = invokeTool('export', fixture.repository, brokenCommit, join(root, 'broken'));
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /unclosed reference/);
  });
});

test('export rejects unsafe manifest paths and symlinks', () => {
  withFixture((root, fixture) => {
    const path = join(fixture.destination, 'bundle.source.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.payload[0] = '../escape';
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    const unsafeCommit = commitAll(fixture.repository, 'unsafe path');
    const unsafe = invokeTool('export', fixture.repository, unsafeCommit, join(root, 'unsafe'));
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /normalized confined path/);
  });

  withFixture((root, fixture) => {
    const path = join(fixture.destination, 'general-diagnostics.md');
    unlinkSync(path);
    symlinkSync('SKILL.md', path);
    const symlinkCommit = commitAll(fixture.repository, 'symlink payload');
    const unsafe = invokeTool('export', fixture.repository, symlinkCommit, join(root, 'symlink'));
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /must not contain symlinks/);
  });
});
