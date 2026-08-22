export type FakeAgentPasteEndScan = { tail: string; ended: boolean }

export function scanFakeAgentPasteEnd(tail: string, input: string): FakeAgentPasteEndScan {
  const marker = '\x1b[201~'
  const candidate = tail + input
  return {
    tail: candidate.slice(1 - marker.length),
    ended: candidate.includes(marker)
  }
}

/** How long a fake agent waits for a bracketed-paste terminator before
 *  acknowledging a bare submit anyway. Gating ACK on the terminator is what
 *  makes these fixtures exercise the real delivery contract; without the
 *  fallback, a delivery path that stops bracketing turns every spec into an
 *  opaque suite timeout instead of a failed assertion. */
export const FAKE_AGENT_UNBRACKETED_ACK_GRACE_MS = 2_000

export const FAKE_AGENT_PASTE_END_SCANNER_SOURCE = `
const scanFakeAgentPasteEnd = ${scanFakeAgentPasteEnd.toString()}
let fakeAgentPasteEndTail = ''
let fakeAgentSawSubmit = false
let fakeAgentUnbracketedAckTimer = null
function fakeAgentMaybeAck(pasteEnded, input, ack) {
  fakeAgentSawSubmit = fakeAgentSawSubmit || input.includes('\\r')
  if (!fakeAgentSawSubmit) return
  if (pasteEnded) {
    if (fakeAgentUnbracketedAckTimer) {
      clearTimeout(fakeAgentUnbracketedAckTimer)
      fakeAgentUnbracketedAckTimer = null
    }
    fakeAgentSawSubmit = false
    ack('bracketed')
    return
  }
  if (fakeAgentUnbracketedAckTimer) return
  fakeAgentUnbracketedAckTimer = setTimeout(() => {
    fakeAgentUnbracketedAckTimer = null
    fakeAgentSawSubmit = false
    ack('unbracketed')
  }, ${FAKE_AGENT_UNBRACKETED_ACK_GRACE_MS})
}
`
