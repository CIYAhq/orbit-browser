import { createHash } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import type { Session } from 'electron'
import type { UpdatePackage } from '../../shared/updates'

/** A download that receives nothing for this long has stalled: it stops, and the next check tries again. */
export const STALL_MS = 60_000

export class DownloadError extends Error {}

export interface FetchOptions {
  /** Follow redirects (a release's files are often served from elsewhere). Test and development builds don't. */
  follow: boolean
  /** How much has come, from 0 to 1, about every percent. */
  onProgress: (share: number) => void
}

/**
 * Downloads an update's file to `file` (UP-01) through the updates session (no cookies, no cache),
 * checking its size and SHA-256 as it comes; a file that doesn't match is deleted, never used.
 */
export async function fetchPackage(ses: Session, pkg: UpdatePackage, file: string, opts: FetchOptions): Promise<void> {
  const controller = new AbortController()
  let stalled: NodeJS.Timeout | undefined
  const alive = () => {
    clearTimeout(stalled)
    stalled = setTimeout(() => controller.abort(), STALL_MS)
  }
  const part = `${file}.part`
  const out = await open(part, 'w')
  let closed = false
  try {
    alive()
    const res = await ses.fetch(pkg.url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: opts.follow ? 'follow' : 'error',
      signal: controller.signal,
    })
    if (!res.ok) throw new DownloadError(`The download answered ${res.status}.`)
    const reader = res.body?.getReader()
    if (!reader) throw new DownloadError('The download was empty.')
    const hash = createHash('sha256')
    let received = 0
    let shown = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      alive()
      received += value.byteLength
      if (received > pkg.size) {
        void reader.cancel()
        throw new DownloadError('The download is larger than the feed says.')
      }
      hash.update(value)
      await out.write(value)
      const share = received / pkg.size
      if (share - shown >= 0.01) {
        shown = share
        opts.onProgress(share)
      }
    }
    if (received !== pkg.size) throw new DownloadError('The download ended early.')
    if (hash.digest('hex') !== pkg.sha256) throw new DownloadError('The download doesn’t match its checksum.')
    closed = true
    await out.close()
    await rename(part, file)
  } catch (err) {
    if (!closed) await out.close().catch(() => {})
    await rm(part, { force: true })
    if (controller.signal.aborted) throw new DownloadError('The download stalled.')
    if (err instanceof DownloadError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new DownloadError(`The download failed (${message.slice(0, 120)}).`)
  } finally {
    clearTimeout(stalled)
  }
}
