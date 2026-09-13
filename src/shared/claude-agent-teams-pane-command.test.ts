import { describe, expect, it } from 'vitest'
import {
  MODERN_ARGUMENT_PASSING_TEST,
  legacyPowerShellNativeArg,
  retargetClaudeAgentTeamsPaneCommand,
  supportsClaudeAgentTeamsPaneCommand,
  tokenizePosixPaneCommand
} from './claude-agent-teams-pane-command'

const q = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** The two-branch native call the rewrite emits for `exe` with `args`. */
function nativeCall(exe: string, args: string[]): string {
  const modern = [`& ${q(exe)}`, ...args.map(q)].join(' ')
  const legacy = [`& ${q(exe)}`, ...args.map((arg) => q(legacyPowerShellNativeArg(arg)))].join(' ')
  const standard = "$PSNativeCommandArgumentPassing = 'Standard'"
  return `if (${MODERN_ARGUMENT_PASSING_TEST}) { ${standard}; ${modern} } else { ${legacy} }`
}

// Verbatim from Claude Code 2.1.238's tmux backend, minus the session ids.
const TEAMMATE_COMMAND =
  "cd 'E:\\Repos\\demo' && env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 " +
  "'C:\\Users\\dev\\.local\\bin\\claude.exe' --agent-name Nova --agent-color blue --model opus"

describe('retargetClaudeAgentTeamsPaneCommand', () => {
  it('re-spells the teammate launch for PowerShell', () => {
    const call = nativeCall('C:\\Users\\dev\\.local\\bin\\claude.exe', [
      '--agent-name',
      'Nova',
      '--agent-color',
      'blue',
      '--model',
      'opus'
    ])
    expect(retargetClaudeAgentTeamsPaneCommand(TEAMMATE_COMMAND, 'powershell')).toBe(
      `Set-Location 'E:\\Repos\\demo'; $env:CLAUDECODE = '1'; $env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'; ${call}`
    )
  })

  it('leaves sh-speaking panes alone', () => {
    expect(retargetClaudeAgentTeamsPaneCommand(TEAMMATE_COMMAND, 'posix')).toBeNull()
  })

  it('declines cmd rather than emitting quoting it cannot carry', () => {
    expect(supportsClaudeAgentTeamsPaneCommand('cmd', 'linux')).toBe(false)
    expect(retargetClaudeAgentTeamsPaneCommand(TEAMMATE_COMMAND, 'cmd')).toBeNull()
    expect(supportsClaudeAgentTeamsPaneCommand('powershell', 'linux')).toBe(true)
    expect(supportsClaudeAgentTeamsPaneCommand('posix', 'linux')).toBe(true)
  })

  it('only trusts PowerShell panes on Windows', () => {
    expect(supportsClaudeAgentTeamsPaneCommand('powershell', 'win32')).toBe(true)
    // Why: Git Bash / WSL panes cannot run the native shim or launcher path.
    expect(supportsClaudeAgentTeamsPaneCommand('posix', 'win32')).toBe(false)
    expect(supportsClaudeAgentTeamsPaneCommand('cmd', 'win32')).toBe(false)
  })

  it('keeps the holding pane blocking instead of prompting for a Get-Content path', () => {
    expect(retargetClaudeAgentTeamsPaneCommand('cat', 'powershell')).toBe('Wait-Event')
  })

  it('handles a bare command with neither prefix', () => {
    expect(retargetClaudeAgentTeamsPaneCommand('sleep 1', 'powershell')).toBe(nativeCall('sleep', ['1']))
  })

  it('keeps the cd prefix optional', () => {
    expect(retargetClaudeAgentTeamsPaneCommand('env A=1 claude', 'powershell')).toBe(
      "$env:A = '1'; & 'claude'"
    )
  })

  it('doubles apostrophes in values it interpolates', () => {
    expect(
      retargetClaudeAgentTeamsPaneCommand("cd '/it'\"'\"'s here' && claude", 'powershell')
    ).toBe("Set-Location '/it''s here'; & 'claude'")
  })

  it('keeps operator characters that sh only ever saw inside quotes', () => {
    expect(
      retargetClaudeAgentTeamsPaneCommand(
        "cd '/repo' && env A='x|y' claude --prompt 'a|b' --filter 'c;d' --to '>e'",
        'powershell'
      )
    ).toBe(
      `Set-Location '/repo'; $env:A = 'x|y'; ${nativeCall('claude', ['--prompt', 'a|b', '--filter', 'c;d', '--to', '>e'])}`
    )
  })

  it('declines a substitution the rewrite would flatten into a literal', () => {
    expect(
      retargetClaudeAgentTeamsPaneCommand("cd '/repo' && claude $(id -un)", 'powershell')
    ).toBeNull()
  })

  it('declines a command carrying an operator it does not model', () => {
    expect(
      retargetClaudeAgentTeamsPaneCommand("cd '/repo' && claude | tee log", 'powershell')
    ).toBeNull()
  })

  it('declines an unbalanced quote instead of guessing', () => {
    expect(retargetClaudeAgentTeamsPaneCommand("cd '/repo", 'powershell')).toBeNull()
  })

  it('keeps quotes and trailing backslashes intact through both PowerShell generations', () => {
    expect(
      retargetClaudeAgentTeamsPaneCommand(
        "cd '/repo' && claude --agent-name 'say \"hi\"' --dir 'C:\\a b\\'",
        'powershell'
      )
    ).toBe(
      `Set-Location '/repo'; ${nativeCall('claude', ['--agent-name', 'say "hi"', '--dir', 'C:\\a b\\'])}`
    )
  })
})

