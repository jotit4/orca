import {
  buildShellCommandFromArgv,
  commandSeparator,
  quoteStartupArg,
  type AgentStartupShell
} from './tui-agent-startup-shell'

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Claude Code holds a placeholder pane open with `cat` until `respawn-pane`
 * replaces it. PowerShell's `cat` is Get-Content, which blocks on a prompt for
 * its mandatory Path instead — alive, but showing the user a stray prompt that
 * would read a file if anything typed into it. Wait-Event blocks silently.
 */
const POWERSHELL_HOLDING_COMMAND = 'Wait-Event'

/**
 * True when Orca can express a teammate pane command in this shell. `cmd` is
 * excluded because its `set "NAME=value"` form cannot carry a `"`, `%` or `!`
 * safely, and a mis-quoted teammate launch is worse than the in-process fallback.
 *
 * On Windows only PowerShell qualifies. A `posix` family there means Git Bash
 * or WSL: the sh text Claude Code writes would parse, but the tmux.exe shim,
 * the Windows launcher path in ORCA_AGENT_TEAMS_SHIM_BIN and the PATH Orca
 * prepends are all native-Windows artifacts that neither shell can run, so the
 * team would come up paneless and fail late instead of degrading up front.
 */
export function supportsClaudeAgentTeamsPaneCommand(
  shell: AgentStartupShell,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') {
    return shell === 'powershell'
  }
  return shell !== 'cmd'
}

/** A pane command as the pane's own shell should read it; undefined when there is none. */
export function claudeAgentTeamsPaneCommand(
  command: string,
  shell: AgentStartupShell
): string | undefined {
  if (!command) {
    return undefined
  }
  return retargetClaudeAgentTeamsPaneCommand(command, shell) ?? command
}

/**
 * Re-spells a teammate pane command for the shell Orca types it into.
 *
 * Claude Code writes it for `/bin/sh` — real tmux runs pane commands through
 * `sh -c`, so `cd '<dir>' && env NAME=value <argv…>` is valid there. Orca hands
 * the text to the pane's own shell, where on Windows `env` is not a command and
 * `&&` does not chain a directory change.
 *
 * Returns null when the shell already speaks sh or the command is not that
 * shape, so callers keep the original text rather than guessing.
 */
export function retargetClaudeAgentTeamsPaneCommand(
  command: string,
  shell: AgentStartupShell
): string | null {
  if (shell !== 'powershell') {
    return null
  }
  const parsed = tokenizePosixPaneCommand(command)
  if (!parsed.ok) {
    return null
  }
  const tokens = parsed.tokens
  const isCdChain = tokens.length > 3 && tokens[0]!.value === 'cd' && tokens[2]!.value === '&&'
  // Why: `&&` after a `cd` is the one operator this rewrite models. Any other
  // diverging token — a bare operator, a substitution, a line continuation —
  // means sh would run something the rewrite does not express, and PowerShell
  // would read it differently again.
  if (tokens.some((token, index) => token.diverges && !(isCdChain && index === 2))) {
    return null
  }
  let directory: string | null = null
  if (isCdChain) {
    directory = tokens[1]!.value
    tokens.splice(0, 3)
  }
  const assignments: { name: string; value: string }[] = []
  if (tokens[0]?.value === 'env') {
    tokens.shift()
    while (tokens[0] !== undefined && ENV_ASSIGNMENT.test(tokens[0].value)) {
      const pair = tokens.shift()!.value
      const separator = pair.indexOf('=')
      assignments.push({ name: pair.slice(0, separator), value: pair.slice(separator + 1) })
    }
  }
  if (tokens.length === 0) {
    return null
  }
  const argv = tokens.map((token) => token.value)
  const body =
    argv.length === 1 && argv[0] === 'cat'
      ? POWERSHELL_HOLDING_COMMAND
      : powerShellNativeInvocation(argv)
  return [
    ...(directory === null ? [] : [`Set-Location ${quoteStartupArg(directory, shell)}`]),
    ...assignments.map((each) => `$env:${each.name} = ${quoteStartupArg(each.value, shell)}`),
    body
  ].join(commandSeparator(shell))
}

type PosixPaneToken = {
  value: string
  /** True when sh would do more than pass the bytes through: an operator, expansion, comment or continuation. */
  diverges: boolean
}

type PosixPaneTokens = { ok: true; tokens: PosixPaneToken[] } | { ok: false }

