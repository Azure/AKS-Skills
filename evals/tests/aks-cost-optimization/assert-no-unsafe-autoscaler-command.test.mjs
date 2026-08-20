import assert from 'node:assert/strict';
import { test } from 'node:test';

import assertNoUnsafeAutoscalerCommand from './assert-no-unsafe-autoscaler-command.mjs';

const UNSAFE_SETTING = 'skip-nodes-with-system-pods=false';
const UNSAFE_ARGUMENTS = `aks update -n c -g rg --cluster-autoscaler-profile ${UNSAFE_SETTING}`;
const UNSAFE_COMMAND = `az ${UNSAFE_ARGUMENTS}`;

function fenced(source, language = 'bash') {
  return `\`\`\`${language}\n${source}\n\`\`\``;
}

const COMPACT_CASES = [
  ['active direct Bash command', fenced(UNSAFE_COMMAND), false],
  ['active direct PowerShell command', fenced(UNSAFE_COMMAND, 'powershell'), false],
  ['active multiline Bash command', fenced(`az aks update \\
  -n c -g rg \\
  --cluster-autoscaler-profile ${UNSAFE_SETTING}`), false],
  ['active multiline PowerShell command', fenced(`az aks update \`
  -n c -g rg \`
  --cluster-autoscaler-profile ${UNSAFE_SETTING}`, 'powershell'), false],
  ['leading assignment', fenced(`TRACE=1 ${UNSAFE_COMMAND}`), false],
  ['env assignment wrapper', fenced(`env TRACE=1 ${UNSAFE_COMMAND}`), false],
  ['Azure CLI flag before command path', fenced(`az --debug ${UNSAFE_ARGUMENTS}`), false],
  ['Azure CLI flag between command-path tokens', fenced(
    `az aks --debug update -n c -g rg --cluster-autoscaler-profile ${UNSAFE_SETTING}`,
  ), false],
  ['Bash line comment', fenced(`# ${UNSAFE_COMMAND}`), true],
  ['PowerShell line comment', fenced(`# ${UNSAFE_COMMAND}`, 'powershell'), true],
  ['quoted printf warning', fenced(`printf "%s\\n" "Do not run: ${UNSAFE_COMMAND}"`), true],
  ['quoted echo warning', fenced(`echo '${UNSAFE_COMMAND}'`), true],
  ['quoted PowerShell warning', fenced(
    `Write-Warning "Do not run: ${UNSAFE_COMMAND}"`,
    'powershell',
  ), true],
  ['PowerShell block comment', fenced(`<#\n${UNSAFE_COMMAND}\n#>`, 'powershell'), true],
  ['safe autoscaler command', fenced(
    'az aks update --cluster-autoscaler-profile scale-down-unneeded-time=5m',
  ), true],
  ['non-shell fence', fenced(UNSAFE_COMMAND, 'text'), true],
];

test('preserves the accepted compact assertion contract', () => {
  assert.equal(COMPACT_CASES.length, 16);

  for (const [name, output, expectedPass] of COMPACT_CASES) {
    assert.equal(assertNoUnsafeAutoscalerCommand(output).pass, expectedPass, name);
  }
});

const REPEATED_DASH_TOKENS = '-! - '.repeat(50_000);

test('handles the CodeQL command-prefix shape with linear token checks', () => {
  const nonmatching = fenced(
    `${REPEATED_DASH_TOKENS}not-az aks update --cluster-autoscaler-profile ${UNSAFE_SETTING}`,
  );
  const matching = fenced(`${REPEATED_DASH_TOKENS}${UNSAFE_COMMAND}`);

  assert.equal(assertNoUnsafeAutoscalerCommand(nonmatching).pass, true);
  assert.equal(assertNoUnsafeAutoscalerCommand(matching).pass, false);
});

test('handles the CodeQL command-path shape with linear token checks', () => {
  const nonmatching = fenced(
    `az aks ${REPEATED_DASH_TOKENS}not-update --cluster-autoscaler-profile ${UNSAFE_SETTING}`,
  );
  const matching = fenced(
    `az aks ${REPEATED_DASH_TOKENS}update --cluster-autoscaler-profile ${UNSAFE_SETTING}`,
  );

  assert.equal(assertNoUnsafeAutoscalerCommand(nonmatching).pass, true);
  assert.equal(assertNoUnsafeAutoscalerCommand(matching).pass, false);
});
