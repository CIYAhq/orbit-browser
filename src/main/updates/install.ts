import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Putting a downloaded update in place at a relaunch (UP-01, UP-05). Orbit's builds are unsigned,
 * so it replaces itself the plain way each system allows:
 * - Linux (the folder build): the update is a .tar.gz of the app's folder. It is unpacked beside
 *   the running folder, and at the relaunch the two swap names; the old one goes at the next start.
 * - macOS: a .zip of Orbit.app, unpacked beside the running app with `ditto`, swapped the same way.
 * - Windows: the installer (.exe), run silently at the relaunch; it starts Orbit again when done.
 * A copy that can't replace itself (a development run, a folder Orbit may not write to, a copy a
 * package manager installed) opens the release's page instead (UP-10).
 * macOS and Windows are unverified: no build for them is tested.
 */
export interface Staged {
  version: string
  /** The downloaded file. */
  file: string
  /** What takes the running copy's place: the unpacked folder or app, or the installer. */
  ready: string
}

export interface Installer {
  /** Why this copy can't update itself, or '' when it can. */
  problem(): string
  /** Unpacks a downloaded, checked file beside the running copy; throws when it can't. */
  stage(file: string, version: string): Promise<Staged>
  /** At quit (`will-quit`): puts the staged copy in place and starts Orbit again. */
  apply(staged: Staged): void
  /** Removes what an earlier update left (the copy it replaced, an unpacked one never used). */
  cleanUp(): Promise<void>
}

export interface InstallerSetup {
  platform: NodeJS.Platform
  /** The running program (process.execPath). */
  execPath: string
  /** Whether this is an installed build (app.isPackaged). */
  packaged: boolean
  env: Record<string, string | undefined>
  /** Starts Orbit again once this one has quit (app.relaunch). */
  relaunch: (execPath?: string) => void
}

/** Runs a program to its end; rejects with what it said when it fails. */
function run(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout: 5 * 60_000, windowsHide: true }, (err, _out, errText) => {
      if (err) reject(new Error(`${basename(program)} failed: ${String(errText).trim().slice(0, 200) || err.message}`))
      else resolve()
    })
  })
}

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Puts `ready` where `current` is; the old copy moves to `old`. Undone if the second move fails. */
function swap(current: string, ready: string, old: string): void {
  rmSync(old, { recursive: true, force: true })
  renameSync(current, old)
  try {
    renameSync(ready, current)
  } catch (err) {
    renameSync(old, current)
    throw err
  }
}

/** Removes these folders, if they are there; a failure leaves them for the next start. */
async function removeAll(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true }).catch(() => {})))
}

/** The one entry of a folder that holds `wanted`, or the folder itself when it does. */
function rootWith(folder: string, wanted: string): string | undefined {
  if (existsSync(join(folder, wanted))) return folder
  const entries = readdirSync(folder)
  if (entries.length === 1 && existsSync(join(folder, entries[0] as string, wanted))) {
    return join(folder, entries[0] as string)
  }
  return undefined
}

/** Linux's folder build: swaps the app's folder for the unpacked update. */
export function linuxInstaller(setup: InstallerSetup): Installer {
  const appDir = dirname(setup.execPath)
  const program = basename(setup.execPath)
  const parent = dirname(appDir)
  const unpacked = join(parent, `.${basename(appDir)}-update`)
  const old = join(parent, `.${basename(appDir)}-old`)
  return {
    problem() {
      if (!setup.packaged) return 'Only an installed copy of Orbit updates itself.'
      if (setup.env.APPIMAGE || setup.env.SNAP || setup.env.FLATPAK_ID) {
        return 'This copy of Orbit is updated through the package it came in.'
      }
      if (!writable(parent) || !writable(appDir)) return `Orbit can't write to ${parent}.`
      return ''
    },
    async stage(file, version) {
      await rm(unpacked, { recursive: true, force: true })
      await mkdir(unpacked, { recursive: true })
      await run('tar', ['-xzf', file, '-C', unpacked])
      const ready = rootWith(unpacked, program)
      if (!ready) throw new Error(`The update has no ${program} in it.`)
      return { version, file, ready }
    },
    apply(staged) {
      swap(appDir, staged.ready, old)
      // The same path now runs the new version.
      setup.relaunch()
    },
    cleanUp: () => removeAll([old, unpacked]),
  }
}

