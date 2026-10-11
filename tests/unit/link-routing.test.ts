import { describe, expect, it } from 'vitest'
import {
  decideLink,
  framesMayOpen,
  isInternalPageUrl,
  isLocalFileUrl,
  isMeetingLink,
  type LinkSettings,
  type LinkSource,
  localFileBlockedMessage,
  pageMayOpen,
  routeFor,
  sameSite,
} from '../../src/shared/link-routing'
import {
  advanceSpring,
  dismissesOnRelease,
  draggedCard,
  dragTravel,
  PEEK_CLOSE_MS,
  PEEK_CLOSE_SCALE,
  PEEK_DISMISS_VELOCITY,
  PEEK_DRAG_UP_MAX,
  PEEK_EXPAND_SPRING,
  PEEK_OPEN_SPRING,
  peekCard,
  peekStart,
  releaseVelocity,
  type Spring,
  springResting,
} from '../../src/shared/peek-geometry'

const on: LinkSettings = { peekExternalLinks: true, peekShiftClick: true, linkRules: [] }
const pinned: LinkSource = { kind: 'tab', section: 'pinned', url: 'https://mail.example.com/inbox' }
const favorite: LinkSource = { kind: 'tab', section: 'favorite', url: 'https://app.example.com/' }
const today: LinkSource = { kind: 'tab', section: 'today', url: 'https://news.example.org/a' }
const peek: LinkSource = { kind: 'peek', url: 'https://other.org/a' }
const mini: LinkSource = { kind: 'mini', url: 'https://other.org/a' }

describe('same site (PK-02)', () => {
  it('compares registrable domains, not hosts', () => {
    expect(sameSite('https://mail.example.com/x', 'https://docs.example.com/y')).toBe(true)
    expect(sameSite('https://www.example.com', 'http://example.com/z')).toBe(true)
    expect(sameSite('https://a.example.co.uk', 'https://b.example.co.uk')).toBe(true)
    expect(sameSite('https://example.co.uk', 'https://other.co.uk')).toBe(false)
    expect(sameSite('https://example.com', 'https://example.org')).toBe(false)
    expect(sameSite('http://localhost:3000/a', 'http://127.0.0.1:3000/a')).toBe(false)
    expect(sameSite('http://localhost:3000/a', 'http://localhost:4000/b')).toBe(true)
  })
})

