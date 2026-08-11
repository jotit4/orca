import type {
  RuntimeTerminalClose,
  RuntimeTerminalFocus,
  RuntimeTerminalRead,
  RuntimeTerminalSend,
  RuntimeTerminalShow,
  RuntimeTerminalSplit
} from '../../shared/runtime-types'

export type AgentTeamsTmuxCompatRequest = {
  teamId: string
  token: string
  envPane: string
  cwd?: string
  argv: string[]
}

export type AgentTeamsTmuxCompatResponse = {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

export type AgentTeamsLaunchEnv = {
  teamId: string
  token: string
  leaderPane: string
  env: Record<string, string>
}

export type AgentTeamsTerminalApi = {
  splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
    }
  ): Promise<RuntimeTerminalSplit>
  readTerminal(handle: string, opts?: { limit?: number }): Promise<RuntimeTerminalRead>
  sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean }
  ): Promise<RuntimeTerminalSend>
  focusTerminal(handle: string): Promise<RuntimeTerminalFocus>
  closeTerminal(handle: string): Promise<RuntimeTerminalClose>
  showTerminal(handle: string): Promise<RuntimeTerminalShow>
  // Why (#11739): a pane's raw handle is only as durable as the runtime process
  // that minted it — a restart or handle remint invalidates it out from under a
  // long-lived session, but the pane's stable identity (paneKey, `tab:leaf`)
  // survives. These let the dispatcher recover that identity and re-resolve a
  // live handle instead of failing every subsequent tmux call with
  // `terminal_handle_stale` for the rest of the session.
  resolvePaneKeyForHandle(handle: string): string | null
  resolveHandleForPaneKey(paneKey: string): string | null
}

export type TeamPane = {
  fakePaneId: string
  handle: string
  index: number
  // Why: Claude Code splits a holding pane (`-- cat`) then `respawn-pane`s it
  // with the real teammate command. We remember how the pane was first split so
  // respawn can recreate it in the same slot while preserving its fake pane id.
  splitFromPane?: string
  splitDirection?: 'horizontal' | 'vertical'
  // Why (#11739): the stable identity behind `handle`, captured opportunistically
  // (leader launch, right after a split/respawn) and used to re-mint `handle`
  // when it goes stale. Absent when the runtime couldn't resolve one yet — the
  // pane still works, it just can't self-heal from a stale handle.
  paneKey?: string
}

export type AgentTeam = {
  teamId: string
  token: string
  leaderPane: string
  leaderHandle: string
  sessionName: string
  windowIndex: string
  tmuxValue: string
  baseEnv: Record<string, string>
  panes: Map<string, TeamPane>
  paneOrder: string[]
  nextPaneNumber: number
  mainVertical: {
    mainPane: string
    lastColumnPane: string | null
  } | null
  previouslyFocusedPane: string | null
}
