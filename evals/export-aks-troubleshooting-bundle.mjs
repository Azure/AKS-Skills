#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SOURCE_ROOT = 'skills/aks-troubleshooting';
const SOURCE_MANIFEST = 'bundle.source.json';
const BENCHMARK_CONTRACT = 'aks-support-benchmark/v1';
const LOCK_CONTRACT = 'aks-troubleshooting-lock/v1';

function fail(message) {
  throw new Error(message);
}

function sha256Bytes(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedRelative(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  if (value.includes('\0') || value.includes('\\') || value.includes(':')) {
    fail(`${label} contains an unsafe character: ${value}`);
  }
  if (value.startsWith('/') || value.endsWith('/')) fail(`${label} must be a normalized relative path: ${value}`);
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`${label} must be a normalized confined path: ${value}`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields mismatch; expected=${wanted.join(',')} actual=${actual.join(',')}`);
  }
}

function runGit(repository, args, { binary = false } = {}) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: binary ? null : 'utf8',
  });
  if (result.error) fail(`git failed: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = binary ? result.stderr.toString('utf8') : result.stderr;
    fail(`git ${args[0]} failed: ${stderr.trim()}`);
  }
  return result.stdout;
}

function resolveSource(repositoryArgument, sourceRef) {
  if (typeof sourceRef !== 'string' || sourceRef.length === 0 || sourceRef.startsWith('-')
      || /[\0\r\n]/.test(sourceRef)) {
    fail('source ref is invalid');
  }
  const repository = realpathSync(resolve(repositoryArgument));
  const root = runGit(repository, ['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(root) !== repository) fail('repository argument must be the Git worktree root');
  const commit = runGit(repository, ['rev-parse', '--verify', `${sourceRef}^{commit}`]).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) fail('source ref did not resolve to an exact commit');
  return { repository, commit };
}

function readBlob(repository, commit, relativePath) {
  normalizedRelative(relativePath);
  return runGit(repository, ['show', `${commit}:${relativePath}`], { binary: true });
}

function readSourceManifest(repository, commit) {
  const manifestPath = `${SOURCE_ROOT}/${SOURCE_MANIFEST}`;
  let manifest;
  try {
    manifest = JSON.parse(readBlob(repository, commit, manifestPath).toString('utf8'));
  } catch (error) {
    fail(`source manifest is not valid JSON: ${error.message}`);
  }
  exactKeys(
    manifest,
    [
      'contract_version',
      'kind',
      'bundle_id',
      'root',
      'entry_point',
      'mapping_version',
      'source_repository',
      'tree_semantics',
      'payload',
      'reconciliation',
      'routing',
      'materialization',
    ],
    'source manifest',
  );
  if (manifest.contract_version !== 'aks-troubleshooting-source/v1') fail('unsupported source contract');
  if (manifest.kind !== 'skill-bundle-source') fail('source manifest kind must be skill-bundle-source');
  if (manifest.bundle_id !== 'aks-troubleshooting') fail('unexpected bundle id');
  if (manifest.root !== SOURCE_ROOT) fail(`source root must be ${SOURCE_ROOT}`);
  if (manifest.entry_point !== 'SKILL.md') fail('entry point must be SKILL.md');
  if (typeof manifest.mapping_version !== 'string' || !manifest.mapping_version) fail('mapping version is required');
  if (typeof manifest.source_repository !== 'string'
      || !/^https:\/\/github\.com\/Azure\/AKS-Skills(?:\.git)?$/.test(manifest.source_repository)) {
    fail('source repository must identify Azure/AKS-Skills');
  }
  exactKeys(
    manifest.tree_semantics,
    ['completeness', 'path_format', 'symlinks', 'allowed_file_modes', 'canonical_hash'],
    'tree semantics',
  );
  if (manifest.tree_semantics.completeness !== 'payload-is-the-exact-file-set'
      || manifest.tree_semantics.path_format !== 'normalized-posix-relative'
      || manifest.tree_semantics.symlinks !== 'forbidden'
      || JSON.stringify(manifest.tree_semantics.allowed_file_modes) !== JSON.stringify(['100644', '100755'])
      || manifest.tree_semantics.canonical_hash !== 'sha256-of-canonical-sorted-file-manifest') {
    fail('unsupported tree semantics');
  }
  exactKeys(
    manifest.reconciliation,
    ['ghcp_source', 'aks_skills_source', 'shared_preserved', 'shared_reconciled', 'focused_only'],
    'reconciliation',
  );
  exactKeys(
    manifest.reconciliation.ghcp_source,
    ['repository', 'commit', 'origin_commit'],
    'GHCP source',
  );
  exactKeys(
    manifest.reconciliation.aks_skills_source,
    ['repository', 'base_commit', 'import_commit'],
    'AKS-Skills source',
  );
  if (!Array.isArray(manifest.reconciliation.shared_preserved)
      || !Array.isArray(manifest.reconciliation.shared_reconciled)
      || !Array.isArray(manifest.reconciliation.focused_only)) {
    fail('reconciliation path sets must be arrays');
  }
  for (const entry of manifest.reconciliation.shared_preserved) {
    exactKeys(
      entry,
      ['path', 'ghcp_blob_at_verdict', 'aks_base_blob', 'base_status'],
      'shared_preserved',
    );
    normalizedRelative(entry.path, 'shared_preserved path');
    if (!/^[0-9a-f]{40}$/.test(entry.ghcp_blob_at_verdict)
        || !/^[0-9a-f]{40}$/.test(entry.aks_base_blob)
        || !['byte-identical', 'strengthened-before-this-layer'].includes(entry.base_status)) {
      fail('shared_preserved contains invalid provenance');
    }
  }
  for (const [label, entries] of [
    ['shared_reconciled', manifest.reconciliation.shared_reconciled],
  ]) {
    for (const entry of entries) {
      exactKeys(entry, ['path', 'ghcp_blob'], label);
      normalizedRelative(entry.path, `${label} path`);
      if (!/^[0-9a-f]{40}$/.test(entry.ghcp_blob)) fail(`${label} contains an invalid GHCP blob`);
    }
  }
  exactKeys(
    manifest.routing,
    ['status', 'focused_skill', 'broad_skill', 'broad_only', 'focused_only', 'focused_absent', 'both_installed'],
    'routing',
  );
  if (manifest.routing.status !== 'intended-unverified'
      || manifest.routing.focused_skill !== 'aks-troubleshooting'
      || manifest.routing.broad_skill !== 'azure-diagnostics') {
    fail('routing metadata overstates or misidentifies the intended boundary');
  }
  exactKeys(
    manifest.materialization,
    ['mode', 'transforms', 'generated_payload_editable', 'runtime_fetch', 'generated_output_committed'],
    'materialization',
  );
  if (manifest.materialization.mode !== 'build-time-only'
      || manifest.materialization.transforms !== 'identity'
      || manifest.materialization.generated_payload_editable !== false
      || manifest.materialization.runtime_fetch !== false
      || manifest.materialization.generated_output_committed !== false) {
    fail('materialization policy is unsafe');
  }
  if (!Array.isArray(manifest.payload) || manifest.payload.length === 0) fail('payload must declare files');
  const seen = new Set();
  const caseSeen = new Set();
  for (const entry of manifest.payload) {
    normalizedRelative(entry, 'payload path');
    if (seen.has(entry)) fail(`duplicate payload path: ${entry}`);
    const folded = entry.toLowerCase();
    if (caseSeen.has(folded)) fail(`case-colliding payload path: ${entry}`);
    seen.add(entry);
    caseSeen.add(folded);
  }
  const sorted = [...manifest.payload].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(manifest.payload)) fail('payload paths must be sorted');
  if (!seen.has(SOURCE_MANIFEST) || !seen.has(manifest.entry_point)) {
    fail('payload must include the source manifest and entry point');
  }
  const reconciledPaths = [
    ...manifest.reconciliation.shared_preserved.map(entry => entry.path),
    ...manifest.reconciliation.shared_reconciled.map(entry => entry.path),
    ...manifest.reconciliation.focused_only,
  ];
  if (new Set(reconciledPaths).size !== reconciledPaths.length) fail('reconciliation path sets overlap');
  for (const path of reconciledPaths) {
    normalizedRelative(path, 'reconciliation path');
    if (!seen.has(path)) fail(`reconciliation path is absent from payload: ${path}`);
  }
  return manifest;
}