describe('which links open in Peek', () => {
  it('[PK-02] other-site links in pinned tabs and Favorites open in Peek; same-site links navigate', () => {
    expect(decideLink('navigate', pinned, 'https://other.org/page', on)).toEqual({ to: 'peek' })
    expect(decideLink('navigate', favorite, 'https://other.org/page', on)).toEqual({ to: 'peek' })
    expect(decideLink('navigate', pinned, 'https://docs.example.com/page', on)).toEqual({ to: 'default' })
    // target=_blank / window.open after a click, to another site, too.
    expect(decideLink('new-tab', pinned, 'https://other.org/page', on)).toEqual({ to: 'peek' })
    expect(decideLink('new-tab', pinned, 'https://mail.example.com/other', on)).toEqual({ to: 'default' })
  })

  it('[PK-02] Today tabs never Peek on a plain click', () => {
    expect(decideLink('navigate', today, 'https://other.org/page', on)).toEqual({ to: 'default' })
    expect(decideLink('new-tab', today, 'https://other.org/page', on)).toEqual({ to: 'default' })
  })

  it('[PK-03] Shift-click opens any link in Peek, in any tab', () => {
    expect(decideLink('shift', today, 'https://other.org/page', on)).toEqual({ to: 'peek' })
    expect(decideLink('shift', today, 'https://news.example.org/b', on)).toEqual({ to: 'peek' })
    expect(decideLink('shift', pinned, 'https://mail.example.com/b', on)).toEqual({ to: 'peek' })
  })

  it('[PK-12] with the toggles off, pinned links open as Today tabs and Shift-click is the default', () => {
    const off = { ...on, peekExternalLinks: false, peekShiftClick: false }
    expect(decideLink('navigate', pinned, 'https://other.org/page', off)).toEqual({ to: 'tab' })
    expect(decideLink('navigate', favorite, 'https://other.org/page', off)).toEqual({ to: 'tab' })
    expect(decideLink('navigate', pinned, 'https://mail.example.com/x', off)).toEqual({ to: 'default' })
    expect(decideLink('shift', today, 'https://other.org/page', off)).toEqual({ to: 'default' })
  })

  it('[PK-04] meeting links open as a new tab, never in Peek', () => {
    expect(decideLink('navigate', pinned, 'https://meet.google.com/abc-defg-hij', on)).toEqual({ to: 'tab' })
    expect(decideLink('shift', today, 'https://us02web.zoom.us/j/123456789?pwd=x', on)).toEqual({ to: 'tab' })
    expect(decideLink('new-tab', favorite, 'https://teams.microsoft.com/l/meetup-join/19%3a', on)).toEqual({
      to: 'tab',
    })
    // From inside a Peek, too.
    expect(decideLink('navigate', peek, 'https://meet.google.com/abc-defg-hij', on)).toEqual({ to: 'tab' })
  })

  it('[PK-04] a routing rule wins over Peek: the link opens as a tab in its Space', () => {
    const rules: LinkSettings = { ...on, linkRules: [{ match: 'contains', value: 'other.org', spaceId: 's-work' }] }
    expect(decideLink('navigate', pinned, 'https://other.org/page', rules)).toEqual({ to: 'tab', spaceId: 's-work' })
    expect(decideLink('shift', today, 'https://www.other.org/', rules)).toEqual({ to: 'tab', spaceId: 's-work' })
    expect(decideLink('navigate', pinned, 'https://third.net/', rules)).toEqual({ to: 'peek' })
  })

  it('[PK-01] links inside a Peek navigate the Peek instead of stacking a card', () => {
    expect(decideLink('navigate', peek, 'https://third.net/', on)).toEqual({ to: 'default' })
    expect(decideLink('new-tab', peek, 'https://third.net/', on)).toEqual({ to: 'self' })
    expect(decideLink('shift', peek, 'https://third.net/', on)).toEqual({ to: 'self' })
    expect(decideLink('background-tab', peek, 'https://third.net/', on)).toEqual({ to: 'default' })
  })

  it('[PK-16] links in a Mini Window never open a Peek', () => {
    expect(decideLink('navigate', mini, 'https://third.net/', on)).toEqual({ to: 'default' })
    expect(decideLink('new-tab', mini, 'https://third.net/', on)).toEqual({ to: 'self' })
    expect(decideLink('shift', mini, 'https://third.net/', on)).toEqual({ to: 'mini' })
  })

  it('[MW-07] ⌘⌥-click opens a Mini Window; explicit tabs and pop-ups keep the default', () => {
    expect(decideLink('mini', today, 'https://other.org/', on)).toEqual({ to: 'mini' })
    expect(decideLink('mini', pinned, 'https://mail.example.com/', on)).toEqual({ to: 'mini' })
    expect(decideLink('background-tab', pinned, 'https://other.org/', on)).toEqual({ to: 'default' })
    expect(decideLink('popup', pinned, 'https://other.org/', on)).toEqual({ to: 'default' })
  })

  it('leaves non-web links alone', () => {
    expect(decideLink('navigate', pinned, 'mailto:a@b.c', on)).toEqual({ to: 'default' })
    expect(decideLink('shift', today, 'about:blank', on)).toEqual({ to: 'default' })
  })
})

describe('meeting links (PK-04)', () => {
  it('recognises common video-call join links', () => {
    for (const url of [
      'https://meet.google.com/abc-defg-hij',
      'https://zoom.us/j/123',
      'https://company.zoom.us/my/someone',
      'https://teams.live.com/meet/123',
      'https://acme.webex.com/meet/someone',
      'https://meet.jit.si/SomeRoom',
      'https://whereby.com/room',
      'https://app.slack.com/huddle/T1/C2',
      'https://facetime.apple.com/join#v=1',
    ]) {
      expect(isMeetingLink(url), url).toBe(true)
    }
    for (const url of [
      'https://meet.google.com/',
      'https://zoom.us/pricing',
      'https://teams.microsoft.com/',
      'https://example.com/meet/123',
      'https://www.google.com/search?q=meet',
    ]) {
      expect(isMeetingLink(url), url).toBe(false)
    }
  })
})

