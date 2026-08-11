import type { AgentTeamsTerminalApi, TeamPane } from './claude-agent-teams-types'

// Why (#11739): the runtime throws this exact string (see orca-runtime.ts) when
// a handle no longer resolves to a live terminal. `includes` rather than `===`
// because some call sites wrap it with extra context.
export function isStaleHandleError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('terminal_handle_stale')
}

// Why (#11739): a pane's cached handle can go stale (runtime restart, handle
// remint) while its identity (paneKey) stays valid. Retry once through a
// freshly re-resolved handle before giving up, and remember it so the next
// call doesn't pay the same failure again.
export async function withLiveHandle<T>(
  pane: TeamPane,
  api: AgentTeamsTerminalApi,
  op: (handle: string) => Promise<T>
): Promise<T> {
  try {
    return await op(pane.handle)
  } catch (error) {
    if (!isStaleHandleError(error) || !pane.paneKey) {
      throw error
    }
    const freshHandle = api.resolveHandleForPaneKey(pane.paneKey)
    if (!freshHandle || freshHandle === pane.handle) {
      throw error
    }
    pane.handle = freshHandle
    return await op(freshHandle)
  }
}