function listSourceTree(repository, commit) {
  const output = runGit(
    repository,
    ['ls-tree', '-rz', commit, '--', SOURCE_ROOT],
    { binary: true },
  );
  const entries = [];
  for (const record of output.toString('utf8').split('\0')) {
    if (!record) continue;
    const match = record.match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]{40})\t(.+)$/);
    if (!match) fail('malformed git tree entry');
    const [, mode, type, object, fullPath] = match;
    if (type !== 'blob') fail(`bundle tree contains unsupported ${type}: ${fullPath}`);
    if (mode === '120000') fail(`bundle tree must not contain symlinks: ${fullPath}`);
    if (mode !== '100644' && mode !== '100755') fail(`unsupported file mode ${mode}: ${fullPath}`);
    const prefix = `${SOURCE_ROOT}/`;
    if (!fullPath.startsWith(prefix)) fail(`tree path escapes source root: ${fullPath}`);
    const path = normalizedRelative(fullPath.slice(prefix.length));
    entries.push({ path, mode, object });
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return entries;
}

function validateReferenceClosure(files, entryPoint) {
  const paths = new Set(files.map(file => file.path));
  if (!paths.has(entryPoint)) fail(`entry point is missing: ${entryPoint}`);
  for (const file of files) {
    if (!file.path.endsWith('.md')) continue;
    const content = file.content.toString('utf8');
    const candidates = [];
    for (const match of content.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
      candidates.push({ value: match[1], rootRelative: false });
    }
    for (const match of content.matchAll(/`((?:scripts|references|assets)\/[^`\s]+)`/g)) {
      candidates.push({ value: match[1], rootRelative: true });
    }
    for (const reference of candidates) {
      let candidate = reference.value.trim().replace(/^<|>$/g, '');
      if (!candidate || candidate.startsWith('#')
          || /^(?:https?:|mailto:)/i.test(candidate)) continue;
      candidate = candidate.split(/\s+"/, 1)[0].split('#', 1)[0];
      try {
        candidate = decodeURIComponent(candidate);
      } catch {
        fail(`invalid encoded reference in ${file.path}: ${candidate}`);
      }
      const resolved = normalizedRelative(
        reference.rootRelative
          ? candidate
          : posix.normalize(posix.join(posix.dirname(file.path), candidate)),
        `reference in ${file.path}`,
      );
      if (!paths.has(resolved)) fail(`unclosed reference in ${file.path}: ${candidate}`);
    }
  }
}

function buildSource(repository, commit) {
  const manifest = readSourceManifest(repository, commit);
  const tree = listSourceTree(repository, commit);
  const declared = manifest.payload;
  const actual = tree.map(entry => entry.path);
  if (JSON.stringify(actual) !== JSON.stringify(declared)) {
    fail(`source manifest drift; declared=${declared.join(',')} actual=${actual.join(',')}`);
  }
  const files = tree.map(entry => ({
    ...entry,
    content: readBlob(repository, commit, `${SOURCE_ROOT}/${entry.path}`),
  }));
  validateReferenceClosure(files, manifest.entry_point);
  const fileManifest = files.map(file => ({
    path: file.path,
    sha256: sha256Bytes(file.content),
    size: file.content.length,
  }));
  const bundleHash = sha256Bytes(canonicalBytes(fileManifest));
  const benchmarkManifest = {
    contract_version: BENCHMARK_CONTRACT,
    kind: 'skill-bundle',
    bundle_id: manifest.bundle_id,
    root: manifest.bundle_id,
    files: fileManifest,
    bundle_hash: bundleHash,
  };
  const benchmarkBytes = Buffer.from(stableJson(benchmarkManifest), 'utf8');
  const lock = {
    contract_version: LOCK_CONTRACT,
    kind: 'skill-bundle-lock',
    source_repository: manifest.source_repository,
    source_commit: commit,
    source_root: manifest.root,
    entry_point: manifest.entry_point,
    mapping_version: manifest.mapping_version,
    canonical_tree_hash: bundleHash,
    source_manifest_sha256: fileManifest.find(file => file.path === SOURCE_MANIFEST).sha256,
    materialized_manifest_sha256: sha256Bytes(benchmarkBytes),
  };
  return { manifest, files, benchmarkManifest, benchmarkBytes, lock };
}

function ensureOutputParent(output) {
  const absolute = resolve(output);
  if (absolute === resolve(sep)) fail('output must not be a filesystem root');
  if (existsSync(absolute)) fail('export output must not already exist');
  const parent = dirname(absolute);
  mkdirSync(parent, { recursive: true });
  if (lstatSync(parent).isSymbolicLink()) fail('output parent must not be a symlink');
  return absolute;
}

function exportBundle(repository, commit, outputArgument) {
  const built = buildSource(repository, commit);
  const output = ensureOutputParent(outputArgument);
  const staging = `${output}.tmp-${process.pid}`;
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(join(staging, built.manifest.bundle_id), { recursive: true, mode: 0o700 });
    for (const file of built.files) {
      const target = join(staging, built.manifest.bundle_id, ...file.path.split('/'));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.content, { mode: file.mode === '100755' ? 0o755 : 0o644 });
      chmodSync(target, file.mode === '100755' ? 0o755 : 0o644);
    }
    writeFileSync(join(staging, 'manifest.json'), built.benchmarkBytes, { mode: 0o644 });
    writeFileSync(join(staging, 'source-lock.json'), stableJson(built.lock), { mode: 0o644 });
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { output, commit, bundle_hash: built.benchmarkManifest.bundle_hash };
}

function walkMaterialized(root) {
  const entries = [];
  function walk(current, relative) {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`materialized output contains a symlink: ${path}`);
      if (stat.isDirectory()) walk(absolute, path);
      else if (stat.isFile()) entries.push(path);
      else fail(`materialized output contains a special file: ${path}`);
    }
  }
  walk(root, '');
  return entries;
}

function verifyBundle(repository, commit, outputArgument) {
  const built = buildSource(repository, commit);
  const output = realpathSync(resolve(outputArgument));
  const expectedPaths = [
    'manifest.json',
    'source-lock.json',
    ...built.files.map(file => `${built.manifest.bundle_id}/${file.path}`),
  ].sort();
  const actualPaths = walkMaterialized(output).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) fail('materialized file set drift');

  for (const file of built.files) {
    const target = join(output, built.manifest.bundle_id, ...file.path.split('/'));
    const content = readFileSync(target);
    if (!content.equals(file.content)) fail(`materialized content drift: ${file.path}`);
    const executable = (lstatSync(target).mode & 0o111) !== 0;
    if (executable !== (file.mode === '100755')) fail(`materialized mode drift: ${file.path}`);
  }
  const manifestBytes = readFileSync(join(output, 'manifest.json'));
  if (!manifestBytes.equals(built.benchmarkBytes)) fail('materialized manifest drift');
  const lockBytes = readFileSync(join(output, 'source-lock.json'));
  if (!lockBytes.equals(Buffer.from(stableJson(built.lock), 'utf8'))) fail('source lock drift');
  return { output, commit, bundle_hash: built.benchmarkManifest.bundle_hash };
}

function parseArguments(argv) {
  const [operation, ...rest] = argv;
  if (operation !== 'export' && operation !== 'verify') {
    fail('usage: export-aks-troubleshooting-bundle.mjs <export|verify> --source-ref <ref> --output <path> [--repository <path>]');
  }
  const options = { repository: null, sourceRef: null, output: null };
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!value) fail(`${option} requires a value`);
    if (option === '--repository') options.repository = value;
    else if (option === '--source-ref') options.sourceRef = value;
    else if (option === '--output') options.output = value;
    else fail(`unknown option: ${option}`);
  }
  if (!options.sourceRef || !options.output) fail('--source-ref and --output are required');
  options.repository ??= resolve(import.meta.dirname, '..');
  return { operation, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { operation, options } = parseArguments(process.argv.slice(2));
    const source = resolveSource(options.repository, options.sourceRef);
    const result = operation === 'export'
      ? exportBundle(source.repository, source.commit, options.output)
      : verifyBundle(source.repository, source.commit, options.output);
    process.stdout.write(`${JSON.stringify({ ok: true, operation, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

export {
  BENCHMARK_CONTRACT,
  LOCK_CONTRACT,
  SOURCE_MANIFEST,
  SOURCE_ROOT,
  buildSource,
  canonicalBytes,
  normalizedRelative,
  sha256Bytes,
  validateReferenceClosure,
};
