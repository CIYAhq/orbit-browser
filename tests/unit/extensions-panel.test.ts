import { describe, expect, it } from 'vitest'
import {
  POPUP_GAP,
  POPUP_MARGIN,
  type PopupAnchor,
  panelExtensions,
  patternMatches,
  popupAnchorOf,
  popupBounds,
  siteAccessOn,
} from '../../src/shared/extensions'
import type { InstalledExtension } from '../../src/shared/state'

/** The site controls panel's extensions (EX-03) and where a popup goes (EX-05): the pure parts. */

const entry = (id: string, fields: Partial<InstalledExtension> = {}): InstalledExtension => ({
  id: id.repeat(32).slice(0, 32),
  profileId: 'p-default',
  name: id,
  version: '1.0',
  description: '',
  source: 'crx',
  path: '/x',
  enabled: true,
  allowPrivate: false,
  allowFileAccess: false,
  permissions: [],
  hosts: [],
  icon: '',
  popup: '',
  options: '',
  installedAt: 1,
  ...fields,
})

describe('[EX-03] The panel’s list', () => {
  it('lists a profile’s enabled extensions: pinned first in pin order, then by name', () => {
    const list = [
      entry('d', { name: 'Delta', installedAt: 1 }),
      entry('b', { name: 'bravo', installedAt: 2 }),
      entry('c', { name: 'Charlie', pinnedAt: 20 }),
      entry('a', { name: 'Alpha', pinnedAt: 10 }),
      entry('e', { name: 'Echo', enabled: false }),
      entry('f', { name: 'Foxtrot', profileId: 'p-other' }),
    ]
    const all = Object.fromEntries(list.map((e) => [`${e.profileId}:${e.id}`, e]))
    expect(panelExtensions(all, 'p-default').map((e) => e.name)).toEqual(['Alpha', 'Charlie', 'bravo', 'Delta'])
    expect(panelExtensions(all, 'p-other').map((e) => e.name)).toEqual(['Foxtrot'])
    expect(panelExtensions(all, 'p-none')).toEqual([])
  })
})

describe('[EX-03] Site access on a page', () => {
  it('matches patterns as the engine does', () => {
    // Scheme: * is http and https only.
    expect(patternMatches('*://example.com/*', 'https://example.com/a')).toBe(true)
    expect(patternMatches('*://example.com/*', 'http://example.com/')).toBe(true)
    expect(patternMatches('*://example.com/*', 'ftp://example.com/')).toBe(false)
    expect(patternMatches('https://example.com/*', 'http://example.com/')).toBe(false)
    // Host: exact, or the site and its subdomains with *.
    expect(patternMatches('https://example.com/*', 'https://www.example.com/')).toBe(false)
    expect(patternMatches('https://*.example.com/*', 'https://www.example.com/')).toBe(true)
    expect(patternMatches('https://*.example.com/*', 'https://example.com/')).toBe(true)
    expect(patternMatches('https://*.example.com/*', 'https://notexample.com/')).toBe(false)
    expect(patternMatches('https://*/*', 'https://anything.test/x')).toBe(true)
    expect(patternMatches('HTTPS://Example.COM/*', 'https://example.com/')).toBe(true)
    // Port: none in the pattern is any port; a port must match (the default one too).
    expect(patternMatches('http://localhost/*', 'http://localhost:3350/page')).toBe(true)
    expect(patternMatches('http://localhost:3350/*', 'http://localhost:3350/page')).toBe(true)
    expect(patternMatches('http://localhost:3351/*', 'http://localhost:3350/page')).toBe(false)
    expect(patternMatches('http://localhost:80/*', 'http://localhost/')).toBe(true)
    expect(patternMatches('http://localhost:*/*', 'http://localhost:9/')).toBe(true)
    // Path: * is any text, over the path and query; the rest is literal.
    expect(patternMatches('https://example.com/docs/*', 'https://example.com/docs/a/b?x=1')).toBe(true)
    expect(patternMatches('https://example.com/docs/*', 'https://example.com/blog/')).toBe(false)
    expect(patternMatches('https://example.com/a.b', 'https://example.com/axb')).toBe(false)
    expect(patternMatches('https://example.com/*.pdf', 'https://example.com/x/y.pdf')).toBe(true)
    // <all_urls>: web and file pages, not Orbit's or an extension's.
    expect(patternMatches('<all_urls>', 'https://example.com/')).toBe(true)
    expect(patternMatches('<all_urls>', 'file:///tmp/a.html')).toBe(true)
    expect(patternMatches('<all_urls>', 'orbit://settings/')).toBe(false)
    expect(patternMatches('<all_urls>', 'chrome-extension://abc/popup.html')).toBe(false)
    // Files.
    expect(patternMatches('file:///*', 'file:///tmp/a.html')).toBe(true)
    expect(patternMatches('file:///*', 'https://example.com/')).toBe(false)
    // Nonsense.
    expect(patternMatches('example.com', 'https://example.com/')).toBe(false)
    expect(patternMatches('https://exa*mple.com/*', 'https://example.com/')).toBe(false)
    expect(patternMatches('https://example.com/*', 'not a url')).toBe(false)
  })

  it('says whether it reaches every site, this one, or not this one', () => {
    expect(siteAccessOn(['<all_urls>'], 'https://example.com/')).toBe('all')
    expect(siteAccessOn(['*://*/*'], 'https://example.com/')).toBe('all')
    const local = ['http://localhost/*', 'http://127.0.0.1/*']
    expect(siteAccessOn(local, 'http://localhost:3350/page/a')).toBe('this')
    expect(siteAccessOn(local, 'https://example.com/')).toBe('none')
    expect(siteAccessOn([], 'https://example.com/')).toBe('none')
  })
})

