import { parseTmuxArgs, tmuxValue } from '../../shared/claude-agent-teams-tmux-compat'
import { claudeAgentTeamsPaneCommand } from '../../shared/claude-agent-teams-pane-command'
import { isStaleHandleError, withLiveHandle } from './claude-agent-teams-handle-refresh'
import type { AgentTeam, AgentTeamsTerminalApi, TeamPane } from './claude-agent-teams-types'
import { paneEnv } from './claude-agent-teams-pane-layout'

export class ClaudeAgentTeamsPaneReplacement {
  private readonly replacing = new WeakSet<TeamPane>()

  constructor(
    private readonly notifyTeammateLaunch: (
      team: AgentTeam,
      handle: string,
      paneKey: string | undefined,
      command: string,
      api: AgentTeamsTerminalApi
    ) => void
  ) {}

  // Why: Claude Code's pane backend creates a teammate pane in two steps — it
  // splits a holding pane running `cat`, then `respawn-pane -k`s it with the
  // real teammate command. Orca panes are PTYs that cannot swap their program in
  // place, so we honor respawn by closing the placeholder terminal and
  // re-splitting from the same origin with the real command, keeping the fake
  // pane id stable so later send-keys/kill-pane/list-panes still resolve.
  async respawnPane(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseTmuxArgs(args, ['-c', '-e', '-t'], ['-k'])
    const pane = this.resolvePane(team, tmuxValue(parsed, '-t') ?? envPane)
    if (this.replacing.has(pane)) {
      throw new Error('pane replacement already in progress')
    }
    this.replacing.add(pane)
    try {
      return await this.replacePane(team, args, envPane, api)
    } finally {
      this.replacing.delete(pane)
    }
  }

  private async replacePane(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseTmuxArgs(args, ['-c', '-e', '-t'], ['-k'])
    const pane = this.resolvePane(team, tmuxValue(parsed, '-t') ?? envPane)
    if (pane.fakePaneId === team.leaderPane) {
      throw new Error('refusing to respawn leader pane')
    }
    const command = parsed.positional.join(' ')
    if (!command) {
      return ''
    }
    const origin =
      (pane.splitFromPane ? team.panes.get(pane.splitFromPane) : undefined) ??
      team.panes.get(team.leaderPane)!
    // Why: create the replacement before destroying the placeholder so a failed
    // split leaves the fake pane id pointing at a still-live terminal; on cleanup
    // failure, discard the new split and keep the placeholder registered.
    const previousHandle = pane.handle
    const split = await withLiveHandle(origin, api, (handle) =>
      api.splitTerminal(handle, {
        direction: pane.splitDirection ?? 'horizontal',
        command: claudeAgentTeamsPaneCommand(command, team.paneShell),
        env: paneEnv(team, pane.fakePaneId),
        envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR'],
        activate: false
      })
    )
    if (team.panes.get(pane.fakePaneId) !== pane) {
      await api.closeTerminal(split.handle)
      throw new Error('pane exited during replacement')
    }
    const previousPaneKey = pane.paneKey
    // Bind before close: runtime teardown forgets the handle synchronously.
    pane.handle = split.handle
    pane.paneKey = api.resolvePaneKeyForHandle(split.handle) ?? undefined
    try {
      await api.closeTerminal(previousHandle)
    } catch (error) {
      // Why: the placeholder is already gone if its own handle went stale —
      // that is the expected shape of this failure, not a cleanup problem.
      if (!isStaleHandleError(error)) {
        pane.handle = previousHandle
        pane.paneKey = previousPaneKey
        try {
          await api.closeTerminal(split.handle)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'pane replacement and rollback cleanup failed'
          )
        }
        throw error
      }
    }
    if (team.panes.get(pane.fakePaneId) !== pane) {
      throw new Error('replacement pane exited')
    }
    // Why: this is the moment the pane actually starts running the real
    // teammate command (the split above only replaced the `cat` holding
    // pane) — the point where auto-attach has a real launch command to read.
    this.notifyTeammateLaunch(team, split.handle, pane.paneKey, command, api)
    return ''
  }

  private resolvePane(team: AgentTeam, target: string): TeamPane {
    const pane = team.panes.get(target)
    if (!pane) {
      throw new Error(`unknown pane: ${target}`)
    }
    return pane
  }
}
