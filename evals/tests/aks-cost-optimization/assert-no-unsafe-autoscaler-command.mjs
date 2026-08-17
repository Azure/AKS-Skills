import { pathToFileURL } from 'node:url';

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
const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CONTROL_PREFIXES = new Set(['!', 'do', 'elif', 'else', 'if', 'then', 'until', 'while']);
const ENV_OPTIONS_WITH_VALUES = new Set([
  '-C',
  '-S',
  '-u',
  '--block-signal',
  '--chdir',
  '--default-signal',
  '--ignore-signal',
  '--split-string',
  '--unset',
]);
const SUDO_OPTIONS_WITH_VALUES = new Set([
  '-C',
  '-D',
  '-g',
  '-h',
  '-p',
  '-R',
  '-r',
  '-T',
  '-t',
  '-u',
  '--chdir',
  '--chroot',
  '--close-from',
  '--command-timeout',
  '--group',
  '--host',
  '--prompt',
  '--role',
  '--type',
  '--user',
]);
const EXEC_OPTIONS_WITH_VALUES = new Set(['-a']);
const TIME_OPTIONS_WITH_VALUES = new Set(['-f', '-o', '--format', '--output']);

function stripShellComment(line) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }

  return line;
}

function splitShellCommands(source) {
  const commands = [];
  let command = '';
  let quote = null;
  let escaped = false;

  const flush = () => {
    if (command.trim()) commands.push(command.trim());
    command = '';
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (escaped) {
      command += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      command += character;
      escaped = true;
      continue;
    }
    if (quote) {
      command += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      command += character;
      continue;
    }
    if (character === '\n' || character === ';' || character === '&' || character === '|') {
      flush();
      if ((character === '&' && next === '&') || (character === '|' && next === '|')) {
        index += 1;
      }
      continue;
    }
    command += character;
  }

  flush();
  return commands;
}

function shellCommands(block) {
  const uncommented = block
    .split(/\r?\n/)
    .map(stripShellComment)
    .join('\n')
    .replace(/(?:\\|`)\s*\n/g, ' ');

  return splitShellCommands(uncommented);
}

function shellTokens(command) {
  const tokens = [];
  let token = '';
  let tokenStarted = false;
  let quote = null;
  let escaped = false;

  const flush = () => {
    if (tokenStarted) tokens.push(token);
    token = '';
    tokenStarted = false;
  };

  for (const character of command) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaped) token += '\\';
  flush();
  return tokens;
}

function commandName(token) {
  return token
    .split(/[\\/]/)
    .at(-1)
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/, '');
}

function skipAssignments(tokens, start) {
  let index = start;
  while (index < tokens.length && ASSIGNMENT_TOKEN.test(tokens[index])) index += 1;
  return index;
}

function skipOptions(tokens, start, optionsWithValues = new Set()) {
  let index = start;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return index + 1;
    if (token === '-' || !token.startsWith('-')) return index;

    const option = token.split('=', 1)[0];
    index += 1;
    if (optionsWithValues.has(option) && !token.includes('=') && index < tokens.length) {
      index += 1;
    }
  }

  return index;
}

function skipCommandOptions(tokens, start) {
  let index = start;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return index + 1;
    if (token === '-' || !token.startsWith('-')) return index;
    if (/^-[^-]*[vV]/.test(token)) return -1;
    index += 1;
  }

  return index;
}

function executableTokenIndex(tokens) {
  let index = skipAssignments(tokens, 0);

  while (index < tokens.length) {
    const name = commandName(tokens[index]);

    if (CONTROL_PREFIXES.has(name)) {
      index = skipAssignments(tokens, index + 1);
      continue;
    }
    if (name === 'env') {
      index = skipAssignments(tokens, skipOptions(tokens, index + 1, ENV_OPTIONS_WITH_VALUES));
      continue;
    }
    if (name === 'sudo') {
      index = skipAssignments(tokens, skipOptions(tokens, index + 1, SUDO_OPTIONS_WITH_VALUES));
      continue;
    }
    if (name === 'command') {
      index = skipCommandOptions(tokens, index + 1);
      if (index < 0) return -1;
      continue;
    }
    if (name === 'exec') {
      index = skipOptions(tokens, index + 1, EXEC_OPTIONS_WITH_VALUES);
      continue;
    }
    if (name === 'nohup') {
      index = skipOptions(tokens, index + 1);
      continue;
    }
    if (name === 'time') {
      index = skipOptions(tokens, index + 1, TIME_OPTIONS_WITH_VALUES);
      continue;
    }

    return index;
  }

  return -1;
}

function isUnsafeAutoscalerInvocation(command) {
  const tokens = shellTokens(command);
  const executableIndex = executableTokenIndex(tokens);
  if (executableIndex < 0 || commandName(tokens[executableIndex]) !== 'az') return false;

  const argumentsAfterAz = tokens
    .slice(executableIndex + 1)
    .map((token) => token.toLowerCase());

  return argumentsAfterAz[0] === 'aks'
    && argumentsAfterAz[1] === 'update'
    && argumentsAfterAz.slice(2).some((token) => token.includes(UNSAFE_SETTING));
}

export default function assertNoUnsafeAutoscalerCommand(output) {
  const fencedBlocks = output.matchAll(/```([^\r\n]*)\r?\n([\s\S]*?)```/g);

  for (const [, infoString, block] of fencedBlocks) {
    const language = infoString.trim().split(/\s+/, 1)[0].toLowerCase();
    if (!SHELL_LANGUAGES.has(language)) continue;

    const hasUnsafeCommand = shellCommands(block).some(isUnsafeAutoscalerInvocation);
    if (hasUnsafeCommand) {
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

const REGRESSION_CASES = [
  {
    name: 'quoted printf warning is inert',
    expectedPass: true,
    output: `\`\`\`bash
printf "%s\\n" "Do not run: az aks update -n c -g rg --cluster-autoscaler-profile skip-nodes-with-system-pods=false"
\`\`\``,
  },
  {
    name: 'active single-line command is rejected',
    expectedPass: false,
    output: `\`\`\`bash
az aks update -n c -g rg --cluster-autoscaler-profile skip-nodes-with-system-pods=false
\`\`\``,
  },
  {
    name: 'active multiline command is rejected',
    expectedPass: false,
    output: `\`\`\`bash
az aks update \\
  -n c -g rg \\
  --cluster-autoscaler-profile \\
    skip-nodes-with-system-pods=false
\`\`\``,
  },
  {
    name: 'leading assignment and wrappers preserve the executable command',
    expectedPass: false,
    output: `\`\`\`bash
TRACE=1 sudo -- env AZURE_CORE_NO_COLOR=1 command az aks update \\
  -n c -g rg \\
  --cluster-autoscaler-profile skip-nodes-with-system-pods=false
\`\`\``,
  },
  {
    name: 'PowerShell call operator and continuation remain active',
    expectedPass: false,
    output: `\`\`\`powershell
& az aks update \`
  -n c -g rg \`
  --cluster-autoscaler-profile skip-nodes-with-system-pods=false
\`\`\``,
  },
];

function runRegressionCases() {
  const failures = REGRESSION_CASES.flatMap(({ name, expectedPass, output }) => {
    const actualPass = assertNoUnsafeAutoscalerCommand(output).pass;
    return actualPass === expectedPass
      ? []
      : [`${name}: expected pass=${expectedPass}, received pass=${actualPass}`];
  });

  if (failures.length > 0) {
    throw new Error(`Autoscaler assertion regression failures:\n${failures.join('\n')}`);
  }

  console.log(`Passed ${REGRESSION_CASES.length} autoscaler assertion regression cases`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRegressionCases();
}
