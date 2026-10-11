import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runningVersion } from '../../src/main/settings/build-info'
import { normalizeSettingsPrefs } from '../../src/main/settings/normalize'
import { DownloadError, fetchPackage } from '../../src/main/updates/download'
import {
  type InstallerSetup,
  linuxInstaller,
  macInstaller,
  TEST_RELAUNCH_FILE,
  testInstaller,
  windowsInstaller,
} from '../../src/main/updates/install'
import { createInitialState } from '../../src/shared/defaults'
import type { Settings } from '../../src/shared/state'
import { MAX_PACKAGE_BYTES, parseFeed, systemKey, type UpdatePackage } from '../../src/shared/updates'

const SHA = 'a'.repeat(64)
const temp = () => mkdtempSync(join(tmpdir(), 'orbit-update-'))
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

describe('[UP-01][UP-05] an update file for this system, in the feed', () => {
  const own = (files: unknown) => ({ version: '2.0.0', url: 'https://example.com/r/2.0.0', files })

  it("reads Orbit's own feed: the file listed under this system, with its SHA-256 and size", () => {
    const files = {
      'linux-x64': { url: 'https://example.com/orbit-2.0.0-linux-x64.tar.gz', sha256: SHA.toUpperCase(), size: 1234 },
      'darwin-arm64': { url: 'https://example.com/orbit-2.0.0-darwin-arm64.zip', sha256: SHA, size: 99 },
    }
    expect(parseFeed(own(files), 'linux-x64')?.package).toEqual({
      url: 'https://example.com/orbit-2.0.0-linux-x64.tar.gz',
      sha256: SHA,
      size: 1234,
    })
    expect(parseFeed(own(files), 'darwin-arm64')?.package?.url).toMatch(/\.zip$/)
    // None for this system, or no system asked: the release's page instead (UP-10).
    expect(parseFeed(own(files), 'win32-x64')?.package).toBeUndefined()
    expect(parseFeed(own(files))?.package).toBeUndefined()
    expect(systemKey('linux', 'x64')).toBe('linux-x64')
  })

  it('takes a file only of its system’s kind, over https (or this computer), with a real SHA-256 and size', () => {
    const one = (file: unknown) => parseFeed(own({ 'linux-x64': file }), 'linux-x64')?.package
    const good = { url: 'https://example.com/o.tar.gz', sha256: SHA, size: 10 }
    expect(one(good)).toBeTruthy()
    expect(one({ ...good, url: 'http://127.0.0.1:3330/o.tar.gz' })).toBeTruthy()
    expect(one({ ...good, url: 'http://example.com/o.tar.gz' })).toBeUndefined()
    expect(one({ ...good, url: 'https://example.com/o.zip' })).toBeUndefined()
    expect(one({ ...good, url: 'https://example.com/o.tar.gz?x=.zip' })).toBeTruthy()
    expect(one({ ...good, sha256: 'abc' })).toBeUndefined()
    expect(one({ ...good, sha256: undefined })).toBeUndefined()
    expect(one({ ...good, size: 0 })).toBeUndefined()
    expect(one({ ...good, size: 1.5 })).toBeUndefined()
    expect(one({ ...good, size: MAX_PACKAGE_BYTES + 1 })).toBeUndefined()
    expect(one('https://example.com/o.tar.gz')).toBeUndefined()
  })

  it("reads a GitHub release's asset for this system, with GitHub's digest", () => {
    const release = {
      tag_name: 'v2.0.0',
      html_url: 'https://github.com/o/r/releases/tag/v2.0.0',
      assets: [
        {
          name: 'orbit-2.0.0-linux-arm64.tar.gz',
          browser_download_url: 'https://g.example/a.tar.gz',
          digest: `sha256:${SHA}`,
          size: 5,
        },
        {
          name: 'orbit-2.0.0-linux-x64.tar.gz',
          browser_download_url: 'https://g.example/b.tar.gz',
          digest: `sha256:${SHA}`,
          size: 7,
        },
        { name: 'orbit-2.0.0-win32-x64.exe', browser_download_url: 'https://g.example/c.exe', digest: null, size: 9 },
      ],
    }
    expect(parseFeed(release, 'linux-x64')?.package).toEqual({
      url: 'https://g.example/b.tar.gz',
      sha256: SHA,
      size: 7,
    })
    // No digest to check it against: not taken.
    expect(parseFeed(release, 'win32-x64')?.package).toBeUndefined()
  })
})

