import { describe, expect, it } from 'vitest'
import { normalizeState } from '../../src/main/persist'
import { createInitialState, DEFAULT_SETTINGS } from '../../src/shared/defaults'
import type { OrbitState, Tweak } from '../../src/shared/state'
import {
  addHidden,
  applyTweakPatch,
  clearTweak,
  colorChain,
  colorCss,
  composeChain,
  DEFAULT_TWEAK_STYLE,
  enabledTweaksFor,
  FONT_PRESETS,
  fontCss,
  hostOrigin,
  invertAffine,
  isEmptyTweak,
  isSafeSelector,
  newTweak,
  normalizeTweak,
  normalizeTweaks,
  removeHidden,
  runChain,
  shuffleStyle,
  subdomainsPossible,
  tweakAppliesTo,
  tweakHostOf,
  tweakIndex,
  tweakOriginOf,
  tweakScript,
  tweakSheets,
  tweaksByHost,
  tweaksFor,
  withImportant,
  withThemeVariables,
} from '../../src/shared/tweaks'

type Rgb = [number, number, number]

const tweak = (id: string, host: string, patch: Partial<Tweak> = {}, createdAt = 1): Tweak => ({
  ...newTweak(id, host, createdAt),
  ...patch,
})
const record = (...list: Tweak[]) => Object.fromEntries(list.map((t) => [t.id, t]))

function hsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s, l }
}
const hueGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const near = (a: Rgb, b: Rgb, tolerance: number) => a.every((v, i) => Math.abs(v - (b[i] as number)) <= tolerance)
const WHITE: Rgb = [1, 1, 1]
const BLACK: Rgb = [0, 0, 0]

describe('[BO-17] which pages a Tweak applies to', () => {
  it('keys a page by its lowercase hostname, without the port, on websites only', () => {
    expect(tweakHostOf('https://WWW.Example.com:8443/a/b?x=1#y')).toBe('www.example.com')
    expect(tweakHostOf('http://example.com./')).toBe('example.com')
    expect(tweakHostOf('http://127.0.0.1:3300/x')).toBe('127.0.0.1')
    expect(tweakHostOf('http://[::1]:3300/')).toBe('[::1]')
    for (const url of [
      'orbit://settings/',
      'file:///tmp/a.html',
      'about:blank',
      'data:text/html,x',
      'chrome://gpu',
      '',
      'nonsense',
    ])
      expect(tweakHostOf(url)).toBeNull()
  })

  it('applies on every page of its host, and not on another site', () => {
    const t = tweak('a', 'www.example.com')
    expect(tweakAppliesTo(t, tweakHostOf('https://www.example.com/a/b?x=1'))).toBe(true)
    expect(tweakAppliesTo(t, tweakHostOf('https://example.org/'))).toBe(false)
    expect(tweakAppliesTo(t, tweakHostOf('https://example.com/'))).toBe(false)
    expect(tweakAppliesTo(t, tweakHostOf('https://news.www.example.com/'))).toBe(false)
  })

  it('reaches subdomains only when it says so, and never by the numbers of an address', () => {
    const t = tweak('a', 'example.com', { subdomains: true })
    expect(tweakAppliesTo(t, 'news.example.com')).toBe(true)
    expect(tweakAppliesTo(t, 'a.b.example.com')).toBe(true)
    expect(tweakAppliesTo(t, 'badexample.com')).toBe(false)
    const ip = tweak('b', '0.0.1', { subdomains: true })
    expect(tweaksFor(record(ip), '127.0.0.1')).toEqual([])
    expect(subdomainsPossible('example.com')).toBe(true)
    expect(subdomainsPossible('127.0.0.1')).toBe(false)
    expect(subdomainsPossible('[::1]')).toBe(false)
  })

  it('finds a host’s Tweaks through an index built once per collection, oldest first', () => {
    const older = tweak('b', 'example.com', {}, 5)
    const newer = tweak('a', 'example.com', {}, 9)
    const parent = tweak('c', 'example.com', { subdomains: true }, 7)
    const other = tweak('d', 'example.org', {}, 1)
    const all = record(newer, older, other)
    expect(tweakIndex(all)).toBe(tweakIndex(all))
    expect(tweaksFor(all, 'example.com').map((t) => t.id)).toEqual(['b', 'a'])
    const withParent = record(newer, older, parent, tweak('e', 'news.example.com', {}, 6))
    expect(tweaksFor(withParent, 'news.example.com').map((t) => t.id)).toEqual(['e', 'c'])
    expect(tweaksFor(withParent, null)).toEqual([])
  })

  it('applies none while Tweaks are off as a whole, and skips those switched off (BO-14, BO-16)', () => {
    const on = tweak('a', 'example.com')
    const off = tweak('b', 'example.com', { enabled: false })
    const all = record(on, off)
    expect(enabledTweaksFor(all, DEFAULT_SETTINGS, 'example.com').map((t) => t.id)).toEqual(['a'])
    expect(enabledTweaksFor(all, { ...DEFAULT_SETTINGS, tweaksEnabled: false }, 'example.com')).toEqual([])
  })
})

