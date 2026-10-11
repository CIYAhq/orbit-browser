import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type DesktopSetup,
  desktopEntry,
  desktopPlan,
  execArg,
  WRITTEN_MARK,
  writeDesktopEntry,
} from '../../src/main/miniwindow/desktop-entry'
import { miniSwitchIn } from '../../src/main/miniwindow/switches'

/** A desktop entry's groups and keys, read the way a launcher reads them (string escapes undone). */
function parse(text: string): Map<string, Map<string, string>> {
  const groups = new Map<string, Map<string, string>>()
  let group: Map<string, string> | undefined
  for (const line of text.split('\n')) {
    const header = /^\[(.+)\]$/.exec(line)?.[1]
    if (header) {
      group = new Map()
      groups.set(header, group)
    } else if (group && line.includes('=')) {
      const at = line.indexOf('=')
      const unescaped = line
        .slice(at + 1)
        .replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r', s: ' ' })[c] ?? c)
      group.set(line.slice(0, at), unescaped)
    }
  }
  return groups
}

/** An Exec value split into arguments as the Desktop Entry spec says (quotes, escapes, `%%`). */
function execArgv(exec: string): string[] {
  const args: string[] = []
  let arg = ''
  let quoted = false
  let started = false
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]
    if (quoted) {
      if (c === '\\') arg += exec[++i]
      else if (c === '"') quoted = false
      else arg += c
    } else if (c === '"') {
      quoted = true
      started = true
    } else if (c === ' ') {
      if (started) args.push(arg)
      arg = ''
      started = false
    } else {
      arg += c
      started = true
    }
  }
  if (started) args.push(arg)
  return args.map((a) => a.replace(/%%/g, '%'))
}

const SETUP: DesktopSetup = {
  env: {},
  home: '/home/ada',
  appName: 'Orbit',
  execPath: '/home/ada/Apps/Orbit/orbit-browser',
  exists: () => false,
  read: () => undefined,
}

