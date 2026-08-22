import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'

// Why: worker-start --terminal and dispatch --inject attach to an EXISTING
// pane by calling runtime.waitForTerminalAgent, which polls
// isTerminalRunningAgent instead of checking it exactly once. Before this,
// a subagent pane that was recognized only a beat later than the single
// synchronous check (e.g. a working-spinner title, or a foreground process
// read that hadn't resolved yet) failed attach outright with
// agent_unconfigured, even though it was a real, live agent.
describe('orchestration attach readiness (worker-start --terminal, dispatch --inject)', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const worktreeId = 'repo::worktree'

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
    ctx = { runtime }
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  function createBoundRun(): { taskId: string } {
    const run = db.createRun({
      objective: 'Attach readiness test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    })
    const task = db.createTask({ runId: run.id, spec: 'work' })
    db.updateTaskStatus(task.id, 'ready')
    return { taskId: task.id }
  }

  describe('orchestration.workerStart --terminal', () => {
    it('attaches once isTerminalRunningAgent starts returning true, before it settles as true forever', async () => {
      setup()
      vi.useFakeTimers()
      const { taskId } = createBoundRun()
      let calls = 0
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockImplementation(async () => {
        calls += 1
        return calls >= 3
      })

      const resultPromise = call('orchestration.workerStart', {
        task: taskId,
        from: 'term_coord',
        terminal: 'term_worker',
        timeoutMs: 5_000
      })
      await vi.advanceTimersByTimeAsync(1_500)
      const result = (await resultPromise) as { state: string }

      expect(calls).toBeGreaterThanOrEqual(3)
      expect(result.state).toBeDefined()
    })

    it('rejects with agent_unconfigured, reporting how long it waited, once the timeout elapses', async () => {
      setup()
      vi.useFakeTimers()
      const { taskId } = createBoundRun()
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(false)

      const resultPromise = call('orchestration.workerStart', {
        task: taskId,
        from: 'term_coord',
        terminal: 'term_worker',
        timeoutMs: 300
      })
      const assertion = expect(resultPromise).rejects.toMatchObject({
        code: 'agent_unconfigured',
        message: expect.stringContaining('waited')
      })
      await vi.advanceTimersByTimeAsync(1_000)
      await assertion
    })
  })

  describe('orchestration.dispatch --inject', () => {
    it('defaults to a single check (waitForAgentMs unset) and fails fast, preserving prior behavior', async () => {
      setup()
      const { taskId } = createBoundRun()
      const check = vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(false)

      await expect(
        call('orchestration.dispatch', {
          task: taskId,
          from: 'term_coord',
          to: 'term_worker',
          inject: true
        })
      ).rejects.toThrow('no recognized agent detected')
      expect(check).toHaveBeenCalledTimes(1)
    })

    it('polls up to --wait-for-agent-ms and succeeds once the terminal is recognized', async () => {
      setup()
      vi.useFakeTimers()
      const { taskId } = createBoundRun()
      let calls = 0
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockImplementation(async () => {
        calls += 1
        return calls >= 3
      })

      const resultPromise = call('orchestration.dispatch', {
        task: taskId,
        from: 'term_coord',
        to: 'term_worker',
        inject: true,
        waitForAgentMs: 5_000
      })
      await vi.advanceTimersByTimeAsync(1_500)
      const result = (await resultPromise) as { injected?: boolean }

      expect(calls).toBeGreaterThanOrEqual(3)
      expect(result).toBeDefined()
    })
  })
})