/** macOS: swaps Orbit.app for the unpacked update. */
export function macInstaller(setup: InstallerSetup): Installer {
  const at = setup.execPath.indexOf('.app/')
  const bundle = at > 0 ? setup.execPath.slice(0, at + 4) : ''
  const name = basename(bundle)
  const parent = dirname(bundle)
  const unpacked = join(parent, `.${name.replace(/\.app$/, '')}-update`)
  const old = join(parent, `.${name.replace(/\.app$/, '')}-old.app`)
  const inBundle = setup.execPath.slice(at + 5)
  return {
    problem() {
      if (!setup.packaged || !bundle) return 'Only an installed copy of Orbit updates itself.'
      // Run from the folder it was downloaded to, macOS runs a read-only copy elsewhere.
      if (bundle.includes('/AppTranslocation/')) return 'Move Orbit to your Applications folder to update it.'
      if (!writable(parent) || !writable(bundle)) return `Orbit can't write to ${parent}.`
      return ''
    },
    async stage(file, version) {
      await rm(unpacked, { recursive: true, force: true })
      await mkdir(unpacked, { recursive: true })
      await run('/usr/bin/ditto', ['-x', '-k', file, unpacked])
      const ready = existsSync(join(unpacked, name, inBundle))
        ? join(unpacked, name)
        : readdirSync(unpacked)
            .filter((entry) => entry.endsWith('.app'))
            .map((entry) => join(unpacked, entry))
            .find((app) => existsSync(join(app, inBundle)))
      if (!ready) throw new Error(`The update has no ${name} in it.`)
      return { version, file, ready }
    },
    apply(staged) {
      swap(bundle, staged.ready, old)
      setup.relaunch(join(bundle, inBundle))
    },
    cleanUp: () => removeAll([old, unpacked]),
  }
}

/** Windows: runs the installer silently once Orbit has quit; it starts Orbit again (`--force-run`). */
export function windowsInstaller(setup: InstallerSetup, productName: string): Installer {
  return {
    problem() {
      if (!setup.packaged) return 'Only an installed copy of Orbit updates itself.'
      // A copy the installer put in place has its uninstaller beside it; the installer updates that one.
      if (!existsSync(join(dirname(setup.execPath), `Uninstall ${productName}.exe`))) {
        return 'Only a copy of Orbit its installer put in place updates itself.'
      }
      return ''
    },
    async stage(file, version) {
      return { version, file, ready: file }
    },
    apply(staged) {
      spawn(staged.ready, ['/S', '--updated', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref()
    },
    cleanUp: async () => {},
  }
}

/** The file a test run writes instead of relaunching (ORBIT_E2E=1): what the relaunch would install. */
export const TEST_RELAUNCH_FILE = 'orbit-update-relaunch.json'

/** For e2e runs: installs nothing and starts nothing; records what a relaunch would have installed. */
export function testInstaller(userData: string): Installer {
  return {
    problem: () => '',
    stage: async (file, version) => ({ version, file, ready: file }),
    apply(staged) {
      writeFileSync(join(userData, TEST_RELAUNCH_FILE), JSON.stringify({ version: staged.version, file: staged.file }))
    },
    cleanUp: async () => {},
  }
}

/** The installer for this system. */
export function systemInstaller(setup: InstallerSetup, productName: string): Installer {
  if (setup.platform === 'darwin') return macInstaller(setup)
  if (setup.platform === 'win32') return windowsInstaller(setup, productName)
  return linuxInstaller(setup)
}
