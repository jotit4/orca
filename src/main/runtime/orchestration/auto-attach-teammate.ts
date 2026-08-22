import type { OrcaRuntimeService } from '../orca-runtime'
import { runWorkerStart } from '../rpc/methods/orchestration-workers'
import type { WorkerStartInput } from '../rpc/methods/orchestration-worker-start-schema'

// Why: readiness budget for a teammate pane that just came up under a bound
// Run. The pane takes ~40s to render Claude's title after the real launch
// command starts, so the timeout carries real slack. This governs ONLY the
// readiness loop below (agent recognized under a live-resolved handle); the
// handoff to runWorkerStart afterwards uses its own short budget since
// recognition was already confirmed.
const AUTO_ATTACH_READINESS_TIMEOUT_MS = 90_000

// Why: how often the readiness loop re-resolves the teammate's live handle
// from its paneKey and re-checks isTerminalRunningAgent.
const AUTO_ATTACH_READINESS_POLL_INTERVAL_MS = 500

// Why: once the readiness loop confirms the agent is recognized, the only
// thing left for runWorkerStart's own --terminal path to wait on is the
// (usually instant) tui-idle condition — it must not re-spend the 90s
// recognition budget on top of what was already spent above.
const AUTO_ATTACH_HANDOFF_TIMEOUT_MS = 15_000

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
  // Why: the teammate pane's stable identity. Two teammates launching in
  // parallel can remint the first one's handle mid-launch (split -> respawn
  // race on the SAME pane) while `teammateHandle` above still points at the
  // handle that was live at notify time. When present, the readiness loop
  // below re-resolves the live handle from this on every poll instead of
  // trusting the one captured at notify time; when absent (older caller, or
  // one that could not resolve a paneKey yet) it falls back to the fixed
  // `teammateHandle`, matching the pre-fix behavior.
  teammatePaneKey?: string
  launchCommand: string
}

// Why: isolates the handle-refresh polling loop from the task/dispatch
// bookkeeping below so both the "still waiting" and "gave up" paths share one
// implementation. Never throws -- isTerminalRunningAgent already swallows its
// own errors, and getTerminalHandleForPaneKey returns null on a miss.
async function waitForReadyTeammateHandle(
  runtime: OrcaRuntimeService,
  info: AutoAttachTeammateInfo
): Promise<{ liveHandle: string; recognized: boolean; waitedMs: number }> {
  const startedAt = Date.now()
  let liveHandle = info.teammateHandle
  for (;;) {
    liveHandle =
      (info.teammatePaneKey && runtime.getTerminalHandleForPaneKey(info.teammatePaneKey)) ||
      info.teammateHandle
    if (await runtime.isTerminalRunningAgent(liveHandle)) {
      return { liveHandle, recognized: true, waitedMs: Date.now() - startedAt }
    }
    const waitedMs = Date.now() - startedAt
    if (waitedMs >= AUTO_ATTACH_READINESS_TIMEOUT_MS) {
      return { liveHandle, recognized: false, waitedMs }
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(AUTO_ATTACH_READINESS_POLL_INTERVAL_MS, AUTO_ATTACH_READINESS_TIMEOUT_MS - waitedMs)
      )
    )
  }
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

    const agentLabel = extractAgentLabelFromLaunchCommand(info.launchCommand) ?? info.teammateHandle

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

    // Why: cheap early exit for the common duplicate -- a second split/respawn
    // notification for a pane that already carries our dispatch. The post-readiness
    // check below covers the case where the handle got reminted meanwhile.
    const earlyDispatch = db.getActiveDispatchForTerminal(info.teammateHandle)
    if (earlyDispatch && earlyDispatch.run_id === run.id) {
      return
    }

    // Why: the task is minted BEFORE waiting for readiness so it is visible from the
    // moment the pane is born (task-list shows "teammate <label>" in `ready`). External
    // tooling that used to attach panes itself (the Claude Code hook in harness/) keys
    // off that row to stand down instead of racing this path; minting it only after
    // the ~40 s recognition window would make it invisible exactly when it matters.
    const task = db.createTask({
      spec: `${AUTO_ATTACH_TEAMMATE_SPEC} (subagente auto-enganchado al nacer el pane, handle ${info.teammateHandle})`,
      taskTitle: `teammate ${agentLabel}`,
      runId: run.id
    })

    // Why (handle churn under a parallel launch): a teammate's terminal
    // HANDLE is routing metadata, not durable identity -- launching two
    // teammates at once can remint the first one's handle mid-launch
    // (split -> respawn on the same pane) while the pane itself stays put.
    // Re-resolve the live handle from the pane's stable paneKey on every
    // poll instead of trusting the one captured at notify time.
    const { liveHandle, recognized, waitedMs } = await waitForReadyTeammateHandle(runtime, info)

    if (!recognized) {
      const handleDetail =
        liveHandle === info.teammateHandle
          ? info.teammateHandle
          : `${info.teammateHandle} (last resolved: ${liveHandle})`
      const reason = `Terminal ${handleDetail} is not running a recognized agent (waited ${waitedMs}ms).`
      db.updateTaskStatus(task.id, 'failed', JSON.stringify({ reason: 'unhooked', detail: reason }))
      notify(`ENGANCHE FALLÓ ${agentLabel}: ${reason}`, 'high')
      return
    }

    // Why: idempotency (#4 of the spec) -- a second split/respawn notification
    // for the same pane, or external tooling that attached this same pane while
    // we were waiting, must not mint a second dispatch for it. Checked against
    // the LIVE handle; our own task is then closed as superseded, not left `ready`.
    const existingDispatch = db.getActiveDispatchForTerminal(liveHandle)
    if (existingDispatch && existingDispatch.run_id === run.id) {
      db.updateTaskStatus(
        task.id,
        'failed',
        JSON.stringify({ reason: 'superseded', detail: `dispatch ${existingDispatch.id} already owns ${liveHandle}` })
      )
      return
    }

    const workerStartParams: WorkerStartInput = {
      task: task.id,
      from: info.leaderHandle,
      terminal: liveHandle,
      // Why: recognition was already confirmed by the readiness loop above --
      // this only needs to cover runWorkerStart's tui-idle wait, which is
      // normally instant once the agent is recognized.
      timeoutMs: AUTO_ATTACH_HANDOFF_TIMEOUT_MS
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
      notify(`ENGANCHADO ${agentLabel} → ${liveHandle} (dispatch ${dispatchId})`, 'normal')
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
