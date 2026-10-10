import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDangerous, markFromInternet, quarantineValue, zoneIdentifier } from '../../src/main/downloads/safety'
import {
  isScreenshotName,
  listScreenshots,
  screenshotFolders,
  screenshotId,
} from '../../src/main/downloads/screenshots'
import { byDay, nameMatches, statusText } from '../../src/renderer/src/downloads/format'
import { ACTIONS_BY_ID, actionForInput, shortcutsFor } from '../../src/shared/actions'
import { extensionOf, fileKind, isMedia, showsInline } from '../../src/shared/commands/downloads'

const MB = 1024 * 1024

describe('[DL-10][DL-11] what a file is, from its name', () => {
  it('reads the extension, lowercased, from a name or a path', () => {
    expect(extensionOf('Report.PDF')).toBe('pdf')
    expect(extensionOf('/home/me/Downloads/archive.tar.gz')).toBe('gz')
    expect(extensionOf('C:\\Users\\me\\setup.EXE')).toBe('exe')
    expect(extensionOf('.bashrc')).toBe('')
    expect(extensionOf('README')).toBe('')
  })

  it('sorts files into kinds; unknown ones are "other"', () => {
    expect(fileKind('photo.JPG')).toBe('image')
    expect(fileKind('clip.webm')).toBe('video')
    expect(fileKind('song.mp3')).toBe('audio')
    expect(fileKind('paper.pdf')).toBe('pdf')
    expect(fileKind('notes.zip')).toBe('archive')
    expect(fileKind('setup.exe')).toBe('installer')
    expect(fileKind('sheet.xlsx')).toBe('document')
    expect(fileKind('data.json')).toBe('code')
    expect(fileKind('mystery.xyz')).toBe('other')
  })

  it('media tiles are images and videos Orbit can show (not HEIC or MKV)', () => {
    expect(isMedia('a.png')).toBe(true)
    expect(isMedia('a.webm')).toBe(true)
    expect(isMedia('a.mp4')).toBe(true)
    expect(isMedia('a.heic')).toBe(false)
    expect(isMedia('a.mkv')).toBe(false)
    expect(isMedia('a.mp3')).toBe(false)
    expect(showsInline('a.mp3')).toBe(true)
    expect(showsInline('a.csv')).toBe(false)
  })
})

describe('[DL-10][DL-14] how a download reads in the Library and the flyout', () => {
  const base = { receivedBytes: 3 * MB, totalBytes: 10 * MB }
  it('says its state, size or progress', () => {
    expect(statusText({ ...base, state: 'completed', receivedBytes: 10 * MB })).toBe('10 MB')
    expect(statusText({ ...base, state: 'completed', missing: true })).toBe('File missing')
    expect(statusText({ ...base, state: 'completed', danger: 'file-type' })).toBe('Can harm your computer')
    expect(statusText({ ...base, state: 'progressing' })).toBe('3 MB of 10 MB')
    expect(statusText({ ...base, state: 'paused' })).toBe('Paused · 3 MB of 10 MB')
    expect(statusText({ ...base, state: 'interrupted', canResume: true })).toBe('Failed · 3 MB of 10 MB')
    expect(statusText({ ...base, state: 'interrupted' })).toBe('Failed')
    expect(statusText({ ...base, state: 'cancelled' })).toBe('Cancelled')
  })

  it('groups downloads by local day, newest first', () => {
    const day = (d: number, h: number) => new Date(2026, 9, d, h, 30).getTime()
    const start = (d: number) => new Date(2026, 9, d).getTime()
    expect(byDay([day(10, 18), day(10, 9), day(9, 23), day(7, 1), day(7, 0)])).toEqual([
      [start(10), 2],
      [start(9), 1],
      [start(7), 2],
    ])
    expect(byDay([])).toEqual([])
  })

  it('search matches every word of a name, in any case and order', () => {
    expect(nameMatches('Quarterly Report 2026.pdf', 'report')).toBe(true)
    expect(nameMatches('Quarterly Report 2026.pdf', '2026 QUARTERLY')).toBe(true)
    expect(nameMatches('Quarterly Report 2026.pdf', 'report 2025')).toBe(false)
    expect(nameMatches('anything', '   ')).toBe(true)
  })
})

