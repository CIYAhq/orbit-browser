import { join, normalize, sep } from 'node:path'
import { INTERNAL_SCHEME } from '../../shared/commands/devtools'
import type { CommandName } from '../../shared/rpc'

/** Internal pages' addresses, files and rights (DT-13); see internal-pages.ts. */

const PREFIX = `${INTERNAL_SCHEME}:`

/** True for the address of an internal page, in any case. */
export function isInternalUrl(url: string | undefined): boolean {
  return !!url && url.slice(0, PREFIX.length).toLowerCase() === PREFIX
}

/**
 * The commands each internal page may run (D53), by its name (`orbit://<name>/`). Main refuses any
 * other command, and every event, so a script that got into a page (one that shows text from the
 * web) can do no more than the page itself. A page that runs no command needs no entry; a new page
 * that runs some lists them here.
 */
export const INTERNAL_PAGE_COMMANDS: Readonly<Record<string, readonly CommandName[]>> = {
  version: ['settings.buildInfo', 'settings.copyBuildInfo'],
  // History (AR-10): its own tab's profile only (src/main/pages/history.ts).
  history: ['pages.history', 'pages.historyOpen', 'pages.historyDelete', 'pages.historyMenu'],
}

/**
 * What an internal page's document allows (D53): no web page may frame it, and it runs only its own
 * scripts (no inline script, no other origin's, no plugins, no `<base>` to move them).
 */
export const INTERNAL_DOCUMENT_CSP = "frame-ancestors 'none'; script-src 'self'; object-src 'none'; base-uri 'none'"

/** The name of the internal page at an address, lowercase: `version` for `orbit://version/…`. */
export function internalPageName(url: string | undefined): string | undefined {
  if (!url || !isInternalUrl(url)) return undefined
  try {
    return new URL(url).hostname.toLowerCase() || undefined
  } catch {
    return undefined
  }
}

/** Whether the internal page at an address may run a command (D53). */
export function internalPageMayRun(url: string | undefined, command: string): boolean {
  const name = internalPageName(url)
  if (!name || !Object.hasOwn(INTERNAL_PAGE_COMMANDS, name)) return false
  return (INTERNAL_PAGE_COMMANDS[name] as readonly string[]).includes(command)
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
