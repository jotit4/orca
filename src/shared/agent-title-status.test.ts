import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from './agent-title-status'

// Why: Claude Code's subagent panes (Explore, general-purpose, ...) decorate
// their OSC title with a rotating spinner glyph while working, distinct from
// the ✳ idle prefix that was previously the only recognized Claude signal.
// isTerminalRunningAgent (orca-runtime.ts) relies on detectAgentStatusFromTitle
// via classifyAgentTitle, so a working subagent pane that never surfaced
// 'working' here could not be attached to by orchestration worker-start
// --terminal / dispatch --inject until it happened to go idle.
describe('detectAgentStatusFromTitle: Claude Code working spinner titles', () => {
  it.each([
    '◐ Explore',
    '◑ general-purpose',
    '◒ Explore',
    '◓ Explore',
    '✶ Thinking',
    '✻ Thinking',
    '✽ Thinking'
  ])('recognizes %j as working', (title) => {
    expect(detectAgentStatusFromTitle(title)).toBe('working')
  })

  it('still recognizes the ✳ idle prefix', () => {
    expect(detectAgentStatusFromTitle('✳ Claude Code')).toBe('idle')
    expect(detectAgentStatusFromTitle('✳')).toBe('idle')
  })

  it('is conservative: requires the glyph as a prefix followed by a space, not merely contained', () => {
    expect(detectAgentStatusFromTitle('Explore ◐ mid-title')).toBeNull()
    expect(detectAgentStatusFromTitle('◐no-space-after-glyph')).toBeNull()
  })

  it('does not misclassify an empty or unrelated title', () => {
    expect(detectAgentStatusFromTitle('')).toBeNull()
    expect(detectAgentStatusFromTitle('bash')).toBeNull()
  })
})
