import { join, normalize, sep } from 'node:path'
import { INTERNAL_SCHEME } from '../../shared/commands/devtools'

/** Internal pages' addresses and files (DT-13); see internal-pages.ts. */

const PREFIX = `${INTERNAL_SCHEME}:`

/** True for the address of an internal page, in any case. */
export function isInternalUrl(url: string | undefined): boolean {
  return !!url && url.slice(0, PREFIX.length).toLowerCase() === PREFIX
}

/**
 * The file an internal page's request asks for: one of the renderer's built assets (at any depth,
 * since the document's `./assets/…` resolve against its path), else the page itself. Never a file
 * outside the renderer's assets, however the path is spelled or escaped.
 */
export function internalFile(rendererDir: string, pathname: string): string {
  let path = pathname
  try {
    path = decodeURIComponent(pathname)
  } catch {
    // A malformed escape: taken as it is.
  }
  const at = path.lastIndexOf('/assets/')
  if (at >= 0) {
    const assets = join(rendererDir, 'assets') + sep
    const file = normalize(join(rendererDir, path.slice(at + 1)))
    if (file.startsWith(assets) && file.length > assets.length) return file
  }
  return join(rendererDir, 'index.html')
}

/**
 * The internal pages tabs are about to show. A navigation that Orbit or an internal page starts
 * awaits its page; a request for a page nobody awaits (a web page's fetch, image or script) gets
 * nothing, as if the scheme didn't exist. Each navigation is good for one request, for a while.
 */
export class AwaitedPages {
  private entries = new Map<string, { count: number; at: number }>()

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** A navigation to this address started. */
  add(url: string): void {
    const key = withoutHash(url)
    const at = this.now()
    this.entries.set(key, { count: (this.live(key, at)?.count ?? 0) + 1, at })
  }

  /** A request for this page: true, once per navigation to it, when one awaits it. */
  take(url: string): boolean {
    const key = withoutHash(url)
    const entry = this.live(key, this.now())
    if (!entry) return false
    entry.count -= 1
    if (entry.count <= 0) this.entries.delete(key)
    return true
  }

  private live(key: string, at: number): { count: number; at: number } | undefined {
    const entry = this.entries.get(key)
    if (entry && at - entry.at < this.ttlMs) return entry
    this.entries.delete(key)
    return undefined
  }
}

function withoutHash(url: string): string {
  const at = url.indexOf('#')
  return at < 0 ? url : url.slice(0, at)
}