describe('[BO-01][BO-18] the saved Tweak', () => {
  it('starts named after its host, on, changing nothing, its JavaScript allowed on this device', () => {
    const t = newTweak('t1', 'news.example.com', 42)
    expect(t).toMatchObject({
      name: 'news.example.com',
      enabled: true,
      subdomains: false,
      jsAllowed: true,
      jsInPrivate: false,
    })
    expect(t.style).toEqual(DEFAULT_TWEAK_STYLE)
    expect(isEmptyTweak(t)).toBe(true)
  })

  it('loads with defaults for what is missing, clamped values, and no JavaScript allowed unless saved so', () => {
    const t = normalizeTweak('x', {
      host: 'Example.COM.',
      js: 'console.log(1)',
      style: {
        size: 500,
        intensity: 2,
        hue: -30,
        font: 'nope',
        textCase: 'shout',
        hidden: [{ id: 'h', selector: '#ad' }, { selector: 'a{' }],
      },
    })
    expect(t).toMatchObject({
      host: 'example.com',
      name: 'example.com',
      enabled: true,
      jsAllowed: false,
      subdomains: false,
    })
    expect(t?.style).toMatchObject({ size: 150, intensity: 1, hue: 330, font: '', textCase: 'none' })
    expect(t?.style.hidden).toEqual([{ id: 'h', selector: '#ad', label: '' }])
    expect(normalizeTweak('y', { host: '' })).toBeNull()
    expect(normalizeTweak('y', 'text')).toBeNull()
    expect(Object.keys(normalizeTweaks({ a: { host: 'a.com' }, b: null, c: { host: 'b c' } }))).toEqual(['a'])
  })

  it('loads a state file from before Tweaks had their controls, and the switches default on and unseen', () => {
    const raw = createInitialState(0) as unknown as Record<string, unknown>
    raw.tweaks = {
      old: { id: 'old', host: 'example.com', name: 'Mine', enabled: false, css: 'a{}', js: '', createdAt: 3 },
    }
    const settings = raw.settings as Record<string, unknown>
    delete settings.tweaksEnabled
    delete settings.tweakIntroSeen
    const state = normalizeState(JSON.parse(JSON.stringify(raw)) as Partial<OrbitState>)
    expect(state.tweaks.old).toMatchObject({
      name: 'Mine',
      enabled: false,
      css: 'a{}',
      updatedAt: 3,
      style: DEFAULT_TWEAK_STYLE,
    })
    expect(state.settings.tweaksEnabled).toBe(true)
    expect(state.settings.tweakIntroSeen).toBe(false)
  })

  it('takes edits checked: clamped and typed; editing JavaScript never allows it (BO-11, BO-18)', () => {
    const t = { ...newTweak('t', 'example.com', 1), jsAllowed: false }
    expect(applyTweakPatch(t, { style: { size: 999, hue: 'red' as unknown as number } }, 5)).toBe(true)
    expect(t.style.size).toBe(150)
    expect(t.style.hue).toBe(DEFAULT_TWEAK_STYLE.hue)
    expect(t.updatedAt).toBe(5)
    expect(applyTweakPatch(t, { style: { size: 150 } }, 9)).toBe(false)
    expect(t.updatedAt).toBe(5)
    applyTweakPatch(t, { js: 'document.title = "x"' }, 10)
    expect(t.js).toBe('document.title = "x"')
    expect(t.jsAllowed).toBe(false)
    applyTweakPatch(t, { jsAllowed: true }, 10)
    expect(t.jsAllowed).toBe(true)
    applyTweakPatch(t, { name: '   ' }, 11)
    expect(t.name).toBe('example.com')
    applyTweakPatch(t, { style: { hidden: [] } as never }, 12)
    expect(t.style.hidden).toEqual([])
  })
})