// Characters that make sh interpret an unquoted word instead of passing it through.
const POSIX_SPECIAL = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', ']', '{', '}', '#', '~', '\n'])

/**
 * Splits a `/bin/sh` command into words the way sh would, remembering per word
 * whether sh only ever saw its bytes inside quotes.
 *
 * Why not reuse the shared startup tokenizer: once tokenized, a quoted `|`
 * inside an argument and a bare pipe operator are the same string. Only the
 * quoting context tells them apart, and rejecting on the token VALUE would
 * refuse a perfectly ordinary `--prompt 'a|b'`. Keeping the tokenizer here also
 * keeps this rewrite independent of upstream churn in the shared one.
 */
export function tokenizePosixPaneCommand(command: string): PosixPaneTokens {
  const tokens: PosixPaneToken[] = []
  let value = ''
  let diverges = false
  let started = false
  let quote: "'" | '"' | null = null
  const flush = (): void => {
    if (started) {
      tokens.push({ value, diverges })
    }
    value = ''
    diverges = false
    started = false
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote === "'") {
      if (char === "'") {
        quote = null
      } else {
        value += char
      }
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === '\\' && index + 1 < command.length && '\\"$`'.includes(command[index + 1]!)) {
        value += command[index + 1]
        index += 1
      } else {
        // Why: `$` and backticks still expand inside double quotes.
        if (char === '$' || char === '`') {
          diverges = true
        }
        value += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === '\\') {
      if (index + 1 >= command.length) {
        // Why: a trailing backslash is a line continuation sh would wait on.
        diverges = true
        started = true
        continue
      }
      const escaped = command[index + 1]!
      if (escaped === '\n') {
        // Why: an escaped newline joins lines; treat it as whitespace.
        index += 1
        flush()
        continue
      }
      value += escaped
      started = true
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      flush()
      continue
    }
    if (POSIX_SPECIAL.has(char)) {
      diverges = true
    }
    // Why: `=` in the first word is an assignment, and `~` only expands at the start of a word.
    if (char === '=' && !started && tokens.length === 0) {
      diverges = true
    }
    value += char
    started = true
  }
  if (quote !== null) {
    return { ok: false }
  }
  flush()
  return { ok: true, tokens }
}

/**
 * `& '<exe>' --% <args>`: the stop-parsing token hands the rest of the line to
 * the executable verbatim, so the only quoting that matters is the one
 * CommandLineToArgvW applies in the child.
 *
 * Why not `& '<exe>' '<arg>' '<arg>'`: PowerShell re-quotes native arguments
 * itself, and Windows PowerShell 5.1 (the `powershell.exe` default) mangles any
 * argument carrying a `"` — it wraps the argument in quotes without escaping the
 * inner ones, so the child sees it split. PowerShell 7 fixed this behind
 * PSNativeCommandArgumentPassing, but the notebook default is still 5.1.
 *
 * `--%` has two blind spots, both handled: PowerShell still expands `%NAME%`
 * after it, and the token cannot span a line, so arguments carrying `%` or a
 * newline take the PowerShell-quoted form instead.
 */
function powerShellNativeInvocation(argv: string[]): string {
  const [executable, ...args] = argv
  const callee = `& ${quoteStartupArg(executable!, 'powershell')}`
  if (args.length === 0) {
    return callee
  }
  if (args.every(canFollowStopParsingToken)) {
    return `${callee} --% ${args.map(quoteWindowsCommandLineArg).join(' ')}`
  }
  return buildShellCommandFromArgv(argv, 'powershell')
}

function canFollowStopParsingToken(arg: string): boolean {
  return !/[%\r\n]/.test(arg)
}

/**
 * Quotes one argument for a Windows command line the way CommandLineToArgvW
 * (and every CRT / libuv parser) reads it back: `"` becomes `\"`, backslashes
 * only need doubling when they precede a `"` or close the quoted span.
 *
 * Also quotes cmd.exe metacharacters (`& | < > ^ ( )`): when the executable is
 * a `.cmd` shim (Claude Code installed through npm), cmd.exe reads the line
 * before the child does, and it treats those literally only inside `"…"`.
 */
export function quoteWindowsCommandLineArg(value: string): string {
  if (value.length > 0 && !/[\s"&|<>^()]/.test(value)) {
    return value
  }
  let quoted = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    quoted +=
      character === '"'
        ? `${'\\'.repeat(backslashes * 2 + 1)}"`
        : `${'\\'.repeat(backslashes)}${character}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}
