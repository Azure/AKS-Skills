import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVALS_DIR, '..');
const SCRIPTS = join(REPO_ROOT, 'skills', 'aks-troubleshooting', 'scripts');
const SUBSCRIPTION = '11111111-1111-1111-1111-111111111111';
const FQDN = 'fixture.hcp.eastus.azmk8s.io';
const SENTINEL = 'fixture-sensitive-value';

const AZ_MOCK = `#!/usr/bin/env bash
set -u
printf 'az' >>"$MOCK_CALLS"
printf ' %q' "$@" >>"$MOCK_CALLS"
printf '\\n' >>"$MOCK_CALLS"
command_name="\${1:-} \${2:-}"
query=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--query" ]]; then query="$argument"; fi
  previous="$argument"
done
if [[ "\${MOCK_AZ_FAIL_CLUSTER:-0}" == "1" && "$command_name" == "aks show" ]]; then
  echo "cluster inaccessible" >&2
  exit 3
fi
case "$command_name:$query" in
  "account show:id") printf '%s\\n' '${SUBSCRIPTION}' ;;
  "account show:tenantId") printf '%s\\n' '22222222-2222-2222-2222-222222222222' ;;
  "account show:user.type") printf '%s\\n' 'servicePrincipal' ;;
  "account show:") printf '{"id":"%s","tenantId":"22222222-2222-2222-2222-222222222222","user":{"type":"servicePrincipal"}}\\n' '${SUBSCRIPTION}' ;;
  "aks show:id") printf '%s\\n' '/subscriptions/${SUBSCRIPTION}/resourceGroups/fixture-rg/providers/Microsoft.ContainerService/managedClusters/fixture-aks' ;;
  "aks show:fqdn") printf '%s\\n' '${FQDN}' ;;
  "aks show:privateFqdn") printf '\\n' ;;
  "aks show:") printf '{"id":"/subscriptions/${SUBSCRIPTION}/resourceGroups/fixture-rg/providers/Microsoft.ContainerService/managedClusters/fixture-aks","fqdn":"${FQDN}"}\\n' ;;
  "aks nodepool") printf 'pool1 System 3 Succeeded\\n' ;;
  "monitor activity-log") printf '2026-08-25T00:00:00Z write Succeeded cluster\\n' ;;
  *) printf 'fixture-output\\n' ;;
esac
`;

