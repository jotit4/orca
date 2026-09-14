import { setClaudeTeammateMode, stripClaudeTeammateMode } from './claude-agent-teams-launch-command'

const TEAM_ENV_KEYS = [
  'ORCA_AGENT_TEAMS_TEAM_ID',
  'ORCA_AGENT_TEAMS_TOKEN',
  'ORCA_AGENT_TEAMS_LEADER_PANE',
  'ORCA_AGENT_TEAMS_SHIM_DIR',
  'ORCA_AGENT_TEAMS_SHIM_BIN',
  'ORCA_AGENT_TEAMS_LAUNCH_PLAN_VERSION'
]

export function claudeTeamsFallbackEnvironment(
  baseEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform
): { env: Record<string, string>; envToDelete: string[] } {
  const env: Record<string, string> = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
  const envToDelete = [...TEAM_ENV_KEYS]
  if (
    baseEnv.ORCA_AGENT_TEAMS_TEAM_ID ||
    baseEnv.TMUX?.startsWith('/tmp/orca-claude-agent-teams/')
  ) {
    envToDelete.push('TMUX', 'TMUX_PANE')
  }
  const shimDir = baseEnv.ORCA_AGENT_TEAMS_SHIM_DIR
  if (shimDir) {
    const pathKey =
      Object.keys(baseEnv).find((key) =>
        platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'
      ) ?? 'PATH'
    const normalize = (value: string): string =>
      platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value
    env[pathKey] = (baseEnv[pathKey] ?? '')
      .split(platform === 'win32' ? ';' : ':')
      .filter((entry) => normalize(entry) !== normalize(shimDir))
      .join(platform === 'win32' ? ';' : ':')
  }
  return { env, envToDelete }
}

export function applyClaudeTeamsPlanToConfig<
  T extends {
    agentCommand?: string
    agentArgs?: string
    agentEnv?: Record<string, string>
  }
>(
  config: T,
  plan: {
    mode: 'in-process' | 'native-panes-shim'
    env: Record<string, string>
    envToDelete?: string[]
  }
): T & { agentCommand: string; agentArgs: string; agentEnv: Record<string, string> } {
  const agentEnv = { ...config.agentEnv, ...plan.env }
  for (const key of plan.envToDelete ?? []) {
    delete agentEnv[key]
  }
  return {
    ...config,
    agentCommand: setClaudeTeammateMode(
      config.agentCommand ?? 'claude',
      plan.mode === 'in-process' ? 'in-process' : 'auto'
    ),
    agentArgs: stripClaudeTeammateMode(config.agentArgs ?? ''),
    agentEnv
  }
}