describe('[BO-11] custom CSS wins over the page', () => {
  it('makes each declaration important', () => {
    expect(withImportant('body { background: yellow }')).toBe('body { background: yellow !important }')
    expect(withImportant('a{color:red;b:1}')).toBe('a{color:red !important;b:1 !important}')
    expect(withImportant('a { color: red !important; }')).toBe('a { color: red !important; }')
    expect(withImportant('a { --x: 1px }')).toBe('a { --x: 1px !important }')
  })

  it('in nested rules and grouping rules too, and nowhere it isn’t allowed', () => {
    expect(withImportant('@media (max-width: 600px) { a { color: red } }')).toBe(
      '@media (max-width: 600px) { a { color: red !important } }',
    )
    expect(withImportant('a { color: red; &:hover { color: blue } }')).toBe(
      'a { color: red !important; &:hover { color: blue !important } }',
    )
    const keep = [
      '@keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }',
      '@font-face { font-family: X; src: url(a.woff2) }',
      '@property --y { syntax: "<length>"; inherits: false; initial-value: 0px }',
      '@import url("x.css");',
    ]
    for (const css of keep) expect(withImportant(css)).toBe(css)
  })

  it('reads strings, URLs and selectors with braces or semicolons in them as one piece', () => {
    expect(withImportant('a { background: url(data:image/png;base64,AA) }')).toBe(
      'a { background: url(data:image/png;base64,AA) !important }',
    )
    expect(withImportant('a[title="{;}"] { content: "};{" }')).toBe('a[title="{;}"] { content: "};{" !important }')
  })

  it('closes what was left open, so half-typed CSS swallows nothing after it', () => {
    expect(withImportant('a { color: red')).toBe('a { color: red !important}')
    expect(withImportant('a { content: "x')).toBe('a { content: "x" !important}')
    expect(withImportant('a { color: red } /* note')).toBe('a { color: red !important } /* note*/')
    expect(withImportant('a { background: url(x')).toBe('a { background: url(x) !important}')
    expect(withImportant('a:is(.b { color: red }')).toBe('a:is(.b ){ color: red !important }')
    expect(withImportant('} a { color: red }')).toBe(' a { color: red !important }')
  })
})

describe('[BO-10] what Hide-element mode saves', () => {
  it('is a selector that can’t reach outside its own rule', () => {
    for (const ok of ['#main > .ad', 'a[href*="x;y"]', 'div:nth-child(2)', ':is(a, b) span', 'p.a\\:b'])
      expect(isSafeSelector(ok), ok).toBe(true)
    for (const bad of ['a{', 'a;b', 'a /* x', 'a[', 'a:not(b', '"x', 'a\\', 'a ]', 'a\nb', '', '[title="a\nb"]'])
      expect(isSafeSelector(bad), bad).toBe(false)
  })

  it('adds each selector once, while there is room, and takes it back by its id', () => {
    const t = tweak('t1', 'news.test')
    expect(addHidden(t, { id: 'h1', selector: ' #promo ', label: 'Big promo' }, 5)).toBe(true)
    expect(t.style.hidden).toEqual([{ id: 'h1', selector: '#promo', label: 'Big promo' }])
    expect(t.updatedAt).toBe(5)
    // The same selector, the same id, or one that could reach outside its rule: nothing changes.
    expect(addHidden(t, { id: 'h2', selector: '#promo', label: '' }, 6)).toBe(false)
    expect(addHidden(t, { id: 'h1', selector: '.ad', label: '' }, 6)).toBe(false)
    expect(addHidden(t, { id: 'h3', selector: 'a{} body', label: '' }, 6)).toBe(false)
    expect(addHidden(t, { id: 'h4', selector: '.ad', label: 'x'.repeat(500) }, 7)).toBe(true)
    expect(t.style.hidden[1]?.label).toHaveLength(120)
    expect(t.updatedAt).toBe(7)
    for (let i = t.style.hidden.length; i < 400; i++) addHidden(t, { id: `n${i}`, selector: `.n${i}`, label: '' }, 8)
    expect(addHidden(t, { id: 'over', selector: '.over', label: '' }, 9)).toBe(false)
    expect(t.style.hidden).toHaveLength(400)
    expect(removeHidden(t, 'h1', 10)).toBe(true)
    expect(removeHidden(t, 'h1', 11)).toBe(false)
    expect(t.style.hidden.some((h) => h.selector === '#promo')).toBe(false)
    expect(t.updatedAt).toBe(10)
  })
})