const KUBECTL_MOCK = `#!/usr/bin/env bash
set -u
printf 'kubectl' >>"$MOCK_CALLS"
printf ' %q' "$@" >>"$MOCK_CALLS"
printf '\\n' >>"$MOCK_CALLS"
joined=" $* "
if [[ "$joined" == *" config view "* ]]; then
  printf '%s\\n' "\${MOCK_KUBE_SERVER:-https://${FQDN}:443}"
  exit 0
fi
if [[ "$joined" == *" debug "* ]]; then
  if [[ "\${MOCK_DEBUG_NO_NAME:-0}" == "1" ]]; then
    printf 'Debug pod creation requested.\\n'
  else
    printf 'Creating debugging pod node-debugger-aks-node-1-fixture with container aks-skills-ig on node aks-node-1.\\n'
  fi
  exit "\${MOCK_DEBUG_STATUS:-0}"
fi
if [[ "$joined" == *" wait "* ]]; then
  printf 'pod/node-debugger-aks-node-1-fixture condition met\\n'
  exit "\${MOCK_WAIT_STATUS:-0}"
fi
if [[ "$joined" == *" delete pod "* ]]; then
  printf 'pod deleted\\n'
  exit "\${MOCK_DELETE_STATUS:-0}"
fi
if [[ "$joined" == *" get pods "*"RUN_IDS"* ]]; then
  case "\${MOCK_MARKER_MODE:-one}" in
    fail) exit 4 ;;
    none) exit 0 ;;
    ambiguous)
      printf 'node-debugger-aks-node-1-fixture\\t%s\\n' "\${AKS_SKILLS_RUN_ID:-fixture-run}"
      printf 'node-debugger-aks-node-1-second\\t%s\\n' "\${AKS_SKILLS_RUN_ID:-fixture-run}"
      ;;
    *) printf 'node-debugger-aks-node-1-fixture\\t%s\\n' "\${AKS_SKILLS_RUN_ID:-fixture-run}" ;;
  esac
  exit 0
fi
if [[ "$joined" == *" get pods "*" -o json "* ]]; then
  case "\${MOCK_MARKER_MODE:-one}" in
    fail) exit 4 ;;
    none) printf '{"items":[]}\\n' ;;
    ambiguous)
      printf '{"items":[{"metadata":{"name":"node-debugger-aks-node-1-fixture"},"spec":{"containers":[{"env":[{"name":"AKS_SKILLS_RUN_ID","value":"%s"}]}]}},{"metadata":{"name":"node-debugger-aks-node-1-second"},"spec":{"containers":[{"env":[{"name":"AKS_SKILLS_RUN_ID","value":"%s"}]}]}}]}\\n' "\${AKS_SKILLS_RUN_ID:-fixture-run}" "\${AKS_SKILLS_RUN_ID:-fixture-run}"
      ;;
    *) printf '{"items":[{"metadata":{"name":"node-debugger-aks-node-1-fixture"},"spec":{"containers":[{"env":[{"name":"AKS_SKILLS_RUN_ID","value":"%s"}]}]}}]}\\n' "\${AKS_SKILLS_RUN_ID:-fixture-run}" ;;
  esac
  exit 0
fi
if [[ "$joined" == *" get pod "*"spec.nodeName"* ]]; then
  printf 'aks-node-1'
  exit 0
fi
if [[ "$joined" == *" get pod "*"containerStatuses"* ]]; then
  printf 'container/app\\tfalse\\t3\\tCrashLoopBackOff\\t\\t\\tError\\t1\\n'
  exit 0
fi
if [[ "$joined" == *" get pod "* ]]; then
  printf 'app-0 false Running 3 aks-node-1\\n'
  exit 0
fi
if [[ "$joined" == *" get pods "*"--no-headers"* ]]; then
  printf 'prod\\tapp-0\\tfalse\\tRunning\\t3\\n'
  exit 0
fi
if [[ "$joined" == *" get nodes "* ]]; then
  printf 'aks-node-1 True 10.0.0.4 v1.34.0\\n'
  exit 0
fi
if [[ "$joined" == *" get pods "* ]]; then
  printf 'prod app-0 false Running 3 aks-node-1\\n'
  exit 0
fi
if [[ "$joined" == *" get events "* ]]; then
  printf '2026-08-25T00:00:00Z Warning BackOff app-0 token=${SENTINEL}\\n'
  exit 0
fi
if [[ "$joined" == *" describe pod "* ]]; then
  printf 'Environment: password=${SENTINEL}\\n'
  exit 0
fi
if [[ "$joined" == *" logs "* && "$joined" == *" -c aks-skills-ig "* ]]; then
  printf '{"event":"dns","client_secret":"${SENTINEL}"}\\n'
  exit 0
fi
if [[ "$joined" == *" logs "* && "$joined" == *" --previous "* ]]; then
  printf 'client_secret: ${SENTINEL}\\n'
  exit "\${MOCK_PREVIOUS_STATUS:-0}"
fi
if [[ "$joined" == *" logs "* ]]; then
  printf 'Authorization: Bearer ${SENTINEL}\\n'
  printf 'password=${SENTINEL}\\n'
  printf 'endpoint=https://user:${SENTINEL}@example.invalid/path\\n'
  printf '%s\\n' '-----BEGIN PRIVATE KEY-----' '${SENTINEL}' '-----END PRIVATE KEY-----'
  exit 0
fi
if [[ "$joined" == *" top pod "* ]]; then
  printf 'app-0 10m 32Mi\\n'
  exit 0
fi
printf 'fixture-output\\n'
`;

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'aks-script-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'az'), AZ_MOCK);
  writeFileSync(join(bin, 'kubectl'), KUBECTL_MOCK);
  chmodSync(join(bin, 'az'), 0o755);
  chmodSync(join(bin, 'kubectl'), 0o755);
  return {
    root,
    bin,
    calls: join(root, 'calls.txt'),
    artifacts(name) {
      return join(root, `artifacts-${name}`);
    },
  };
}

