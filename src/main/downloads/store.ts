/**
 * The downloads list (DL-01, DL-08, DL-10): every download of every profile, in the order they
 * started, in one small JSON file (`userData/downloads.json`). It lives outside OrbitState, which only
 * holds what the sidebar shows now (ARCHITECTURE §2). Pure Node (no Electron), so it is unit-tested.
 *
 * - Loaded on first use: nothing is read at startup.
 * - Writes are debounced and atomic (temp file, then rename); `flushSync` writes at quit.
 * - At most `max` entries: the oldest finished ones go first, running ones never.
 * - A download still running in the file was cut off by a crash or a quit: it loads as interrupted.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Download, ProfileId } from '../../shared/state'

/** What an interrupted download needs to continue after a restart (`session.createInterruptedDownload`). */
export interface ResumeInfo {
  urlChain: string[]
  mimeType: string
  etag: string
  lastModified: string
  /** The partial file. */
  tempPath: string
  /** When it started, in seconds since the epoch (DownloadItem.getStartTime). */
  startTime: number
}

export interface DownloadRecord extends Download {
  resume?: ResumeInfo
}

export const MAX_DOWNLOADS = 1000
const WRITE_DELAY_MS = 500

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const STATES = new Set<Download['state']>(['progressing', 'paused', 'completed', 'cancelled', 'interrupted'])

/** A stored entry, or undefined when it isn't one. */
function readRecord(value: unknown): DownloadRecord | undefined {
  if (!isRecord(value)) return undefined
  const { id, url, filename, savePath, profileId } = value
  if (typeof id !== 'string' || typeof url !== 'string' || typeof filename !== 'string') return undefined
  if (typeof savePath !== 'string' || typeof profileId !== 'string') return undefined
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  let state = STATES.has(value.state as Download['state']) ? (value.state as Download['state']) : 'interrupted'
  if (state === 'progressing' || state === 'paused') state = 'interrupted'
  const record: DownloadRecord = {
    id,
    url,
    filename,
    savePath,
    profileId,
    state,
    receivedBytes: num(value.receivedBytes),
    totalBytes: num(value.totalBytes),
    startedAt: num(value.startedAt),
  }
  if (typeof value.endedAt === 'number') record.endedAt = value.endedAt
  if (typeof value.error === 'string') record.error = value.error
  if (typeof value.mimeType === 'string') record.mimeType = value.mimeType
  if (typeof value.pageUrl === 'string') record.pageUrl = value.pageUrl
  if (typeof value.canResume === 'boolean') record.canResume = value.canResume
  const r = value.resume
  if (isRecord(r) && Array.isArray(r.urlChain) && typeof r.tempPath === 'string') {
    record.resume = {
      urlChain: r.urlChain.filter((u): u is string => typeof u === 'string'),
      mimeType: typeof r.mimeType === 'string' ? r.mimeType : '',
      etag: typeof r.etag === 'string' ? r.etag : '',
      lastModified: typeof r.lastModified === 'string' ? r.lastModified : '',
      tempPath: r.tempPath,
      startTime: num(r.startTime),
    }
  }
  return record
}

export class DownloadStore {
  /** In start order (oldest first). */
  private records = new Map<string, DownloadRecord>()
  private loaded = false
  private timer: NodeJS.Timeout | undefined
  private writing: Promise<void> | undefined
  private dirty = false
  /** Bumped by each synchronous write, so an older background write never lands after it. */
  private generation = 0

  constructor(
    readonly file: string,
    private max = MAX_DOWNLOADS,
    private delayMs = WRITE_DELAY_MS,
  ) {}

  /** Every entry of a profile (or of all), newest first. */
  list(profileId?: ProfileId): DownloadRecord[] {
    this.load()
    const out: DownloadRecord[] = []
    for (const r of this.records.values()) if (!profileId || r.profileId === profileId) out.push(r)
    return out.reverse()
  }

  get(id: string): DownloadRecord | undefined {
    this.load()
    return this.records.get(id)
  }

  /** Adds an entry (as the newest) or replaces the one with its id (in place). */
  put(record: DownloadRecord): void {
    this.load()
    this.records.set(record.id, record)
    this.trim()
    this.changed()
  }

  /** Changes some fields of an entry. */
  update(id: string, fields: Partial<DownloadRecord>): DownloadRecord | undefined {
    this.load()
    const record = this.records.get(id)
    if (!record) return undefined
    const next = { ...record, ...fields }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete (next as Record<string, unknown>)[key]
    }
    this.records.set(id, next)
    this.changed()
    return next
  }

  remove(id: string): boolean {
    this.load()
    const had = this.records.delete(id)
    if (had) this.changed()
    return had
  }

  /** Removes every entry `match` picks; returns them. */
  removeWhere(match: (record: DownloadRecord) => boolean): DownloadRecord[] {
    this.load()
    const removed = [...this.records.values()].filter(match)
    for (const r of removed) this.records.delete(r.id)
    if (removed.length > 0) this.changed()
    return removed
  }

  /** Writes pending changes now (quit). */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return
    this.dirty = false
    this.generation += 1
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.sync.tmp`
      writeFileSync(tmp, this.serialize())
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[downloads] failed to save the downloads list:', err)
    }
  }

  /** Resolves when the writes asked for so far are on disk (tests). */
  async settle(): Promise<void> {
    while (this.timer || this.writing) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = undefined
        void this.write()
      }
      await this.writing
    }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      const list = isRecord(parsed) && Array.isArray(parsed.downloads) ? parsed.downloads : []
      for (const value of list) {
        const record = readRecord(value)
        if (record) this.records.set(record.id, record)
      }
    } catch (err) {
      // Keep the unreadable file aside rather than overwrite it.
      console.error('[downloads] the downloads list is unreadable; starting a new one:', err)
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        // nothing to keep
      }
    }
  }

  private trim(): void {
    let excess = this.records.size - this.max
    if (excess <= 0) return
    for (const r of this.records.values()) {
      if (excess <= 0) break
      if (r.state === 'progressing' || r.state === 'paused') continue
      this.records.delete(r.id)
      excess--
    }
  }

  private changed(): void {
    this.dirty = true
    if (this.timer || this.writing) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.write()
    }, this.delayMs)
    this.timer.unref?.()
  }

  private serialize(): string {
    return JSON.stringify({ version: 1, downloads: [...this.records.values()] })
  }

  private write(): Promise<void> {
    if (this.writing) return this.writing
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    const generation = this.generation
    const data = this.serialize()
    const tmp = `${this.file}.tmp`
    this.writing = (async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(tmp, data)
      if (generation === this.generation) await rename(tmp, this.file)
    })()
      .catch((err) => console.error('[downloads] failed to save the downloads list:', err))
      .finally(() => {
        this.writing = undefined
        if (this.dirty) this.changed()
      })
    return this.writing
  }
}
