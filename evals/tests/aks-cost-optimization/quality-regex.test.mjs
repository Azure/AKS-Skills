import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const qualityTests = yaml.load(
  fs.readFileSync(path.join(testDir, 'quality-tests.yaml'), 'utf8'),
);
const autoscalerTest = qualityTests.find(
  ({ description }) => description
    === 'Autoscaler cost tuning must not recommend disabling kube-system pod protection',
);
const fencedCommandAssertion = autoscalerTest.assert.find(
  ({ type }) => type === 'not-regex',
);
const unsafeFencedCommand = new RegExp(fencedCommandAssertion.value);

const safeResponse = `Use the cost-optimized profile:

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

const unsafeResponse = `Apply this profile:

\`\`\`bash
az aks update \\
  --cluster-autoscaler-profile \\
    scale-down-delay-after-add=5m \\
    skip-nodes-with-system-pods=false
\`\`\``;

assert.equal(
  unsafeFencedCommand.test(safeResponse),
  false,
  'safe caveat between separate command blocks must pass',
);
assert.equal(
  unsafeFencedCommand.test(unsafeResponse),
  true,
  'unsafe assignment inside one command block must fail',
);
