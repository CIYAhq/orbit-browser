/**
 * Linux launcher actions (MW-14): New Mini Window and Show/Hide All Mini Windows in the menu of
 * Orbit's launcher (a dock's or the app grid's right-click menu), as in the Windows jump list and
 * the macOS dock menu (MW-08). Each runs Orbit again with a switch, which reaches the running app
 * as a second instance (switches.ts).
 *
 * Launcher actions live in a desktop entry. A packaged Linux build that no package installed (the
 * plain folder build) has none, so it writes its own to the user's applications folder at start-up,
 * pointing at where it runs from, and keeps it current. It never touches an entry it didn't write,
 * and an entry a package installed wins. Kept apart from Electron so it is unit-tested.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NEW_MINI_SWITCH, TOGGLE_MINIS_SWITCH } from './switches'

/** Marks the entries Orbit wrote itself: the only ones it ever rewrites. */
export const WRITTEN_MARK = 'X-Orbit-Written=true'

export interface DesktopEntryInfo {
  /** The app's name in launchers. */
  name: string
  /** The program to run (an AppImage's own path when it runs from one). */
  exec: string
  /** A PNG for the launcher, if the build has one. */
  icon?: string
  /** The windows' class (X11 WM_CLASS, Wayland app id), which ties them to the entry. */
  wmClass: string
}

/** A string value as the Desktop Entry spec writes one: no line breaks, backslashes escaped. */
function text(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
}

/**
 * One argument of an Exec key (Desktop Entry spec, "The Exec key"): `%` doubled (it starts a field
 * code otherwise), and quoted when it holds a reserved character, with `"`, `` ` ``, `$` and `\`
 * escaped inside the quotes. The key's value then gets the string escapes too, which double each
 * backslash again.
 */
export function execArg(arg: string): string {
  const literal = arg.replace(/%/g, '%%')
  if (!/[\s"'\\<>~|&;$*?#()`]/.test(literal)) return literal
  return `"${literal.replace(/["`$\\]/g, (c) => `\\${c}`)}"`
}

/** The desktop entry, with its two launcher actions. */
export function desktopEntry(info: DesktopEntryInfo): string {
  const exec = (...args: string[]) => `Exec=${text([execArg(info.exec), ...args].join(' '))}`
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${text(info.name)}`,
    'GenericName=Web Browser',
    exec('%U'),
    ...(info.icon ? [`Icon=${text(info.icon)}`] : []),
    'Terminal=false',
    'Categories=Network;WebBrowser;',
    `StartupWMClass=${text(info.wmClass)}`,
    'StartupNotify=true',
    'Actions=new-mini-window;toggle-mini-windows;',
    WRITTEN_MARK,
    '',
    '[Desktop Action new-mini-window]',
    'Name=New Mini Window',
    exec(NEW_MINI_SWITCH),
    '',
    '[Desktop Action toggle-mini-windows]',
    'Name=Show/Hide All Mini Windows',
    exec(TOGGLE_MINIS_SWITCH),
    '',
  ].join('\n')
}

export interface DesktopSetup {
  env: Record<string, string | undefined>
  home: string
  /** The app's name (Electron's app.name). */
  appName: string
  /** The running program (process.execPath). */
  execPath: string
  icon?: string
  /** Whether something is at a path (a link counts, even one to nothing). */
  exists: (path: string) => boolean
  /** A file's text, if it can be read. */
  read: (path: string) => string | undefined
}

export type DesktopPlan = { write: string; text: string } | { skip: string }

/** The desktop entry's file name: Electron's (CHROME_DESKTOP), else the app's name. */
function entryName(env: DesktopSetup['env'], appName: string): string {
  const named = env.CHROME_DESKTOP?.trim()
  return named && /^[^/\\]+\.desktop$/.test(named) ? named : `${appName}.desktop`
}

/** Whether to write the user's desktop entry at start-up, and what. */
export function desktopPlan(setup: DesktopSetup): DesktopPlan {
  const { env } = setup
  // These give the app its entry themselves.
  if (env.FLATPAK_ID || setup.exists('/.flatpak-info')) return { skip: 'flatpak' }
  if (env.SNAP) return { skip: 'snap' }
  const name = entryName(env, setup.appName)
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((dir) => dir.startsWith('/'))
  if (dataDirs.some((dir) => setup.exists(join(dir, 'applications', name)))) return { skip: 'installed' }
  const dataHome = env.XDG_DATA_HOME?.startsWith('/') ? env.XDG_DATA_HOME : join(setup.home, '.local', 'share')
  const path = join(dataHome, 'applications', name)
  const exec = env.APPIMAGE?.startsWith('/') ? env.APPIMAGE : setup.execPath
  // GLib checks that the program exists before it turns `%%` back into `%`, so GNOME and its kin
  // ignore an entry whose program path has a `%` in it, however it is written.
  if (exec.includes('%')) return { skip: 'path' }
  const entry = desktopEntry({
    name: setup.appName,
    exec,
    icon: setup.icon,
    // Electron's X11 window class is the app's name (on Wayland the entry's own name ties them).
    wmClass: setup.appName,
  })
  if (setup.exists(path)) {
    // What it can't read (a link to nothing, a folder, a file it may not read) may be someone else's.
    const current = setup.read(path)
    if (current === undefined || !current.split('\n').includes(WRITTEN_MARK)) return { skip: 'not ours' }
    if (current === entry) return { skip: 'current' }
  }
  return { write: path, text: entry }
}

/** Writes the user's desktop entry if it should (see desktopPlan); returns what it did. */
export async function writeDesktopEntry(setup: Omit<DesktopSetup, 'exists' | 'read'>): Promise<DesktopPlan> {
  const plan = desktopPlan({
    ...setup,
    exists: (path) => {
      try {
        lstatSync(path)
        return true
      } catch {
        return false
      }
    },
    read: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
  })
  if ('write' in plan) {
    await mkdir(dirname(plan.write), { recursive: true })
    await writeFile(plan.write, plan.text, { mode: 0o644 })
  }
  return plan
}
