import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_METHODS } from './orchestration'

// Why: federationAttachStart's existing-terminal branch (params.worktree not
// 'current'/'new-child', params.terminal set) used to call
// isTerminalRunningAgent exactly once, same bug as worker-start --terminal --
// see orchestration-worker-attach-readiness.test.ts. It now polls via
// runtime.waitForTerminalAgent instead.
describe('federationAttachStart terminal attach readiness', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function findMethod() {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }
    return method
  }

  function setupRuntime(): OrcaRuntimeService {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::remote-worktree'
    } as never)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'repo::remote-worktree',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote:leaf_remote')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:term_remote_worker:1'
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_remote_worker',
      accepted: true,
      bytesWritten: 1
    })
    return runtime
  }

  function callAttach(runtime: OrcaRuntimeService, timeoutMs: number, requestId: string) {
    const method = findMethod()
    return method.handler(
      method.params!.parse({
        dispatchId: `ctx_${requestId}`,
        taskId: `task_${requestId}`,
        taskSpec: 'remote attach worker',
        protocolVersion: 1,
        worktree: 'id:repo::remote-worktree',
        terminal: 'term_remote_worker',
        timeoutMs
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId,
          method: 'orchestration.federationAttachStart',
          payloadHash: `payload_${requestId}`
        }
      }
    )
  }

  it('attaches once isTerminalRunningAgent starts returning true, within the timeout budget', async () => {
    const runtime = setupRuntime()
    vi.useFakeTimers()
    let calls = 0
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockImplementation(async () => {
      calls += 1
      return calls >= 3
    })

    const resultPromise = callAttach(runtime, 5_000, 'attach_ready')
    await vi.advanceTimersByTimeAsync(1_500)
    const result = (await resultPromise) as { state: string }

    expect(calls).toBeGreaterThanOrEqual(3)
    expect(result.state).toBeDefined()
  })

  it('resolves as failed with agent_unconfigured, reporting how long it waited, once the timeout elapses', async () => {
    // Why: unlike worker-start --terminal (whose readiness check runs before
    // its try/catch, so agent_unconfigured propagates as a rejection),
    // federationAttachStart's equivalent check runs inside its try/catch, so
    // the failure surfaces as a resolved { state: 'failed', lastError } via
    // failFederatedAttachmentWithReceipt -- pre-existing shape, unchanged by
    // this fix.
    const runtime = setupRuntime()
    vi.useFakeTimers()
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(false)

    const resultPromise = callAttach(runtime, 300, 'attach_timeout')
    await vi.advanceTimersByTimeAsync(1_000)
    const result = (await resultPromise) as { state: string; lastError?: string }

    expect(result.state).toBe('failed')
    expect(result.lastError).toContain('not running a recognized agent')
    expect(result.lastError).toContain('waited 300ms')
  })
})
