import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Favicons by origin, kept out of OrbitState (lane review MF-2): archived pages, history and
 * other lists look icons up here (`tabs.favicon`) instead of each entry carrying a copy. Small
 * (bounded entries, each a ≤16 KB data URL), saved off the main thread a moment after changes.
 */
export class FaviconStore {
  private byOrigin = new Map<string, string>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private file: string,
    private limit = 400,
  ) {}

  load(): void {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>
      for (const [origin, url] of Object.entries(data)) {
        if (typeof url === 'string' && url.startsWith('data:image/')) this.byOrigin.set(origin, url)
      }
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  get(pageUrl: string): string | undefined {
    const origin = originOf(pageUrl)
    return origin ? this.byOrigin.get(origin) : undefined
  }

  set(pageUrl: string, dataUrl: string): void {
    const origin = originOf(pageUrl)
    if (!origin || !dataUrl.startsWith('data:image/') || this.byOrigin.get(origin) === dataUrl) return
    this.byOrigin.delete(origin)
    this.byOrigin.set(origin, dataUrl)
    while (this.byOrigin.size > this.limit) {
      const oldest = this.byOrigin.keys().next().value
      if (oldest === undefined) break
      this.byOrigin.delete(oldest)
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const tmp = `${this.file}.tmp`
      void mkdir(dirname(this.file), { recursive: true })
        .then(() => writeFile(tmp, JSON.stringify(Object.fromEntries(this.byOrigin))))
        .then(() => rename(tmp, this.file))
        .catch(() => {})
    }, 2000)
    this.timer.unref?.()
  }
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.origin : undefined
  } catch {
    return undefined
  }
}
