import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildClaudeAgentTeamsLaunchPlan,
  ensureClaudeAgentTeamsShimDir,
  resolveClaudeAgentTeamsShimBin
} from './claude-agent-teams-shim-env'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

describe('claude agent teams shim env', () => {
  it('writes a private tmux shim that calls the Orca shim command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
    roots.push(root)

    await ensureClaudeAgentTeamsShimDir(root)

    await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux "$@"')
  })

  it('builds native shim env only for direct Claude commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
    roots.push(root)
    const cliName = process.platform === 'win32' ? 'orca.exe' : 'orca-dev'
    const cliPath = join(root, cliName)
    await writeFile(cliPath, '#!/usr/bin/env sh\n', 'utf8')
    if (process.platform !== 'win32') {
      await chmod(cliPath, 0o755)
    }

    let capturedShimBin = ''
    if (process.platform === 'win32') {
      // Why: the native path needs the spawnable shim the packaged app installs; dev builds have none.
      await writeFile(join(root, 'tmux.exe'), 'MZ', 'utf8')
    }
    const plan = await buildClaudeAgentTeamsLaunchPlan({
      command: "claude 'hello'",
      mode: 'native-panes-shim',
      baseEnv: { PATH: root },
      shimRoot: root,
      createTeamEnv: (shimDir, shimBin) => {
        capturedShimBin = shimBin
        return {
          PATH: `${shimDir}:/usr/bin`,
          TMUX: '/tmp/orca/fake,0,0',
          TMUX_PANE: '%1'
        }
      }
    })

    expect(plan).toMatchObject({
      command: "claude --teammate-mode auto 'hello'",
      env: expect.objectContaining({ TMUX_PANE: '%1' }),
      envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
    })
    expect(capturedShimBin).toBe(cliPath)

    await expect(
      buildClaudeAgentTeamsLaunchPlan({
        command: "echo ok; claude 'hello'",
        mode: 'native-panes-shim',
        baseEnv: {},
        createTeamEnv: () => ({})
      })
    ).resolves.toBeNull()
  })

  it('falls back to in-process teammates when the panes speak cmd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
    roots.push(root)
    const cliPath = join(root, process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev')
    await writeFile(cliPath, '#!/usr/bin/env sh\n', 'utf8')
    if (process.platform !== 'win32') {
      await chmod(cliPath, 0o755)
    }

    await expect(
      buildClaudeAgentTeamsLaunchPlan({
        command: 'claude',
        mode: 'native-panes-shim',
        baseEnv: { PATH: root },
        paneShell: 'cmd',
        shimRoot: root,
        createTeamEnv: () => {
          throw new Error('cmd panes cannot run the sh command Claude Code writes')
        }
      })
    ).resolves.toMatchObject({
      mode: 'in-process',
      command: 'claude --teammate-mode in-process',
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      fallbackReason: 'pane-shell-unsupported'
    })
  })

  it('falls back instead of aborting when the private shim cannot be installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-install-'))
    roots.push(root)
    const cliPath = join(root, process.platform === 'win32' ? 'orca.exe' : 'orca-dev')
    const blockedRoot = join(root, 'not-a-directory')
    await writeFile(cliPath, 'MZ launcher', 'utf8')
    await writeFile(blockedRoot, 'blocked', 'utf8')
    if (process.platform !== 'win32') {
      await chmod(cliPath, 0o755)
    }

    await expect(
      buildClaudeAgentTeamsLaunchPlan({
        command: 'claude',
        mode: 'native-panes-shim',
        baseEnv: { PATH: root },
        shimRoot: blockedRoot,
        createTeamEnv: () => ({})
      })
    ).resolves.toMatchObject({
      mode: 'in-process',
      fallbackReason: 'shim-install-failed'
    })
  })

  it.skipIf(process.platform !== 'win32')(
    'falls back to in-process teammates when no spawnable Windows shim is installed',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
      roots.push(root)
      const cliPath = join(root, 'orca-dev.cmd')
      await writeFile(cliPath, '@echo off\r\n', 'utf8')

      await expect(
        buildClaudeAgentTeamsLaunchPlan({
          command: 'claude',
          mode: 'native-panes-shim',
          baseEnv: { PATH: root },
          shimRoot: root,
          createTeamEnv: () => {
            throw new Error('Claude Code cannot spawn tmux.cmd, so panes are unreachable')
          }
        })
      ).resolves.toMatchObject({
        mode: 'in-process',
        command: 'claude --teammate-mode in-process',
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
        fallbackReason: 'windows-shim-executable-missing'
      })
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'installs the published launcher as the spawnable tmux.exe shim',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
      roots.push(root)
      const launcher = join(root, 'orca.exe')
      await writeFile(launcher, 'MZ-launcher', 'utf8')

      const plan = await buildClaudeAgentTeamsLaunchPlan({
        command: 'claude',
        mode: 'native-panes-shim',
        baseEnv: { PATH: root, ORCA_AGENT_TEAMS_SHIM_BIN: launcher },
        shimRoot: root,
        createTeamEnv: (shimDir, shimBin) => ({ SHIM_DIR: shimDir, SHIM_BIN: shimBin })
      })

      expect(plan).toMatchObject({
        command: 'claude --teammate-mode auto',
        env: { SHIM_DIR: root, SHIM_BIN: launcher }
      })
      expect(await readFile(join(root, 'tmux.exe'), 'utf8')).toBe('MZ-launcher')
    }
  )

  it('resolves the dev CLI wrapper for the tmux callback binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
    roots.push(root)
    const cliName = process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev'
    const cliPath = join(root, cliName)
    await writeFile(cliPath, '#!/usr/bin/env sh\n', 'utf8')
    if (process.platform !== 'win32') {
      await chmod(cliPath, 0o755)
    }

    expect(resolveClaudeAgentTeamsShimBin({ PATH: root })).toBe(cliPath)
  })
})
