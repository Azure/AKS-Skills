#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  extractMarkdownShellSources,
  inspectShellSource,
  validateLeadingContents,
} = require('./lint-skills.js');

const PINNED_MCR = 'mcr.microsoft.com/cbl-mariner/base/core'
  + '@sha256:c833841d2dcfd3081d2ee807050d19368854f70d9b6faef027463e2c6f45ee41';

function findingKinds(source, options) {
  return inspectShellSource(source, options).map(finding => finding.kind);
}

test('TOC validation rejects empty, non-linking, and invalid-anchor contents', () => {
  assert.match(
    validateLeadingContents('# Reference\n\n## Contents\n\n## Details\n'),
    /at least one Markdown link/,
  );
  assert.match(
    validateLeadingContents('# Reference\n\n## Contents\n\n- Details\n\n## Details\n'),
    /at least one Markdown link/,
  );
  assert.match(
    validateLeadingContents('# Reference\n\n## Contents\n\n- [Missing](#missing)\n\n## Details\n'),
    /does not resolve/,
  );
  assert.match(
    validateLeadingContents(
      '# Reference\n\n## Contents\n\n- [Example](#example)\n\n'
      + '```markdown\n## Example\n```\n\n## Details\n',
    ),
    /does not resolve/,
  );
});

test('TOC validation accepts links to real heading anchors', () => {
  assert.equal(
    validateLeadingContents(
      '# Reference\n\n## Contents\n\n- [Details](#details)\n'
      + '- [More Detail](#more-detail)\n\n## Details\n\n## More Detail\n',
    ),
    null,
  );
});

test('passive inline commands and YAML examples are not executable contexts', () => {
  const markdown = [
    'Never run `kubectl exec -it pod -- sh` in an agent path.',
    '',
    '```yaml',
    'containers:',
    '- name: passive-example',
    '  image: busybox:latest',
    '```',
    '',
  ].join('\n');
  assert.deepEqual(extractMarkdownShellSources(markdown), { sources: [], errors: [] });
});

test('shell fences and bare command lines are executable contexts', () => {
  const markdown = [
    '```bash',
    'kubectl exec -it pod -- true',
    '```',
    '',
    'kubectl create deployment fixture --image=busybox:latest',
    '',
  ].join('\n');
  const { sources, errors } = extractMarkdownShellSources(markdown);
  assert.deepEqual(errors, []);
  assert.equal(sources.length, 2);
  assert.deepEqual(
    sources.flatMap(source => findingKinds(source.content, { startLine: source.startLine })),
    ['tty', 'image'],
  );
});

for (const command of [
  'kubectl exec -i -t pod -- true',
  'kubectl exec -t -i pod -- true',
  'kubectl exec -itd pod -- true',
  'docker run -itd busybox:latest',
  'docker run --interactive --tty busybox:latest',
]) {
  test(`TTY flags are rejected: ${command}`, () => {
    assert.ok(findingKinds(command).includes('tty'));
  });
}

test('non-TTY short flags are not substring matches', () => {
  assert.deepEqual(findingKinds('kubectl logs -t pod'), []);
  assert.deepEqual(findingKinds('kubectl get pods --sort-by=.metadata.name'), []);
});

test('eval is rejected in executable Markdown and script source', () => {
  assert.deepEqual(findingKinds('eval "$COMMAND"'), ['eval']);
});

test('kubectl create and set image enforce executable image provenance', () => {
  assert.deepEqual(
    findingKinds('kubectl create deployment fixture --image=busybox:latest'),
    ['image'],
  );
  assert.deepEqual(
    findingKinds('kubectl set image deployment/fixture app=mcr.microsoft.com/base/app:latest'),
    ['image'],
  );
  assert.deepEqual(
    findingKinds(`kubectl create deployment fixture --image=${PINNED_MCR}`),
    [],
  );
});

test('applied YAML heredocs enforce image provenance but passive YAML does not', () => {
  const source = [
    "kubectl apply -f - <<'EOF'",
    'apiVersion: v1',
    'kind: Pod',
    'spec:',
    '  containers:',
    '  - name: fixture',
    '    image: busybox:latest',
    'EOF',
  ].join('\n');
  const findings = inspectShellSource(source);
  assert.deepEqual(findings.map(finding => finding.kind), ['image']);
  assert.equal(findings[0].line, 7);
});

test('Docker run accepts common value options and finds the image', () => {
  const command = [
    'docker run --rm --name fixture --network host',
    '-v /tmp:/data -e FOO=bar -p 8080:80 -u 1000',
    PINNED_MCR,
  ].join(' ');
  assert.deepEqual(findingKinds(command), []);
});

test('Docker Hub and tag-only MCR runtime images are rejected', () => {
  assert.deepEqual(findingKinds('docker run --rm busybox:1.36'), ['image']);
  assert.deepEqual(
    findingKinds('docker run --rm mcr.microsoft.com/cbl-mariner/base/core:2.0'),
    ['image'],
  );
});

test('digest-pinned image variables resolve through fixed assignments', () => {
  const source = [
    `IMAGE_DEFAULT="${PINNED_MCR}"`,
    'IMAGE="$IMAGE_DEFAULT"',
    'kubectl debug node/fixture --image="$IMAGE" -- true',
  ].join('\n');
  assert.deepEqual(findingKinds(source), []);
});

test('ambiguous Docker options and unresolved image variables fail closed', () => {
  assert.deepEqual(findingKinds(`docker run --unknown value ${PINNED_MCR}`), ['malformed-image']);
  assert.deepEqual(
    findingKinds('kubectl debug node/fixture --image="$UNRESOLVED" -- true'),
    ['malformed-image'],
  );
});

test('line reporting survives comments and backslash continuations', () => {
  const source = [
    '# line 1 is intentionally ignored',
    'kubectl exec \\',
    '  pod \\',
    '  -i \\',
    '  -t -- true',
  ].join('\n');
  const findings = inspectShellSource(source);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'tty');
  assert.equal(findings[0].line, 5);
});

test('current executable skill scripts satisfy shared command policy', () => {
  const skillsDir = path.join(__dirname, '..', 'skills');
  const scripts = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.sh')) scripts.push(entryPath);
    }
  }
  walk(skillsDir);

  for (const script of scripts) {
    assert.deepEqual(
      inspectShellSource(fs.readFileSync(script, 'utf8')),
      [],
      `${path.relative(skillsDir, script)} violates the shared command policy`,
    );
  }
});
