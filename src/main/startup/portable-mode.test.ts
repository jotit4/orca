import { describe, expect, it } from 'vitest'
import { win32 } from 'node:path'
import { portableUserDataPath, resolvePortableDataDir } from './portable-mode'

describe('resolvePortableDataDir', () => {
  const execPath = 'D:\\tools\\Orca\\Orca.exe'

  it('resolves the marker folder next to the executable on Windows', () => {
    const seen: string[] = []
    const dir = resolvePortableDataDir({
      execPath,
      platform: 'win32',
      exists: (path) => {
        seen.push(path)
        return true
      }
    })
    expect(dir).toBe(win32.join('D:\\tools\\Orca', 'orca-portable-data'))
    expect(seen).toEqual([win32.join('D:\\tools\\Orca', 'orca-portable-data')])
  })

  it('is not portable without the marker folder', () => {
    expect(resolvePortableDataDir({ execPath, platform: 'win32', exists: () => false })).toBeNull()
  })

  it('never engages outside Windows, even with a marker present', () => {
    // Why: only the Windows zip is distributed as a portable copy.
    expect(resolvePortableDataDir({ execPath, platform: 'linux', exists: () => true })).toBeNull()
    expect(resolvePortableDataDir({ execPath, platform: 'darwin', exists: () => true })).toBeNull()
  })

  it('keeps the profile inside the portable folder', () => {
    expect(portableUserDataPath('D:\\tools\\Orca\\orca-portable-data')).toBe(
      win32.join('D:\\tools\\Orca\\orca-portable-data', 'profile')
    )
  })
})