function commonArgs(artifacts) {
  return [
    '--subscription', SUBSCRIPTION,
    '--resource-group', 'fixture-rg',
    '--cluster', 'fixture-aks',
    '--context', 'fixture-context',
    '--artifacts-dir', artifacts,
  ];
}

function runScript(script, args, fixture, environment = {}) {
  return spawnSync('bash', [join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      MOCK_CALLS: fixture.calls,
      ...environment,
    },
  });
}

function reviewerRedactionVectors() {
  return [
    'Author' + 'ization: Digest ' + SENTINEL,
    'STORAGE' + '_KEY=' + SENTINEL,
    'creden' + 'tial=' + SENTINEL,
    'p' + 'wd: ' + SENTINEL,
    's' + 'as=' + SENTINEL,
    'signa' + 'ture=' + SENTINEL,
    'coo' + 'kie=' + SENTINEL,
    'Set-' + 'Cookie: session=' + SENTINEL,
    'Account' + 'Key=' + SENTINEL,
    'SharedAccess' + 'Key=' + SENTINEL,
    'SharedAccess' + 'Signature=' + SENTINEL,
    'connection_' + 'string=Server=tcp:fixture;User Id=fixture;Password=' + SENTINEL,
    'DefaultEndpointsProtocol=https;AccountName=fixture;Account' + 'Key=' + SENTINEL + ';EndpointSuffix=core.windows.net',
    'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=fixture;SharedAccess' + 'Key=' + SENTINEL,
  ];
}

function runBashRedaction(lines) {
  return spawnSync(
    'bash',
    ['-c', 'source "$1"; redact_evidence', 'bash', join(SCRIPTS, 'evidence-common.sh')],
    {
      encoding: 'utf8',
      input: `${lines.join('\n')}\n`,
    },
  );
}

function calls(fixture) {
  return existsSync(fixture.calls) ? readFileSync(fixture.calls, 'utf8') : '';
}

test('redaction covers the reviewer credential and connection-string vectors', () => {
  const vectors = reviewerRedactionVectors();
  const result = runBashRedaction(vectors);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(SENTINEL));
  const projected = result.stdout.trim().split('\n');
  assert.equal(projected.length, vectors.length);
  for (const line of projected) assert.match(line, /\[REDACTED]/);
});