describe('local files a page may have Orbit open (D49)', () => {
  const file = 'file:///tmp/orbit/notes.txt'
  it('a web page: no local file, nor its source; web and other links stay', () => {
    expect(pageMayOpen('https://example.com/a', file)).toBe(false)
    expect(pageMayOpen('http://localhost:3330/page/A', 'FILE:///tmp/x')).toBe(false)
    expect(pageMayOpen('https://example.com/a', `view-source:${file}`)).toBe(false)
    expect(pageMayOpen('https://example.com/a', 'https://example.org/b')).toBe(true)
    expect(pageMayOpen('https://example.com/a', 'mailto:someone@example.com')).toBe(true)
  })
  it('a page that is itself a local file opens local files', () => {
    expect(pageMayOpen('file:///tmp/orbit/index.html', file)).toBe(true)
    expect(pageMayOpen('file:///tmp/orbit/index.html', 'https://example.org/b')).toBe(true)
  })
  it('a page not known (a dropped link), or a blank, data or source page, is not a local file', () => {
    for (const from of [undefined, '', 'about:blank', 'data:text/html,<a>x</a>', `view-source:${file}`]) {
      expect(pageMayOpen(from, file)).toBe(false)
    }
  })
  it('a page that asks from a frame Orbit can’t name: a local file only when every frame is local (F1)', () => {
    const framed = (...origins: string[]) => ({ mainFrame: { framesInSubtree: origins.map((origin) => ({ origin })) } })
    expect(framesMayOpen(framed('file://'), file)).toBe(true)
    // An about:blank or srcdoc frame of a local page has its origin.
    expect(framesMayOpen(framed('file://', 'file://'), file)).toBe(true)
    expect(framesMayOpen(framed('file://', 'http://localhost:3310'), file)).toBe(false)
    expect(framesMayOpen(framed('file://', 'null'), file)).toBe(false)
    expect(framesMayOpen(framed('https://example.com'), file)).toBe(false)
    expect(framesMayOpen(framed('https://example.com'), `view-source:${file}`)).toBe(false)
    expect(framesMayOpen(framed('https://example.com', 'null'), 'https://example.org/b')).toBe(true)
    const gone = {
      get mainFrame(): never {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      },
    }
    expect(framesMayOpen(gone, file)).toBe(false)
    expect(framesMayOpen(gone, 'https://example.org/b')).toBe(true)
  })
  it('a local file refused for a page is named in its toast (round 3 fix check F1)', () => {
    expect(localFileBlockedMessage('file:///tmp/orbit/notes.txt')).toBe('Local file blocked: notes.txt')
    expect(localFileBlockedMessage('file:///tmp/my%20docs/caf%C3%A9%20menu.pdf')).toBe(
      'Local file blocked: café menu.pdf',
    )
    expect(localFileBlockedMessage('view-source:file:///tmp/orbit/index.html')).toBe('Local file blocked: index.html')
    expect(localFileBlockedMessage('file:///C:/Users/me/plan.txt')).toBe('Local file blocked: plan.txt')
    expect(localFileBlockedMessage('file:///home/me/')).toBe('Local file blocked: me')
    expect(localFileBlockedMessage('file:///tmp/100%.txt')).toBe('Local file blocked: 100%.txt')
    expect(localFileBlockedMessage('file:///')).toBe('Local file blocked: file:///')
  })
  it('[DT-13] an internal page only for another internal page: no web, local, blank or unknown page opens one (D53)', () => {
    const internal = 'orbit://version/'
    for (const from of [
      'https://example.com/a',
      'file:///tmp/orbit/index.html',
      'about:blank',
      'data:text/html,<a>x</a>',
      `view-source:${internal}`,
      '',
      undefined,
    ]) {
      expect(pageMayOpen(from, internal), String(from)).toBe(false)
      expect(pageMayOpen(from, 'ORBIT://pages/'), String(from)).toBe(false)
      expect(pageMayOpen(from, ` view-source:${internal}`), String(from)).toBe(false)
    }
    expect(pageMayOpen('orbit://pages/', internal)).toBe(true)
    expect(pageMayOpen('orbit://pages', internal)).toBe(true)
    // An internal page opens web pages, and no local file.
    expect(pageMayOpen('orbit://pages/', 'https://example.org/b')).toBe(true)
    expect(pageMayOpen('orbit://pages/', file)).toBe(false)
    // Asked from a frame Orbit can't name: only when every frame is an internal page's.
    const framed = (...origins: string[]) => ({ mainFrame: { framesInSubtree: origins.map((origin) => ({ origin })) } })
    expect(framesMayOpen(framed('https://example.com'), internal)).toBe(false)
    expect(framesMayOpen(framed('file://'), internal)).toBe(false)
    expect(framesMayOpen(framed('orbit://pages', 'https://example.com'), internal)).toBe(false)
    expect(framesMayOpen(framed('orbit://pages'), internal)).toBe(true)
    expect(isInternalPageUrl(internal)).toBe(true)
    expect(isInternalPageUrl('https://example.com/orbit://x')).toBe(false)
    expect(isInternalPageUrl('orbitx://y')).toBe(false)
  })
  it('which addresses are local files', () => {
    expect(isLocalFileUrl(file)).toBe(true)
    expect(isLocalFileUrl(` ${file}`)).toBe(true)
    expect(isLocalFileUrl('view-source:file:///etc/hosts')).toBe(true)
    expect(isLocalFileUrl('https://example.com/file:///x')).toBe(false)
    expect(isLocalFileUrl('filesystem:https://example.com/temporary/x')).toBe(false)
  })
})