describe('[BO-15] the Library’s list', () => {
  it('lists by site, alphabetically, a site’s Tweaks oldest first', () => {
    const all = record(
      tweak('a', 'shop.example', {}, 1),
      tweak('b', 'news.example', {}, 5),
      tweak('c', 'news.example', {}, 2),
      tweak('d', 'blog.example', {}, 9),
    )
    expect(tweaksByHost(all).map((t) => t.id)).toEqual(['d', 'c', 'b', 'a'])
    expect(tweaksByHost({})).toEqual([])
  })

  it('keeps the origin a Tweak was made on, for Open Site; a site without one opens on https, or http on this device', () => {
    expect(tweakOriginOf('http://shop.example:8080/cart?x=1#top', 'shop.example')).toBe('http://shop.example:8080')
    expect(tweakOriginOf('https://Shop.Example./a', 'shop.example')).toBe('https://shop.example.')
    // Another host's page, or no page: the host's own.
    expect(tweakOriginOf('https://other.example/', 'shop.example')).toBe('https://shop.example')
    expect(tweakOriginOf('file:///tmp/a.html', 'shop.example')).toBe('https://shop.example')
    expect(tweakOriginOf(undefined, 'shop.example')).toBe('https://shop.example')
    expect(hostOrigin('localhost')).toBe('http://localhost')
    expect(hostOrigin('app.localhost')).toBe('http://app.localhost')
    expect(hostOrigin('192.168.1.20')).toBe('http://192.168.1.20')
    expect(hostOrigin('[::1]')).toBe('http://[::1]')
    expect(newTweak('t', 'news.example', 1).origin).toBe('https://news.example')
    expect(newTweak('t', 'localhost', 1, 'http://localhost:5173').origin).toBe('http://localhost:5173')
    // Loaded: kept when it is the host's, else the host's own.
    expect(normalizeTweak('x', { host: 'localhost', origin: 'http://localhost:5173' })?.origin).toBe(
      'http://localhost:5173',
    )
    expect(normalizeTweak('x', { host: 'news.example', origin: 'https://evil.example' })?.origin).toBe(
      'https://news.example',
    )
    expect(normalizeTweak('x', { host: 'news.example', origin: 'javascript:alert(1)' })?.origin).toBe(
      'https://news.example',
    )
    expect(normalizeTweak('x', { host: 'news.example' })?.origin).toBe('https://news.example')
  })
})

describe('[BO-12][BO-13] the title menu', () => {
  it('resets every edit and keeps the name, the switch and the scope', () => {
    const t = tweak('t1', 'news.test', { name: 'Calm news', enabled: false, subdomains: true, css: 'a{}', js: 'x()' })
    t.style = { ...t.style, hue: 40, intensity: 0.6, font: 'serif', size: 120, textCase: 'upper' }
    addHidden(t, { id: 'h1', selector: '#promo', label: '' }, 2)
    expect(clearTweak(t, 9)).toBe(true)
    expect(isEmptyTweak(t)).toBe(true)
    expect(t.style).toEqual({ ...DEFAULT_TWEAK_STYLE, hidden: [] })
    expect([t.name, t.enabled, t.subdomains, t.updatedAt]).toEqual(['Calm news', false, true, 9])
    // Nothing to reset: nothing changes, not even the time.
    expect(clearTweak(t, 10)).toBe(false)
    expect(t.updatedAt).toBe(9)
  })

  it('shuffles a look that holds together, and never hidden elements or code', () => {
    let seed = 7
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return (seed - 1) / 2147483646
    }
    const fonts = new Set<string>()
    let inverted = 0
    for (let i = 0; i < 400; i++) {
      const look = shuffleStyle(random)
      expect(Object.keys(look).sort()).toEqual(
        [
          'accent',
          'brightness',
          'contrast',
          'font',
          'hue',
          'intensity',
          'invert',
          'saturation',
          'size',
          'textCase',
        ].sort(),
      )
      expect(look.hue).toBeGreaterThanOrEqual(0)
      expect(look.hue).toBeLessThan(360)
      expect(look.intensity).toBeGreaterThanOrEqual(0.35)
      expect(look.intensity).toBeLessThanOrEqual(0.85)
      const step = ((look.accent as number) - (look.hue as number) + 360) % 360
      expect([30, 60, 120, 150, 180, 210, 240, 300]).toContain(step)
      expect([look.contrast, look.brightness, look.saturation]).toEqual([100, 100, 100])
      expect([100, 110]).toContain(look.size)
      fonts.add(look.font as string)
      if (look.invert) inverted++
      // What it makes is a valid style as it is.
      const t = tweak('t', 'a.test')
      applyTweakPatch(t, { style: look }, 1)
      expect(t.style).toMatchObject(look)
    }
    expect(fonts.size).toBe(FONT_PRESETS.length)
    expect(inverted).toBeGreaterThan(60)
    expect(inverted).toBeLessThan(180)
    // Always the same look from the same numbers.
    expect(shuffleStyle(() => 0.5)).toEqual(shuffleStyle(() => 0.5))
  })
})