describe('legacyPowerShellNativeArg', () => {
  it('leaves plain arguments alone', () => {
    expect(legacyPowerShellNativeArg('--agent-name')).toBe('--agent-name')
    expect(legacyPowerShellNativeArg('C:\\Users\\dev\\claude.exe')).toBe('C:\\Users\\dev\\claude.exe')
  })

  it('escapes inner quotes whether or not the shell will wrap the argument', () => {
    // Why: legacy passing wraps only on whitespace; the inner quote needs escaping either way.
    expect(legacyPowerShellNativeArg('say "hi"')).toBe('say \\"hi\\"')
    expect(legacyPowerShellNativeArg('a"b')).toBe('a\\"b')
    expect(legacyPowerShellNativeArg('x\\\\"y')).toBe('x\\\\\\\\\\"y')
  })

  it('doubles a trailing backslash run only when the shell adds a closing quote', () => {
    expect(legacyPowerShellNativeArg('C:\\a b\\')).toBe('C:\\a b\\\\')
    expect(legacyPowerShellNativeArg('C:\\ab\\')).toBe('C:\\ab\\')
    expect(legacyPowerShellNativeArg('')).toBe('')
  })
})

describe('tokenizePosixPaneCommand', () => {
  it('records which words sh would interpret', () => {
    const parsed = tokenizePosixPaneCommand("cd '/r' && env A='x|y' claude 'a|b' $HOME")
    expect(parsed.ok && parsed.tokens.map((each) => [each.value, each.diverges])).toEqual([
      ['cd', false],
      ['/r', false],
      ['&&', true],
      ['env', false],
      ['A=x|y', false],
      ['claude', false],
      ['a|b', false],
      ['$HOME', true]
    ])
  })

  it('handles double quotes, escapes and continuations like sh', () => {
    const parsed = tokenizePosixPaneCommand('claude "it\\"s" a\\ b "$X" \\\ntail')
    expect(parsed.ok && parsed.tokens.map((each) => [each.value, each.diverges])).toEqual([
      ['claude', false],
      ['it"s', false],
      ['a b', false],
      ['$X', true],
      ['tail', false]
    ])
    expect(tokenizePosixPaneCommand("claude 'open").ok).toBe(false)
    expect(tokenizePosixPaneCommand('claude "open').ok).toBe(false)
  })
})
