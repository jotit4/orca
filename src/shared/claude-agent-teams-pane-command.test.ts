import { describe, expect, it } from 'vitest'
import {
  quoteWindowsCommandLineArg,
  retargetClaudeAgentTeamsPaneCommand,
  supportsClaudeAgentTeamsPaneCommand,
  tokenizePosixPaneCommand
} from './claude-agent-teams-pane-command'

// Verbatim from Claude Code 2.1.238's tmux backend, minus the session ids.
const TEAMMATE_COMMAND =
  "cd 'E:\\Repos\\demo' && env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 " +
  "'C:\\Users\\dev\\.local\\bin\\claude.exe' --agent-name Nova --agent-color blue --model opus"

describe('retargetClaudeAgentTeamsPaneCommand', () => {
  it('re-spells the teammate launch for PowerShell', () => {
    expect(retargetClaudeAgentTeamsPaneCommand(TEAMMATE_COMMAND, 'powershell')).toBe(
      "Set-Location 'E:\\Repos\\demo'; " +
        "$env:CLAUDECODE = '1'; " +
        "$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'; " +
        "& 'C:\\Users\\dev\\.local\\bin\\claude.exe' --% --agent-name Nova " +
        '--agent-color blue --model opus'
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
    expect(retargetClaudeAgentTeamsPaneCommand('sleep 1', 'powershell')).toBe("& 'sleep' --% 1")
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
      "Set-Location '/repo'; $env:A = 'x|y'; " +
        '& \'claude\' --% --prompt "a|b" --filter c;d --to ">e"'
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

  it('escapes quotes for CommandLineToArgvW instead of letting PowerShell 5.1 split them', () => {
    expect(
      retargetClaudeAgentTeamsPaneCommand(
        "cd '/repo' && claude --agent-name 'say \"hi\"' --dir 'C:\\a b\\'",
        'powershell'
      )
    ).toBe(
      'Set-Location \'/repo\'; & \'claude\' --% --agent-name "say \\"hi\\"" --dir "C:\\a b\\\\"'
    )
  })

  it('falls back to PowerShell quoting when an argument carries a percent sign', () => {
    // Why: PowerShell still expands %NAME% after the stop-parsing token.
    expect(
      retargetClaudeAgentTeamsPaneCommand("cd '/repo' && claude --prompt '100%'", 'powershell')
    ).toBe("Set-Location '/repo'; & 'claude' '--prompt' '100%'")
  })

  it('keeps a quoted newline inside an argument out of the stop-parsing line', () => {
    expect(
      retargetClaudeAgentTeamsPaneCommand("claude --prompt 'a\nb'", 'powershell')
    ).toBe("& 'claude' '--prompt' 'a\nb'")
  })
})

describe('quoteWindowsCommandLineArg', () => {
  it('leaves plain arguments alone', () => {
    expect(quoteWindowsCommandLineArg('--agent-name')).toBe('--agent-name')
    expect(quoteWindowsCommandLineArg('C:\\Users\\dev\\claude.exe')).toBe('C:\\Users\\dev\\claude.exe')
  })

  it('quotes whitespace, quotes, empties and cmd metacharacters', () => {
    expect(quoteWindowsCommandLineArg('a b')).toBe('"a b"')
    expect(quoteWindowsCommandLineArg('')).toBe('""')
    expect(quoteWindowsCommandLineArg('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteWindowsCommandLineArg('a|b')).toBe('"a|b"')
    expect(quoteWindowsCommandLineArg('x&y')).toBe('"x&y"')
  })

  it('doubles backslashes only where CommandLineToArgvW would eat them', () => {
    expect(quoteWindowsCommandLineArg('C:\\a b\\')).toBe('"C:\\a b\\\\"')
    expect(quoteWindowsCommandLineArg('back\\slash "q"')).toBe('"back\\slash \\"q\\""')
    expect(quoteWindowsCommandLineArg('x\\\\"y')).toBe('"x\\\\\\\\\\"y"')
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
