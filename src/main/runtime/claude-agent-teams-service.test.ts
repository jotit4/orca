import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService, type AgentTeamsTerminalApi } from './claude-agent-teams-service'

function createServiceWithLeader(): {
  service: ClaudeAgentTeamsService
  teamId: string
  token: string
  leaderPane: string
  api: AgentTeamsTerminalApi
  splitCalls: { handle: string; direction?: string; command?: string; envPane?: string }[]
  // Why (#11739): lets a test simulate a runtime handle remint — mark a handle
  // stale and point its paneKey at the fresh replacement — without needing a
  // real runtime.
  staleHandles: Set<string>
  handleByPaneKey: Map<string, string>
} {
  const service = new ClaudeAgentTeamsService()
  const paneKeyByHandle = new Map<string, string>([['leader-handle', 'tab-1:leader-leaf']])
  const handleByPaneKey = new Map<string, string>([['tab-1:leader-leaf', 'leader-handle']])
  const staleHandles = new Set<string>()
  const launch = service.createLaunchEnv({
    leaderHandle: 'leader-handle',
    leaderPaneKey: 'tab-1:leader-leaf',
    baseEnv: { PATH: '/usr/bin' },
    shimDir: '/tmp/orca-shim',
    shimBin: '/usr/bin/orca'
  })
  expect(launch.env.ORCA_AGENT_TEAMS_SHIM_DIR).toBe('/tmp/orca-shim')
  const splitCalls: { handle: string; direction?: string; command?: string; envPane?: string }[] =
    []
  let splitCount = 0
  const throwIfStale = (handle: string): void => {
    if (staleHandles.has(handle)) {
      throw new Error('terminal_handle_stale')
    }
  }
  const api: AgentTeamsTerminalApi = {
    splitTerminal: vi.fn(async (handle, opts) => {
      throwIfStale(handle)
      splitCount += 1
      splitCalls.push({
        handle,
        direction: opts.direction,
        command: opts.command,
        envPane: opts.env?.TMUX_PANE
      })
      const newHandle = `teammate-${splitCount}`
      const paneKey = `tab-1:teammate-leaf-${splitCount}`
      paneKeyByHandle.set(newHandle, paneKey)
      handleByPaneKey.set(paneKey, newHandle)
      return { handle: newHandle, tabId: 'tab-1', paneRuntimeId: -1 }
    }),
    readTerminal: vi.fn(async (handle) => {
      throwIfStale(handle)
      return {
        handle,
        status: 'running' as const,
        tail: ['line one', 'line two'],
        truncated: false,
        nextCursor: null
      }
    }),
    sendTerminal: vi.fn(async (handle, action) => {
      throwIfStale(handle)
      return {
        handle,
        accepted: Boolean(action.text),
        bytesWritten: action.text?.length ?? 0
      }
    }),
    focusTerminal: vi.fn(async (handle) => {
      throwIfStale(handle)
      return { handle, tabId: 'tab-1', worktreeId: 'wt-1' }
    }),
    closeTerminal: vi.fn(async (handle) => {
      throwIfStale(handle)
      return { handle, tabId: 'tab-1', ptyKilled: true }
    }),
    showTerminal: vi.fn(async (handle) => ({
      handle,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/wt',
      branch: 'main',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      title: null,
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: '',
      paneRuntimeId: -1,
      ptyId: 'pty-1',
      rendererGraphEpoch: 1
    })),
    resolvePaneKeyForHandle: vi.fn((handle) => paneKeyByHandle.get(handle) ?? null),
    resolveHandleForPaneKey: vi.fn((paneKey) => handleByPaneKey.get(paneKey) ?? null)
  }
  return {
    service,
    teamId: launch.teamId,
    token: launch.token,
    leaderPane: launch.leaderPane,
    api,
    splitCalls,
    staleHandles,
    handleByPaneKey
  }
}