describe('Linux launcher actions (MW-14)', () => {
  it('[MW-14] the entry has New Mini Window and Show/Hide All Mini Windows, each running Orbit with its switch', () => {
    const entry = parse(
      desktopEntry({ name: 'Orbit', exec: '/opt/Orbit/orbit', icon: '/opt/Orbit/icon.png', wmClass: 'Orbit' }),
    )
    const main = entry.get('Desktop Entry')
    expect(main?.get('Type')).toBe('Application')
    expect(main?.get('Name')).toBe('Orbit')
    expect(main?.get('Exec')).toBe('/opt/Orbit/orbit %U')
    expect(main?.get('Icon')).toBe('/opt/Orbit/icon.png')
    expect(main?.get('StartupWMClass')).toBe('Orbit')
    const actions = (main?.get('Actions') ?? '').split(';').filter(Boolean)
    expect(actions).toHaveLength(2)
    const byName = new Map(actions.map((id) => [entry.get(`Desktop Action ${id}`)?.get('Name'), id]))
    const run = (name: string) => execArgv(entry.get(`Desktop Action ${byName.get(name)}`)?.get('Exec') ?? '')
    expect(miniSwitchIn(run('New Mini Window'))).toBe('new')
    expect(miniSwitchIn(run('Show/Hide All Mini Windows'))).toBe('toggle')
    expect(run('New Mini Window')[0]).toBe('/opt/Orbit/orbit')
    // No icon to point at: no Icon key.
    expect(
      parse(desktopEntry({ name: 'Orbit', exec: '/o', wmClass: 'Orbit' }))
        .get('Desktop Entry')
        ?.has('Icon'),
    ).toBe(false)
  })

  it('[MW-14] a program path with spaces, quotes, $, backquotes or backslashes reaches the launcher intact', () => {
    expect(execArg('/opt/Orbit/orbit')).toBe('/opt/Orbit/orbit')
    expect(execArg('/home/ada/My Apps/orbit')).toBe('"/home/ada/My Apps/orbit"')
    expect(execArg('/home/ada/100%/orbit')).toBe('/home/ada/100%%/orbit')
    for (const path of [
      '/home/ada/My Apps/orbit',
      '/home/ada/"odd"/orbit',
      '/home/ada/$HOME/`x`/orbit',
      '/home/ada/back\\slash/orbit',
      "/home/ada/it's/orbit",
      '/home/ada/semi;colon(paren)#hash/orbit',
      '/home/ada/tab\there/orbit',
    ]) {
      const entry = parse(desktopEntry({ name: 'Orbit', exec: path, wmClass: 'Orbit' }))
      expect(execArgv(entry.get('Desktop Entry')?.get('Exec') ?? '')).toEqual([path, '%U'])
      expect(execArgv(entry.get('Desktop Action new-mini-window')?.get('Exec') ?? '')).toEqual([
        path,
        '--new-mini-window',
      ])
    }
  })

  it("[MW-14] it goes in the user's applications folder, under Electron's desktop name, and runs the AppImage when there is one", () => {
    const plan = desktopPlan(SETUP)
    expect(plan).toMatchObject({ write: '/home/ada/.local/share/applications/Orbit.desktop' })
    expect('text' in plan && plan.text.includes(WRITTEN_MARK)).toBe(true)
    const placed = desktopPlan({
      ...SETUP,
      env: {
        XDG_DATA_HOME: '/data/ada',
        CHROME_DESKTOP: 'orbit-browser.desktop',
        APPIMAGE: '/home/ada/Orbit.AppImage',
      },
    })
    expect(placed).toMatchObject({ write: '/data/ada/applications/orbit-browser.desktop' })
    const main = parse('text' in placed ? placed.text : '').get('Desktop Entry')
    expect(execArgv(main?.get('Exec') ?? '')[0]).toBe('/home/ada/Orbit.AppImage')
    // The X11 window class stays the app's name whatever the entry is called.
    expect(main?.get('StartupWMClass')).toBe('Orbit')
    // A relative XDG_DATA_HOME is ignored, as the base directory spec says.
    expect(desktopPlan({ ...SETUP, env: { XDG_DATA_HOME: 'rel' } })).toMatchObject({
      write: '/home/ada/.local/share/applications/Orbit.desktop',
    })
  })

  it("[MW-14] it leaves alone sandboxed installs, a package's entry and an entry it didn't write, and rewrites its own only when stale", () => {
    expect(desktopPlan({ ...SETUP, env: { FLATPAK_ID: 'digital.ciya.Orbit' } })).toEqual({ skip: 'flatpak' })
    expect(desktopPlan({ ...SETUP, exists: (p) => p === '/.flatpak-info' })).toEqual({ skip: 'flatpak' })
    expect(desktopPlan({ ...SETUP, env: { SNAP: '/snap/orbit/1' } })).toEqual({ skip: 'snap' })
    // No launcher on GLib would run it.
    expect(desktopPlan({ ...SETUP, execPath: '/home/ada/100%/orbit' })).toEqual({ skip: 'path' })
    expect(desktopPlan({ ...SETUP, exists: (p) => p === '/usr/share/applications/Orbit.desktop' })).toEqual({
      skip: 'installed',
    })
    expect(
      desktopPlan({
        ...SETUP,
        env: { XDG_DATA_DIRS: '/var/lib/flatpak/exports/share:/opt/share' },
        exists: (p) => p === '/opt/share/applications/Orbit.desktop',
      }),
    ).toEqual({ skip: 'installed' })
    const user = '/home/ada/.local/share/applications/Orbit.desktop'
    const theirs = '[Desktop Entry]\nType=Application\nName=Orbit\nExec=/somewhere/else\n'
    expect(desktopPlan({ ...SETUP, exists: (p) => p === user, read: () => theirs })).toEqual({ skip: 'not ours' })
    // One it can't read may be someone else's too.
    expect(desktopPlan({ ...SETUP, exists: (p) => p === user, read: () => undefined })).toEqual({ skip: 'not ours' })
    const first = desktopPlan(SETUP)
    const ours = 'text' in first ? first.text : ''
    expect(desktopPlan({ ...SETUP, exists: (p) => p === user, read: () => ours })).toEqual({ skip: 'current' })
    // Orbit's folder moved: the entry follows it.
    expect(
      desktopPlan({ ...SETUP, execPath: '/opt/Orbit/orbit-browser', exists: (p) => p === user, read: () => ours }),
    ).toMatchObject({ write: user })
  })

  describe('writing it', () => {
    let dir = ''
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
      dir = ''
    })

    it('[MW-14] writes the entry once, keeps it current, and never overwrites one the user made', async () => {
      dir = mkdtempSync(join(tmpdir(), 'orbit-desktop-'))
      const env = { XDG_DATA_HOME: join(dir, 'home'), XDG_DATA_DIRS: join(dir, 'system') }
      const setup = { env, home: dir, appName: 'Orbit', execPath: '/opt/Orbit/orbit-browser' }
      const path = join(dir, 'home', 'applications', 'Orbit.desktop')
      expect(await writeDesktopEntry(setup)).toMatchObject({ write: path })
      const written = readFileSync(path, 'utf8')
      expect(parse(written).get('Desktop Action toggle-mini-windows')?.get('Name')).toBe('Show/Hide All Mini Windows')
      expect(await writeDesktopEntry(setup)).toEqual({ skip: 'current' })
      expect(await writeDesktopEntry({ ...setup, execPath: '/opt/Orbit 2/orbit-browser' })).toMatchObject({
        write: path,
      })
      expect(execArgv(parse(readFileSync(path, 'utf8')).get('Desktop Entry')?.get('Exec') ?? '')[0]).toBe(
        '/opt/Orbit 2/orbit-browser',
      )
      const mine = '[Desktop Entry]\nType=Application\nName=My Orbit\nExec=/opt/Orbit/orbit-browser --flag\n'
      writeFileSync(path, mine)
      expect(await writeDesktopEntry(setup)).toEqual({ skip: 'not ours' })
      expect(readFileSync(path, 'utf8')).toBe(mine)
      // A package installed Orbit's entry: none of Orbit's own is written.
      rmSync(path)
      await mkdir(join(dir, 'system', 'applications'), { recursive: true })
      writeFileSync(join(dir, 'system', 'applications', 'Orbit.desktop'), '[Desktop Entry]\n')
      expect(await writeDesktopEntry(setup)).toEqual({ skip: 'installed' })
    })

    it("[MW-14] leaves alone an entry it can't read: a link to nothing, a folder, a file it may not read", async () => {
      dir = mkdtempSync(join(tmpdir(), 'orbit-desktop-'))
      const env = { XDG_DATA_HOME: join(dir, 'home'), XDG_DATA_DIRS: join(dir, 'system') }
      const setup = { env, home: dir, appName: 'Orbit', execPath: '/opt/Orbit/orbit-browser' }
      const path = join(dir, 'home', 'applications', 'Orbit.desktop')
      await mkdir(join(dir, 'home', 'applications'), { recursive: true })
      // Writing through the link would make a file where it points.
      const target = join(dir, 'elsewhere.desktop')
      symlinkSync(target, path)
      expect(await writeDesktopEntry(setup)).toEqual({ skip: 'not ours' })
      expect(existsSync(target)).toBe(false)
      rmSync(path)
      mkdirSync(path)
      expect(await writeDesktopEntry(setup)).toEqual({ skip: 'not ours' })
      rmSync(path, { recursive: true })
      // Root reads any file: the plan's own test covers that case there.
      if (process.getuid?.() === 0) return
      const mine = '[Desktop Entry]\nName=Mine\n'
      writeFileSync(path, mine, { mode: 0o200 })
      expect(await writeDesktopEntry(setup)).toEqual({ skip: 'not ours' })
      chmodSync(path, 0o600)
      expect(readFileSync(path, 'utf8')).toBe(mine)
    })
  })
})
