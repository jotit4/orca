import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * Portable mode: a folder named `orca-portable-data` next to `Orca.exe` makes
 * the app keep its profile, daemon host and Agent Teams shim inside that folder
 * instead of `%APPDATA%`, `%LOCALAPPDATA%` and `%USERPROFILE%\.orca`.
 *
 * Why: the fork is distributed as a zip of `win-unpacked` for machines where
 * an installer is not wanted — no Programs & Features entry, no shortcuts, no
 * uninstaller — and a portable copy should not scatter state across the user
 * profile either. The marker is a directory (not a file) so the zip can ship it
 * with a README and the user can delete it to opt out.
 *
 * Windows-only on purpose: the NSIS/macOS/Linux packages never carry the marker.
 */
export const PORTABLE_DATA_DIR_NAME = 'orca-portable-data'

export function resolvePortableDataDir(args: {
  execPath: string
  platform: NodeJS.Platform
  exists?: (path: string) => boolean
}): string | null {
  if (args.platform !== 'win32') {
    return null
  }
  // Why: resolve with the Windows path dialect explicitly so the same code is testable from any host.
  const pathApi = args.platform === 'win32' ? win32 : posix
  const candidate = pathApi.join(pathApi.dirname(args.execPath), PORTABLE_DATA_DIR_NAME)
  return (args.exists ?? existsSync)(candidate) ? candidate : null
}

let cachedPortableDataDir: string | null | undefined

/** The portable data folder for this process, resolved once; null when not portable. */
export function getPortableDataDir(): string | null {
  if (cachedPortableDataDir === undefined) {
    cachedPortableDataDir = resolvePortableDataDir({
      execPath: process.execPath,
      platform: process.platform
    })
  }
  return cachedPortableDataDir
}

export function isPortableMode(): boolean {
  return getPortableDataDir() !== null
}

export function resetPortableModeForTests(): void {
  cachedPortableDataDir = undefined
}

/** Where a portable copy keeps the Electron userData (profile, settings, sessions). */
export function portableUserDataPath(portableDataDir: string): string {
  return win32.join(portableDataDir, 'profile')
}
