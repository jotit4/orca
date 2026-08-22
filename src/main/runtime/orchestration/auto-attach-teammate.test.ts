import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { autoAttachTeammateToRun, extractAgentLabelFromLaunchCommand } from './auto-attach-teammate'

// Why: mirrors the fixture in
// rpc/methods/orchestration-worker-attach-readiness.test.ts (the exact
// --terminal path autoAttachTeammateToRun reuses via runWorkerStart) so this
// test exercises the same shape of runtime/db doubles as the RPC method it is
// piggy-backing on.
describe('autoAttachTeammateToRun', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let notifyMessageArrivedSpy: ReturnType<typeof vi.spyOn>

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const worktreeId = 'repo::worktree'
  const launchCommand = 'cd /repo && env CLAUDECODE=1 claude --agent-id a1 --teammate-mode auto'

  // Why: a worker pane's handle can be reminted mid-launch (that is exactly
  // the bug this fix addresses) -- 'term_worker_reminted' is the fixture's
  // stand-in for that reminted handle, and it must resolve to the same
  // worker identity as 'term_worker' everywhere the original handle did.
  const isWorkerHandle = (handle: string): boolean =>
    handle === 'term_worker' || handle === 'term_worker_reminted'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : isWorkerHandle(handle) ? workerPaneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      isWorkerHandle(handle) ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      isWorkerHandle(handle)
        ? ({
            terminalHandle: handle,
            paneKey: workerPaneKey,
            processIncarnation: 'runtime_test:term_worker:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId, status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({ id: worktreeId } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'waitForTerminalAgent').mockResolvedValue({ recognized: true, waitedMs: 10 })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    // Why: notify() intentionally stopped calling this (see auto-attach-teammate.ts) --
    // it was what typed "You have N orchestration messages..." into the coordinator's
    // pane on every teammate launch, which the coordinator already reads via the
    // PostToolUse hook. Spied (not mocked away) so tests below can assert it stays
    // silent while the message itself still lands in the mailbox.
    notifyMessageArrivedSpy = vi.spyOn(runtime, 'notifyMessageArrived')
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  })

  function bindRun() {
    return db.createRun({
      objective: 'auto-attach test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    })
  }

  it('extracts the agent label from the observed --agent-id launch command shape', () => {
    expect(extractAgentLabelFromLaunchCommand(launchCommand)).toBe('a1')
    expect(extractAgentLabelFromLaunchCommand('claude --agent-name rag-debugger')).toBe(
      'rag-debugger'
    )
    expect(extractAgentLabelFromLaunchCommand('cat')).toBeUndefined()
  })

  it('creates a task + dispatch and posts ENGANCHADO when the leader has a bound Run', async () => {
    setup()
    const run = bindRun()

    await autoAttachTeammateToRun(runtime, {
      leaderHandle: 'term_coord',
      leaderPaneKey: coordinatorPaneKey,
      teammateHandle: 'term_worker',
      launchCommand
    })

    const tasks = db.listTasks({ runId: run.id })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].task_title).toBe('teammate a1')
    expect(tasks[0].status).not.toBe('failed')

    const dispatch = db.getActiveDispatchForTerminal('term_worker')
    expect(dispatch?.run_id).toBe(run.id)

    const messages = db.getRunMailboxHistory(run.id)
    expect(messages.some((m) => m.subject.startsWith('ENGANCHADO a1 → term_worker'))).toBe(true)
    // Why: the ENGANCHADO status message must land in the mailbox (asserted
    // above) without also typing a "you have N messages" nudge into the
    // coordinator's pane -- the coordinator already reads these via the
    // PostToolUse hook.
    expect(notifyMessageArrivedSpy).not.toHaveBeenCalled()
  })

  it('does nothing when the leader pane has no Run bound', async () => {
    setup()
    // No db.createRun() call — the leader pane is unbound.

    await autoAttachTeammateToRun(runtime, {
      leaderHandle: 'term_coord',
      leaderPaneKey: coordinatorPaneKey,
      teammateHandle: 'term_worker',
      launchCommand
    })

    expect(db.listTasks()).toHaveLength(0)
    expect(db.getActiveDispatchForTerminal('term_worker')).toBeUndefined()
  })

  it('marks the task failed and posts ENGANCHE FALLÓ with both handles when readiness never arrives', async () => {
    setup()
    const run = bindRun()
    vi.useFakeTimers()
    try {
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(false)
      vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue('term_worker_live')

      const attach = autoAttachTeammateToRun(runtime, {
        leaderHandle: 'term_coord',
        leaderPaneKey: coordinatorPaneKey,
        teammateHandle: 'term_worker',
        teammatePaneKey: workerPaneKey,
        launchCommand
      })
      await vi.advanceTimersByTimeAsync(90_000)
      await attach

      const tasks = db.listTasks({ runId: run.id })
      expect(tasks).toHaveLength(1)
      expect(tasks[0].status).toBe('failed')
      const result = JSON.parse(tasks[0].result ?? '{}')
      expect(result.reason).toBe('unhooked')
      // Why: both the handle captured at notify time and the last one the
      // readiness loop resolved must be in the diagnostic detail -- that's
      // the whole point of the fix (#22/08 val-par-a incident).
      expect(result.detail).toContain('term_worker')
      expect(result.detail).toContain('term_worker_live')

      const messages = db.getRunMailboxHistory(run.id)
      expect(
        messages.some(
          (m) =>
            m.subject.startsWith('ENGANCHE FALLÓ a1') &&
            m.subject.includes('term_worker') &&
            m.subject.includes('term_worker_live')
        )
      ).toBe(true)
      expect(notifyMessageArrivedSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-resolves the live handle when it changes mid-poll and attaches to the new one', async () => {
    setup()
    const run = bindRun()
    let recognizedHandle: string | undefined
    let call = 0
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneKey === workerPaneKey ? 'term_worker_reminted' : null
    )
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockImplementation(async (handle) => {
      call += 1
      // Why: simulates the handle only becoming live/recognized on its second
      // resolution -- the first poll sees the pane before it renders its
      // title, same as the real ~40s startup slack.
      if (call < 2) {
        return false
      }
      recognizedHandle = handle
      return true
    })

    await autoAttachTeammateToRun(runtime, {
      leaderHandle: 'term_coord',
      leaderPaneKey: coordinatorPaneKey,
      teammateHandle: 'term_worker',
      teammatePaneKey: workerPaneKey,
      launchCommand
    })

    expect(recognizedHandle).toBe('term_worker_reminted')
    const tasks = db.listTasks({ runId: run.id })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).not.toBe('failed')
    const dispatch = db.getActiveDispatchForTerminal('term_worker_reminted')
    expect(dispatch?.run_id).toBe(run.id)
    const messages = db.getRunMailboxHistory(run.id)
    expect(messages.some((m) => m.subject.startsWith('ENGANCHADO a1 → term_worker_reminted'))).toBe(
      true
    )
  })

  it('falls back to the fixed handle (pre-fix behavior) when no teammatePaneKey is given', async () => {
    setup()
    const run = bindRun()
    const getHandleSpy = vi.spyOn(runtime, 'getTerminalHandleForPaneKey')

    await autoAttachTeammateToRun(runtime, {
      leaderHandle: 'term_coord',
      leaderPaneKey: coordinatorPaneKey,
      teammateHandle: 'term_worker',
      launchCommand
    })

    expect(getHandleSpy).not.toHaveBeenCalled()
    const dispatch = db.getActiveDispatchForTerminal('term_worker')
    expect(dispatch?.run_id).toBe(run.id)
    const messages = db.getRunMailboxHistory(run.id)
    expect(messages.some((m) => m.subject.startsWith('ENGANCHADO a1 → term_worker'))).toBe(true)
  })

  it('does not duplicate the dispatch on a second notification for the same pane', async () => {
    setup()
    const run = bindRun()
    const info = {
      leaderHandle: 'term_coord',
      leaderPaneKey: coordinatorPaneKey,
      teammateHandle: 'term_worker',
      launchCommand
    }

    await autoAttachTeammateToRun(runtime, info)
    await autoAttachTeammateToRun(runtime, info)

    expect(db.listTasks({ runId: run.id })).toHaveLength(1)
  })

  it('is a no-op when ORCA_AGENT_TEAMS_AUTO_DISPATCH=0', async () => {
    setup()
    const run = bindRun()
    const previous = process.env.ORCA_AGENT_TEAMS_AUTO_DISPATCH
    process.env.ORCA_AGENT_TEAMS_AUTO_DISPATCH = '0'
    try {
      await autoAttachTeammateToRun(runtime, {
        leaderHandle: 'term_coord',
        leaderPaneKey: coordinatorPaneKey,
        teammateHandle: 'term_worker',
        launchCommand
      })
      expect(db.listTasks({ runId: run.id })).toHaveLength(0)
    } finally {
      if (previous === undefined) {
        delete process.env.ORCA_AGENT_TEAMS_AUTO_DISPATCH
      } else {
        process.env.ORCA_AGENT_TEAMS_AUTO_DISPATCH = previous
      }
    }
  })

  it('never throws, even when the runtime/db blow up internally', async () => {
    setup()
    bindRun()
    vi.spyOn(runtime, 'showTerminal').mockRejectedValue(new Error('boom'))

    await expect(
      autoAttachTeammateToRun(runtime, {
        leaderHandle: 'term_coord',
        leaderPaneKey: coordinatorPaneKey,
        teammateHandle: 'term_worker',
        launchCommand
      })
    ).resolves.toBeUndefined()
  })
})
