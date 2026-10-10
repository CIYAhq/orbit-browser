import { describe, expect, it, vi } from 'vitest'
import { fileClipboardData, showsInline } from '../../src/main/downloads/file-kinds'
import { type DownloadMenuActions, downloadMenu } from '../../src/main/downloads/menu'
import { dockProgress, sameProgress } from '../../src/main/downloads/progress'
import {
  formatBytes,
  formatProgress,
  formatTimeLeft,
  percentDone,
  secondsLeft,
  smoothSpeed,
  splitName,
} from '../../src/renderer/src/downloads/format'
import type { DownloadEntry } from '../../src/shared/commands/downloads'

const MB = 1024 * 1024

describe('[DL-03] sizes, progress and time left', () => {
  it('formats sizes 1024-based, with one decimal under 10', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3.27 * MB)).toBe('3.2 MB')
    expect(formatBytes(10 * MB)).toBe('10 MB')
    expect(formatBytes(734 * MB)).toBe('734 MB')
    expect(formatBytes(1.5 * 1024 * MB)).toBe('1.5 GB')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })

  it('shows bytes received of the total, or only the bytes when the total is unknown', () => {
    expect(formatProgress(3.2 * MB, 10 * MB)).toBe('3.2 MB of 10 MB')
    expect(formatProgress(3.2 * MB, 0)).toBe('3.2 MB')
  })

  it('tells the time left from the speed, and nothing when it is stalled or the total unknown', () => {
    expect(secondsLeft(2 * MB, 10 * MB, MB)).toBe(8)
    expect(secondsLeft(2 * MB, 10 * MB, 0)).toBeUndefined()
    expect(secondsLeft(2 * MB, 0, MB)).toBeUndefined()
    expect(formatTimeLeft(0.2)).toBe('1 s left')
    expect(formatTimeLeft(42.1)).toBe('43 s left')
    expect(formatTimeLeft(150)).toBe('3 min left')
    expect(formatTimeLeft(3600)).toBe('1 h left')
    expect(formatTimeLeft(4800)).toBe('1 h 20 min left')
    expect(formatTimeLeft(7190)).toBe('2 h left')
  })

  it('smooths the speed so the estimate does not jump about', () => {
    expect(smoothSpeed(undefined, 100)).toBe(100)
    expect(smoothSpeed(100, 200)).toBe(130)
    expect(smoothSpeed(100, 0)).toBe(70)
  })

  it('percent done stays within 0–100, unknown without a total', () => {
    expect(percentDone(5, 10)).toBe(50)
    expect(percentDone(12, 10)).toBe(100)
    expect(percentDone(5, 0)).toBeUndefined()
  })

  it('truncates names in the middle: the end and the extension stay', () => {
    expect(splitName('quarterly-report-final.pdf')).toEqual({ head: 'quarterly-report', tail: '-final.pdf' })
    expect(splitName('a-very-long-archive-name.tar.gz')).toEqual({
      head: 'a-very-long-archive-n',
      tail: 'ame.tar.gz',
    })
    // Short names, and names without an extension.
    expect(splitName('notes.zip')).toEqual({ head: '', tail: 'notes.zip' })
    expect(splitName('README-for-the-project')).toEqual({ head: 'README-for-t', tail: 'he-project' })
    const { head, tail } = splitName('some-name.csv')
    expect(head + tail).toBe('some-name.csv')
  })
})

const download = (fields: Partial<DownloadEntry>): DownloadEntry => ({
  id: 'd1',
  url: 'http://localhost/file.zip',
  filename: 'file.zip',
  savePath: '/tmp/file.zip',
  state: 'completed',
  receivedBytes: 10,
  totalBytes: 10,
  startedAt: 1,
  profileId: 'p-default',
  ...fields,
})

const actions = (): DownloadMenuActions => ({
  open: vi.fn(),
  showInFolder: vi.fn(),
  copyFile: vi.fn(),
  copyLink: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  delete: vi.fn(),
  keep: vi.fn(),
  discard: vi.fn(),
})

const labels = (d: DownloadEntry, platform = 'linux') =>
  downloadMenu(d, actions(), platform).map((i) => (i.type === 'separator' ? '-' : i.label))