function usingFixture(callback) {
  const fixture = makeFixture();
  try {
    return callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('baseline proves the target and pins every cluster read to the context', () => {
  usingFixture(fixture => {
    const result = runScript(
      'aks-baseline.sh',
      commonArgs(fixture.artifacts('baseline')),
      fixture,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /targetProof=matched/);
    assert.match(result.stdout, /collectionStatus=complete/);
    const invocationLog = calls(fixture);
    assert.match(invocationLog, /kubectl --context fixture-context config view/);
    assert.match(invocationLog, /kubectl --context fixture-context get nodes/);
    assert.match(invocationLog, /az aks show --subscription/);
  });
});

test('wrong or unknown target stops before cluster collection', () => {
  usingFixture(fixture => {
    const mismatch = runScript(
      'aks-baseline.sh',
      commonArgs(fixture.artifacts('mismatch')),
      fixture,
      { MOCK_KUBE_SERVER: 'https://different.hcp.eastus.azmk8s.io:443' },
    );
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not target the named AKS cluster/);
    const invocationLog = calls(fixture);
    assert.match(invocationLog, /kubectl --context fixture-context config view/);
    assert.doesNotMatch(invocationLog, /kubectl --context fixture-context get /);
  });

  usingFixture(fixture => {
    const inaccessible = runScript(
      'aks-baseline.sh',
      commonArgs(fixture.artifacts('inaccessible')),
      fixture,
      { MOCK_AZ_FAIL_CLUSTER: '1' },
    );
    assert.notEqual(inaccessible.status, 0);
    assert.match(inaccessible.stderr, /AKS resource target is inaccessible/);
    assert.doesNotMatch(calls(fixture), /^kubectl/m);
  });
});

test('pod evidence redacts model output and preserves raw artifacts', () => {
  usingFixture(fixture => {
    const artifacts = fixture.artifacts('pod');
    const result = runScript(
      'pod-evidence.sh',
      [...commonArgs(artifacts), '--pod', 'app-0', '--namespace', 'prod'],
      fixture,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, new RegExp(SENTINEL));
    assert.match(result.stdout, /\[REDACTED]/);
    assert.match(result.stdout, /collectionStatus=complete/);
    assert.match(
      readFileSync(join(artifacts, 'prod.app-0.logs.current.raw.txt'), 'utf8'),
      new RegExp(SENTINEL),
    );
    assert.match(
      readFileSync(join(artifacts, 'prod.app-0.logs.previous.raw.txt'), 'utf8'),
      new RegExp(SENTINEL),
    );
  });
});

test('run-ig rejects malicious arguments and missing approval before mutation', () => {
  usingFixture(fixture => {
    const malicious = runScript(
      'run-ig.sh',
      [
        ...commonArgs(fixture.artifacts('malicious')),
        '--namespace', 'prod',
        '--pod', 'app-0',
        '--gadget', 'trace_dns;delete',
        '--dry-run',
      ],
      fixture,
    );
    assert.notEqual(malicious.status, 0);
    assert.match(malicious.stderr, /unsupported gadget/);
    assert.doesNotMatch(calls(fixture), / debug /);
  });

  usingFixture(fixture => {
    const malicious = runScript(
      'run-ig.sh',
      [
        ...commonArgs(fixture.artifacts('malicious-filter')),
        '--namespace', 'prod',
        '--pod', 'app-0',
        '--gadget', 'tcpdump',
        '--packet-filter', 'port 80; delete pod',
        '--dry-run',
      ],
      fixture,
    );
    assert.notEqual(malicious.status, 0);
    assert.match(malicious.stderr, /invalid packet filter/);
    assert.doesNotMatch(calls(fixture), / debug /);
  });

  usingFixture(fixture => {
    const malicious = runScript(
      'run-ig.sh',
      [
        ...commonArgs(fixture.artifacts('malicious-pod')),
        '--namespace', 'prod',
        '--pod', 'app-0;delete',
        '--gadget', 'trace_dns',
        '--dry-run',
      ],
      fixture,
    );
    assert.notEqual(malicious.status, 0);
    assert.match(malicious.stderr, /invalid pod name/);
    assert.doesNotMatch(calls(fixture), / debug /);
  });

  usingFixture(fixture => {
    const denied = runScript(
      'run-ig.sh',
      [
        ...commonArgs(fixture.artifacts('denied')),
        '--namespace', 'prod',
        '--pod', 'app-0',
        '--gadget', 'trace_dns',
        '--deadline', '45s',
      ],
      fixture,
    );
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /requires --approve-privileged/);
    assert.doesNotMatch(calls(fixture), / debug /);
  });
});

