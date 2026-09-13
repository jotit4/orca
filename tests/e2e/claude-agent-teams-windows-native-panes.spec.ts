import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalCreate, RuntimeTerminalSummary } from '../../src/shared/runtime-types'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { countVisibleTerminalPanes } from './helpers/terminal'

/**
 * End-to-end proof of the native-pane Agent Teams path on Windows, without a
 * Claude account: a fake `claude` on PATH replays the exact tmux calls Claude
 * Code 2.1.270 makes when it spawns a teammate, and a fake teammate records the
 * argv, cwd and env it actually received.
 *
 * What this exercises for real, on a Windows host:
 *   - the launch plan (PowerShell pane shell, published launcher, tmux.exe
 *     installed under ~/.orca/claude-agent-teams-bin, team env + PATH injected)
 *   - Claude Code's shell-less `tmux` spawn resolving to tmux.exe
 *   - tmux.exe → Orca CLI (`agent-teams-tmux`) → runtime → dispatcher
 *   - the sh → PowerShell re-spelling, the `--%` argv round trip, and the
 *     placeholder → respawn two-step landing in a second Orca pane
 *
 * Why a fake Claude: the assertion is about Orca's plumbing, and a real Claude
 * session needs credentials the runner does not have.
 *
 * Requires ORCA_E2E_WINDOWS_CLI_LAUNCHER: the compiled OrcaCliLauncher (see
 * config/scripts/build-windows-cli-launcher.mjs). Unpackaged builds have no
 * resources/bin/orca.exe, so the spec stands one up next to a node.exe copy
 * named Orca.exe and a junction to the built CLI — the layout the launcher
 * expects.
 */

const isWindows = process.platform === 'win32'
const launcherPath = process.env.ORCA_E2E_WINDOWS_CLI_LAUNCHER ?? null
const enabled = isWindows && launcherPath !== null && existsSync(launcherPath)

const fixtureRoot = enabled ? mkdtempSync(path.join(tmpdir(), 'orca-e2e-agent-teams-win-')) : null
const appDir = fixtureRoot ? path.join(fixtureRoot, 'app') : ''
const launcherBinDir = path.join(appDir, 'resources', 'bin')
const publishedLauncher = path.join(launcherBinDir, 'orca.exe')
const fakeCliDir = fixtureRoot ? path.join(fixtureRoot, 'claude-bin') : ''
const userDataLink = fixtureRoot ? path.join(fixtureRoot, 'user-data') : ''
const teammateScriptPath = path.join(fakeCliDir, 'fake-teammate.cjs')

function runPaths(slug: string): { leaderLogPath: string; teammateMarkerPath: string } {
  return {
    leaderLogPath: path.join(fixtureRoot ?? '', `${slug}-leader.json`),
    teammateMarkerPath: path.join(fixtureRoot ?? '', `${slug}-teammate.json`)
  }
}

const TEAMMATE_ARGS = [
  '--agent-name',
  'Nova',
  '--agent-color',
  'blue',
  '--agent-id',
  'Nova@team-e2e',
  // Why: the three shapes PowerShell 5.1 gets wrong without `--%`: an inner
  // quote, a pipe/semicolon sh only saw quoted, and a trailing backslash.
  '--prompt',
  'say "hi" | a;b',
  '--dir',
  'C:\\a b\\'
]

function pick(names: string[]): string {
  return `Object.fromEntries(${JSON.stringify(names)}.map((name) => [name, process.env[name] ?? null]))`
}

