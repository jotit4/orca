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

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const worktreeId = 'repo::worktree'
  const launchCommand = 'cd /repo && env CLAUDECODE=1 claude --agent-id a1 --teammate-mode auto'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
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

  it('marks the task failed and posts ENGANCHE FALLÓ when readiness never arrives', async () => {
    setup()
    const run = bindRun()
    vi.spyOn(runtime, 'waitForTerminalAgent').mockResolvedValue({
      recognized: false,
      waitedMs: 90_000
    })

    await autoAttachTeammateToRun(runtime, {
      leaderHandle: 'term_coord',
      leaderPaneKey: coordinatorPaneKey,
      teammateHandle: 'term_worker',
      launchCommand
    })

    const tasks = db.listTasks({ runId: run.id })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('failed')
    expect(JSON.parse(tasks[0].result ?? '{}')).toMatchObject({ reason: 'unhooked' })

    const messages = db.getRunMailboxHistory(run.id)
    expect(messages.some((m) => m.subject.startsWith('ENGANCHE FALLÓ a1'))).toBe(true)
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