describe('[EX-05] Where a popup goes', () => {
  const area = { width: 1200, height: 800 }
  const icon: PopupAnchor = { x: 100, y: 40, width: 24, height: 24, side: 'below' }
  const row: PopupAnchor = { x: 300, y: 120, width: 320, height: 40, side: 'beside' }

  it('takes only a rect of numbers from the UI', () => {
    expect(popupAnchorOf({ x: 1, y: 2, width: 3, height: 4, side: 'beside' })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      side: 'beside',
    })
    expect(popupAnchorOf({ x: 1, y: 2, width: 3, height: 4 })?.side).toBe('below')
    expect(popupAnchorOf({ x: 1, y: 2, width: 3, height: 4, side: 'left' })?.side).toBe('below')
    expect(popupAnchorOf(null)).toBeNull()
    expect(popupAnchorOf('1,2,3,4')).toBeNull()
    expect(popupAnchorOf({ x: '1', y: 2, width: 3, height: 4 })).toBeNull()
    expect(popupAnchorOf({ x: Number.NaN, y: 2, width: 3, height: 4 })).toBeNull()
    expect(popupAnchorOf({ x: 1, y: Number.POSITIVE_INFINITY, width: 3, height: 4 })).toBeNull()
    expect(popupAnchorOf({ x: 1, y: 2, width: -3, height: 4 })).toBeNull()
    expect(popupAnchorOf({ x: 1e9, y: 2, width: 3, height: 4 })).toBeNull()
    expect(popupAnchorOf({ x: 1, y: 2, width: 3 })).toBeNull()
  })

  it('hangs under its icon at its page’s size', () => {
    expect(popupBounds(icon, { width: 272, height: 115 }, area)).toEqual({
      x: 100,
      y: 40 + 24 + POPUP_GAP,
      width: 272,
      height: 115,
    })
  })

  it('opens beside its panel’s row, or on the panel’s other side when there is no room', () => {
    expect(popupBounds(row, { width: 272, height: 115 }, area)).toEqual({
      x: 300 + 320 + POPUP_GAP,
      y: 120,
      width: 272,
      height: 115,
    })
    const right: PopupAnchor = { ...row, x: 860 }
    expect(popupBounds(right, { width: 272, height: 115 }, area)).toMatchObject({ x: 860 - POPUP_GAP - 272, y: 120 })
  })

  it('opens above its icon when there is no room below', () => {
    const low: PopupAnchor = { ...icon, y: 700 }
    expect(popupBounds(low, { width: 272, height: 200 }, area)).toMatchObject({ y: 700 - POPUP_GAP - 200 })
  })

  it('keeps to 25×25–800×600 and to the window, inside it', () => {
    expect(popupBounds(icon, { width: 1200, height: 900 }, area)).toMatchObject({ width: 800, height: 600 })
    expect(popupBounds(icon, { width: 3, height: 0 }, area)).toMatchObject({ width: 25, height: 25 })
    expect(popupBounds(icon, { width: 10.2, height: 30.5 }, area)).toMatchObject({ width: 25, height: 31 })
    // A small window: never past its edges.
    const small = { width: 500, height: 400 }
    const r = popupBounds({ ...icon, x: 400 }, { width: 800, height: 600 }, small)
    expect(r.width).toBe(500 - 2 * POPUP_MARGIN)
    expect(r.height).toBe(400 - 2 * POPUP_MARGIN)
    expect(r.x).toBe(POPUP_MARGIN)
    expect(r.y).toBe(POPUP_MARGIN)
    // Near the right edge, pulled back in.
    expect(popupBounds({ ...icon, x: 1100 }, { width: 272, height: 115 }, area).x).toBe(1200 - POPUP_MARGIN - 272)
    // Beside a panel that fills the window: over it, inside the window.
    const wide: PopupAnchor = { x: 0, y: 100, width: 1200, height: 40, side: 'beside' }
    const over = popupBounds(wide, { width: 272, height: 115 }, area)
    expect(over.x + over.width).toBeLessThanOrEqual(1200 - POPUP_MARGIN)
    expect(over.x).toBeGreaterThanOrEqual(POPUP_MARGIN)
  })
})