describe('[BO-03][BO-04][BO-05][BO-06] colours', () => {
  const style = (patch: Partial<typeof DEFAULT_TWEAK_STYLE>) => ({ ...DEFAULT_TWEAK_STYLE, ...patch })

  it('change nothing at their defaults (BO-06’s reset)', () => {
    expect(colorChain(DEFAULT_TWEAK_STYLE)).toEqual([])
    expect(colorCss(DEFAULT_TWEAK_STYLE)).toBe('')
  })

  it('tint white to a pastel of the wheel’s hue, as light as the intensity says, and keep black', () => {
    for (const hue of [0, 30, 60, 120, 180, 220, 270, 320])
      for (const intensity of [0.25, 0.5, 1]) {
        const chain = colorChain(style({ hue, accent: hue, intensity }))
        const white = hsl(runChain(chain, WHITE))
        expect(hueGap(white.h, hue), `hue ${hue} at ${intensity}`).toBeLessThan(4)
        expect(Math.abs(white.l - (1 - 0.12 * intensity)), `lightness ${hue} at ${intensity}`).toBeLessThan(0.02)
        expect(near(runChain(chain, BLACK), BLACK, 2 / 255)).toBe(true)
      }
  })

  it('keep text readable on its background, tinted or inverted', () => {
    for (const hue of [0, 60, 120, 220, 300])
      for (const invert of [false, true]) {
        const chain = colorChain(style({ hue, accent: hue, intensity: 1, invert }))
        expect(contrast(runChain(chain, WHITE), runChain(chain, BLACK)), `hue ${hue}`).toBeGreaterThan(7)
        expect(contrast(runChain(chain, WHITE), runChain(chain, [0.2, 0.2, 0.2])), `hue ${hue}`).toBeGreaterThan(4.5)
      }
  })

  it('invert lightness: white becomes black, black white, and greys keep their place (BO-04)', () => {
    const chain = colorChain(style({ invert: true }))
    expect(near(runChain(chain, WHITE), BLACK, 1 / 255)).toBe(true)
    expect(near(runChain(chain, BLACK), WHITE, 1 / 255)).toBe(true)
    expect(near(runChain(chain, [0.5, 0.5, 0.5]), [0.5, 0.5, 0.5], 1 / 255)).toBe(true)
    const blue = hsl(runChain(chain, [0.2, 0.4, 0.8]))
    expect(hueGap(blue.h, hsl([0.2, 0.4, 0.8]).h)).toBeLessThan(3)
  })

  it('turn the page’s own colours by the rim handle’s distance from the main hue', () => {
    const red: Rgb = [0.8, 0.2, 0.2]
    const kept = hsl(runChain(colorChain(style({ hue: 220, accent: 220, intensity: 0.5 })), red)).h
    expect(hueGap(kept, 0)).toBeLessThan(15)
    const turned = hsl(runChain(colorChain(style({ hue: 220, accent: 340, intensity: 0.5 })), red)).h
    expect(hueGap(turned, 120)).toBeLessThan(25)
  })

  it('give images and video a filter that undoes the page’s, for their usual colours', () => {
    let seed = 3
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (const s of [
      style({ invert: true }),
      style({ hue: 220, accent: 220, intensity: 0.5 }),
      style({ contrast: 120, brightness: 90 }),
    ]) {
      const chain = colorChain(s)
      const inverse = invertAffine(composeChain(chain))
      expect(inverse).not.toBeNull()
      if (!inverse) continue
      for (let n = 0; n < 300; n++) {
        // A photo's colours: muted, mid lightness.
        const grey = 0.25 + random() * 0.5
        const x: Rgb = [grey + (random() - 0.5) * 0.2, grey + (random() - 0.5) * 0.2, grey + (random() - 0.5) * 0.2]
        const undone = [0, 1, 2].map((r) =>
          Math.min(
            1,
            Math.max(
              0,
              inverse.m[r * 3]! * x[0] + inverse.m[r * 3 + 1]! * x[1] + inverse.m[r * 3 + 2]! * x[2] + inverse.t[r]!,
            ),
          ),
        ) as Rgb
        expect(near(runChain(chain, undone), x, 4 / 255)).toBe(true)
      }
    }
    expect(colorCss(style({ invert: true }))).toContain('feColorMatrix')
  })

  it('reach the top layer and a page without a background of its own', () => {
    const css = colorCss(style({ invert: true }))
    expect(css).toContain('html { background-color: Canvas; }')
    expect(css).toMatch(/html, :modal, :popover-open \{ filter: invert\(1\) hue-rotate\(180deg\) !important; \}/)
  })
})