/** A session whose `fetch` answers `body` in chunks, as `status`; records what it was asked. */
function fakeSession(body: Buffer, opts: { status?: number; chunk?: number } = {}) {
  const asked: { url: string; init: RequestInit }[] = []
  const ses = {
    fetch: async (url: string, init: RequestInit) => {
      asked.push({ url, init })
      const chunk = opts.chunk ?? 1000
      let at = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= body.length) return controller.close()
          controller.enqueue(new Uint8Array(body.subarray(at, at + chunk)))
          at += chunk
        },
      })
      return new Response(stream, { status: opts.status ?? 200 })
    },
  }
  return { ses: ses as unknown as Session, asked }
}

describe('[UP-01] downloading an update', () => {
  const data = Buffer.alloc(10_500, 7)
  const pkg = (over: Partial<UpdatePackage> = {}): UpdatePackage => ({
    url: 'http://127.0.0.1:3330/o.tar.gz',
    sha256: sha256(data),
    size: data.length,
    ...over,
  })

  it('saves a file that matches its SHA-256 and size, saying how far it got, through no redirect and no cookies', async () => {
    const dir = temp()
    const file = join(dir, 'o.tar.gz')
    const { ses, asked } = fakeSession(data)
    const shares: number[] = []
    await fetchPackage(ses, pkg(), file, { follow: false, onProgress: (s) => shares.push(s) })
    expect(readFileSync(file).equals(data)).toBe(true)
    expect(readdirSync(dir)).toEqual(['o.tar.gz'])
    expect(shares.length).toBeGreaterThan(5)
    expect(shares.at(-1)).toBe(1)
    expect(asked[0]?.init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' })
    // Release builds follow a redirect (a release's files are often served from elsewhere).
    const other = fakeSession(data)
    await fetchPackage(other.ses, pkg(), join(dir, 'p.tar.gz'), { follow: true, onProgress: () => {} })
    expect(other.asked[0]?.init.redirect).toBe('follow')
  })

  it('throws away a file that is not the one the feed describes', async () => {
    const dir = temp()
    const file = join(dir, 'o.tar.gz')
    const fails = async (body: Buffer, over: Partial<UpdatePackage>, status = 200) => {
      const { ses } = fakeSession(body, { status })
      const err = await fetchPackage(ses, pkg(over), file, { follow: false, onProgress: () => {} }).catch((e) => e)
      expect(err).toBeInstanceOf(DownloadError)
      expect(readdirSync(dir)).toEqual([])
      return (err as Error).message
    }
    expect(await fails(data, { sha256: SHA })).toBe('The download doesn’t match its checksum.')
    expect(await fails(data, { size: data.length - 1 })).toBe('The download is larger than the feed says.')
    expect(await fails(data, { size: data.length + 1 })).toBe('The download ended early.')
    expect(await fails(data, {}, 404)).toBe('The download answered 404.')
  })
})

describe('[UP-05] putting the update in place at the relaunch', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const setup = (execPath: string, over: Partial<InstallerSetup> = {}): InstallerSetup => ({
    platform: 'linux',
    execPath,
    packaged: true,
    env: {},
    relaunch: vi.fn(),
    ...over,
  })

  /** An installed folder build: <root>/apps/Orbit/orbit, saying "old". */
  function installed(): { root: string; app: string; exec: string } {
    const root = temp()
    const app = join(root, 'apps', 'Orbit')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'orbit'), 'old')
    return { root, app, exec: join(app, 'orbit') }
  }

  /** A .tar.gz of an app folder saying "new", inside a folder of its own or at its top. */
  function tarball(root: string, nested: boolean, program = 'orbit'): string {
    const src = join(root, 'pkg')
    const folder = nested ? join(src, 'Orbit-2.0.0') : src
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, program), 'new')
    writeFileSync(join(folder, 'resources.pak'), 'pak')
    const file = join(root, 'orbit-2.0.0-linux-x64.tar.gz')
    execFileSync('tar', ['-czf', file, '-C', src, '.'])
    return file
  }

  it.runIf(process.platform !== 'win32')(
    'Linux: unpacks the folder build beside the running one, swaps them at quit, starts the new one and clears the old at the next start',
    async () => {
      for (const nested of [true, false]) {
        const { root, app, exec } = installed()
        const s = setup(exec)
        const installer = linuxInstaller(s)
        expect(installer.problem()).toBe('')
        const staged = await installer.stage(tarball(root, nested), '2.0.0')
        // Nothing changes until the relaunch.
        expect(readFileSync(exec, 'utf8')).toBe('old')
        installer.apply(staged)
        expect(readFileSync(exec, 'utf8')).toBe('new')
        expect(readFileSync(join(app, 'resources.pak'), 'utf8')).toBe('pak')
        expect(s.relaunch).toHaveBeenCalledWith()
        expect(readdirSync(join(root, 'apps'))).toEqual(expect.arrayContaining(['.Orbit-old', 'Orbit']))
        await installer.cleanUp()
        expect(readdirSync(join(root, 'apps'))).toEqual(['Orbit'])
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'Linux: an update without Orbit in it is refused and changes nothing',
    async () => {
      const { root, exec } = installed()
      const installer = linuxInstaller(setup(exec))
      await expect(installer.stage(tarball(root, true, 'other'), '2.0.0')).rejects.toThrow(
        'The update has no orbit in it.',
      )
      expect(readFileSync(exec, 'utf8')).toBe('old')
    },
  )

  it('says why a copy can’t update itself: a development run, a package manager’s copy, a folder it can’t write', () => {
    const { exec } = installed()
    expect(linuxInstaller(setup(exec, { packaged: false })).problem()).toBe(
      'Only an installed copy of Orbit updates itself.',
    )
    for (const env of [{ APPIMAGE: '/x.AppImage' }, { SNAP: '/snap/orbit' }, { FLATPAK_ID: 'digital.ciya.orbit' }]) {
      expect(linuxInstaller(setup(exec, { env })).problem()).toBe(
        'This copy of Orbit is updated through the package it came in.',
      )
    }
    expect(linuxInstaller(setup('/nonexistent/Orbit/orbit')).problem()).toBe("Orbit can't write to /nonexistent.")
    // macOS: a copy run from where it was downloaded runs from a read-only place.
    const translocated = '/private/var/folders/x/T/AppTranslocation/ABC/d/Orbit.app/Contents/MacOS/Orbit'
    expect(macInstaller(setup(translocated, { platform: 'darwin' })).problem()).toBe(
      'Move Orbit to your Applications folder to update it.',
    )
    expect(macInstaller(setup('/usr/local/bin/orbit', { platform: 'darwin' })).problem()).toBe(
      'Only an installed copy of Orbit updates itself.',
    )
    // Windows: only a copy its installer put in place (its uninstaller is beside it).
    const win = temp()
    const winExec = join(win, 'Orbit.exe')
    expect(windowsInstaller(setup(winExec, { platform: 'win32' }), 'Orbit').problem()).toBe(
      'Only a copy of Orbit its installer put in place updates itself.',
    )
    writeFileSync(join(win, 'Uninstall Orbit.exe'), '')
    expect(windowsInstaller(setup(winExec, { platform: 'win32' }), 'Orbit').problem()).toBe('')
  })

  it('test runs install nothing and start nothing: they record what the relaunch would install', async () => {
    const userData = temp()
    const installer = testInstaller(userData)
    const staged = await installer.stage('/x/orbit-2.0.0-linux-x64.tar.gz', '2.0.0')
    installer.apply(staged)
    expect(JSON.parse(readFileSync(join(userData, TEST_RELAUNCH_FILE), 'utf8'))).toEqual({
      version: '2.0.0',
      file: '/x/orbit-2.0.0-linux-x64.tar.gz',
    })
    expect(existsSync('/x')).toBe(false)
  })

  it('a test run can start as another version, to start "after an update"; nothing else can', () => {
    expect(runningVersion('0.1.0')).toBe('0.1.0')
    vi.stubEnv('ORBIT_E2E_VERSION', '2.0.0')
    expect(runningVersion('0.1.0')).toBe('0.1.0')
    vi.stubEnv('ORBIT_E2E', '1')
    expect(runningVersion('0.1.0')).toBe('2.0.0')
    vi.stubEnv('ORBIT_E2E_VERSION', 'not a version')
    expect(runningVersion('0.1.0')).toBe('0.1.0')
  })
})

