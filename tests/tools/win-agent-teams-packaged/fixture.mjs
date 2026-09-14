import { writeFileSync } from 'node:fs'
import path from 'node:path'

export const TEAMMATE_ARGS = ['--prompt', 'say "hi" | a;b', '--dir', 'C:\\a b\\', '--empty', '']
const shQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`

// A deterministic protocol client, never an authenticated Claude session.
export function writeTeamFixture(root, bin, cwd) {
  const teammate = path.join(bin, 'teammate.cjs')
  const leader = path.join(bin, 'leader.cjs')
  const marker = path.join(root, 'teammate.json')
  const command = `cd ${shQuote(cwd)} && env ORCA_TEAM_TEST_MARKER=${shQuote(marker)} ${[process.execPath, teammate, ...TEAMMATE_ARGS].map(shQuote).join(' ')}`
  writeFileSync(
    teammate,
    `
const fs = require('node:fs');
fs.writeFileSync(process.env.ORCA_TEAM_TEST_MARKER, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), pane: process.env.TMUX_PANE,
  team: process.env.ORCA_AGENT_TEAMS_TEAM_ID
}));
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => process.stdout.write('INPUT_ACK:' + data));
process.stdout.write('PACKAGED_TEAM_READY\\n');
setInterval(() => {}, 1000);
`
  )
  writeFileSync(
    leader,
    `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = ${JSON.stringify(root)};
const tmux = args => execFileSync('tmux', args, { encoding: 'utf8', timeout: 55000, windowsHide: true }).trim();
const save = (name, data) => fs.writeFileSync(path.join(root, name), JSON.stringify(data));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (check()) return; await delay(200); }
  throw new Error('Timed out: ' + label);
}
(async () => {
  const leader = tmux(['display-message', '-p', '#{pane_id}']);
  const pane = tmux(['split-window', '-d', '-t', leader, '-h', '-P', '-F', '#{pane_id}', '--', 'cat']);
  tmux(['respawn-pane', '-k', '-t', pane, '--', ${JSON.stringify(command)}]);
  if (!tmux(['list-panes', '-F', '#{pane_id}']).split(/\\r?\\n/).includes(pane)) throw new Error('respawn lost pane');
  await until(() => tmux(['capture-pane', '-p', '-t', pane]).includes('PACKAGED_TEAM_READY'), 'teammate ready');
  tmux(['send-keys', '-t', pane, '-l', 'roundtrip-probe']);
  tmux(['send-keys', '-t', pane, 'Enter']);
  await until(() => tmux(['capture-pane', '-p', '-t', pane]).includes('INPUT_ACK:roundtrip-probe'), 'send/capture');
  save('ready.json', { pane, leader, team: process.env.ORCA_AGENT_TEAMS_TEAM_ID,
    shim: process.env.ORCA_AGENT_TEAMS_SHIM_BIN, argv: process.argv.slice(2) });
  await until(() => fs.existsSync(path.join(root, 'close-request')), 'visible-pane acknowledgment');
  tmux(['kill-pane', '-t', pane]);
  const remaining = tmux(['list-panes', '-F', '#{pane_id}']).split(/\\r?\\n/);
  if (remaining.includes(pane) || !remaining.includes(leader)) throw new Error('incorrect close target');
  save('done.json', { remaining });
})().catch(error => save('error.json', { error: String(error), stderr: String(error.stderr || '') }));
setInterval(() => {}, 1000);
`
  )
  writeFileSync(
    path.join(bin, 'claude.cmd'),
    `@echo off\r\nif "%~1"=="--version" (echo 2.1.270 ^(Claude Code fixture^) & exit /b 0)\r\n"${process.execPath}" "${leader}" %*\r\n`
  )
}
