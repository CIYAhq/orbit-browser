import { rmSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Another browser's files are read from copies (IM-14): the browser may be running and holding
 * them, and its SQLite files must never be opened in place. The copies go in a folder under
 * Orbit's user data: the ones being read are removed at quit, and whatever a crash left is
 * removed at the next startup, so no copy of someone's history outlives Orbit (D58).
 */

/** Where scratch folders go, once Orbit has started (`setScratchFolder`); the system's temp folder before (tests). */
let root: string | undefined
/** Startup's clearing of the folder: a new copy waits for it. */
let cleared: Promise<void> = Promise.resolve()
/** The scratch folders being read now. */
const inUse = new Set<Scratch>()
/** How a file is copied in: e2e tests hold a copy open with it, to quit while one is (`setCopyStep`). */
let copyStep: CopyFile = copyFile

/** Tests (e2e): every copy from now on is made with `step`. */
export function setCopyStep(step: CopyFile): void {
  copyStep = step
}

/** Startup: copies go in `dir`, and whatever a quit or a crash left there is removed first (D58). */
export function setScratchFolder(dir: string): void {
  root = dir
  cleared = rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** Quit: the copies being read are closed and their folders removed, before Orbit exits (D58). */
export function removeScratch(): void {
  for (const scratch of inUse) scratch.discard()
  inUse.clear()
}

/** A file the source browser holds, so it couldn't be copied: quit the browser and try again. */
export class LockedError extends Error {
  constructor(readonly file: string) {
    super(`${basename(file)} is in use`)
  }
}

/**
 * Why a copied file couldn't be read, as the summary says it (IM-14): the system's error reading it,
 * or anything else (SQLite's "file is not a database", JSON that doesn't parse): a damaged file.
 */
export function unreadableReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? 'the file couldn’t be read' : 'the file is damaged'
}

/** Errors that mean another program holds the file (Windows reports a sharing violation as EBUSY). */
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'])

export type CopyFile = (from: string, to: string) => Promise<void>

/** A temporary folder for copies of a browser's files. */
export class Scratch {
  private n = 0
  /** The databases open on copies in it. */
  private readonly open = new Set<DatabaseSync>()
  /** Set at quit: its copies are gone, and nothing more is copied in. */
  private discarded = false

  constructor(
    readonly dir: string,
    private readonly copy: CopyFile = copyFile,
  ) {}

  /** Copies a file in, with a SQLite file's log or journal; undefined when there's no such file. */
  async take(file: string): Promise<string | undefined> {
    if (this.discarded) throw new Error('Orbit is quitting')
    const to = join(this.dir, `${this.n++}-${basename(file)}`)
    try {
      await this.copy(file, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      if (LOCK_CODES.has(code)) throw new LockedError(file)
      throw err
    }
    for (const extra of ['-wal', '-journal']) await this.copy(file + extra, to + extra).catch(() => {})
    return to
  }

  /** Opens a copied SQLite file, closed by `close` (or at quit). */
  openDatabase(path: string): DatabaseSync {
    if (this.discarded) throw new Error('Orbit is quitting')
    const db = openCopy(path)
    this.open.add(db)
    return db
  }

  close(db: DatabaseSync): void {
    if (this.open.delete(db)) db.close()
  }

  /** Closes its databases and removes the folder, synchronously: a read still going fails at its next step. */
  discard(): void {
    this.discarded = true
    for (const db of this.open) {
      try {
        db.close()
      } catch {}
    }
    this.open.clear()
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch {}
  }
}

/** Runs `fn` with a fresh scratch folder, removed after (or at quit). Tests pass their own way of copying. */
export async function withScratch<T>(fn: (scratch: Scratch) => Promise<T>, copy?: CopyFile): Promise<T> {
  await cleared
  const parent = root ?? tmpdir()
  if (root) await mkdir(root, { recursive: true })
  const scratch = new Scratch(await mkdtemp(join(parent, root ? 'read-' : 'orbit-import-')), copy ?? copyStep)
  inUse.add(scratch)
  try {
    return await fn(scratch)
  } finally {
    inUse.delete(scratch)
    scratch.discard()
  }
}

/** Opens a copied SQLite file (Electron's own Node has `node:sqlite`: no native module). */
export function openCopy(path: string): DatabaseSync {
  return new DatabaseSync(path)
}

/** Runs `fn` on a copy of a SQLite file; undefined when there's no such file. */
export async function withDatabase<T>(
  scratch: Scratch,
  file: string,
  fn: (db: DatabaseSync) => T | Promise<T>,
): Promise<T | undefined> {
  const copy = await scratch.take(file)
  if (!copy) return undefined
  const db = scratch.openDatabase(copy)
  try {
    return await fn(db)
  } finally {
    scratch.close(db)
  }
}