describe('[BO-07][BO-08][BO-09][BO-14] a page’s stylesheets', () => {
  it('are in the Tweak layer, one for the colours, one for type and one per Tweak', () => {
    const a = tweak(
      'a',
      'example.com',
      { css: 'body { color: red }', style: { ...DEFAULT_TWEAK_STYLE, size: 110, invert: true } },
      1,
    )
    const b = tweak(
      'b',
      'example.com',
      { style: { ...DEFAULT_TWEAK_STYLE, size: 125, hidden: [{ id: 'h', selector: '.ad', label: 'Ad' }] } },
      2,
    )
    const parts = tweakSheets([a, b])
    expect(parts.map((p) => p.key)).toEqual(['color', 'base', 't:a', 't:b'])
    for (const part of parts) expect(part.css.startsWith('@layer orbit-tweaks {')).toBe(true)
    expect(parts[1]?.css).toContain('zoom: 1.25 !important')
    expect(parts[2]?.css).toContain('body { color: red !important }')
    expect(parts[3]?.css).toContain('.ad { display: none !important; }')
    expect(tweakSheets([b], { showHidden: 'h' }).map((p) => p.key)).toEqual(['base'])
    expect(tweakSheets([])).toEqual([])
  })

  it('leave icon fonts and code in their own fonts', () => {
    expect(FONT_PRESETS.length).toBeGreaterThanOrEqual(6)
    const css = fontCss('serif')
    expect(css).toContain('[class*="icon" i]')
    expect(css).toContain('code')
    expect(css).toMatch(/serif !important; \}$/)
    expect(fontCss('')).toBe('')
  })

  it('put the Space colours in place of their variables, so the page never sees them (BO-19)', () => {
    const vars = { '--orbit-theme-accent': '#ff0000' }
    expect(withThemeVariables('a { color: var(--orbit-theme-accent) }', vars)).toBe('a { color: #ff0000 }')
    expect(withThemeVariables('a { color: var(--orbit-nope, blue) }', vars)).toBe('a { color: blue }')
    expect(withThemeVariables('a { color: var(--orbit-nope, rgb(1, 2, 3)) }', vars)).toBe('a { color: rgb(1, 2, 3) }')
    expect(withThemeVariables('a { color: var(--page-own) }', vars)).toBe('a { color: var(--page-own) }')
  })
})

describe('[BO-11] JavaScript', () => {
  it('runs in a function of its own whose errors go to the page’s console, named', () => {
    const script = tweakScript({ name: 'My "best" </script>', js: 'throw new Error("x") // last line' })
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain(JSON.stringify('[Tweak “My "best" </script>”]'))
    const logged: unknown[][] = []
    const run = new Function('window', 'console', script)
    run({}, { error: (...args: unknown[]) => logged.push(args) })
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.[1])).toContain('Error: x')
  })
})
