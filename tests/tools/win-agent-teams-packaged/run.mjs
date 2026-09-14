import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import {
  launchInstalledApp,
  ensureTerminal,
  closeApp,
  captureFailureDiagnostics
} from '../win-update-e2e/app-driver.mjs'
import { createSeededRepo, buildFreshProfile } from '../win-update-e2e/onboarding-profile.mjs'
import { findDaemonProcesses } from '../win-update-e2e/daemon-processes.mjs'
import { TEAMMATE_ARGS, writeTeamFixture } from './fixture.mjs'

assert.equal(process.platform, 'win32', 'This gate requires real Windows')
const appExe = realpathSync.native(path.resolve(process.argv[2] ?? 'dist/win-unpacked/Orca.exe'))
const launcher = path.join(path.dirname(appExe), 'resources', 'bin', 'orca.exe')
assert.ok(existsSync(launcher), 'Packaged CLI launcher missing')
const evidence = path.resolve('test-results', 'windows-agent-teams-packaged')
mkdirSync(evidence, { recursive: true })

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'orca-packaged-teams-')))
  const userDataDir = path.join(root, 'profile')
  const bin = path.join(root, 'fixture-bin')
  const cwd = path.join(root, "teammate [literal] O'Brien")
  mkdirSync(bin)
  mkdirSync(cwd)
  writeTeamFixture(root, bin, cwd)
  const profile = buildFreshProfile({ repo: createSeededRepo(path.join(root, 'repo')) })
  Object.assign(profile.settings, {
    claudeAgentTeamsMode: 'native-panes-shim',
    claudeAgentTeamsDefaultDisabledMigrated: true,
    disabledTuiAgents: [],
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: shell
  })
  let app, page
  try {
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const launched = await launchInstalledApp({
      exePath: appExe,
      userDataDir,
      seedProfile: profile,
      extraEnv: {
        [pathKey]: [bin, path.dirname(launcher), process.env[pathKey] ?? ''].join(path.delimiter),
        ORCA_USER_DATA_PATH: userDataDir,
        ORCA_AGENT_TEAMS_SHIM_BIN: '',
        ORCA_AGENT_TEAMS_SHIM_DIR: '',
        ORCA_AGENT_TEAMS_TEAM_ID: '',
        ORCA_AGENT_TEAMS_TOKEN: '',
        TMUX: '',
        TMUX_PANE: ''
      }
    })
    ;({ app, page } = launched)
    await ensureTerminal(page)
    await page.getByRole('button', { name: 'New tab', exact: true }).click()
    const entry = page.getByRole('menuitem', { name: /^Claude Agent Teams/ })
    await expect(entry).toBeVisible({ timeout: 60000 })
    await entry.click()
    const read = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'))
    const completed = (name) => {
      if (existsSync(path.join(root, 'error.json'))) {
        throw new Error(JSON.stringify(read('error.json')))
      }
      return existsSync(path.join(root, name))
    }
    await expect.poll(() => completed('ready.json'), { timeout: 180000 }).toBe(true)
    const ready = read('ready.json')
    const teammate = read('teammate.json')
    assert.equal(
      realpathSync.native(ready.shim).toLowerCase(),
      realpathSync.native(launcher).toLowerCase()
    )
    assert.deepEqual(teammate.argv, TEAMMATE_ARGS)
    assert.equal(
      realpathSync.native(teammate.cwd).toLowerCase(),
      realpathSync.native(cwd).toLowerCase()
    )
    assert.equal(teammate.pane, ready.pane)
    assert.equal(teammate.team, ready.team)
    assert.ok(ready.argv.join(' ').includes('--teammate-mode auto'))
    await expect(page.locator('.xterm:visible')).toHaveCount(2, { timeout: 30000 })
    await page.screenshot({ path: path.join(evidence, `${shell}-two-panes.png`) })
    writeFileSync(path.join(root, 'close-request'), '')
    await expect.poll(() => completed('done.json'), { timeout: 60000 }).toBe(true)
    await expect(page.locator('.xterm:visible')).toHaveCount(1, { timeout: 30000 })
    writeFileSync(
      path.join(evidence, `${shell}.json`),
      JSON.stringify(
        { appExe, launcher, shell, ready, teammate, closed: read('done.json') },
        null,
        2
      )
    )
  } catch (error) {
    if (page) {
      await captureFailureDiagnostics(page, evidence, shell).catch(() => {})
    }
    throw error
  } finally {
    if (app) {
      await closeApp(app)
    }
    // Only the daemon with this fresh profile's socket/token may be terminated.
    for (const daemon of findDaemonProcesses(userDataDir)) {
      try {
        execFileSync('taskkill', ['/pid', String(daemon.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* exited */
      }
    }
    console.log(`Isolated fixture retained for diagnosis: ${root}`)
  }
}
