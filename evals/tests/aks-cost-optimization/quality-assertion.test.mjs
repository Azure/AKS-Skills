import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.resolve(testDir, '../..');
const qualityTests = yaml.load(
  fs.readFileSync(path.join(testDir, 'quality-tests.yaml'), 'utf8'),
);
const autoscalerTest = qualityTests.find(
  ({ description }) => description
    === 'Autoscaler cost tuning must not recommend disabling kube-system pod protection',
);
const fencedCommandAssertion = autoscalerTest.assert.find(
  ({ type }) => type === 'javascript',
);
assert.match(fencedCommandAssertion.value, /^file:\/\//);
const assertionPath = path.resolve(
  evalRoot,
  fencedCommandAssertion.value.slice('file://'.length),
);
const { default: assertNoUnsafeAutoscalerCommand } = await import(
  pathToFileURL(assertionPath)
);

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
