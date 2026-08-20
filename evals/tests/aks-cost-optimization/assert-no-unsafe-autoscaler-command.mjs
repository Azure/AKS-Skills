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
const COMMAND_PREFIXES = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time']);

function isAsciiLetter(character) {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(character) {
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isAssignment(token) {
  const equalsIndex = token.indexOf('=');
  if (equalsIndex <= 0) return false;

  const name = token.slice(0, equalsIndex);
  if (!(name[0] === '_' || isAsciiLetter(name[0]))) return false;

  return [...name.slice(1)].every(
    (character) => character === '_' || isAsciiLetter(character) || isAsciiDigit(character),
  );
}

function isUnsafeAutoscalerCommand(command) {
  const tokens = command.toLowerCase().split(/\s+/);
  let index = 0;

  while (index < tokens.length
    && (isAssignment(tokens[index])
      || COMMAND_PREFIXES.has(tokens[index])
      || tokens[index].startsWith('-'))) {
    index += 1;
  }
  if (tokens[index] !== 'az' && tokens[index] !== 'az.exe') return false;

  index += 1;
  while (index < tokens.length && tokens[index].startsWith('-')) index += 1;
  if (tokens[index] !== 'aks') return false;

  index += 1;
  while (index < tokens.length && tokens[index].startsWith('-')) index += 1;

  return tokens[index] === 'update' && tokens.includes(UNSAFE_SETTING);
}

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

    const unsafeCommand = shellCommands(block).some(isUnsafeAutoscalerCommand);
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