describe('ClaudeAgentTeamsService', () => {
  it('supports Claude core tmux teammate sequence with native splits', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await expect(
      request(['display-message', '-t', leaderPane, '-p', '#{session_name}:#{window_index}'])
    ).resolves.toMatchObject({ stdout: 'orca:0\n', exitCode: 0 })

    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%2\n', exitCode: 0 })

    await request(['select-layout', '-t', 'orca:0', 'main-vertical'])
    await request(['resize-pane', '-t', leaderPane, '-x', '30%'])

    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({
      stdout: '%1\n%2\n'
    })
    expect(splitCalls).toEqual([
      { handle: 'leader-handle', direction: 'vertical', command: undefined, envPane: '%2' }
    ])
  })

  it('puts the first teammate on the right, then stacks repeated main-vertical teammates downward', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    await request(['select-layout', '-t', 'orca:0', 'main-vertical'])
    await request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    await request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])

    expect(splitCalls.map((call) => [call.handle, call.direction, call.envPane])).toEqual([
      ['leader-handle', 'vertical', '%2'],
      ['teammate-1', 'horizontal', '%3'],
      ['teammate-2', 'horizontal', '%4']
    ])
  })

  it('does not recycle fake pane ids after a teammate closes', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    await request(['select-layout', '-t', 'orca:0', 'main-vertical'])
    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    await request(['kill-pane', '-t', '%3'])

    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%4\n', exitCode: 0 })
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({
      stdout: '%1\n%2\n%4\n'
    })
    expect(splitCalls.map((call) => [call.handle, call.direction, call.envPane])).toEqual([
      ['leader-handle', 'vertical', '%2'],
      ['teammate-1', 'horizontal', '%3'],
      ['teammate-1', 'horizontal', '%4']
    ])
  })

  it('relaunches a teammate via respawn-pane after a cat holding split', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    // Claude splits a holding pane running `cat`, then respawns it with the
    // real teammate command (the failure mode before respawn-pane was supported).
    await expect(
      request([
        'split-window',
        '-d',
        '-t',
        leaderPane,
        '-h',
        '-l',
        '70%',
        '-P',
        '-F',
        '#{pane_id}',
        '--',
        'cat'
      ])
    ).resolves.toMatchObject({ stdout: '%2\n', exitCode: 0 })

    await request(['set-option', '-p', '-t', '%2', 'remain-on-exit', 'failed'])

    const teammateCommand = 'cd /repo && env CLAUDECODE=1 claude --agent-id a --teammate-mode auto'
    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', teammateCommand])
    ).resolves.toMatchObject({ stdout: '', exitCode: 0 })

    // the placeholder terminal is closed and the pane is recreated, from the same
    // origin/direction, with the real teammate command.
    expect(api.closeTerminal).toHaveBeenCalledWith('teammate-1')
    expect(splitCalls).toEqual([
      { handle: 'leader-handle', direction: 'vertical', command: 'cat', envPane: '%2' },
      { handle: 'leader-handle', direction: 'vertical', command: teammateCommand, envPane: '%2' }
    ])

    // the fake pane id is preserved and now backed by the relaunched terminal.
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%1\n%2\n' })

    await request(['kill-pane', '-t', '%2'])
    expect(api.closeTerminal).toHaveBeenLastCalledWith('teammate-2')
  })

  it('keeps the placeholder handle when the respawn split fails', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request([
      'split-window',
      '-d',
      '-t',
      leaderPane,
      '-h',
      '-P',
      '-F',
      '#{pane_id}',
      '--',
      'cat'
    ])

    vi.mocked(api.splitTerminal).mockRejectedValueOnce(new Error('no space for new pane'))
    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id a'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })

    // the placeholder terminal is left intact and the fake pane id still resolves.
    expect(api.closeTerminal).not.toHaveBeenCalled()
    await request(['kill-pane', '-t', '%2'])
    expect(api.closeTerminal).toHaveBeenCalledWith('teammate-1')
  })

  it('refuses to respawn the leader pane', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()

    await expect(
      service.handleTmuxCompat(
        {
          teamId,
          token,
          envPane: leaderPane,
          argv: ['respawn-pane', '-k', '-t', leaderPane, '--', 'cat']
        },
        api
      )
    ).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      stderr: 'tmux: refusing to respawn leader pane\n'
    })
  })

  it('rejects stale or unauthorized shim calls', async () => {
    const { service, teamId, leaderPane, api } = createServiceWithLeader()

    await expect(
      service.handleTmuxCompat(
        { teamId, token: 'wrong', envPane: leaderPane, argv: ['list-panes'] },
        api
      )
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
  })

  it('keeps the inherited Windows `Path` instead of minting a truncated `PATH`', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const launch = new ClaudeAgentTeamsService().createLaunchEnv({
        leaderHandle: 'leader-handle',
        baseEnv: { Path: 'C:\\Windows\\system32' },
        shimDir: 'C:\\orca-shim',
        shimBin: 'C:\\orca.exe'
      })

      expect(Object.keys(launch.env).filter((key) => /^path$/i.test(key))).toEqual(['Path'])
      expect(launch.env.Path).toBe('C:\\orca-shim;C:\\Windows\\system32')
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  // Regression: a teammate pane whose terminal died outside the shim (UI close,
  // handle-addressed close, or the teammate process exiting) stayed registered,
  // so `list-panes` still reported it and the next `split-window` used its dead
  // handle as the split origin. In the app that surfaced as
  // `Failed to create teammate pane: tmux: terminal_exited` on every subsequent
  // spawn until Orca was restarted.
  it('drops a teammate pane whose terminal died outside the shim', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    await request(['select-layout', '-t', 'orca:0', 'main-vertical'])
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%1\n%2\n' })

    service.forgetTerminalHandle('teammate-1')

    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%1\n' })

    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ exitCode: 0 })
    expect(splitCalls.at(-1)?.handle).toBe('leader-handle')
  })

  it('keeps the team alive when a teammate handle is forgotten', () => {
    const { service } = createServiceWithLeader()
    service.forgetTerminalHandle('teammate-1')
    expect(service.getActiveTeamCount()).toBe(1)

    service.forgetTerminalHandle('leader-handle')
    expect(service.getActiveTeamCount()).toBe(0)
  })

  // Regression (#11739): the leader/teammate pane's raw handle is only as
  // durable as the runtime process that minted it — a restart or handle
  // remint invalidates it while the pane's paneKey identity stays valid. The
  // general orchestration path already re-resolves through the paneKey on a
  // `terminal_handle_stale` failure (PR #7514); the agent-teams shim path did
  // not, so every subsequent tmux call failed for the rest of the session.
  it('re-resolves a stale leader handle through its paneKey instead of failing the split', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls, staleHandles, handleByPaneKey } =
      createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    // Simulate a runtime handle remint: the leader's old handle is dead, but
    // its paneKey now resolves to a fresh one.
    staleHandles.add('leader-handle')
    handleByPaneKey.set('tab-1:leader-leaf', 'leader-handle-reminted')

    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ ok: true, exitCode: 0 })

    expect(splitCalls.at(-1)?.handle).toBe('leader-handle-reminted')
    expect(api.resolveHandleForPaneKey).toHaveBeenCalledWith('tab-1:leader-leaf')
  })

  it('re-resolves a stale teammate handle through its paneKey instead of failing send-keys', async () => {
    const { service, teamId, token, leaderPane, api, staleHandles, handleByPaneKey } =
      createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])

    // Simulate a runtime handle remint on the teammate pane created above.
    staleHandles.add('teammate-1')
    handleByPaneKey.set('tab-1:teammate-leaf-1', 'teammate-1-reminted')

    const sendResult = request(['send-keys', '-t', '%2', 'hello', 'Enter'])
    await expect(sendResult).resolves.toMatchObject({ ok: true, exitCode: 0 })
    expect(api.sendTerminal).toHaveBeenLastCalledWith(
      'teammate-1-reminted',
      expect.objectContaining({ text: expect.any(String) })
    )
  })

  it('fails normally when a stale handle has no paneKey to recover through', async () => {
    const { service, teamId, token, leaderPane, api, staleHandles } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    staleHandles.add('leader-handle')
    // No replacement registered under the leader's paneKey: resolution fails.

    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
  })
})
