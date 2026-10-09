import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface SitePrefsData {
  /** One-time hints already shown (e.g. the ⌘⇧C tip, NV-17). */
  hints: Record<string, true>
}

/**
 * The chrome lane's small per-user settings, kept out of OrbitState so they never travel to the
 * renderers: one-time hints now, per-site choices later. Saved off the main thread shortly after
 * a change, and synchronously on quit. Private windows never write here.
 */
export class SitePrefs {
  private data: SitePrefsData = { hints: {} }
  private timer: NodeJS.Timeout | undefined
  private dirty = false

  constructor(private file: string) {}

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SitePrefsData>
      const hints: Record<string, true> = {}
      for (const [id, shown] of Object.entries(raw.hints ?? {})) if (shown === true) hints[id] = true
      this.data = { hints }
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  hintShown(id: string): boolean {
    return this.data.hints[id] === true
  }

  markHint(id: string): void {
    if (this.data.hints[id]) return
    this.data.hints[id] = true
    this.schedule()
  }

  /** Writes pending changes now (quit). */
  flush(): void {
    if (!this.dirty) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data))
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[site-prefs] could not save', err)
    }
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.dirty) return
      this.dirty = false
      const tmp = `${this.file}.tmp`
      void mkdir(dirname(this.file), { recursive: true })
        .then(() => writeFile(tmp, JSON.stringify(this.data)))
        .then(() => rename(tmp, this.file))
        .catch((err) => console.error('[site-prefs] could not save', err))
    }, 500)
    this.timer.unref?.()
  }
}
