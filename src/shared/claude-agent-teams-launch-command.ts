type CommandWord = { raw: string; value: string; start: number; end: number }

function commandWords(command: string): CommandWord[] {
  return [...command.matchAll(/(?:[^\s'"\\]|\\.|'[^']*'|"(?:\\.|[^"\\])*")+/g)].map((match) => ({
    raw: match[0],
    value: match[0].replace(/^(['"])(.*)\1$/s, '$2'),
    start: match.index,
    end: match.index + match[0].length
  }))
}

export function claudeTeammateMode(command: string): string | undefined {
  const words = commandWords(command)
  for (let index = 0; index < words.length; index += 1) {
    const value = words[index]!.value
    if (value === '--') {
      break
    }
    if (value === '--teammate-mode') {
      return words[index + 1]?.value
    }
    if (value.startsWith('--teammate-mode=')) {
      return value.slice('--teammate-mode='.length)
    }
  }
  return undefined
}

export function stripClaudeTeammateMode(command: string): string {
  const words = commandWords(command)
  const spans: { start: number; end: number }[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    if (word.value === '--') {
      break
    }
    if (word.value === '--teammate-mode') {
      const next = words[index + 1]
      spans.push({
        start: word.start,
        end: next && !next.value.startsWith('--') ? next.end : word.end
      })
      if (next && !next.value.startsWith('--')) {
        index += 1
      }
    } else if (word.value.startsWith('--teammate-mode=')) {
      spans.push(word)
    }
  }
  for (const span of spans.toReversed()) {
    command = command.slice(0, span.start) + command.slice(span.end).trimStart()
  }
  return command.trim()
}

export function setClaudeTeammateMode(command: string, mode: 'auto' | 'in-process'): string {
  const stripped = stripClaudeTeammateMode(command)
  const words = commandWords(stripped)
  const executable = words[words[0]?.value === '&' ? 1 : 0]
  if (!executable) {
    throw new Error('Claude command is empty')
  }
  return `${stripped.slice(0, executable.end)} --teammate-mode ${mode}${stripped.slice(executable.end)}`
}

export function isDirectClaudeLaunch(command: string | undefined): boolean {
  if (!command?.trim()) {
    return false
  }
  const words = commandWords(command)
  const offset = words[0]?.value === '&' ? 1 : 0
  const executable = words[offset]?.value.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase()
  if (!executable || !['claude', 'claude.exe', 'claude.cmd'].includes(executable)) {
    return false
  }
  // Only literal direct launches enter the planner; compound shell programs retain their own semantics.
  let end = 0
  for (const word of words) {
    if (command.slice(end, word.start).trim()) {
      return false
    }
    end = word.end
  }
  if (command.slice(end).trim()) {
    return false
  }
  return words
    .slice(offset)
    .every((word) => !/[;&|<>`'"]/.test(word.raw.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '')))
}
