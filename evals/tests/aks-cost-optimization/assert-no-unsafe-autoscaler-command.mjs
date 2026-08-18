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
const POWERSHELL_LANGUAGES = new Set(['powershell', 'pwsh']);
const UNSAFE_SETTING = 'skip-nodes-with-system-pods=false';
const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEREDOC_ESCAPABLE_CHARACTERS = new Set(['$', '`', '\\', '\n']);
const CONTROL_PREFIXES = new Set(['!', 'do', 'elif', 'else', 'if', 'then', 'until', 'while']);
const AZ_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  '-o',
  '--output',
  '--query',
  '--subscription',
]);
const AZ_GLOBAL_FLAGS = new Set([
  '-h',
  '--debug',
  '--help',
  '--only-show-errors',
  '--verbose',
  '--version',
]);
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

function isPowerShell(language) {
  return POWERSHELL_LANGUAGES.has(language);
}

function stripPowerShellBlockComments(source) {
  let result = '';
  let quote = null;
  let escaped = false;
  let commentDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (commentDepth > 0) {
      if (character === '<' && next === '#') {
        commentDepth += 1;
        result += '  ';
        index += 1;
      } else if (character === '#' && next === '>') {
        commentDepth -= 1;
        result += '  ';
        index += 1;
      } else {
        result += character === '\n' || character === '\r' ? character : ' ';
      }
      continue;
    }
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '`' && quote !== "'") {
      result += character;
      escaped = true;
      continue;
    }
    if (quote) {
      result += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
      continue;
    }
    if (character === '<' && next === '#') {
      commentDepth = 1;
      result += '  ';
      index += 1;
      continue;
    }
    result += character;
  }

  return result;
}

function bashHeredocs(line) {
  const heredocs = [];
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];

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
    if (character === '#' && (index === 0 || /[\s;&|(){}]/.test(line[index - 1]))) {
      break;
    }
    if (character !== '<' || next !== '<' || line[index + 2] === '<') continue;

    let cursor = index + 2;
    const allowTabs = line[cursor] === '-';
    if (allowTabs) cursor += 1;
    while (cursor < line.length && /[ \t]/.test(line[cursor])) cursor += 1;

    let delimiter = '';
    let delimiterQuote = null;
    let delimiterEscaped = false;
    let delimiterQuoted = false;

    for (; cursor < line.length; cursor += 1) {
      const delimiterCharacter = line[cursor];

      if (delimiterEscaped) {
        delimiter += delimiterCharacter;
        delimiterEscaped = false;
        continue;
      }
      if (delimiterCharacter === '\\' && delimiterQuote !== "'") {
        delimiterEscaped = true;
        delimiterQuoted = true;
        continue;
      }
      if (delimiterQuote) {
        if (delimiterCharacter === delimiterQuote) {
          delimiterQuote = null;
        } else {
          delimiter += delimiterCharacter;
        }
        continue;
      }
      if (delimiterCharacter === "'" || delimiterCharacter === '"') {
        delimiterQuote = delimiterCharacter;
        delimiterQuoted = true;
        continue;
      }
      if (/[\s;&|(){}<>]/.test(delimiterCharacter)) break;
      delimiter += delimiterCharacter;
    }

    if (delimiter) heredocs.push({
      delimiter,
      allowTabs,
      expands: !delimiterQuoted,
    });
    index = cursor - 1;
  }

  return heredocs;
}

function stripBashHeredocBodies(source) {
  const pending = [];

  return source
    .split(/\r?\n/)
    .map((line) => {
      if (pending.length > 0) {
        const { delimiter, allowTabs, expands } = pending[0];
        const candidate = allowTabs ? line.replace(/^\t+/, '') : line;
        if (candidate === delimiter) pending.shift();
        if (candidate === delimiter || !expands) return '';

        return heredocCommandSubstitutionBodies(line)
          .map((body) => `$(${body})`)
          .join(' ');
      }

      pending.push(...bashHeredocs(line));
      return line;
    })
    .join('\n');
}