test('run-ig dry-run uses the fixed digest and performs no privileged mutation', () => {
  usingFixture(fixture => {
    const result = runScript(
      'run-ig.sh',
      [
        ...commonArgs(fixture.artifacts('dry-run')),
        '--namespace', 'prod',
        '--pod', 'app-0',
        '--gadget', 'trace_dns',
        '--dry-run',
      ],
      fixture,
      { AKS_SKILLS_RUN_ID: 'fixture-run' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stdout,
      /v0\.51\.0@sha256:6610863f6d8cae28800f9331756434639bca44be065719cbcfe76e34c91dffa4/,
    );
    assert.match(result.stdout, /executionStatus=dry-run/);
    assert.doesNotMatch(calls(fixture), / debug /);
  });
});

test('run-ig node dry-run tolerates empty filters on Bash 3.2', () => {
  for (const gadget of ['trace_dns', 'tcpdump']) {
    usingFixture(fixture => {
      const result = runScript(
        'run-ig.sh',
        [
          ...commonArgs(fixture.artifacts(`node-${gadget}`)),
          '--namespace', 'prod',
          '--node', 'aks-node-1',
          '--gadget', gadget,
          '--dry-run',
        ],
        fixture,
        { AKS_SKILLS_RUN_ID: 'fixture-run' },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /executionStatus=dry-run/);
      assert.doesNotMatch(calls(fixture), / get pod /);
      assert.doesNotMatch(calls(fixture), / debug /);
    });
  }
});

test('run-ig cleans the exact debug pod on success and deadline failure', () => {
  usingFixture(fixture => {
    const artifacts = fixture.artifacts('ig-success');
    const result = runScript(
      'run-ig.sh',
      [
        ...commonArgs(artifacts),
        '--namespace', 'prod',
        '--pod', 'app-0',
        '--gadget', 'trace_dns',
        '--approve-privileged',
        '--deadline', '45s',
      ],
      fixture,
      { AKS_SKILLS_RUN_ID: 'fixture-run' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /cleanupStatus=requested/);
    assert.match(result.stdout, /executionStatus=complete/);
    assert.doesNotMatch(result.stdout, new RegExp(SENTINEL));
    assert.match(
      readFileSync(join(artifacts, 'ig-output.raw.txt'), 'utf8'),
      new RegExp(SENTINEL),
    );
    assert.match(
      calls(fixture),
      /--request-timeout=45s delete pod node-debugger-aks-node-1-fixture -n prod --wait=false/,
    );
  });

  usingFixture(fixture => {
    const result = runScript(
      'run-ig.sh',
      [
        ...commonArgs(fixture.artifacts('ig-timeout')),
        '--namespace', 'prod',
        '--pod', 'app-0',
        '--gadget', 'trace_dns',
        '--approve-privileged',
        '--deadline', '45s',
      ],
      fixture,
      { AKS_SKILLS_RUN_ID: 'fixture-run', MOCK_WAIT_STATUS: '1' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /executionStatus=deadline-or-command-failure/);
    assert.match(
      calls(fixture),
      /--request-timeout=45s delete pod node-debugger-aks-node-1-fixture -n prod --wait=false/,
    );
  });

  usingFixture(fixture => {
    const result = runScript(
      'run-ig.sh',
      [
        ...commonArgs(fixture.artifacts('ig-create-failure')),
        '--namespace', 'prod',
        '--pod', 'app-0',
        '--gadget', 'trace_dns',
        '--approve-privileged',
        '--deadline', '45s',
      ],
      fixture,
      { AKS_SKILLS_RUN_ID: 'fixture-run', MOCK_DEBUG_STATUS: '1' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /creation command failed/);
    assert.match(calls(fixture), /RUN_IDS/);
    assert.match(
      calls(fixture),
      /--request-timeout=45s delete pod node-debugger-aks-node-1-fixture -n prod --wait=false/,
    );
  });

  usingFixture(fixture => {
    const result = runScript(
      'run-ig.sh',
      [
        ...commonArgs(fixture.artifacts('ig-marker-fallback')),
        '--namespace', 'prod',
        '--pod', 'app-0',
        '--gadget', 'trace_dns',
        '--approve-privileged',
        '--deadline', '45s',
      ],
      fixture,
      { AKS_SKILLS_RUN_ID: 'fixture-run', MOCK_DEBUG_NO_NAME: '1' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /debugPod=node-debugger-aks-node-1-fixture/);
    assert.match(
      calls(fixture),
      /--request-timeout=45s delete pod node-debugger-aks-node-1-fixture -n prod --wait=false/,
    );
  });

  usingFixture(fixture => {
    const result = runScript(
      'run-ig.sh',
      [
        ...commonArgs(fixture.artifacts('ig-ambiguous')),
        '--namespace', 'prod',
        '--pod', 'app-0',
        '--gadget', 'trace_dns',
        '--approve-privileged',
        '--deadline', '45s',
      ],
      fixture,
      {
        AKS_SKILLS_RUN_ID: 'fixture-run',
        MOCK_DEBUG_NO_NAME: '1',
        MOCK_MARKER_MODE: 'ambiguous',
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown or ambiguous/);
    const invocationLog = calls(fixture);
    assert.match(
      invocationLog,
      /delete pod node-debugger-aks-node-1-fixture -n prod --wait=false/,
    );
    assert.match(
      invocationLog,
      /delete pod node-debugger-aks-node-1-second -n prod --wait=false/,
    );
  });
});

test('Bash and PowerShell entry points declare the same safety contract', () => {
  const pairs = ['aks-baseline', 'pod-evidence', 'run-ig'];
  const bashTerms = {
    Subscription: 'subscription',
    ResourceGroup: 'resource[-_]group',
    Cluster: 'cluster',
    Context: 'context',
    ArtifactsDir: 'artifacts[-_]dir',
  };
  for (const name of pairs) {
    const bash = readFileSync(join(SCRIPTS, `${name}.sh`), 'utf8');
    const powershell = readFileSync(join(SCRIPTS, `${name}.ps1`), 'utf8');
    for (const term of ['Subscription', 'ResourceGroup', 'Cluster', 'Context', 'ArtifactsDir']) {
      assert.match(bash.toLowerCase(), new RegExp(bashTerms[term]));
      assert.match(powershell, new RegExp(term));
    }
  }
  const bashIg = readFileSync(join(SCRIPTS, 'run-ig.sh'), 'utf8');
  const powershellIg = readFileSync(join(SCRIPTS, 'run-ig.ps1'), 'utf8');
  const digest = 'sha256:6610863f6d8cae28800f9331756434639bca44be065719cbcfe76e34c91dffa4';
  assert.match(bashIg, new RegExp(digest));
  assert.match(powershellIg, new RegExp(digest));
  assert.doesNotMatch(bashIg, /--ig-version/);
  assert.doesNotMatch(powershellIg, /\[string]\$IgVersion/);
  assert.doesNotMatch(bashIg, /\beval\b/);
  assert.doesNotMatch(bashIg, /kubectl[^\n]*(?:\s-it\b|\s-i\b|\s-t\b|--tty|--stdin)/);
  assert.match(bashIg, /discover_marker_pods/);
  assert.match(powershellIg, /Find-MarkerPods/);
  assert.match(powershellIg, /Remove-DebugPods/);
  assert.doesNotMatch(bashIg, /for \(index =/);

  const bashRedaction = readFileSync(join(SCRIPTS, 'evidence-common.sh'), 'utf8').toLowerCase();
  const powershellRedaction = readFileSync(join(SCRIPTS, 'evidence-common.ps1'), 'utf8').toLowerCase();
  for (const term of [
    'authorization',
    'credential',
    'pwd',
    'sas',
    'signature',
    'cookie',
    'accountkey',
    'sharedaccesskey',
    'sharedaccesssignature',
    'connection',
  ]) {
    assert.match(bashRedaction, new RegExp(term));
    assert.match(powershellRedaction, new RegExp(term));
  }
});

const pwshAvailable = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8',
}).status === 0;

test('PowerShell collectors execute the same mock safety contract', { skip: !pwshAvailable }, () => {
  usingFixture(fixture => {
    const environment = {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      MOCK_CALLS: fixture.calls,
      AKS_SKILLS_RUN_ID: 'fixture-run',
    };
    const redaction = spawnSync('pwsh', [
      '-NoProfile',
      '-Command',
      '. $args[0]; $text = [Console]::In.ReadToEnd(); Protect-EvidenceText @($text -split "`r?`n" | Where-Object { $_ })',
      join(SCRIPTS, 'evidence-common.ps1'),
    ], {
      encoding: 'utf8',
      input: `${reviewerRedactionVectors().join('\n')}\n`,
      env: environment,
    });
    assert.equal(redaction.status, 0, `${redaction.stdout}\n${redaction.stderr}`);
    assert.doesNotMatch(redaction.stdout, new RegExp(SENTINEL));
    assert.equal(
      redaction.stdout.trim().split(/\r?\n/).length,
      reviewerRedactionVectors().length,
    );

    const baseline = spawnSync('pwsh', [
      '-NoProfile',
      '-File',
      join(SCRIPTS, 'aks-baseline.ps1'),
      '-Subscription', SUBSCRIPTION,
      '-ResourceGroup', 'fixture-rg',
      '-Cluster', 'fixture-aks',
      '-Context', 'fixture-context',
      '-ArtifactsDir', fixture.artifacts('pwsh-baseline'),
    ], {
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
    assert.match(baseline.stdout, /targetProof=matched/);
    assert.match(baseline.stdout, /collectionStatus=complete/);

    const pod = spawnSync('pwsh', [
      '-NoProfile',
      '-File',
      join(SCRIPTS, 'pod-evidence.ps1'),
      '-Subscription', SUBSCRIPTION,
      '-ResourceGroup', 'fixture-rg',
      '-Cluster', 'fixture-aks',
      '-Context', 'fixture-context',
      '-ArtifactsDir', fixture.artifacts('pwsh-pod'),
      '-Pod', 'app-0',
      '-Namespace', 'prod',
    ], { encoding: 'utf8', env: environment });
    assert.equal(pod.status, 0, `${pod.stdout}\n${pod.stderr}`);
    assert.doesNotMatch(pod.stdout, new RegExp(SENTINEL));
    assert.match(pod.stdout, /\[REDACTED]/);

    const dryRun = spawnSync('pwsh', [
      '-NoProfile',
      '-File',
      join(SCRIPTS, 'run-ig.ps1'),
      '-Subscription', SUBSCRIPTION,
      '-ResourceGroup', 'fixture-rg',
      '-Cluster', 'fixture-aks',
      '-Context', 'fixture-context',
      '-ArtifactsDir', fixture.artifacts('pwsh-ig-dry'),
      '-Namespace', 'prod',
      '-Pod', 'app-0',
      '-Gadget', 'trace_dns',
      '-DryRun',
    ], { encoding: 'utf8', env: environment });
    assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
    assert.match(dryRun.stdout, /executionStatus=dry-run/);

    const ig = spawnSync('pwsh', [
      '-NoProfile',
      '-File',
      join(SCRIPTS, 'run-ig.ps1'),
      '-Subscription', SUBSCRIPTION,
      '-ResourceGroup', 'fixture-rg',
      '-Cluster', 'fixture-aks',
      '-Context', 'fixture-context',
      '-ArtifactsDir', fixture.artifacts('pwsh-ig'),
      '-Namespace', 'prod',
      '-Pod', 'app-0',
      '-Gadget', 'trace_dns',
      '-ApprovePrivileged',
      '-Deadline', '45s',
    ], { encoding: 'utf8', env: environment });
    assert.equal(ig.status, 0, `${ig.stdout}\n${ig.stderr}`);
    assert.match(ig.stdout, /cleanupStatus=requested/);
    assert.doesNotMatch(ig.stdout, new RegExp(SENTINEL));
  });
});
