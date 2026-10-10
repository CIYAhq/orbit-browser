import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  freePath,
  moveFile,
  numberedName,
  PARTIAL_SUFFIX,
  safeFilename,
  splitName,
} from '../../src/main/downloads/names'
import { type DownloadRecord, DownloadStore } from '../../src/main/downloads/store'
import { isRuntimeOnlyPatch, normalizeState } from '../../src/main/persist'
import { createInitialState } from '../../src/shared/defaults'
import type { Download, OrbitState } from '../../src/shared/state'

const tmp = () => mkdtempSync(join(tmpdir(), 'orbit-downloads-'))

const record = (id: string, fields: Partial<DownloadRecord> = {}): DownloadRecord => ({
  id,
  url: `http://localhost/${id}.zip`,
  filename: `${id}.zip`,
  savePath: `/tmp/${id}.zip`,
  state: 'completed',
  receivedBytes: 10,
  totalBytes: 10,
  startedAt: 1000,
  profileId: 'p-default',
  ...fields,
})

describe('download file names', () => {
  it('[DL-01] numbers a name that is taken: report (1).pdf, then report (2).pdf', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'report.pdf'), 'x')
    const taken = (p: string) => existsSync(p)
    expect(freePath(dir, 'report.pdf', taken)).toBe(join(dir, 'report (1).pdf'))
    writeFileSync(join(dir, 'report (1).pdf'), 'x')
    expect(freePath(dir, 'report.pdf', taken)).toBe(join(dir, 'report (2).pdf'))
    expect(freePath(dir, 'other.pdf', taken)).toBe(join(dir, 'other.pdf'))
  })

  it('[DL-01] a partial file still there takes its name too', () => {
    const dir = tmp()
    writeFileSync(join(dir, `data.csv${PARTIAL_SUFFIX}`), 'x')
    expect(freePath(dir, 'data.csv', (p) => existsSync(p))).toBe(join(dir, 'data (1).csv'))
  })

  it('[DL-01] keeps double extensions and names without one whole', () => {
    expect(splitName('logs.tar.gz')).toEqual(['logs', '.tar.gz'])
    expect(numberedName('logs.tar.gz', 1)).toBe('logs (1).tar.gz')
    expect(numberedName('README', 2)).toBe('README (2)')
    expect(numberedName('archive.zip', 0)).toBe('archive.zip')
  })

  it('[DL-01] makes names safe on every platform', () => {
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j.txt')).toBe('a_b_c_d_e_f_g_h_i_j.txt')
    expect(safeFilename('  .hidden  ')).toBe('hidden')
    expect(safeFilename('notes.txt...')).toBe('notes.txt')
    expect(safeFilename('tab\there.txt')).toBe('tab_here.txt')
    expect(safeFilename('CON.txt')).toBe('_CON.txt')
    expect(safeFilename('')).toBe('download')
    expect(safeFilename('...')).toBe('download')
    const long = safeFilename(`${'x'.repeat(400)}.pdf`)
    expect(long.length).toBeLessThanOrEqual(180)
    expect(long.endsWith('.pdf')).toBe(true)
  })
})

describe('downloads list', () => {
  it('[DL-01] keeps every download, newest first, per profile, across restarts', async () => {
    const file = join(tmp(), 'downloads.json')
    const a = new DownloadStore(file, 1000, 5)
    a.put(record('d-1'))
    a.put(record('d-2', { profileId: 'p-work' }))
    a.put(record('d-3'))
    a.update('d-3', { state: 'interrupted', canResume: true })
    expect(a.list('p-default').map((r) => r.id)).toEqual(['d-3', 'd-1'])
    expect(a.list().map((r) => r.id)).toEqual(['d-3', 'd-2', 'd-1'])
    await a.settle()
    const b = new DownloadStore(file)
    expect(b.list().map((r) => r.id)).toEqual(['d-3', 'd-2', 'd-1'])
    expect(b.get('d-3')).toMatchObject({ state: 'interrupted', canResume: true })
  })

  it('[DL-01] a download cut off by a quit or crash loads as interrupted', () => {
    const file = join(tmp(), 'downloads.json')
    const a = new DownloadStore(file)
    a.put(record('d-1', { state: 'progressing', resume: resumeOf('/tmp/d-1.zip.crdownload') }))
    a.put(record('d-2', { state: 'paused' }))
    a.flushSync()
    const b = new DownloadStore(file)
    expect(b.get('d-1')?.state).toBe('interrupted')
    expect(b.get('d-1')?.resume?.tempPath).toBe('/tmp/d-1.zip.crdownload')
    expect(b.get('d-2')?.state).toBe('interrupted')
  })

  it('removes entries, drops the oldest finished ones past the limit, never running ones', () => {
    const store = new DownloadStore(join(tmp(), 'downloads.json'), 3)
    store.put(record('d-1', { state: 'progressing' }))
    store.put(record('d-2'))
    store.put(record('d-3'))
    store.put(record('d-4'))
    expect(store.list().map((r) => r.id)).toEqual(['d-4', 'd-3', 'd-1'])
    expect(store.remove('d-3')).toBe(true)
    expect(store.removeWhere((r) => r.state === 'completed').map((r) => r.id)).toEqual(['d-4'])
    expect(store.list().map((r) => r.id)).toEqual(['d-1'])
  })

  it('an update with an undefined field removes it', () => {
    const store = new DownloadStore(join(tmp(), 'downloads.json'))
    store.put(record('d-1', { state: 'interrupted', canResume: true, resume: resumeOf('/x') }))
    store.update('d-1', { state: 'completed', canResume: undefined, resume: undefined })
    const r = store.get('d-1')
    expect(r?.state).toBe('completed')
    expect(r && 'canResume' in r).toBe(false)
    expect(r && 'resume' in r).toBe(false)
  })

  it('keeps an unreadable file aside and starts a new list', () => {
    const dir = tmp()
    const file = join(dir, 'downloads.json')
    writeFileSync(file, '{ not json')
    const store = new DownloadStore(file)
    expect(store.list()).toEqual([])
    expect(readdirSync(dir).some((f) => f.startsWith('downloads.json.corrupt-'))).toBe(true)
    store.put(record('d-1'))
    store.flushSync()
    expect(JSON.parse(readFileSync(file, 'utf8')).downloads).toHaveLength(1)
  })

  it('skips malformed entries', () => {
    const file = join(tmp(), 'downloads.json')
    writeFileSync(file, JSON.stringify({ version: 1, downloads: [record('d-1'), { id: 'd-2' }, 'x', null] }))
    expect(new DownloadStore(file).list().map((r) => r.id)).toEqual(['d-1'])
  })
})

