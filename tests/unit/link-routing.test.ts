import { describe, expect, it } from 'vitest'
import {
  decideLink,
  isMeetingLink,
  type LinkSettings,
  type LinkSource,
  routeFor,
  sameSite,
} from '../../src/shared/link-routing'
import { peekCard, peekStart } from '../../src/shared/peek-geometry'

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
