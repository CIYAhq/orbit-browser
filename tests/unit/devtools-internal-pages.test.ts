import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AwaitedPages,
  INTERNAL_DOCUMENT_CSP,
  internalFile,
  internalPageMayRun,
  internalPageName,
  isInternalUrl,
} from '../../src/main/devtools/internal-urls'
import { parseInput } from '../../src/shared/url'

describe('[DT-13] internal pages: their addresses and files', () => {
  it('knows an internal address, in any case; nothing else is one', () => {
    expect(isInternalUrl('orbit://pages/')).toBe(true)
    expect(isInternalUrl('ORBIT://Version/')).toBe(true)
    expect(isInternalUrl('orbit:version')).toBe(true)
    expect(isInternalUrl('https://orbit.example/')).toBe(false)
    expect(isInternalUrl('orbits://pages/')).toBe(false)
    expect(isInternalUrl('view-source:orbit://pages/')).toBe(false)
    expect(isInternalUrl('')).toBe(false)
    expect(isInternalUrl(undefined)).toBe(false)
  })

  it('each page runs only the commands listed for it, by its name in any case; nothing else runs any (D53)', () => {
    expect(internalPageName('orbit://version/?a#b')).toBe('version')
    expect(internalPageName('ORBIT://Version/')).toBe('version')
    expect(internalPageName('https://version/')).toBeUndefined()
    expect(internalPageMayRun('orbit://version/', 'settings.buildInfo')).toBe(true)
    expect(internalPageMayRun('ORBIT://VERSION/x?y#z', 'settings.copyBuildInfo')).toBe(true)
    for (const command of ['tabs.create', 'tabs.navigate', 'downloads.open', 'settings.set', 'action.run']) {
      expect(internalPageMayRun('orbit://version/', command), command).toBe(false)
    }
    expect(internalPageMayRun('orbit://pages/', 'settings.buildInfo')).toBe(false)
    expect(internalPageMayRun('orbit://nope/', 'settings.buildInfo')).toBe(false)
    expect(internalPageMayRun('orbit://constructor/', 'constructor')).toBe(false)
    expect(internalPageMayRun('orbit://__proto__/', 'settings.buildInfo')).toBe(false)
    expect(internalPageMayRun('https://version/', 'settings.buildInfo')).toBe(false)
    expect(internalPageMayRun(undefined, 'settings.buildInfo')).toBe(false)
    // Its document runs only its own scripts, and no web page frames it.
    expect(INTERNAL_DOCUMENT_CSP).toContain("script-src 'self'")
    expect(INTERNAL_DOCUMENT_CSP).toContain("frame-ancestors 'none'")
  })

  it('typed in the command bar, an internal address is an address, not a search', () => {
    expect(parseInput('orbit://version/')).toEqual({ kind: 'url', url: 'orbit://version/' })
    expect(parseInput('orbit://pages').kind).toBe('url')
  })

  it("serves the page, and of the renderer's files only its assets, however the path is spelled", () => {
    const dir = join('/app', 'out', 'renderer')
    const page = join(dir, 'index.html')
    expect(internalFile(dir, '/')).toBe(page)
    expect(internalFile(dir, '/some/path')).toBe(page)
    expect(internalFile(dir, '/assets/index-abc.js')).toBe(join(dir, 'assets', 'index-abc.js'))
    // Scripts the page loads from a deeper address.
    expect(internalFile(dir, '/some/path/assets/chunk-1.css')).toBe(join(dir, 'assets', 'chunk-1.css'))
    expect(internalFile(dir, '/assets/')).toBe(page)
    // Never a file outside the assets.
    expect(internalFile(dir, '/assets/../../main/index.js')).toBe(page)
    expect(internalFile(dir, '/assets/%2e%2e/%2e%2e/main/index.js')).toBe(page)
    expect(internalFile(dir, '/assets/..%2F..%2Fmain%2Findex.js')).toBe(page)
    expect(internalFile(dir, '/assets/..%5C..%5Cmain%5Cindex.js')).not.toContain(join(dir, 'main'))
    expect(internalFile(dir, '/assets/%2e%2e')).toBe(page)
    // A malformed escape stays as it is (a file that isn't there).
    expect(internalFile(dir, '/assets/%E0%A4%A')).toBe(join(dir, 'assets', '%E0%A4%A'))
  })

  it('serves a page once per navigation that awaits it, for a while; the hash is not sent', () => {
    let now = 1000
    const awaited = new AwaitedPages(30_000, () => now)
    // Nobody navigated there: a web page's request.
    expect(awaited.take('orbit://pages/')).toBe(false)
    awaited.add('orbit://pages/#top')
    expect(awaited.take('orbit://version/')).toBe(false)
    expect(awaited.take('orbit://pages/')).toBe(true)
    expect(awaited.take('orbit://pages/')).toBe(false)
    // Two tabs restored on the same page.
    awaited.add('orbit://version/')
    awaited.add('orbit://version/')
    expect(awaited.take('orbit://version/')).toBe(true)
    expect(awaited.take('orbit://version/')).toBe(true)
    expect(awaited.take('orbit://version/')).toBe(false)
    // A navigation that never asked (cancelled, or shown from the back-forward cache) doesn't last.
    awaited.add('orbit://pages/?q=1')
    now += 30_000
    expect(awaited.take('orbit://pages/?q=1')).toBe(false)
  })
})
