import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { claudeTeamsFallbackEnvironment } from '../../shared/claude-agent-teams-launch-plan'
import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess,
  isDirectClaudeCommand,
  type ClaudeAgentTeamsMode
} from '../../shared/claude-agent-teams-tmux-compat'
import { supportsClaudeAgentTeamsPaneCommand } from '../../shared/claude-agent-teams-pane-command'
import { getOrcaCliCommandNameForPlatform } from '../../shared/orca-cli-command-name'
import { resolveStartupShell, type AgentStartupShell } from '../../shared/tui-agent-startup-shell'

export type ClaudeAgentTeamsLaunchPlan = {
  mode: 'in-process' | 'native-panes-shim'
  command: string
  env: Record<string, string>
  envToDelete?: string[]
  /** Set when native panes were requested but the plan degraded to in-process, and why. */
  fallbackReason?: ClaudeAgentTeamsFallbackReason
}

export type ClaudeAgentTeamsFallbackReason =
  | 'pane-shell-unsupported'
  | 'shim-bin-unresolved'
  | 'shim-install-failed'
  | 'windows-shim-executable-missing'

export async function ensureClaudeAgentTeamsShimDir(
  root = defaultShimRoot(),
  opts?: {
    /** Launcher executable to install as tmux.exe; defaults to the packaged one. */
    windowsLauncher?: string | null
  }
): Promise<string> {
  await mkdir(root, { recursive: true })
  await writeIfChanged(join(root, 'tmux'), unixShimScript())
  if (process.platform === 'win32') {
    await writeIfChanged(join(root, 'tmux.cmd'), windowsShimScript())
    await installWindowsShimExecutable(
      root,
      opts?.windowsLauncher ?? process.env.ORCA_AGENT_TEAMS_SHIM_BIN ?? bundledLauncherPath()
    )
  }
  return root
}

/** Path of the Windows shim Claude Code can actually spawn; see installWindowsShimExecutable. */
export function windowsClaudeAgentTeamsShimExecutablePath(root = defaultShimRoot()): string {
  return join(root, 'tmux.exe')
}

/**
 * Claude Code spawns `tmux` with no shell, and Node refuses to spawn `.cmd`
 * without one (CVE-2024-27980), so `tmux.cmd` alone is unreachable — the spawn
 * fails with EINVAL before the shim runs. The packaged launcher is a
 * self-contained .NET Framework executable that already forwards argv to the
 * Orca CLI, and it switches to tmux-shim mode when its own file name is `tmux`,
 * so a copy of it under that name is the shim.
 */
async function installWindowsShimExecutable(root: string, launcher: string | null): Promise<void> {
  // Why: only a real launcher binary can be the shim; a `.cmd` (the dev CLI wrapper) is exactly what Claude Code cannot spawn.
  if (!launcher || !/\.exe$/i.test(launcher) || !isExecutableFile(launcher)) {
    return
  }
  const target = windowsClaudeAgentTeamsShimExecutablePath(root)
  const launcherBytes = await readFile(launcher)
  try {
    await writeIfChanged(target, launcherBytes)
  } catch (error) {
    // Why: Windows refuses to replace an executable while a copy of it is still
    // running (a teammate's tmux call in flight). An older shim that already
    // exists keeps working, so keep the launch alive instead of failing it.
    const targetMatches = await readFile(target)
      .then((content) => content.equals(launcherBytes))
      .catch(() => false)
    if (!targetMatches) {
      throw error
    }
  }
}

