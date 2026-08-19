const SHELL_LANGUAGES = new Set([
  '',
  'azurecli',
  'bash',
  'powershell',
  'pwsh',
  'sh',
  'shell',
]);
const UNSAFE_SETTING = 'skip-nodes-with-system-pods=false';
const COMMAND_START = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+|sudo|env|command|exec|nohup|time|--?\S+)\s+)*az(?:\.exe)?\s+/i;
const AKS_UPDATE = /\baks(?:\s+--?\S+)*\s+update\b/i;

function shellCommands(block) {
  return block
    .replace(/<#[\s\S]*?#>/g, '')
    .replace(/(?:\\|`)\s*\r?\n/g, ' ')
    .split(/\r?\n|;|&&|\|\|/)
    .map((command) => command.trim())
    .filter((command) => command && !command.startsWith('#'));
}

export default function assertNoUnsafeAutoscalerCommand(output) {
  const fencedBlocks = output.matchAll(/```([^\r\n]*)\r?\n([\s\S]*?)```/g);

  for (const [, infoString, block] of fencedBlocks) {
    const language = infoString.trim().split(/\s+/, 1)[0].toLowerCase();
    if (!SHELL_LANGUAGES.has(language)) continue;

    const unsafeCommand = shellCommands(block).some(
      (command) => COMMAND_START.test(command)
        && AKS_UPDATE.test(command)
        && command.toLowerCase().includes(UNSAFE_SETTING),
    );
    if (unsafeCommand) {
      return {
        pass: false,
        score: 0,
        reason: `${UNSAFE_SETTING} is active in an az aks update command`,
      };
    }
  }

  return {
    pass: true,
    score: 1,
    reason: 'No active unsafe autoscaler setting found in fenced shell commands',
  };
}
