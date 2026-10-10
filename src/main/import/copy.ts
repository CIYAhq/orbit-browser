import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Another browser's files are read from copies (IM-14): the browser may be running and holding
 * them, and its SQLite files must never be opened in place.
 */

/** A file the source browser holds, so it couldn't be copied: quit the browser and try again. */
export class LockedError extends Error {
  constructor(readonly file: string) {
    super(`${basename(file)} is in use`)
  }
}

/** Errors that mean another program holds the file (Windows reports a sharing violation as EBUSY). */
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'])

export type CopyFile = (from: string, to: string) => Promise<void>

/** A temporary folder for copies of a browser's files. */
export class Scratch {
  private n = 0

  constructor(
    readonly dir: string,
    private readonly copy: CopyFile = copyFile,
  ) {}

  /** Copies a file in, with a SQLite file's log or journal; undefined when there's no such file. */
  async take(file: string): Promise<string | undefined> {
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
}

/** Runs `fn` with a fresh temporary folder, removed after. Tests pass their own way of copying. */
export async function withScratch<T>(fn: (scratch: Scratch) => Promise<T>, copy?: CopyFile): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-import-'))
  try {
    return await fn(new Scratch(dir, copy))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
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
  const db = openCopy(copy)
  try {
    return await fn(db)
  } finally {
    db.close()
  }
}