describe('link routing rules (ST-09)', () => {
  it('matches "contains" and "exact" rules, first rule wins', () => {
    const rules = [
      { match: 'exact' as const, value: 'https://example.com/', spaceId: 's-a' },
      { match: 'contains' as const, value: 'github.com/acme', spaceId: 's-b' },
      { match: 'contains' as const, value: 'github.com', spaceId: 's-c' },
      { match: 'contains' as const, value: '  ', spaceId: 's-empty' },
    ]
    expect(routeFor(rules, 'http://example.com')).toBe('s-a')
    expect(routeFor(rules, 'https://example.com/other')).toBeUndefined()
    expect(routeFor(rules, 'https://github.com/acme/repo')).toBe('s-b')
    expect(routeFor(rules, 'https://GitHub.com/other')).toBe('s-c')
    expect(routeFor([], 'https://github.com')).toBeUndefined()
  })
})

describe('Peek card geometry (PK-05, PK-06)', () => {
  it('insets the card from the page area so the page shows around it', () => {
    const area = { width: 1100, height: 820 }
    const card = peekCard(area)
    expect(card.x).toBeGreaterThanOrEqual(32)
    expect(card.x).toBeLessThanOrEqual(64)
    expect(card.y).toBeGreaterThanOrEqual(22)
    expect(card.width / area.width).toBeGreaterThan(0.85)
    expect(card.width / area.width).toBeLessThan(0.95)
    expect(card.x * 2 + card.width).toBe(area.width)
    expect(card.y * 2 + card.height).toBe(area.height)
  })

  it('grows from the clicked link, or from slightly smaller at the centre', () => {
    const area = { width: 1000, height: 800 }
    const card = peekCard(area)
    const fromLink = peekStart(card, area, { x: 100, y: 700 })
    expect(fromLink.width).toBeLessThan(card.width / 4)
    expect(fromLink.x + fromLink.width / 2).toBeCloseTo(100, 0)
    expect(fromLink.y + fromLink.height).toBeLessThanOrEqual(area.height)
    const centred = peekStart(card, area)
    expect(centred.width / card.width).toBeCloseTo(0.94, 2)
    expect(centred.x + centred.width / 2).toBeCloseTo(card.x + card.width / 2, 5)
  })
})