function heredocCommandSubstitutionBodies(source) {
  const bodies = [];

  // Quotes are literal in an expanding heredoc; only Bash's four backslash escapes suppress expansion.
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '\\' && HEREDOC_ESCAPABLE_CHARACTERS.has(next)) {
      index += 1;
      continue;
    }
    if (character === '$' && next === '(') {
      const closeIndex = findClosingParenthesis(source, index + 1, 'bash');
      if (closeIndex >= 0) {
        bodies.push(source.slice(index + 2, closeIndex));
        index = closeIndex;
      }
      continue;
    }
    if (character === '`') {
      let closeIndex = index + 1;

      for (; closeIndex < source.length; closeIndex += 1) {
        const backtickCharacter = source[closeIndex];
        const afterBackslash = source[closeIndex + 1];

        if (backtickCharacter === '\\'
          && HEREDOC_ESCAPABLE_CHARACTERS.has(afterBackslash)) {
          closeIndex += 1;
        } else if (backtickCharacter === '`') {
          break;
        }
      }

      if (closeIndex < source.length) {
        bodies.push(source.slice(index + 1, closeIndex));
        index = closeIndex;
      }
    }
  }

  return bodies;
}

function stripShellComment(line, language) {
  const powershell = isPowerShell(language);
  const escapeCharacter = powershell ? '`' : '\\';
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === escapeCharacter && quote !== "'") {
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
    if (character === '#'
      && (powershell || index === 0 || /[\s;&|(){}]/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }

  return line;
}

function splitShellCommands(source, language) {
  const commands = [];
  const escapeCharacter = isPowerShell(language) ? '`' : '\\';
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
    if (character === escapeCharacter && quote !== "'") {
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
    if (character === '\n' || character === ';' || character === '&' || character === '|'
      || character === '(' || character === ')' || character === '{' || character === '}') {
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

function findClosingParenthesis(source, openIndex, language) {
  const escapeCharacter = isPowerShell(language) ? '`' : '\\';
  const restoreQuotes = [null];
  let quote = null;
  let escaped = false;

  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === escapeCharacter && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (character === '$' && next === '(') {
      restoreQuotes.push(quote);
      quote = null;
      index += 1;
      continue;
    }
    if (quote) continue;
    if (!isPowerShell(language) && character === '`') {
      let closeIndex = index + 1;
      let backtickEscaped = false;

      for (; closeIndex < source.length; closeIndex += 1) {
        const backtickCharacter = source[closeIndex];
        if (backtickEscaped) {
          backtickEscaped = false;
        } else if (backtickCharacter === '\\') {
          backtickEscaped = true;
        } else if (backtickCharacter === '`') {
          break;
        }
      }

      index = closeIndex;
      continue;
    }
    if (character === '(') {
      restoreQuotes.push(null);
    } else if (character === ')') {
      const restoreQuote = restoreQuotes.pop();
      if (restoreQuotes.length === 0) return index;
      quote = restoreQuote;
    }
  }

  return -1;
}

function commandSubstitutionBodies(source, language) {
  const bodies = [];
  const powershell = isPowerShell(language);
  const escapeCharacter = powershell ? '`' : '\\';
  let quote = null;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === escapeCharacter && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (character === '$' && next === '(') {
      const closeIndex = findClosingParenthesis(source, index + 1, language);
      if (closeIndex >= 0) {
        bodies.push(source.slice(index + 2, closeIndex));
        index = closeIndex;
      }
      continue;
    }
    if (!powershell && character === '`') {
      let closeIndex = index + 1;
      let backtickEscaped = false;

      for (; closeIndex < source.length; closeIndex += 1) {
        const backtickCharacter = source[closeIndex];
        if (backtickEscaped) {
          backtickEscaped = false;
        } else if (backtickCharacter === '\\') {
          backtickEscaped = true;
        } else if (backtickCharacter === '`') {
          break;
        }
      }

      if (closeIndex < source.length) {
        bodies.push(source.slice(index + 1, closeIndex));
        index = closeIndex;
      }
    }
  }

  return bodies;
}

function shellCommands(block, language) {
  const powershell = isPowerShell(language);
  const withoutInertBodies = powershell
    ? stripPowerShellBlockComments(block)
    : stripBashHeredocBodies(block);
  const uncommented = withoutInertBodies
    .split(/\r?\n/)
    .map((line) => stripShellComment(line, language))
    .join('\n')
    .replace(powershell ? /`\s*\n/g : /\\\s*\n/g, ' ');
  const commands = new Set();

  const collect = (source) => {
    splitShellCommands(source, language).forEach((command) => commands.add(command));
    commandSubstitutionBodies(source, language).forEach(collect);
  };

  collect(uncommented);
  return [...commands];
}

function shellTokens(command, language) {
  const tokens = [];
  const escapeCharacter = isPowerShell(language) ? '`' : '\\';
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
    if (character === escapeCharacter && quote !== "'") {
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

  if (escaped) token += escapeCharacter;
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

function skipRedirections(tokens, start) {
  let index = start;

  while (index < tokens.length) {
    const token = tokens[index];
    const operator = token.match(/^\d*(?:&>>?|>>?|<<?|<>|>&|<&)/)?.[0];
    if (!operator) return index;

    index += 1;
    if (token === operator && index < tokens.length) index += 1;
  }

  return index;
}

function skipCommandPrefixes(tokens, start) {
  let index = start;
  let previous = -1;

  while (index !== previous) {
    previous = index;
    index = skipAssignments(tokens, index);
    index = skipRedirections(tokens, index);
  }

  return index;
}

function executableTokenIndex(tokens) {
  let index = skipCommandPrefixes(tokens, 0);

  while (index < tokens.length) {
    const name = commandName(tokens[index]);

    if (CONTROL_PREFIXES.has(name)) {
      index = skipCommandPrefixes(tokens, index + 1);
      continue;
    }
    if (name === 'env') {
      index = skipCommandPrefixes(
        tokens,
        skipOptions(tokens, index + 1, ENV_OPTIONS_WITH_VALUES),
      );
      continue;
    }
    if (name === 'sudo') {
      index = skipCommandPrefixes(
        tokens,
        skipOptions(tokens, index + 1, SUDO_OPTIONS_WITH_VALUES),
      );
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

function azureCommandPath(tokens, start) {
  const path = [];
  let index = start;

  while (index < tokens.length && path.length < 2) {
    const token = tokens[index].toLowerCase();
    const option = token.split('=', 1)[0];

    if (token === '--') {
      index += 1;
      continue;
    }
    if (AZ_GLOBAL_FLAGS.has(option)) {
      index += 1;
      continue;
    }
    if (AZ_GLOBAL_OPTIONS_WITH_VALUES.has(option)) {
      index += token.includes('=') ? 1 : 2;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }

    path.push(token);
    index += 1;
  }

  return { path, argumentsStart: index };
}

function isUnsafeAutoscalerInvocation(command, language) {
  const tokens = shellTokens(command, language);
  const executableIndex = executableTokenIndex(tokens);
  if (executableIndex < 0 || commandName(tokens[executableIndex]) !== 'az') return false;

  const { path, argumentsStart } = azureCommandPath(tokens, executableIndex + 1);

  return path[0] === 'aks'
    && path[1] === 'update'
    && tokens
      .slice(argumentsStart)
      .some((token) => token.toLowerCase().includes(UNSAFE_SETTING));
}

export default function assertNoUnsafeAutoscalerCommand(output) {
  const fencedBlocks = output.matchAll(/```([^\r\n]*)\r?\n([\s\S]*?)```/g);

  for (const [, infoString, block] of fencedBlocks) {
    const language = infoString.trim().split(/\s+/, 1)[0].toLowerCase();
    if (!SHELL_LANGUAGES.has(language)) continue;

    const hasUnsafeCommand = shellCommands(block, language).some(
      (command) => isUnsafeAutoscalerInvocation(command, language),
    );
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

const UNSAFE_ARGUMENTS = `aks update -n c -g rg \
--cluster-autoscaler-profile ${UNSAFE_SETTING}`;
const UNSAFE_COMMAND = `az ${UNSAFE_ARGUMENTS}`;

function fenced(source, language = 'bash') {
  return `\`\`\`${language}\n${source}\n\`\`\``;
}

const REGRESSION_CASES = [
  {
    name: 'quoted printf warning is inert',
    expectedPass: true,
    output: fenced(`printf "%s\\n" "Do not run: ${UNSAFE_COMMAND}"`),
  },
  {
    name: 'quoted echo warning is inert',
    expectedPass: true,
    output: fenced(`echo '${UNSAFE_COMMAND}'`),
  },
  {
    name: 'assignment-only warning is inert',
    expectedPass: true,
    output: fenced(`warning="${UNSAFE_COMMAND}"`),
  },
  {
    name: 'escaped command substitution text is inert',
    expectedPass: true,
    output: fenced(`printf "%s\\n" "\\$(${UNSAFE_COMMAND})"`),
  },
  {
    name: 'Bash line comment is inert',
    expectedPass: true,
    output: fenced(`# ${UNSAFE_COMMAND}`),
  },
  {
    name: 'quoted Bash heredoc body is inert',
    expectedPass: true,
    output: fenced(`cat <<'EOF'\n${UNSAFE_COMMAND}\nEOF`),
  },
  {
    name: 'unquoted Bash heredoc literal command is inert',
    expectedPass: true,
    output: fenced(`cat <<EOF\n${UNSAFE_COMMAND}\nEOF`),
  },
  {
    name: 'backslash suppresses dollar substitution in expanding heredoc',
    expectedPass: true,
    output: fenced(`cat <<EOF\n'\\$(${UNSAFE_COMMAND})'\nEOF`),
  },
  {
    name: 'backslash suppresses legacy backticks in expanding heredoc',
    expectedPass: true,
    output: fenced(`cat <<EOF\n'\\\`${UNSAFE_COMMAND}\\\`'\nEOF`),
  },
  {
    name: 'PowerShell block comment is inert',
    expectedPass: true,
    output: fenced(`<#\n${UNSAFE_COMMAND}\n#>`, 'powershell'),
  },
  {
    name: 'PowerShell line comment is inert',
    expectedPass: true,
    output: fenced(`# ${UNSAFE_COMMAND}`, 'powershell'),
  },
  {
    name: 'PowerShell warning string is inert',
    expectedPass: true,
    output: fenced(`Write-Warning "Do not run: ${UNSAFE_COMMAND}"`, 'powershell'),
  },
  {
    name: 'single-quoted PowerShell subexpression text is inert',
    expectedPass: true,
    output: fenced(`Write-Output '$(& ${UNSAFE_COMMAND})'`, 'powershell'),
  },
  {
    name: 'command lookup does not execute az',
    expectedPass: true,
    output: fenced(`command -v ${UNSAFE_COMMAND}`),
  },
  {
    name: 'non-shell fence is inert',
    expectedPass: true,
    output: fenced(UNSAFE_COMMAND, 'text'),
  },
  {
    name: 'safe autoscaler command passes',
    expectedPass: true,
    output: fenced(
      'az aks update -n c -g rg --cluster-autoscaler-profile scale-down-unneeded-time=5m',
    ),
  },
  {
    name: 'active single-line command is rejected',
    expectedPass: false,
    output: fenced(UNSAFE_COMMAND),
  },
  {
    name: 'active multiline Bash command is rejected',
    expectedPass: false,
    output: fenced(`az aks update \\
  -n c -g rg \\
  --cluster-autoscaler-profile \\
    ${UNSAFE_SETTING}`),
  },
  {
    name: 'leading assignment preserves the executable command',
    expectedPass: false,
    output: fenced(`TRACE=1 ${UNSAFE_COMMAND}`),
  },
  {
    name: 'env wrapper preserves the executable command',
    expectedPass: false,
    output: fenced(`env AZURE_CORE_NO_COLOR=1 ${UNSAFE_COMMAND}`),
  },
  {
    name: 'sudo wrapper preserves the executable command',
    expectedPass: false,
    output: fenced(`sudo -E -- ${UNSAFE_COMMAND}`),
  },
  {
    name: 'command wrapper preserves the executable command',
    expectedPass: false,
    output: fenced(`command -- ${UNSAFE_COMMAND}`),
  },
  {
    name: 'exec wrapper preserves the executable command',
    expectedPass: false,
    output: fenced(`exec -- ${UNSAFE_COMMAND}`),
  },
  {
    name: 'nohup wrapper preserves the executable command',
    expectedPass: false,
    output: fenced(`nohup ${UNSAFE_COMMAND}`),
  },
  {
    name: 'time wrapper preserves the executable command',
    expectedPass: false,
    output: fenced(`time -p ${UNSAFE_COMMAND}`),
  },
  {
    name: 'semicolon-separated command is rejected',
    expectedPass: false,
    output: fenced(`printf done; ${UNSAFE_COMMAND}`),
  },
  {
    name: 'AND-separated command is rejected',
    expectedPass: false,
    output: fenced(`true && ${UNSAFE_COMMAND}`),
  },
  {
    name: 'OR-separated command is rejected',
    expectedPass: false,
    output: fenced(`false || ${UNSAFE_COMMAND}`),
  },
  {
    name: 'unsafe command on pipeline left is rejected',
    expectedPass: false,
    output: fenced(`${UNSAFE_COMMAND} | cat`),
  },
  {
    name: 'unsafe command on pipeline right is rejected',
    expectedPass: false,
    output: fenced(`printf x | ${UNSAFE_COMMAND}`),
  },
  {
    name: 'quoted Bash executable is rejected',
    expectedPass: false,
    output: fenced(`"az" ${UNSAFE_ARGUMENTS}`),
  },
  {
    name: 'concatenated Bash executable is rejected',
    expectedPass: false,
    output: fenced(`a"z" ${UNSAFE_ARGUMENTS}`),
  },
  {
    name: 'escaped Bash executable is rejected',
    expectedPass: false,
    output: fenced(`a\\z ${UNSAFE_ARGUMENTS}`),
  },
  {
    name: 'Bash subshell command is rejected',
    expectedPass: false,
    output: fenced(`(${UNSAFE_COMMAND})`),
  },
  {
    name: 'Bash brace group command is rejected',
    expectedPass: false,
    output: fenced(`{ ${UNSAFE_COMMAND}; }`),
  },
  {
    name: 'Bash assignment substitution is rejected',
    expectedPass: false,
    output: fenced(`result=$(${UNSAFE_COMMAND})`),
  },
  {
    name: 'quoted Bash assignment substitution is rejected',
    expectedPass: false,
    output: fenced(`result="$(${UNSAFE_COMMAND})"`),
  },
  {
    name: 'nested Bash command substitution is rejected',
    expectedPass: false,
    output: fenced(`printf "%s\\n" "$(printf prefix; ${UNSAFE_COMMAND})"`),
  },
  {
    name: 'legacy Bash backtick substitution is rejected',
    expectedPass: false,
    output: fenced(`result=\`${UNSAFE_COMMAND}\``),
  },
  {
    name: 'command substitution in expanding heredoc is rejected',
    expectedPass: false,
    output: fenced(`cat <<EOF\nresult=$(${UNSAFE_COMMAND})\nEOF`),
  },
  {
    name: 'single quotes do not suppress substitution in expanding heredoc',
    expectedPass: false,
    output: fenced(`cat <<EOF\n'$(${UNSAFE_COMMAND})'\nEOF`),
  },
  {
    name: 'quotes do not suppress legacy backticks in expanding heredoc',
    expectedPass: false,
    output: fenced(`cat <<EOF\n'\`${UNSAFE_COMMAND}\`'\nEOF`),
  },
  {
    name: 'escaped backslash leaves heredoc substitution active',
    expectedPass: false,
    output: fenced(`cat <<EOF\n'\\\\$(${UNSAFE_COMMAND})'\nEOF`),
  },
  {
    name: 'escaped newline leaves heredoc substitution active',
    expectedPass: false,
    output: fenced(`cat <<EOF\n'\\
$(${UNSAFE_COMMAND})'\nEOF`),
  },
  {
    name: 'unsafe command after heredoc delimiter is rejected',
    expectedPass: false,
    output: fenced(`cat <<EOF\n${UNSAFE_COMMAND}\nEOF\n${UNSAFE_COMMAND}`),
  },
  {
    name: 'Azure CLI global debug option preserves command path',
    expectedPass: false,
    output: fenced(`az --debug ${UNSAFE_ARGUMENTS}`),
  },
  {
    name: 'Azure CLI valued global option preserves command path',
    expectedPass: false,
    output: fenced(`az --output json ${UNSAFE_ARGUMENTS}`),
  },
  {
    name: 'PowerShell call operator and continuation remain active',
    expectedPass: false,
    output: fenced(`& az aks update \`
  -n c -g rg \`
  --cluster-autoscaler-profile ${UNSAFE_SETTING}`, 'powershell'),
  },
  {
    name: 'escaped PowerShell executable is rejected',
    expectedPass: false,
    output: fenced(`a\`z ${UNSAFE_ARGUMENTS}`, 'powershell'),
  },
  {
    name: 'escaped PowerShell command path is rejected',
    expectedPass: false,
    output: fenced(`a\`z a\`ks up\`date -n c -g rg \
--cluster-autoscaler-profile ${UNSAFE_SETTING}`, 'pwsh'),
  },
  {
    name: 'PowerShell subexpression is rejected',
    expectedPass: false,
    output: fenced(`$result = "$(& a\`z ${UNSAFE_ARGUMENTS})"`, 'powershell'),
  },
  {
    name: 'case-insensitive PowerShell command is rejected',
    expectedPass: false,
    output: fenced(UNSAFE_COMMAND.toUpperCase(), 'powershell'),
  },
  {
    name: 'PowerShell command after block comment is rejected',
    expectedPass: false,
    output: fenced(`<# ${UNSAFE_COMMAND} #>\n${UNSAFE_COMMAND}`, 'powershell'),
  },
  {
    name: 'active command before Bash comment is rejected',
    expectedPass: false,
    output: fenced(`${UNSAFE_COMMAND} # keep this unsafe setting disabled`),
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
