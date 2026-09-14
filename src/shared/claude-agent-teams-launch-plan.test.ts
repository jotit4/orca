import { describe, expect, it } from 'vitest'
import {
  applyClaudeTeamsPlanToConfig,
  claudeTeamsFallbackEnvironment
} from './claude-agent-teams-launch-plan'
import {
  claudeTeammateMode,
  isDirectClaudeLaunch,
  setClaudeTeammateMode
} from './claude-agent-teams-launch-command'

describe('Claude Teams launch contract', () => {
  it('replaces every mode option but preserves prompts and the option terminator', () => {
    expect(
      setClaudeTeammateMode(
        "claude '--teammate-mode' 'auto' --model opus --teammate-mode=tmux -- '--teammate-mode auto'",
        'in-process'
      )
    ).toBe("claude --teammate-mode in-process --model opus -- '--teammate-mode auto'")
    expect(setClaudeTeammateMode("claude 'explain --teammate-mode auto'", 'auto')).toBe(
      "claude --teammate-mode auto 'explain --teammate-mode auto'"
    )
    expect(claudeTeammateMode("claude 'explain --teammate-mode auto'")).toBeUndefined()
    expect(claudeTeammateMode('claude -- --teammate-mode auto')).toBeUndefined()
  })

  it('recognizes native Windows launch paths without mistaking compound commands for Claude', () => {
    expect(isDirectClaudeLaunch("& 'C:\\Users\\A B\\claude.exe' --teammate-mode auto")).toBe(true)
    expect(setClaudeTeammateMode("& 'C:\\A B\\claude.exe' --model opus", 'auto')).toBe(
      "& 'C:\\A B\\claude.exe' --teammate-mode auto --model opus"
    )
    expect(isDirectClaudeLaunch('claude.exe --model opus')).toBe(true)
    expect(isDirectClaudeLaunch('claude; other')).toBe(false)
    expect(isDirectClaudeLaunch('claude && other')).toBe(false)
    expect(isDirectClaudeLaunch('claude "hello";other')).toBe(false)
    expect(isDirectClaudeLaunch('claude "unfinished')).toBe(false)
  })

  it('removes only the managed team environment and shim PATH entry on fallback', () => {
    const result = claudeTeamsFallbackEnvironment(
      {
        Path: 'C:\\shim;C:\\tools;C:\\other',
        ORCA_AGENT_TEAMS_SHIM_DIR: 'c:\\SHIM',
        ORCA_AGENT_TEAMS_TEAM_ID: 'old',
        TMUX: '/tmp/orca-claude-agent-teams/old,0,1'
      },
      'win32'
    )
    expect(result.env.Path).toBe('C:\\tools;C:\\other')
    expect(result.envToDelete).toContain('TMUX_PANE')
    const outside = claudeTeamsFallbackEnvironment(
      { PATH: '/usr/bin', TMUX: '/tmp/tmux-user' },
      'linux'
    )
    expect(outside.envToDelete).not.toContain('TMUX')
    expect(outside.env).not.toHaveProperty('PATH')
  })

  it('normalizes saved args independently of the launch command and clears stale tokens', () => {
    const config = applyClaudeTeamsPlanToConfig(
      {
        agentCommand: 'claude',
        agentArgs: '--model opus --teammate-mode auto',
        agentEnv: { ORCA_AGENT_TEAMS_TOKEN: 'old', CLAUDE_PROFILE: 'keep' }
      },
      {
        mode: 'in-process',
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
        envToDelete: ['ORCA_AGENT_TEAMS_TOKEN']
      }
    )
    expect(config.agentCommand).toBe('claude --teammate-mode in-process')
    expect(config.agentArgs).toBe('--model opus')
    expect(config.agentEnv).toEqual({
      CLAUDE_PROFILE: 'keep',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'
    })
  })
})
