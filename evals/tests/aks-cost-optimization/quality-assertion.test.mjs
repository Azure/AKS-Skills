import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.resolve(testDir, '../..');
const qualityTestSource = fs.readFileSync(
  path.join(testDir, 'quality-tests.yaml'),
  'utf8',
);

function testSection(description) {
  const marker = `- description: "${description}"`;
  const start = qualityTestSource.indexOf(marker);
  assert.notEqual(start, -1, `Missing quality test: ${description}`);
  const next = qualityTestSource.indexOf('\n- description: "', start + marker.length);
  return qualityTestSource.slice(start, next === -1 ? undefined : next);
}

const autoscalerSection = testSection(
  'Autoscaler cost tuning must not recommend disabling kube-system pod protection',
);
const fencedCommandAssertion = autoscalerSection.match(
  /- type: javascript\r?\n\s+value: "(file:\/\/[^"]+)"/,
);
assert.ok(fencedCommandAssertion, 'Missing autoscaler JavaScript assertion');
const assertionPath = path.resolve(
  evalRoot,
  fencedCommandAssertion[1].slice('file://'.length),
);
const { default: assertNoUnsafeAutoscalerCommand } = await import(
  pathToFileURL(assertionPath)
);
const spotSection = testSection(
  'Spot resilience guidance must not claim a PDB stops Azure Spot reclamation',
);
const spotPdbAssertion = spotSection.match(
  /- type: javascript\r?\n\s+value: \|\r?\n((?: {8}.*(?:\r?\n|$))+)/,
);
assert.ok(spotPdbAssertion, 'Missing inline Spot PDB JavaScript assertion');
const spotPdbAssertionSource = spotPdbAssertion[1].replace(/^ {8}/gm, '').trim();
const assertNoInvalidSpotPdbClaim = Function(
  `"use strict"; return (${spotPdbAssertionSource});`,
)();

test('safe caveat between separate command blocks passes', () => {
  const response = `Use the cost-optimized profile:

\`\`\`bash
az aks update \\
  --cluster-autoscaler-profile \\
    scale-down-delay-after-add=5m \\
    scale-down-unneeded-time=5m \\
    scale-down-utilization-threshold=0.5
\`\`\`

Do not add skip-nodes-with-system-pods=false. Leave the default protection enabled.

To roll back:

\`\`\`bash
az aks update --cluster-autoscaler-profile ""
\`\`\``;

  assert.equal(assertNoUnsafeAutoscalerCommand(response).pass, true);
});

test('safe caveat as a shell comment in the same block passes', () => {
  const response = `\`\`\`bash
az aks update --cluster-autoscaler-profile scale-down-unneeded-time=5m
# Do not add skip-nodes-with-system-pods=false; keep protection enabled.
\`\`\``;

  assert.equal(assertNoUnsafeAutoscalerCommand(response).pass, true);
});

test('active unsafe assignment in an az aks update command fails', () => {
  const response = `Apply this profile:

\`\`\`bash
az aks update \\
  --cluster-autoscaler-profile \\
    scale-down-delay-after-add=5m \\
    skip-nodes-with-system-pods=false
\`\`\``;

  assert.equal(assertNoUnsafeAutoscalerCommand(response).pass, false);
});

test('unsafe PowerShell command with backtick continuations fails', () => {
  const response = `Apply this profile:

\`\`\`powershell
az aks update \`
  --cluster-autoscaler-profile \`
    scale-down-delay-after-add=5m \`
    skip-nodes-with-system-pods=false
\`\`\``;

  assert.equal(assertNoUnsafeAutoscalerCommand(response).pass, false);
});

test('unsafe pwsh command with backtick continuations fails', () => {
  const response = `Apply this profile:

\`\`\`pwsh
Az AKS Update \`
  --cluster-autoscaler-profile \`
    scale-down-unneeded-time=5m \`
    SKIP-NODES-WITH-SYSTEM-PODS=false
\`\`\``;

  assert.equal(assertNoUnsafeAutoscalerCommand(response).pass, false);
});

test('valid PDB guidance for voluntary drains passes', () => {
  const response = [
    'Use a PodDisruptionBudget to limit simultaneous evictions during voluntary drains.',
    'A PDB does not prevent Azure Spot reclamation.',
  ].join(' ');

  assert.equal(assertNoInvalidSpotPdbClaim(response), true);
});

test('valid Eviction API guidance for Spot workloads passes', () => {
  const response = 'A PDB can limit Eviction API disruptions during a voluntary drain of Spot-backed workloads.';

  assert.equal(assertNoInvalidSpotPdbClaim(response), true);
});

test('claim that a PDB limits Azure Spot reclamation fails', () => {
  const response = 'Use a PodDisruptionBudget to limit simultaneous evictions during Azure Spot reclamation.';

  assert.equal(assertNoInvalidSpotPdbClaim(response), false);
});

test('claim that a PDB limits eviction when Azure reclaims Spot nodes fails', () => {
  const response = 'A PDB limits evictions when Azure reclaims Spot nodes.';

  assert.equal(assertNoInvalidSpotPdbClaim(response), false);
});