const TRACKED_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'TMUX',
  'TMUX_PANE',
  'ORCA_AGENT_TEAMS_TEAM_ID',
  'ORCA_AGENT_TEAMS_SHIM_DIR',
  'ORCA_AGENT_TEAMS_SHIM_BIN'
]

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function fakeClaudeSource(cwd: string, leaderLogPath: string, teammateMarkerPath: string): string {
  // Verbatim shape of Claude Code's tmux backend: leader pane id, a `cat`
  // placeholder split, remain-on-exit, then respawn-pane with the sh command.
  // ORCA_E2E_TEAMMATE_MARKER rides along like any env assignment Claude forwards.
  const teammateCommand = [
    `cd ${shQuote(cwd)}`,
    '&&',
    `env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 ORCA_E2E_TEAMMATE_MARKER=${shQuote(teammateMarkerPath)}`,
    shQuote(process.execPath),
    shQuote(teammateScriptPath),
    ...TEAMMATE_ARGS.map((arg) => (/[\s"'|;\\]/.test(arg) ? shQuote(arg) : arg))
  ].join(' ')
  return [
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    `const log = (data) => fs.writeFileSync(${JSON.stringify(leaderLogPath)}, JSON.stringify(data, null, 2));`,
    // Why: no shell, like Claude Code — this is what makes a .cmd shim unreachable.
    'const tmux = (args) => execFileSync("tmux", args, { encoding: "utf8", windowsHide: true }).trim();',
    'const calls = [];',
    'try {',
    '  const leader = tmux(["display-message", "-p", "#{pane_id}"]); calls.push(["display-message", leader]);',
    '  const pane = tmux(["split-window", "-d", "-t", leader, "-h", "-P", "-F", "#{pane_id}", "--", "cat"]); calls.push(["split-window", pane]);',
    '  tmux(["set-option", "-p", "-t", pane, "remain-on-exit", "failed"]); calls.push(["set-option"]);',
    `  tmux(["respawn-pane", "-k", "-t", pane, "--", ${JSON.stringify(teammateCommand)}]); calls.push(["respawn-pane"]);`,
    `  log({ ok: true, leader, pane, calls, argv: process.argv.slice(2), env: ${pick(TRACKED_ENV)}, path: process.env.PATH ?? process.env.Path ?? null });`,
    '} catch (error) {',
    '  log({ ok: false, calls, error: String(error && error.stack || error), stdout: String(error && error.stdout || ""), stderr: String(error && error.stderr || ""), path: process.env.PATH ?? process.env.Path ?? null });',
    '}',
    'process.stdout.write("FAKE_CLAUDE_LEADER_READY\\n");',
    'setInterval(() => {}, 1000);'
  ].join('\n')
}

function fakeTeammateSource(): string {
  return [
    'const fs = require("node:fs");',
    'const { execFileSync } = require("node:child_process");',
    // Why: the raw command line is the only way to tell whether PowerShell honoured `--%`
    // or re-quoted the arguments before the child parsed them.
    'let commandLine = null; let psVersion = null;',
    'try { commandLine = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CommandLine`], { encoding: "utf8", windowsHide: true }).trim() } catch (error) { commandLine = String(error) }',
    'try { psVersion = execFileSync("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", windowsHide: true }).trim() } catch {}',
    `fs.writeFileSync(process.env.ORCA_E2E_TEAMMATE_MARKER, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: ${pick(TRACKED_ENV)}, commandLine, psVersion, parentShell: process.env.PSModulePath ?? null }, null, 2));`,
    'process.stdout.write("ORCA_NATIVE_TEAMMATE_OK\\n");',
    'setInterval(() => {}, 1000);'
  ].join('\n')
}

function prepareFixture(): void {
  if (!fixtureRoot || !launcherPath) {
    return
  }
  mkdirSync(launcherBinDir, { recursive: true })
  mkdirSync(fakeCliDir, { recursive: true })
  // Why: the app sees ORCA_USER_DATA_PATH at launch; keep it an existing (empty)
  // directory until the fixture's userData is known and it becomes a junction.
  mkdirSync(userDataLink, { recursive: true })
  // Why: the launcher runs <app>\Orca.exe with ELECTRON_RUN_AS_NODE=1 on
  // <app>\resources\app.asar.unpacked\out\cli\index.js. node.exe honours the
  // same contract, and a junction keeps the CLI's relative requires and
  // node_modules resolution rooted in the repo.
  copyFileSync(process.execPath, path.join(appDir, 'Orca.exe'))
  copyFileSync(launcherPath, publishedLauncher)
  const unpackedOut = path.join(appDir, 'resources', 'app.asar.unpacked', 'out')
  mkdirSync(unpackedOut, { recursive: true })
  symlinkSync(path.join(process.cwd(), 'out', 'cli'), path.join(unpackedOut, 'cli'), 'junction')
  writeFileSync(
    path.join(fakeCliDir, 'claude.cmd'),
    `@echo off\r\n"${process.execPath}" "${path.join(fakeCliDir, 'fake-claude.cjs')}" %*\r\n`
  )
  writeFileSync(teammateScriptPath, fakeTeammateSource())
  // Why: the catalog lists "Claude Agent Teams" only when an Orca CLI (`orca`,
  // `orca-dev` or `orca-ide`) is detected next to `claude`; unpackaged builds
  // install none, and on Windows the entry launches `claude` directly anyway.
  writeFileSync(path.join(fakeCliDir, 'orca-dev.cmd'), '@echo off\r\necho orca-dev stub\r\n')
}

prepareFixture()

function pathEnvKey(): string {
  return Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

// Why: skip before the fixtures launch Electron; on other platforms there is nothing to prove here.
test.skip(!enabled, 'Windows-only; set ORCA_E2E_WINDOWS_CLI_LAUNCHER to the compiled launcher')

test.use({
  seedTestRepo: true,
  orcaAppExtraEnv: enabled
    ? {
        // Why: the fake claude must be what `claude --teammate-mode auto` resolves to in the pane.
        [pathEnvKey()]: [fakeCliDir, path.join(process.cwd(), 'out', 'bin'), process.env[pathEnvKey()] ?? ''].join(
          path.delimiter
        ),
        // Why: unpackaged builds have no bundled launcher; this is the absolute CLI the team publishes.
        ORCA_AGENT_TEAMS_SHIM_BIN: publishedLauncher,
        // Why: the shim's CLI needs the runtime metadata of THIS app instance; the
        // junction to the fixture's userData is created once the app is up.
        ORCA_USER_DATA_PATH: userDataLink
      }
    : {}
})

test.afterAll(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

type LeaderLaunch = { handle: string; tabId: string | null | undefined }

async function verifyNativeTeammate(args: {
  slug: string
  electronApp: ElectronApplication
  orcaPage: Page
  testRepoPath: string
  /** Which PowerShell hosts the panes; `auto` is Orca's default (pwsh when installed). */
  powerShell?: 'powershell.exe' | 'pwsh.exe'
  launchLeader: (client: RuntimeClient, worktreeSelector: string) => Promise<LeaderLaunch>
}): Promise<void> {
  const { slug, electronApp, orcaPage, testRepoPath, launchLeader, powerShell } = args
  const { leaderLogPath, teammateMarkerPath } = runPaths(slug)
  await waitForSessionReady(orcaPage)
  // Why: the runtime RPC takes explicit selectors; `active` is a CLI-side alias.
  const worktreeSelector = `id:${await waitForActiveWorktree(orcaPage)}`
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  rmSync(userDataLink, { recursive: true, force: true })
  symlinkSync(userDataDir, userDataLink, 'junction')
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  if (powerShell) {
    // Why: the re-spelled teammate command branches on the PowerShell generation; both must
    // land the argv intact. The runtime RPC does not expose this setting; the renderer store does.
    await orcaPage.evaluate(
      (implementation) =>
        window.__store?.getState().updateSettings({
          terminalWindowsPowerShellImplementation: implementation
        }),
      powerShell
    )
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => window.__store?.getState().settings?.terminalWindowsPowerShellImplementation ?? null
        )
      )
      .toBe(powerShell)
  }

  writeFileSync(
    path.join(fakeCliDir, 'fake-claude.cjs'),
    fakeClaudeSource(testRepoPath, leaderLogPath, teammateMarkerPath)
  )

  const leader = await launchLeader(client, worktreeSelector)

  // 1. The leader ran, and every tmux call reached Orca through tmux.exe.
  await expect
    .poll(() => existsSync(leaderLogPath), {
      timeout: 90_000,
      message: 'fake claude never wrote its log — did `claude` resolve on the pane PATH?'
    })
    .toBe(true)
  const leaderLog = JSON.parse(readFileSync(leaderLogPath, 'utf8')) as {
    ok: boolean
    leader?: string
    pane?: string
    calls: unknown[]
    argv?: string[]
    env?: Record<string, string | null>
    path?: string | null
    error?: string
    stdout?: string
    stderr?: string
  }
  expect(leaderLog, JSON.stringify(leaderLog, null, 2)).toMatchObject({ ok: true })
  expect(leaderLog.argv).toEqual(['--teammate-mode', 'auto'])
  expect(leaderLog.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
  expect(leaderLog.env?.TMUX_PANE).toBe(leaderLog.leader)
  expect(leaderLog.env?.ORCA_AGENT_TEAMS_SHIM_BIN).toBe(publishedLauncher)
  expect(leaderLog.env?.ORCA_AGENT_TEAMS_SHIM_DIR).toBeTruthy()
  expect(existsSync(path.join(leaderLog.env!.ORCA_AGENT_TEAMS_SHIM_DIR!, 'tmux.exe'))).toBe(true)
  expect(leaderLog.pane).toMatch(/^%\d+$/)

  // 2. The teammate command was re-spelled for PowerShell and its argv survived verbatim.
  await expect
    .poll(() => existsSync(teammateMarkerPath), {
      timeout: 60_000,
      message: 'teammate never started — the respawned pane did not run the re-spelled command'
    })
    .toBe(true)
  const teammate = JSON.parse(readFileSync(teammateMarkerPath, 'utf8')) as {
    argv: string[]
    cwd: string
    env: Record<string, string | null>
    commandLine?: string | null
    psVersion?: string | null
  }
  expect(teammate.argv, JSON.stringify(teammate, null, 2)).toEqual(TEAMMATE_ARGS)
  // Why: tmpdir paths can surface as 8.3 short names on Windows; compare canonical forms.
  expect(realpathSync.native(teammate.cwd).toLowerCase()).toBe(
    realpathSync.native(testRepoPath).toLowerCase()
  )
  const teammateContext = JSON.stringify({ teammate, leader: leaderLog }, null, 2)
  expect(teammate.env.CLAUDECODE, teammateContext).toBe('1')
  expect(teammate.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, teammateContext).toBe('1')
  expect(teammate.env.TMUX_PANE, teammateContext).toBe(leaderLog.pane)
  expect(teammate.env.ORCA_AGENT_TEAMS_TEAM_ID, teammateContext).toBe(
    leaderLog.env?.ORCA_AGENT_TEAMS_TEAM_ID
  )

  // 3. The teammate is a real second pane of the leader's tab, in the runtime and on screen.
  if (leader.tabId) {
    await expect
      .poll(
        async () => {
          const listed = await client.call<{ terminals: RuntimeTerminalSummary[] }>('terminal.list', {
            worktree: worktreeSelector
          })
          return listed.result.terminals.filter((terminal) => terminal.tabId === leader.tabId).length
        },
        { timeout: 30_000 }
      )
      .toBe(2)
  }
  await expect.poll(() => countVisibleTerminalPanes(orcaPage), { timeout: 30_000 }).toBe(2)
}

async function launchLeaderThroughRuntime(
  client: RuntimeClient,
  worktreeSelector: string
): Promise<LeaderLaunch> {
  const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: worktreeSelector,
    title: 'Agent Teams leader',
    // Why: a background (runtime-owned) create returns the handle immediately; the
    // renderer-backed `focus` path timed out waiting for the pane handle on the runner.
    command: 'claude --teammate-mode auto'
  })
  return { handle: created.result.terminal.handle, tabId: created.result.terminal.tabId }
}

for (const powerShell of ['pwsh.exe', 'powershell.exe'] as const) {
  test(`a Claude teammate lands in a native Orca pane on Windows (${powerShell} panes)`, async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    test.setTimeout(180_000)
    await verifyNativeTeammate({
      slug: `rpc-${powerShell.replace('.exe', '')}`,
      electronApp,
      orcaPage,
      testRepoPath,
      powerShell,
      launchLeader: launchLeaderThroughRuntime
    })
  })
}

test('the "Claude Agent Teams" catalog entry opens a native-pane team on Windows', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout(180_000)
  await verifyNativeTeammate({
    slug: 'menu',
    electronApp,
    orcaPage,
    testRepoPath,
    // Why: this is the path a user takes — New tab → Claude Agent Teams — which on
    // Windows launches `claude --teammate-mode auto` through the renderer.
    launchLeader: async () => {
      await orcaPage.getByRole('button', { name: 'New tab' }).click({ force: true })
      const entry = orcaPage.getByRole('menuitem', { name: 'Claude Agent Teams', exact: true })
      const menuItems = async (): Promise<string[]> =>
        orcaPage.getByRole('menuitem').allTextContents().catch(() => [])
      await expect(
        entry,
        `catalog entry missing: is orca-dev/claude detected on PATH? menu: ${JSON.stringify(await menuItems())}`
      ).toBeVisible({ timeout: 30_000 })
      await entry.click({ force: true })
      const tabId = await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        return worktreeId ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null) : null
      })
      return { handle: '', tabId }
    }
  })
})
