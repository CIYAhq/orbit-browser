import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BackupInfo } from '../../shared/commands/archive'
import type { OrbitState } from '../../shared/state'
import { DAY_MS } from './retention'
import { buildSnapshot, parseSnapshot, type SidebarSnapshot, sidebarHash, snapshotCounts } from './snapshot'
import { dayStart } from './store'

/** A backup's id and file name (without `.json`): `<taken at>-<Spaces>-<tabs>-<fingerprint>`. */
const BACKUP_ID = /^(\d{1,16})-(\d{1,6})-(\d{1,7})-([0-9a-f]{8})$/

/** A backup as its file name describes it (listing reads no file). */
export interface StoredBackup extends BackupInfo {
  /** The sidebar's fingerprint (`sidebarHash`): the same in two backups means nothing to restore. */
  hash: string
}

export function parseBackupId(id: unknown): StoredBackup | undefined {
  if (typeof id !== 'string') return undefined
  const m = BACKUP_ID.exec(id)
  if (!m) return undefined
  return { id, at: Number(m[1]), spaces: Number(m[2]), tabs: Number(m[3]), hash: m[4] as string }
}

/** Backups kept from today (AR-11)… */
export const KEEP_TODAY = 10
/** …then the newest of each of this many days before… */
const DAILY_DAYS = 10
/** …of each week of the month before that… */
const WEEKLY_DAYS = 31
/** …and of each 30 days of the year before that. Older ones go. */
const MONTHLY_DAYS = 365

/**
 * Which backups stay (AR-11): up to 10 from today, then the newest of each of the 10 days before,
 * of each week of the month before that, and of each month of the year before that. Days are local
 * calendar days. The newest backup always stays.
 */
export function backupsToKeep(list: readonly { id: string; at: number }[], now: number): Set<string> {
  const keep = new Set<string>()
  const buckets = new Set<string>()
  const today = dayStart(now)
  let todays = 0
  const sorted = [...list].sort((a, b) => b.at - a.at)
  sorted.forEach((b, i) => {
    // Rounded: a day with a clock change is 23 or 25 hours long.
    const days = Math.max(0, Math.round((today - dayStart(b.at)) / DAY_MS))
    let bucket: string | undefined
    if (days === 0) {
      if (todays < KEEP_TODAY || i === 0) keep.add(b.id)
      todays++
      return
    }
    if (days <= DAILY_DAYS) bucket = `day ${days}`
    else if (days <= DAILY_DAYS + WEEKLY_DAYS) bucket = `week ${Math.floor((days - DAILY_DAYS - 1) / 7)}`
    else if (days <= DAILY_DAYS + WEEKLY_DAYS + MONTHLY_DAYS)
      bucket = `month ${Math.floor((days - DAILY_DAYS - WEEKLY_DAYS - 1) / 30)}`
    if (i === 0 || (bucket && !buckets.has(bucket))) {
      keep.add(b.id)
      if (bucket) buckets.add(bucket)
    }
  })
  return keep
}

/** Writes a whole file or nothing: a temp file, flushed to disk, then renamed over. */
async function writeAtomic(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, file)
}

/**
 * The sidebar backups on disk (AR-11): one JSON file per backup in `dir` (userData/backups), named
 * by `parseBackupId`'s pattern. Disk work runs one step at a time.
 */
export class BackupStore {
  private queue: Promise<unknown> = Promise.resolve()
  private cleaned = false
  /** Called after backups were added or removed. */
  onChange?: () => void

  constructor(readonly dir: string) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Every backup, newest first. */
  list(): Promise<StoredBackup[]> {
    return this.serial(() => this.readList())
  }

  private async readList(): Promise<StoredBackup[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    if (!this.cleaned) {
      this.cleaned = true
      // A write cut short (Orbit quit or crashed mid-write) leaves its temp file behind.
      for (const name of names) if (name.endsWith('.tmp')) await rm(join(this.dir, name), { force: true })
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => parseBackupId(name.slice(0, -'.json'.length)))
      .filter((b): b is StoredBackup => !!b)
      .sort((a, b) => b.at - a.at)
  }

  /**
   * Backs up the sidebar of `state` as it is now, unless the newest backup holds the same sidebar
   * (then that one is the answer). Backups the schedule no longer keeps go.
   */
  take(state: OrbitState, now: number): Promise<StoredBackup> {
    const snap = buildSnapshot(state, now)
    const hash = sidebarHash(snap)
    return this.serial(async () => {
      const list = await this.readList()
      const newest = list[0]
      if (newest && newest.hash === hash) return newest
      const { spaces, tabs } = snapshotCounts(snap)
      const id = `${now}-${spaces}-${tabs}-${hash}`
      const info: StoredBackup = { id, at: now, spaces, tabs, hash }
      await writeAtomic(join(this.dir, `${id}.json`), JSON.stringify(snap))
      const keep = backupsToKeep([info, ...list], now)
      for (const b of list) if (!keep.has(b.id)) await rm(join(this.dir, `${b.id}.json`), { force: true })
      this.onChange?.()
      return info
    })
  }

  /** A backup's content; undefined when there is no such backup or it cannot be read. */
  read(id: unknown): Promise<SidebarSnapshot | undefined> {
    const info = parseBackupId(id)
    if (!info) return Promise.resolve(undefined)
    return this.serial(async () => {
      try {
        return parseSnapshot(JSON.parse(await readFile(join(this.dir, `${info.id}.json`), 'utf8')))
      } catch {
        return undefined
      }
    })
  }
}

/** Whether a change can have touched the sidebar (cheap: Immer keeps unchanged parts identical). */
function sidebarMayDiffer(a: OrbitState, b: OrbitState): boolean {
  return (
    a.spaces !== b.spaces ||
    a.spaceOrder !== b.spaceOrder ||
    a.profiles !== b.profiles ||
    a.folders !== b.folders ||
    a.splits !== b.splits ||
    a.tabs !== b.tabs
  )
}

/** After a change, a backup is taken within this long (AR-11)… */
export const BACKUP_EVERY_MS = 5 * 60_000
/** …and one this long after launch, for changes made just before Orbit last quit. */
export const FIRST_BACKUP_MS = 30_000

/**
 * Takes backups while Orbit runs (AR-11): every five minutes when the sidebar may have changed (a
 * backup is only written when it differs from the newest), and once shortly after launch. Returns
 * a function that stops it.
 */
export function scheduleBackups(
  ctx: { store: { state: OrbitState; subscribe(fn: (next: OrbitState, prev: OrbitState) => void): () => void } },
  backups: Pick<BackupStore, 'take'>,
  now: () => number = Date.now,
): () => void {
  let dirty = true
  const off = ctx.store.subscribe((next, prev) => {
    if (!dirty && sidebarMayDiffer(prev, next)) dirty = true
  })
  const run = () => {
    if (!dirty) return
    dirty = false
    backups.take(ctx.store.state, now()).catch((err) => console.error('[backups] could not back up the sidebar', err))
  }
  const first = setTimeout(run, FIRST_BACKUP_MS)
  const timer = setInterval(run, BACKUP_EVERY_MS)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
    off()
  }
}