describe('[DL-12] download safety', () => {
  it('holds back programs, installers, scripts and disk images; Windows-only scripts elsewhere are just files', () => {
    for (const name of [
      'setup.exe',
      'Installer.MSI',
      'tool.dmg',
      'app.pkg',
      'pkg.deb',
      'x.AppImage',
      'a.jar',
      'b.apk',
    ]) {
      expect(isDangerous(name, 'linux'), name).toBe(true)
      expect(isDangerous(name, 'darwin'), name).toBe(true)
      expect(isDangerous(name, 'win32'), name).toBe(true)
    }
    for (const name of ['script.js', 'run.vbs', 'fix.reg', 'link.lnk']) {
      expect(isDangerous(name, 'win32'), name).toBe(true)
      expect(isDangerous(name, 'darwin'), name).toBe(false)
    }
    for (const name of ['report.pdf', 'photo.png', 'notes.zip', 'data.csv', 'setup.exe.txt', 'exe']) {
      expect(isDangerous(name, 'win32'), name).toBe(false)
    }
  })

  it("Windows' marker: from the Internet zone, with the page and the file's address but no password", () => {
    expect(
      zoneIdentifier({ url: 'https://me:secret@files.example/setup.exe', pageUrl: 'https://example.com/download' }),
    ).toBe(
      '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/download\r\nHostUrl=https://files.example/setup.exe\r\n',
    )
    // Addresses that aren't the web's (a blob: or data: URL) are left out.
    expect(zoneIdentifier({ url: 'blob:https://example.com/123' })).toBe('[ZoneTransfer]\r\nZoneId=3\r\n')
  })

  it("macOS' marker: downloaded, when, by Orbit", () => {
    expect(quarantineValue(Date.UTC(2026, 9, 10, 12))).toBe(
      `0081;${(Date.UTC(2026, 9, 10, 12) / 1000).toString(16)};Orbit;`,
    )
  })

  it('marks a finished file the way the OS does; Linux has no marker; a failure is never thrown', async () => {
    const runner = vi.fn(async () => {})
    const write = vi.fn(async () => {})
    const origin = { url: 'https://example.com/a.exe' }
    expect(await markFromInternet('/d/a.exe', origin, 'darwin', { runner, write })).toBe(true)
    expect(runner).toHaveBeenCalledWith('/usr/bin/xattr', [
      '-w',
      'com.apple.quarantine',
      expect.any(String),
      '/d/a.exe',
    ])
    expect(await markFromInternet('C:\\d\\a.exe', origin, 'win32', { runner, write })).toBe(true)
    expect(write).toHaveBeenCalledWith('C:\\d\\a.exe:Zone.Identifier', expect.stringContaining('ZoneId=3'))
    expect(await markFromInternet('/d/a.exe', origin, 'linux', { runner, write })).toBe(false)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = vi.fn(async () => {
      throw new Error('no extended attributes here')
    })
    expect(await markFromInternet('/d/a.exe', origin, 'darwin', { runner: failing })).toBe(false)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('[DL-05][DL-11] the OS screenshots', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-shots-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const file = (path: string, at: number) => {
    writeFileSync(path, 'x')
    utimesSync(path, at / 1000, at / 1000)
  }

  it('knows the names the OS gives screenshots', () => {
    expect(isScreenshotName('Screenshot 2026-10-10 at 09.41.00.png')).toBe(true)
    expect(isScreenshotName('Screen Shot 2022-01-01 at 10.00.00.png')).toBe(true)
    expect(isScreenshotName('Bildschirmfoto 2026-10-10 um 09.41.00.png')).toBe(true)
    expect(isScreenshotName('holiday.png')).toBe(false)
  })

  it('looks where each OS saves them', () => {
    const paths = { home: '/h', desktop: '/h/Desktop', pictures: '/h/Pictures' }
    expect(screenshotFolders('darwin', paths)).toEqual([{ path: '/h/Desktop', all: false }])
    expect(screenshotFolders('darwin', paths, '/h/Shots')).toEqual([{ path: '/h/Shots', all: false }])
    expect(screenshotFolders('win32', paths)).toEqual([{ path: join('/h/Pictures', 'Screenshots'), all: true }])
    expect(screenshotFolders('linux', paths)).toEqual([
      { path: join('/h/Pictures', 'Screenshots'), all: true },
      { path: '/h/Pictures', all: false },
    ])
  })

  it('lists screenshot images newest first: every image of a Screenshots folder, named ones elsewhere', async () => {
    const shots = join(dir, 'Screenshots')
    mkdirSync(shots)
    file(join(shots, 'capture-1.png'), Date.UTC(2026, 9, 10, 9))
    file(join(shots, 'notes.txt'), Date.UTC(2026, 9, 10, 11))
    file(join(dir, 'Screenshot 2026-10-10 at 10.00.00.png'), Date.UTC(2026, 9, 10, 10))
    file(join(dir, 'holiday.png'), Date.UTC(2026, 9, 10, 12))
    file(join(dir, 'Screenshot movie.mov'), Date.UTC(2026, 9, 10, 12))
    const list = await listScreenshots([
      { path: shots, all: true },
      { path: dir, all: false },
      { path: join(dir, 'missing'), all: true },
    ])
    expect(list.map((s) => s.name)).toEqual(['Screenshot 2026-10-10 at 10.00.00.png', 'capture-1.png'])
    expect(list[0]).toMatchObject({
      id: screenshotId(join(dir, 'Screenshot 2026-10-10 at 10.00.00.png')),
      path: join(dir, 'Screenshot 2026-10-10 at 10.00.00.png'),
      at: Date.UTC(2026, 9, 10, 10),
      size: 1,
    })
    expect(list[0]?.id).toMatch(/^shot-/)
    expect(await listScreenshots([{ path: shots, all: true }], 0)).toEqual([])
  })
})

describe('[DL-14] the Downloads keys', () => {
  it('⇧⌘J and ⌥⌘L on macOS, Ctrl+J on Windows and Linux, all for the one "Downloads" action', () => {
    const downloads = ACTIONS_BY_ID['app.downloads']
    expect(downloads?.title).toBe('Downloads')
    if (!downloads) return
    expect(shortcutsFor(downloads, 'darwin')).toEqual(['Cmd+Shift+J', 'Cmd+Alt+L'])
    expect(shortcutsFor(downloads, 'linux')).toEqual(['Ctrl+J'])
    expect(shortcutsFor(downloads, 'win32')).toEqual(['Ctrl+J'])
    const key = { key: 'j', code: 'KeyJ', shift: false, control: false, alt: false, meta: false }
    expect(actionForInput({ ...key, control: true }, 'linux')?.id).toBe('app.downloads')
    expect(actionForInput({ ...key, meta: true, shift: true, key: 'J' }, 'darwin')?.id).toBe('app.downloads')
    expect(actionForInput({ ...key, meta: true, alt: true, key: '¬', code: 'KeyL' }, 'darwin')?.id).toBe(
      'app.downloads',
    )
  })
})
