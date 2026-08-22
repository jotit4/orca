import { quoteStartupArg, resolveStartupShell } from '../../../src/shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../src/shared/windows-terminal-shell'

/**
 * The Windows shell these fixtures pin through `updateSettings`. The override
 * built below is quoted for whichever shell the runtime will actually type it
 * into, so specs must apply this value alongside the override rather than
 * relying on the default happening to match.
 */
export const FAKE_AGENT_WINDOWS_SHELL = 'powershell.exe'

export function buildFakeAgentCommandOverride(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
  terminalWindowsShell: string = FAKE_AGENT_WINDOWS_SHELL
): string {
  // Why resolve rather than assume PowerShell on win32: the startup shell comes
  // from the user's terminalWindowsShell setting, and a cmd/Git Bash/WSL host
  // would silently fail to launch a PowerShell-quoted path.
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({ platform, isRemote: false, terminalWindowsShell })
  )
  const quotedPath = quoteStartupArg(executablePath, shell)
  return shell === 'powershell' ? `& ${quotedPath}` : quotedPath
}