describe("[UP-06] the update a relaunch installs, saved for the next start's What's new", () => {
  const load = (settings: Record<string, unknown>) => {
    const state = createInitialState(0)
    state.settings = { ...state.settings, ...settings } as unknown as Settings
    normalizeSettingsPrefs(state)
    return state.settings
  }

  it('keeps its version, line and page; drops what is not a version, a long line or a page that is not https', () => {
    const pending = { version: '2.0.0', summary: 'Calmer colours', url: 'https://example.com/r/2.0.0' }
    expect(load({ pendingUpdate: pending }).pendingUpdate).toEqual(pending)
    expect(load({ pendingUpdate: { version: 'nope' } }).pendingUpdate).toBeUndefined()
    expect(
      load({ pendingUpdate: { ...pending, summary: 'x'.repeat(201), url: 'javascript:alert(1)' } }).pendingUpdate,
    ).toEqual({
      version: '2.0.0',
    })
    const news = { version: '2.0.0', since: 5, summary: 'Calmer colours', url: 'http://127.0.0.1:3330/r' }
    expect(load({ whatsNew: news }).whatsNew).toEqual(news)
    expect(load({ whatsNew: { ...news, url: 'file:///etc/passwd' } }).whatsNew).toEqual({
      version: '2.0.0',
      since: 5,
      summary: 'Calmer colours',
    })
  })
})