describe('Peek interactive dismiss (PK-06, FL-19)', () => {
  const area = { width: 1000, height: 800 }
  const card = peekCard(area)

  it('[PK-06] the dragged card follows the input 1:1 downward and shrinks a little', () => {
    const moved = draggedCard(card, 100, card.height)
    // Its centre moves down exactly as far as the pointer.
    expect(moved.y + moved.height / 2).toBeCloseTo(card.y + card.height / 2 + 100, 5)
    expect(moved.x + moved.width / 2).toBeCloseTo(card.x + card.width / 2, 5)
    expect(moved.width).toBeLessThan(card.width)
    expect(moved.width / card.width).toBeGreaterThan(0.95)
    expect(draggedCard(card, 0, card.height)).toEqual(card)
  })

  it('[PK-06] dragged upward it only gives a little (rubber band)', () => {
    expect(dragTravel(-10)).toBeLessThan(0)
    expect(dragTravel(-10)).toBeGreaterThan(-10)
    expect(dragTravel(-1000)).toBeGreaterThanOrEqual(-PEEK_DRAG_UP_MAX)
    expect(draggedCard(card, -400, card.height).width).toBe(card.width)
  })

  it('[PK-06] letting go past a quarter of its height or flicking down faster than 500 px/s dismisses it', () => {
    const h = card.height
    expect(dismissesOnRelease(h * 0.3, h, 0)).toBe(true)
    expect(dismissesOnRelease(h * 0.2, h, 0)).toBe(false)
    expect(dismissesOnRelease(20, h, 800)).toBe(true)
    expect(dismissesOnRelease(20, h, 300)).toBe(false)
    // Past the threshold but pushed back up quickly: it stays.
    expect(dismissesOnRelease(h * 0.3, h, -900)).toBe(false)
  })

  it('[PK-06] the release velocity is the movement of the last ~100 ms; holding still first gives zero', () => {
    const samples = [
      { t: 0, y: 0 },
      { t: 50, y: 20 },
      { t: 100, y: 60 },
      { t: 150, y: 110 },
    ]
    expect(releaseVelocity(samples, 150)).toBeCloseTo(((110 - 20) / 100) * 1000, 5)
    expect(releaseVelocity(samples, 400)).toBe(0)
    expect(releaseVelocity([], 10)).toBe(0)
    expect(releaseVelocity([{ t: 0, y: 0 }], 0)).toBe(0)
  })

  it('[PK-06] events delivered together (one timestamp) still read as a flick, not a stop', () => {
    const together = [
      { t: 40, y: 0 },
      { t: 40, y: 15 },
      { t: 40, y: 30 },
    ]
    expect(releaseVelocity(together, 40)).toBeGreaterThan(PEEK_DISMISS_VELOCITY)
    expect(dismissesOnRelease(30, 600, releaseVelocity(together, 40))).toBe(true)
  })
})

/** Runs a spring frame by frame, as the overlay does: when it looks done, when it rests, its peak. */
function runSpring(cfg: Spring, fps: number) {
  let x = 0
  let v = 0
  let ms = 0
  let peak = 0
  let done: number | undefined
  while (ms < 2000) {
    const next = advanceSpring(cfg, x, v, 1 / fps)
    x = next.x
    v = next.v
    ms += 1000 / fps
    peak = Math.max(peak, x)
    if (done === undefined && Math.abs(1 - x) < 0.005) done = ms
    if (springResting(x, v)) return { done: done ?? ms, rest: ms, peak }
  }
  throw new Error('the spring never came to rest')
}

describe('Peek motion timing (FL-19)', () => {
  it('[FL-19][PK-06] the card grows into place in about 280–320 ms with no visible overshoot', () => {
    const open = runSpring(PEEK_OPEN_SPRING, 60)
    expect(open.done).toBeGreaterThanOrEqual(250)
    expect(open.done).toBeLessThanOrEqual(330)
    expect(open.peak).toBeLessThanOrEqual(1.02)
    expect(open.rest).toBeLessThan(450)
  })

  it('[FL-19][PK-07] expanding to a tab meets the page frame in about 220–260 ms', () => {
    const expand = runSpring(PEEK_EXPAND_SPRING, 60)
    expect(expand.done).toBeGreaterThanOrEqual(200)
    expect(expand.done).toBeLessThanOrEqual(270)
    expect(expand.peak).toBeLessThanOrEqual(1.02)
  })

  it('[FL-19][PK-09] closing shrinks to about 0.96 and fades in 150–180 ms', () => {
    expect(PEEK_CLOSE_MS).toBeGreaterThanOrEqual(150)
    expect(PEEK_CLOSE_MS).toBeLessThanOrEqual(180)
    expect(PEEK_CLOSE_SCALE).toBeCloseTo(0.96, 5)
  })

  it('[FL-19] slow frames neither speed the springs up nor make them jump or overshoot', () => {
    // At 10 fps a frame is 100 ms; each frame advances at most 50 ms of motion.
    const slow = runSpring(PEEK_OPEN_SPRING, 10)
    expect(slow.peak).toBeLessThanOrEqual(1.02)
    expect(slow.done).toBeGreaterThan(runSpring(PEEK_OPEN_SPRING, 60).done)
    expect(advanceSpring(PEEK_OPEN_SPRING, 0, 0, 5).x).toBeCloseTo(advanceSpring(PEEK_OPEN_SPRING, 0, 0, 0.05).x, 9)
  })
})
