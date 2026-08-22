import type { OrcaRuntimeService } from '../orca-runtime'
import { runWorkerStart } from '../rpc/methods/orchestration-workers'
import type { WorkerStartInput } from '../rpc/methods/orchestration-worker-start-schema'

// Why: readiness budget for a teammate pane that just came up under a bound
// Run. The pane takes ~40s to render Claude's title after the real launch
// command starts, so the timeout carries real slack; it governs both
// runtime.waitForTerminalAgent (agent recognized) and the tui-idle wait
// inside runWorkerStart (agent ready for input) — see orchestration-workers.ts.
const AUTO_ATTACH_READINESS_TIMEOUT_MS = 90_000

// Why: identical protocol text to the external hook
// (harness/claude-code/scripts/enganchar-subagente-orquestacion.sh) so a
// teammate sees the same message regardless of which mechanism attached it.
// The spec is DEFERENTE on purpose — the subagent already received its real
// task in Claude Code's own prompt; this only layers the reporting protocol
// (worker_done/heartbeat/ask) on top, never competes with the real task.
const AUTO_ATTACH_TEAMMATE_SPEC =
  'Seguí exactamente la tarea que ya recibiste en tu prompt inicial — este bloque no la ' +
  'reemplaza ni la modifica. Lo único que agrega es el protocolo de reporte: mandá ' +
  'worker_done cuando termines, heartbeat mientras trabajás, y usá ask (nunca ' +
  'AskUserQuestion) si necesitás una decisión del orquestador.'

// Why: the observed real launch command carries `--agent-id <id>`, not
// `--agent-name` (verified against claude-agent-teams-service.test.ts's
// "relaunches a teammate via respawn-pane" fixture: `claude --agent-id a
// --teammate-mode auto`). Both flags are matched so a future/other launcher
// spelling `--agent-name` still resolves; `--agent-id` wins when both exist
// only because it is checked second and therefore overwrites -- order does
// not matter in practice since a real command carries at most one of them.
export function extractAgentLabelFromLaunchCommand(command: string): string | undefined {
  const idMatch = command.match(/--agent-id[= ]+(\S+)/)
  const nameMatch = command.match(/--agent-name[= ]+(\S+)/)
  return nameMatch?.[1] ?? idMatch?.[1] ?? undefined
}

export type AutoAttachTeammateInfo = {
  leaderHandle: string
  leaderPaneKey?: string
  teammateHandle: string
  launchCommand: string
}

// Why: called fire-and-forget from orca-runtime.ts's handleAgentTeamsTmuxCompat
// right after a teammate pane starts running its real launch command (see
// claude-agent-teams-tmux-dispatcher.ts's notifyTeammateLaunch). Never throws
// and never leaves a rejected promise — every failure path is caught here and
// only reflected in the task/message state, exactly like the rest of this
// function's "no external effect can propagate to the shim" contract.
export async function autoAttachTeammateToRun(
  runtime: OrcaRuntimeService,
  info: AutoAttachTeammateInfo
): Promise<void> {
  try {
    if (process.env.ORCA_AGENT_TEAMS_AUTO_DISPATCH === '0') {
      return
    }
    if (!info.leaderPaneKey) {
      // Why: a freshly pre-allocated leader handle may not have a resolvable
      // paneKey yet (see prepareClaudeAgentTeamsLeaderForHandle) — no paneKey,
      // no way to look up a bound Run. Degrade silently, same as a leader with
      // no Run at all.
      return
    }

    const db = runtime.getOrchestrationDb()
    const run = db.getCurrentRunForPane(info.leaderPaneKey)
    if (!run) {
      // Why: no Run bound to this coordinator pane (or a legacy Run, which
      // getCurrentRunForPane already excludes) -- nothing to auto-attach.
      return
    }

    // Why: idempotency (#4 of the spec) -- a second split/respawn notification
    // for the same pane, or the external hook still racing this same handle,
    // must not mint a second task+dispatch for it.
    const existingDispatch = db.getActiveDispatchForTerminal(info.teammateHandle)
    if (existingDispatch && existingDispatch.run_id === run.id) {
      return
    }

    const agentLabel = extractAgentLabelFromLaunchCommand(info.launchCommand) ?? info.teammateHandle
    const task = db.createTask({
      spec: `${AUTO_ATTACH_TEAMMATE_SPEC} (subagente auto-enganchado al nacer el pane, handle ${info.teammateHandle})`,
      taskTitle: `teammate ${agentLabel}`,
      runId: run.id
    })

    const notify = (subject: string, priority: 'normal' | 'high'): void => {
      const message = db.insertMessage({
        runId: run.id,
        from: 'system:auto-attach',
        to: `run:${run.id}`,
        subject,
        type: 'status',
        priority
      })
      runtime.notifyMessageArrived(message.to_handle, message.type)
    }

    const workerStartParams: WorkerStartInput = {
      task: task.id,
      from: info.leaderHandle,
      terminal: info.teammateHandle,
      timeoutMs: AUTO_ATTACH_READINESS_TIMEOUT_MS
    } as WorkerStartInput

    let result: unknown
    try {
      result = await runWorkerStart(workerStartParams, { runtime })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      db.updateTaskStatus(task.id, 'failed', JSON.stringify({ reason: 'unhooked', detail: reason }))
      notify(`ENGANCHE FALLÓ ${agentLabel}: ${reason}`, 'high')
      return
    }

    const state = (result as { state?: unknown } | null)?.state
    const dispatchId = (result as { dispatchId?: unknown } | null)?.dispatchId
    if (state === 'ready' && typeof dispatchId === 'string') {
      notify(`ENGANCHADO ${agentLabel} → ${info.teammateHandle} (dispatch ${dispatchId})`, 'normal')
      return
    }

    // Why: runWorkerStart's failure paths (failWorkerStartWithReceipt) already
    // mark the task failed with the raw error text as `result` — normalize it
    // to the {"reason":"unhooked"} shape the external hook and any downstream
    // tooling already expect, without disturbing the dispatch_contexts/
    // worker_dispatches rows it already wrote.
    const lastError = (result as { lastError?: unknown } | null)?.lastError
    const reason = typeof lastError === 'string' ? lastError : `unexpected worker-start state: ${String(state)}`
    db.updateTaskStatus(task.id, 'failed', JSON.stringify({ reason: 'unhooked', detail: reason }))
    notify(`ENGANCHE FALLÓ ${agentLabel}: ${reason}`, 'high')
  } catch (error) {
    // Why: last-resort net. Nothing above this line may throw into the caller
    // — it is invoked `void`'d from a tmux-compat response path.
    console.warn('[orchestration] auto-attach teammate failed', error)
  }
}
