import { commandSeparator, quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

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
 * `& '<exe>' '<arg>' …`, spelled twice: PowerShell's own native-argument
 * quoting is the only channel that is honoured the same way whether the
 * command reaches the shell by `-EncodedCommand` or typed input, but WHAT it
 * does to an argument depends on the version:
 *
 * - 7.3+ (`$PSNativeCommandArgumentPassing`): with `Standard` the shell escapes
 *   `"` and backslashes for CommandLineToArgvW itself, so the true values are
 *   passed as-is.
 * - 5.1 / 7.0–7.2 (legacy): the shell wraps an argument in `"…"` only when it
 *   carries whitespace and never escapes an inner `"`, so the values are
 *   pre-escaped here (`legacyPowerShellNativeArg`) to land intact.
 *
 * Why not `--%`: on 7.3+ the text after the stop-parsing token is split on
 * whitespace and every piece is re-quoted (observed on a real host: `"say`,
 * `\"hi\"`, `|` arrived as four arguments), so no single spelling survives
 * both versions. The branch is decided by the shell that runs it.
 */
function powerShellNativeInvocation(argv: string[]): string {
  const [executable, ...args] = argv
  const callee = `& ${quoteStartupArg(executable!, 'powershell')}`
  if (args.length === 0) {
    return callee
  }
  const modern = [callee, ...args.map((arg) => quoteStartupArg(arg, 'powershell'))].join(' ')
  const legacy = [
    callee,
    ...args.map((arg) => quoteStartupArg(legacyPowerShellNativeArg(arg), 'powershell'))
  ].join(' ')
  return `if (${MODERN_ARGUMENT_PASSING_TEST}) { $PSNativeCommandArgumentPassing = 'Standard'; ${modern} } else { ${legacy} }`
}

/** True in the PowerShell that runs it when native-argument passing is version 7.3 or later semantics. */
export const MODERN_ARGUMENT_PASSING_TEST =
  "[version]($PSVersionTable.PSVersion.ToString().Split('-')[0]) -ge [version]'7.3.0'"

/**
 * Pre-escapes one argument for legacy PowerShell native-argument passing so
 * that CommandLineToArgvW in the child reads the original value back.
 *
 * Legacy passing wraps the argument in `"…"` iff it contains whitespace (or is
 * empty) and otherwise emits it verbatim; in both cases an inner `"` must be
 * escaped as `\"` (backslashes before it doubled), and a trailing backslash run
 * needs doubling only when the shell will add the closing quote after it.
 */
export function legacyPowerShellNativeArg(value: string): string {
  const shellWillQuote = value.length === 0 || /\s/.test(value)
  let escaped = ''
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    escaped +=
      character === '"'
        ? `${'\\'.repeat(backslashes * 2 + 1)}"`
        : `${'\\'.repeat(backslashes)}${character}`
    backslashes = 0
  }
  return `${escaped}${'\\'.repeat(shellWillQuote ? backslashes * 2 : backslashes)}`
}