export async function buildClaudeAgentTeamsLaunchPlan(args: {
  command: string | undefined
  mode: ClaudeAgentTeamsMode | undefined
  baseEnv: Record<string, string | undefined>
  /** Shell the panes type into; decides whether Orca can spell the teammate command. */
  paneShell?: AgentStartupShell
  shimRoot?: string
  createTeamEnv: (shimDir: string, shimBin: string) => Record<string, string>
}): Promise<ClaudeAgentTeamsLaunchPlan | null> {
  const mode = args.mode ?? 'off'
  if (!args.command || mode === 'off' || !isDirectClaudeCommand(args.command)) {
    return null
  }
  const inProcess = (
    fallbackReason?: ClaudeAgentTeamsFallbackReason
  ): ClaudeAgentTeamsLaunchPlan => {
    if (fallbackReason) {
      // Why: a silent degrade is the failure mode that cost days on Windows —
      // the team "works" with every teammate hidden inside the leader's TUI.
      console.warn(
        `[claude-agent-teams] native panes unavailable (${fallbackReason}); launching in-process`
      )
    }
    return {
      mode: 'in-process',
      command: addClaudeTeammateModeInProcess(args.command!),
      ...claudeTeamsFallbackEnvironment(args.baseEnv, process.platform),
      ...(fallbackReason ? { fallbackReason } : {})
    }
  }
  if (mode === 'in-process') {
    return inProcess()
  }
  // Why: Claude Code writes pane commands for sh; cmd.exe cannot carry them, and on Windows only PowerShell can run the shim.
  if (
    !supportsClaudeAgentTeamsPaneCommand(
      resolveStartupShell(process.platform, args.paneShell),
      process.platform
    )
  ) {
    return inProcess('pane-shell-unsupported')
  }
  const shimBin = resolveClaudeAgentTeamsShimBin(args.baseEnv)
  if (!shimBin || !isAbsolute(shimBin) || !isExecutableFile(shimBin)) {
    // Why: without an absolute CLI path the shim would resolve a bare `orca` against the pane cwd, so degrade instead.
    return inProcess('shim-bin-unresolved')
  }
  if (process.platform === 'win32' && !/\.exe$/i.test(shimBin)) {
    return inProcess('windows-shim-executable-missing')
  }
  // Why: the shim is a copy of the launcher the team publishes as ORCA_AGENT_TEAMS_SHIM_BIN, so the
  // same binary serves packaged installs and an unpackaged build pointed at a built launcher.
  let shimDir: string
  try {
    shimDir = await ensureClaudeAgentTeamsShimDir(args.shimRoot ?? defaultShimRoot(), {
      windowsLauncher: shimBin
    })
  } catch {
    return inProcess('shim-install-failed')
  }
  // Why: the .cmd shim is unspawnable from Claude Code, so without the executable the team would launch paneless.
  if (
    process.platform === 'win32' &&
    !isExecutableFile(windowsClaudeAgentTeamsShimExecutablePath(shimDir))
  ) {
    return inProcess('windows-shim-executable-missing')
  }
  const env = args.createTeamEnv(shimDir, shimBin)
  return {
    mode: 'native-panes-shim',
    command: addClaudeTeammateModeAuto(args.command),
    env,
    envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
  }
}

export function resolveClaudeAgentTeamsShimBin(
  env: Record<string, string | undefined> = process.env
): string {
  if (env.ORCA_AGENT_TEAMS_SHIM_BIN) {
    return env.ORCA_AGENT_TEAMS_SHIM_BIN
  }
  const bundled = bundledLauncherPath()
  if (bundled && isExecutableFile(bundled)) {
    return bundled
  }
  const pathKey =
    Object.keys(env).find((key) =>
      process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'
    ) ?? 'PATH'
  return (
    findExecutableOnPath(process.platform === 'win32' ? 'orca.exe' : 'orca-dev', env[pathKey]) ??
    findExecutableOnPath(
      process.platform === 'win32'
        ? 'orca-dev.cmd'
        : getOrcaCliCommandNameForPlatform(process.platform),
      env[pathKey]
    ) ??
    getOrcaCliCommandNameForPlatform(process.platform)
  )
}

function defaultShimRoot(): string {
  return join(homedir(), '.orca', 'claude-agent-teams-bin')
}

function bundledLauncherPath(): string | null {
  if (!process.resourcesPath) {
    return null
  }
  if (process.platform === 'darwin') {
    return join(process.resourcesPath, 'bin', 'orca')
  }
  if (process.platform === 'linux') {
    return join(process.resourcesPath, 'bin', 'orca-ide')
  }
  if (process.platform === 'win32') {
    return join(process.resourcesPath, 'bin', 'orca.exe')
  }
  return null
}

function findExecutableOnPath(command: string, pathValue: string | undefined): string | null {
  for (const directory of pathValue?.split(delimiter) ?? []) {
    if (!directory) {
      continue
    }
    const candidate = join(directory, command)
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }
  return null
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false
    }
    accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function unixShimScript(): string {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    `exec "\${ORCA_AGENT_TEAMS_SHIM_BIN:-${getOrcaCliCommandNameForPlatform(process.platform)}}" agent-teams-tmux "$@"`,
    ''
  ].join('\n')
}

function windowsShimScript(): string {
  return [
    '@echo off',
    'setlocal',
    'if "%ORCA_AGENT_TEAMS_SHIM_BIN%"=="" (',
    `  set "ORCA_AGENT_TEAMS_SHIM_BIN=${getOrcaCliCommandNameForPlatform(process.platform)}"`,
    ')',
    '"%ORCA_AGENT_TEAMS_SHIM_BIN%" agent-teams-tmux %*',
    ''
  ].join('\r\n')
}

async function writeIfChanged(path: string, content: string | Buffer): Promise<void> {
  try {
    if (typeof content === 'string') {
      if ((await readFile(path, 'utf8')) === content) {
        return
      }
    } else if (content.equals(await readFile(path))) {
      return
    }
  } catch {
    // rewrite below
  }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  let renamed = false
  try {
    await writeFile(tmp, content, 'utf8')
    if (process.platform !== 'win32') {
      await chmod(tmp, 0o755)
    }
    await rename(tmp, path)
    renamed = true
  } finally {
    if (!renamed) {
      await rm(tmp, { force: true })
    }
  }
}