describe('downloads in saved state', () => {
  const withDownloads = (downloads: Record<string, Partial<Download>>): OrbitState => {
    const raw = JSON.parse(JSON.stringify(createInitialState())) as OrbitState
    raw.downloads = downloads as Record<string, Download>
    return normalizeState(raw)
  }

  it('[DL-01] a running download comes back interrupted; finished, cancelled and private ones are dropped', () => {
    const state = withDownloads({
      'd-1': { ...record('d-1'), state: 'progressing', speed: 5000 },
      'd-2': { ...record('d-2'), state: 'paused' },
      'd-3': record('d-3'),
      'd-4': { ...record('d-4'), state: 'cancelled' },
      'd-5': { ...record('d-5'), state: 'progressing', private: true },
      'd-6': { ...record('d-6'), state: 'interrupted', profileId: 'p-gone' },
      'd-7': { id: 'd-7', state: 'interrupted' },
    })
    expect(Object.keys(state.downloads).sort()).toEqual(['d-1', 'd-2', 'd-6'])
    expect(state.downloads['d-1']?.state).toBe('interrupted')
    expect(state.downloads['d-1']?.speed).toBeUndefined()
    expect(state.downloads['d-2']?.state).toBe('interrupted')
    expect(state.downloads['d-6']?.profileId).toBe('p-default')
  })

  it('[DL-01] progress alone does not rewrite the state file', () => {
    expect(isRuntimeOnlyPatch({ op: 'replace', path: ['downloads', 'd-1', 'receivedBytes'], value: 5 })).toBe(true)
    expect(isRuntimeOnlyPatch({ op: 'replace', path: ['downloads', 'd-1', 'speed'], value: 5 })).toBe(true)
    expect(isRuntimeOnlyPatch({ op: 'replace', path: ['downloads', 'd-1', 'state'], value: 'completed' })).toBe(false)
  })
})

describe('download location', () => {
  it('[DL-07] a finished file moves into place, to another disk too', async () => {
    const dir = tmp()
    const from = join(dir, '.orbit-d-1.crdownload')
    writeFileSync(from, 'bytes')
    await moveFile(from, join(dir, 'a.csv'))
    expect(readdirSync(dir)).toEqual(['a.csv'])
    // Another disk: the rename fails, a copy goes there.
    const otherDisk = () => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
    }
    await moveFile(join(dir, 'a.csv'), join(dir, 'b.csv'), otherDisk)
    expect(readdirSync(dir)).toEqual(['b.csv'])
    expect(readFileSync(join(dir, 'b.csv'), 'utf8')).toBe('bytes')
    // Any other failure is the caller's.
    await expect(moveFile(join(dir, 'gone.csv'), join(dir, 'c.csv'))).rejects.toThrow()
  })

  it('[DL-07] saved locations: folders are absolute paths; Ask every time is on or unset', () => {
    const raw = JSON.parse(JSON.stringify(createInitialState())) as OrbitState
    const folder = join(tmpdir(), 'Chosen')
    raw.profiles['p-default'] = {
      ...(raw.profiles['p-default'] as OrbitState['profiles'][string]),
      downloadFolder: folder,
      downloadAsk: true,
      downloadAskFolder: folder,
    }
    raw.profiles['p-2'] = {
      ...(raw.profiles['p-default'] as OrbitState['profiles'][string]),
      id: 'p-2',
      downloadFolder: 'relative/folder',
      downloadAsk: 'yes' as unknown as boolean,
      downloadAskFolder: 42 as unknown as string,
    }
    const state = normalizeState(raw)
    expect(state.profiles['p-default']).toMatchObject({
      downloadFolder: folder,
      downloadAsk: true,
      downloadAskFolder: folder,
    })
    const other = state.profiles['p-2']
    expect(other?.id).toBe('p-2')
    expect([other?.downloadFolder, other?.downloadAsk, other?.downloadAskFolder]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })
})

function resumeOf(tempPath: string) {
  return {
    urlChain: ['http://localhost/x'],
    mimeType: 'application/zip',
    etag: '',
    lastModified: '',
    tempPath,
    startTime: 1,
  }
}