describe('[DL-04][DL-08][DL-15] a download menu fits its state', () => {
  it('a finished download: open, show, copy, remove, delete', () => {
    expect(labels(download({}), 'darwin')).toEqual([
      'Open',
      'Show in Finder',
      '-',
      'Copy File',
      'Copy Download Link',
      '-',
      'Remove from List',
      'Delete File',
    ])
    expect(labels(download({}), 'win32')[1]).toBe('Show in Folder')
  })

  it('a finished download whose file is gone: "File Missing", download it again', () => {
    const items = downloadMenu(download({ missing: true }), actions(), 'linux')
    expect(items.map((i) => i.label ?? '-')).toEqual([
      'File Missing',
      'Download Again',
      '-',
      'Copy Download Link',
      '-',
      'Remove from List',
    ])
    expect(items[0]?.enabled).toBe(false)
  })

  it('[DL-12] held back as possibly harmful: keep or discard', () => {
    const a = actions()
    const items = downloadMenu(download({ danger: 'file-type' }), a, 'linux')
    expect(items.map((i) => i.label ?? '-')).toEqual(['Keep', 'Discard', '-', 'Copy Download Link'])
    for (const item of items.slice(0, 2)) (item.click as () => void)()
    expect(a.keep).toHaveBeenCalledOnce()
    expect(a.discard).toHaveBeenCalledOnce()
    // Its file gone meanwhile: like any missing file.
    expect(labels(download({ danger: 'file-type', missing: true }))[0]).toBe('File Missing')
  })

  it('running: pause or resume, cancel; failed: resume when it can continue, else retry', () => {
    expect(labels(download({ state: 'progressing' }))).toEqual(['Pause', 'Cancel', '-', 'Copy Download Link'])
    expect(labels(download({ state: 'paused' }))).toEqual(['Resume', 'Cancel', '-', 'Copy Download Link'])
    expect(labels(download({ state: 'interrupted', canResume: true }))[0]).toBe('Resume')
    expect(labels(download({ state: 'interrupted', canResume: false }))[0]).toBe('Retry')
    expect(labels(download({ state: 'cancelled' }))).toEqual([
      'Retry',
      '-',
      'Copy Download Link',
      '-',
      'Remove from List',
    ])
  })

  it('each item runs its action', () => {
    const a = actions()
    const items = downloadMenu(download({}), a, 'linux')
    for (const item of items) (item.click as (() => void) | undefined)?.()
    expect(a.open).toHaveBeenCalledOnce()
    expect(a.showInFolder).toHaveBeenCalledOnce()
    expect(a.copyFile).toHaveBeenCalledOnce()
    expect(a.copyLink).toHaveBeenCalledOnce()
    expect(a.remove).toHaveBeenCalledOnce()
    expect(a.delete).toHaveBeenCalledOnce()
    expect(a.cancel).not.toHaveBeenCalled()
  })
})

describe('[DL-04] files', () => {
  it('opens PDFs, images, text, audio and video in a tab; anything else in its app', () => {
    for (const name of ['a.pdf', 'b.PNG', 'c.jpeg', 'd.gif', 'e.txt', 'f.json', 'g.mp4', 'h.mp3', 'i.webm']) {
      expect(showsInline(`/tmp/${name}`), name).toBe(true)
    }
    for (const name of ['a.zip', 'b.dmg', 'c.exe', 'd.docx', 'e', 'f.html', 'g.svg']) {
      expect(showsInline(`/tmp/${name}`), name).toBe(false)
    }
  })

  it('a copied file pastes as the file: its path as text, its URL in the file managers’ formats', () => {
    const raw = (format: string) => `electron application/osclipboard;format="${format}"`
    expect(fileClipboardData('/tmp/my report.pdf', 'linux')).toEqual({
      'text/plain': '/tmp/my report.pdf',
      'text/uri-list': 'file:///tmp/my%20report.pdf',
      [raw('x-special/gnome-copied-files')]: 'copy\nfile:///tmp/my%20report.pdf',
    })
    expect(fileClipboardData('/tmp/a.zip', 'darwin')).toEqual({
      'text/plain': '/tmp/a.zip',
      'text/uri-list': 'file:///tmp/a.zip',
      [raw('public.file-url')]: 'file:///tmp/a.zip',
    })
  })
})

describe('[DL-17] the Dock and taskbar progress', () => {
  const d = (state: DownloadEntry['state'], receivedBytes: number, totalBytes: number) =>
    ({ state, receivedBytes, totalBytes }) as DownloadEntry

  it('is the bytes received of those expected, over the downloads running or paused', () => {
    expect(dockProgress([])).toBeUndefined()
    expect(dockProgress([d('completed', 10, 10), d('interrupted', 1, 10)])).toBeUndefined()
    expect(dockProgress([d('progressing', 25, 100), d('paused', 50, 100), d('completed', 1, 1)])).toEqual({
      value: 0.375,
      mode: 'normal',
    })
    // Sizes not known yet don't count; with none known, the bar can't tell.
    expect(dockProgress([d('progressing', 30, 0), d('progressing', 10, 40)])).toEqual({ value: 0.25, mode: 'normal' })
    expect(dockProgress([d('progressing', 30, 0)])).toEqual({ value: 2, mode: 'indeterminate' })
    // Every one paused; more received than announced.
    expect(dockProgress([d('paused', 5, 10)])).toEqual({ value: 0.5, mode: 'paused' })
    expect(dockProgress([d('progressing', 15, 10)])).toEqual({ value: 1, mode: 'normal' })
  })

  it('changes on screen in whole percents', () => {
    expect(sameProgress({ value: 0.501, mode: 'normal' }, { value: 0.504, mode: 'normal' })).toBe(true)
    expect(sameProgress({ value: 0.5, mode: 'normal' }, { value: 0.51, mode: 'normal' })).toBe(false)
    expect(sameProgress({ value: 0.5, mode: 'normal' }, { value: 0.5, mode: 'paused' })).toBe(false)
    expect(sameProgress(undefined, undefined)).toBe(true)
    expect(sameProgress(undefined, { value: 0, mode: 'normal' })).toBe(false)
  })
})
