/**
 * Tweaks (BO-*): per-site customisations, as pure logic shared by main and the renderers.
 *
 * - The model: a Tweak's defaults, normalisation of what was saved, and checked edits.
 * - Matching (BO-17): which Tweaks apply to a page's host. An index by host makes it a few map
 *   lookups (the host, then each parent domain for "also apply to subdomains"), never a scan.
 * - The stylesheets (BO-18): what a page gets, as several sheets (`tweakSheets`): the colours (the
 *   wheel, invert and sliders: a filter on the root, and its inverse on images and video), the type
 *   (fonts, size, case), and each Tweak's hidden elements and own CSS. All sit in the cascade layer
 *   `orbit-tweaks`, every declaration `!important`: a layered important declaration beats the
 *   page's own important ones, wherever the sheet sits in the cascade.
 * - The Space colours (BO-19): `var(--orbit-theme-…)` in a Tweak's CSS is replaced by the colour
 *   itself, so the variables exist only inside Tweaks and never on the page.
 * - JavaScript (BO-11): the code main runs in the page, with errors going to the page's console.
 */
import { TWEAK_SHEET_MEDIA } from './site'
import type { Settings, Tweak, TweakHidden, TweakStyle } from './state'
import { hexToHsl } from './theme'

// ---- Model ----------------------------------------------------------------

/** The cascade layer every Tweak rule is in; also the media type that marks the preload's sheets. */
export const TWEAK_LAYER = 'orbit-tweaks'
export { TWEAK_SHEET_MEDIA }

/** Page size steps (BO-08), in percent. The −/+ buttons move between them. */
export const TWEAK_SIZES = [90, 100, 110, 125, 150] as const
export const TWEAK_SIZE_MIN = 90
export const TWEAK_SIZE_MAX = 150

/** Text case, in the order the case button cycles through (BO-09). */
export const TEXT_CASES: TweakStyle['textCase'][] = ['none', 'lower', 'upper', 'capitalize']

/** The advanced sliders' range (BO-05), in percent; 100 changes nothing. */
export const SLIDER_MIN = 50
export const SLIDER_MAX = 150
export const SATURATION_MAX = 200

/** Limits on what a Tweak holds. */
export const TWEAK_LIMITS = { name: 80, code: 200_000, hidden: 400, selector: 2_000, label: 120 } as const

export interface FontPreset {
  id: string
  label: string
  /** A font stack of typefaces already on the computer: nothing is downloaded (BO-02, BO-07). */
  stack: string
}

/**
 * Font presets (BO-07): serif, sans-serif, monospace, rounded and handwritten styles. Each is a
 * stack of fonts the system may have, ending in a generic family, so Orbit bundles no font files
 * and a page never fetches one; the exact face differs between systems.
 */
export const FONT_PRESETS: readonly FontPreset[] = [
  {
    id: 'sans',
    label: 'Sans',
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Cantarell, "Helvetica Neue", Arial, sans-serif',
  },
  {
    id: 'serif',
    label: 'Serif',
    stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, "Noto Serif", "DejaVu Serif", Georgia, serif',
  },
  {
    id: 'classic',
    label: 'Classic',
    stack: '"Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", P052, "Book Antiqua", Georgia, serif',
  },
  {
    id: 'humanist',
    label: 'Humanist',
    stack: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", "Source Sans Pro", sans-serif',
  },
  {
    id: 'rounded',
    label: 'Rounded',
    stack:
      'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", "Arial Rounded MT Bold", Calibri, sans-serif',
  },
  {
    id: 'mono',
    label: 'Mono',
    stack:
      'ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    stack: '"American Typewriter", "Courier Prime", "Courier New", Courier, "Nimbus Mono PS", monospace',
  },
  {
    id: 'hand',
    label: 'Hand',
    stack: '"Comic Neue", "Comic Sans MS", "Chalkboard SE", "Segoe Print", "Bradley Hand", Chilanka, cursive',
  },
]

export const DEFAULT_TWEAK_STYLE: TweakStyle = {
  hue: 220,
  intensity: 0,
  accent: 220,
  invert: false,
  contrast: 100,
  brightness: 100,
  saturation: 100,
  font: '',
  size: 100,
  textCase: 'none',
  hidden: [],
}

/** A new Tweak for a host, named after it (BO-01), on, with nothing changed yet. */
export function newTweak(id: string, host: string, now: number): Tweak {
  return {
    id,
    host,
    name: host,
    enabled: true,
    css: '',
    js: '',
    createdAt: now,
    updatedAt: now,
    subdomains: false,
    jsAllowed: true,
    jsInPrivate: false,
    style: { ...DEFAULT_TWEAK_STYLE, hidden: [] },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const num = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
/** Degrees in [0, 360). */
export const wrapHue = (deg: number): number => ((deg % 360) + 360) % 360

/** A host Tweaks can be keyed by: a lowercase hostname, no port, no trailing dot. */
export function isTweakHost(host: unknown): host is string {
  return typeof host === 'string' && host.length > 0 && host.length <= 253 && /^[a-z0-9._\-[\]:]+$/.test(host)
}

/** The host a page's Tweaks are keyed by (BO-17), or null where Tweaks never apply (BO-01, BO-18). */
export function tweakHostOf(url: string | undefined | null): string | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  return isTweakHost(host) ? host : null
}

function normalizeHidden(raw: unknown): TweakHidden[] {
  if (!Array.isArray(raw)) return []
  const out: TweakHidden[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!isRecord(item)) continue
    const selector = str(item.selector, TWEAK_LIMITS.selector).trim()
    const id = str(item.id, 64) || `h${out.length + 1}`
    if (!isSafeSelector(selector) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, selector, label: str(item.label, TWEAK_LIMITS.label) })
    if (out.length >= TWEAK_LIMITS.hidden) break
  }
  return out
}

/** A saved style, each field checked and clamped; anything missing takes its default. */
export function normalizeTweakStyle(raw: unknown): TweakStyle {
  const s = isRecord(raw) ? raw : {}
  const d = DEFAULT_TWEAK_STYLE
  const textCase = TEXT_CASES.includes(s.textCase as TweakStyle['textCase'])
    ? (s.textCase as TweakStyle['textCase'])
    : d.textCase
  const font = typeof s.font === 'string' && FONT_PRESETS.some((f) => f.id === s.font) ? s.font : ''
  return {
    hue: wrapHue(num(s.hue, d.hue, -1e6, 1e6)),
    intensity: num(s.intensity, d.intensity, 0, 1),
    accent: wrapHue(num(s.accent, d.accent, -1e6, 1e6)),
    invert: bool(s.invert, d.invert),
    contrast: num(s.contrast, d.contrast, SLIDER_MIN, SLIDER_MAX),
    brightness: num(s.brightness, d.brightness, SLIDER_MIN, SLIDER_MAX),
    saturation: num(s.saturation, d.saturation, 0, SATURATION_MAX),
    font,
    size: num(s.size, d.size, TWEAK_SIZE_MIN, TWEAK_SIZE_MAX),
    textCase,
    hidden: normalizeHidden(s.hidden),
  }
}

/** A saved Tweak, or null when it can't be one (no usable host). Missing fields take safe defaults. */
export function normalizeTweak(id: string, raw: unknown): Tweak | null {
  if (!isRecord(raw)) return null
  const host = typeof raw.host === 'string' ? raw.host.toLowerCase().replace(/\.$/, '') : ''
  if (!isTweakHost(host)) return null
  const createdAt = num(raw.createdAt, 0, 0, Number.MAX_SAFE_INTEGER)
  return {
    id,
    host,
    name: str(raw.name, TWEAK_LIMITS.name).trim() || host,
    enabled: bool(raw.enabled, true),
    css: str(raw.css, TWEAK_LIMITS.code),
    js: str(raw.js, TWEAK_LIMITS.code),
    createdAt,
    updatedAt: num(raw.updatedAt, createdAt, 0, Number.MAX_SAFE_INTEGER),
    subdomains: bool(raw.subdomains, false),
    // JavaScript runs only where allowed on this device (BO-18): not allowed unless saved so.
    jsAllowed: bool(raw.jsAllowed, false),
    jsInPrivate: bool(raw.jsInPrivate, false),
    style: normalizeTweakStyle(raw.style),
  }
}

/** Every saved Tweak that can be one, keyed by its id. */
export function normalizeTweaks(raw: unknown): Record<string, Tweak> {
  const out: Record<string, Tweak> = {}
  if (!isRecord(raw)) return out
  for (const [id, value] of Object.entries(raw)) {
    const tweak = normalizeTweak(id, value)
    if (tweak) out[id] = tweak
  }
  return out
}

/** The Tweak settings of a saved state, checked (BO-16, BO-01). */
export function normalizeTweakSettings(settings: Settings): void {
  if (typeof settings.tweaksEnabled !== 'boolean') settings.tweaksEnabled = true
  if (typeof settings.tweakIntroSeen !== 'boolean') settings.tweakIntroSeen = false
}

/** What an edit may change: the editor's controls (BO-02). Hidden elements have commands of their own. */
export interface TweakPatch {
  name?: string
  enabled?: boolean
  css?: string
  js?: string
  subdomains?: boolean
  jsAllowed?: boolean
  jsInPrivate?: boolean
  style?: Partial<Omit<TweakStyle, 'hidden'>>
}

/**
 * Applies a checked edit to a Tweak (a draft in a store update). Values out of range are clamped,
 * values of the wrong type ignored. An edit of the JavaScript never allows it: JavaScript that came
 * from elsewhere stays off until the user allows it on this device (BO-11, BO-18).
 * True when something changed.
 */
export function applyTweakPatch(tweak: Tweak, patch: TweakPatch, now: number): boolean {
  if (!isRecord(patch)) return false
  let changed = false
  const set = <K extends keyof Tweak>(key: K, value: Tweak[K]) => {
    if (tweak[key] === value) return
    tweak[key] = value
    changed = true
  }
  if (typeof patch.name === 'string') set('name', patch.name.trim().slice(0, TWEAK_LIMITS.name) || tweak.host)
  if (typeof patch.enabled === 'boolean') set('enabled', patch.enabled)
  if (typeof patch.css === 'string') set('css', patch.css.slice(0, TWEAK_LIMITS.code))
  if (typeof patch.js === 'string') set('js', patch.js.slice(0, TWEAK_LIMITS.code))
  if (typeof patch.subdomains === 'boolean') set('subdomains', patch.subdomains)
  if (typeof patch.jsAllowed === 'boolean') set('jsAllowed', patch.jsAllowed)
  if (typeof patch.jsInPrivate === 'boolean') set('jsInPrivate', patch.jsInPrivate)
  if (isRecord(patch.style)) {
    const next = normalizeTweakStyle({ ...tweak.style, ...patch.style, hidden: tweak.style.hidden })
    const style = tweak.style
    for (const key of Object.keys(next) as (keyof TweakStyle)[]) {
      if (key === 'hidden' || style[key] === next[key]) continue
      ;(style as unknown as Record<string, unknown>)[key] = next[key]
      changed = true
    }
  }
  if (changed) tweak.updatedAt = now
  return changed
}

/** The colours, invert and sliders at their defaults (BO-06's reset). */
export function colorReset(): Partial<TweakStyle> {
  const d = DEFAULT_TWEAK_STYLE
  return {
    hue: d.hue,
    intensity: d.intensity,
    accent: d.accent,
    invert: d.invert,
    contrast: d.contrast,
    brightness: d.brightness,
    saturation: d.saturation,
  }
}

export function hasColor(style: TweakStyle): boolean {
  return (
    style.intensity > 0 ||
    style.invert ||
    style.contrast !== 100 ||
    style.brightness !== 100 ||
    style.saturation !== 100
  )
}

/** The Tweak changes nothing at all yet. */
export function isEmptyTweak(tweak: Tweak): boolean {
  const s = tweak.style
  return (
    !hasColor(s) &&
    !s.font &&
    s.size === 100 &&
    s.textCase === 'none' &&
    s.hidden.length === 0 &&
    !tweak.css.trim() &&
    !tweak.js.trim()
  )
}

/**
 * Clears every edit of a Tweak (BO-12's "Reset all edits"): colours, font, size, case, hidden
 * elements and code. Its name, switch and scope stay. True when something changed.
 */
export function clearTweak(tweak: Tweak, now: number): boolean {
  if (isEmptyTweak(tweak)) return false
  tweak.style = { ...DEFAULT_TWEAK_STYLE, hidden: [] }
  tweak.css = ''
  tweak.js = ''
  tweak.updatedAt = now
  return true
}

/**
 * Adds a hidden element to a Tweak (BO-10): a selector that can't reach outside its own rule, not one
 * the Tweak hides already, while there is room. True when added.
 */
export function addHidden(tweak: Tweak, hidden: TweakHidden, now: number): boolean {
  const list = tweak.style.hidden
  const selector = hidden.selector.trim()
  if (!isSafeSelector(selector) || list.length >= TWEAK_LIMITS.hidden) return false
  if (list.some((h) => h.id === hidden.id || h.selector === selector)) return false
  list.push({ id: hidden.id.slice(0, 64), selector, label: hidden.label.slice(0, TWEAK_LIMITS.label) })
  tweak.updatedAt = now
  return true
}

/** Brings a hidden element back (BO-10's restore marker). True when it was hidden. */
export function removeHidden(tweak: Tweak, hiddenId: string, now: number): boolean {
  const i = tweak.style.hidden.findIndex((h) => h.id === hiddenId)
  if (i < 0) return false
  tweak.style.hidden.splice(i, 1)
  tweak.updatedAt = now
  return true
}

/** Hue steps between a shuffled tint and its accent: neighbours, thirds and opposites (BO-13). */
const ACCENT_STEPS = [30, 60, 120, 150, 180, 210, 240, 300]

/**
 * A random look that holds together (BO-13): a tint of any hue with an accent a pleasing step away,
 * sometimes inverted, one of the fonts, the site's size or a little larger, and mostly the site's own
 * case. Hidden elements and code are never part of it.
 */
export function shuffleStyle(random: () => number = Math.random): Partial<Omit<TweakStyle, 'hidden'>> {
  const pick = <T>(list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))] as T
  const hue = Math.floor(random() * 360)
  const cases: TweakStyle['textCase'][] = ['lower', 'upper', 'capitalize']
  return {
    hue,
    intensity: round(0.35 + random() * 0.5, 2),
    accent: wrapHue(hue + pick(ACCENT_STEPS)),
    invert: random() < 0.3,
    contrast: 100,
    brightness: 100,
    saturation: 100,
    font: pick(FONT_PRESETS).id,
    size: pick([100, 100, 110]),
    textCase: random() < 0.8 ? 'none' : pick(cases),
  }
}

// ---- Matching (BO-17) -------------------------------------------------------

const indexes = new WeakMap<Record<string, Tweak>, Map<string, Tweak[]>>()

/** Oldest first, so a later Tweak's rules come later and win (BO-14). */
const byCreated = (a: Tweak, b: Tweak) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Every Tweak by its host. Built once per version of the collection. */
export function tweakIndex(tweaks: Record<string, Tweak>): Map<string, Tweak[]> {
  let index = indexes.get(tweaks)
  if (index) return index
  index = new Map()
  for (const tweak of Object.values(tweaks)) {
    const list = index.get(tweak.host)
    if (list) list.push(tweak)
    else index.set(tweak.host, [tweak])
  }
  for (const list of index.values()) list.sort(byCreated)
  indexes.set(tweaks, index)
  return index
}

const isIpHost = (host: string) => host.includes(':') || /^\d+(\.\d+){3}$/.test(host)

/** Whether a host can have subdomains: not an address by number (BO-17). */
export const subdomainsPossible = (host: string): boolean => !isIpHost(host)

/** Whether a Tweak applies to pages of a host (its own, or a subdomain when it says so). */
export function tweakAppliesTo(tweak: Tweak, host: string | null): boolean {
  if (!host) return false
  if (tweak.host === host) return true
  return tweak.subdomains && !isIpHost(host) && host.endsWith(`.${tweak.host}`)
}

/**
 * The Tweaks for a host, on or off, oldest first (BO-14 lists them; `enabledTweaksFor` applies
 * them): those made on the host, and those made on a parent domain that also apply to subdomains.
 * One map lookup per label of the host.
 */
export function tweaksFor(tweaks: Record<string, Tweak>, host: string | null): Tweak[] {
  if (!host) return []
  const index = tweakIndex(tweaks)
  const own = index.get(host)
  let out: Tweak[] | undefined
  if (!isIpHost(host)) {
    for (let dot = host.indexOf('.'); dot >= 0; dot = host.indexOf('.', dot + 1)) {
      for (const tweak of index.get(host.slice(dot + 1)) ?? []) {
        if (!tweak.subdomains) continue
        out ??= own ? [...own] : []
        out.push(tweak)
      }
    }
  }
  if (!out) return own ?? []
  return out.sort(byCreated)
}

/** The Tweaks that apply to a host now: on, and Tweaks on as a whole (BO-16). */
export function enabledTweaksFor(tweaks: Record<string, Tweak>, settings: Settings, host: string | null): Tweak[] {
  if (!settings.tweaksEnabled) return []
  return tweaksFor(tweaks, host).filter((t) => t.enabled)
}

// ---- Colour (BO-03 to BO-06) ------------------------------------------------

type Mat = number[]
type Rgb = [number, number, number]

const rad = (deg: number) => (deg * Math.PI) / 180

/** CSS filter functions as 3×3 matrices on sRGB (Filter Effects §: sepia, saturate, hue-rotate). */
const sepiaM = (a: number): Mat => {
  const k = 1 - a
  return [
    0.393 + 0.607 * k,
    0.769 - 0.769 * k,
    0.189 - 0.189 * k,
    0.349 - 0.349 * k,
    0.686 + 0.314 * k,
    0.168 - 0.168 * k,
    0.272 - 0.272 * k,
    0.534 - 0.534 * k,
    0.131 + 0.869 * k,
  ]
}
const saturateM = (s: number): Mat => [
  0.213 + 0.787 * s,
  0.715 - 0.715 * s,
  0.072 - 0.072 * s,
  0.213 - 0.213 * s,
  0.715 + 0.285 * s,
  0.072 - 0.072 * s,
  0.213 - 0.213 * s,
  0.715 - 0.715 * s,
  0.072 + 0.928 * s,
]
const hueM = (deg: number): Mat => {
  const c = Math.cos(rad(deg))
  const s = Math.sin(rad(deg))
  return [
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.14,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072,
  ]
}

/** One step of a filter chain: its CSS and the affine map it is (out = m·in + t). */
export interface FilterStep {
  css: string
  m: Mat
  t: Rgb
}

const step = (css: string, m: Mat, t: Rgb = [0, 0, 0]): FilterStep => ({ css, m, t })
const scale = (k: number): Mat => [k, 0, 0, 0, k, 0, 0, 0, k]
const round = (n: number, places = 3) => Number(n.toFixed(places))

/** How light white's tint is at full intensity, as HSL lightness (BO-03): a pastel of the hue. */
const TINT_LIGHTNESS = 0.88
/** The most sepia a tint mixes in: well below 1, so the tint stays invertible for images (BO-03). */
const SEPIA_LIMIT = 0.75

function multiply(a: Mat, b: Mat): Mat {
  const out: Mat = []
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out.push(
        (a[r * 3] as number) * (b[c] as number) +
          (a[r * 3 + 1] as number) * (b[3 + c] as number) +
          (a[r * 3 + 2] as number) * (b[6 + c] as number),
      )
  return out
}

const apply = (m: Mat, v: Rgb): Rgb => [
  (m[0] as number) * v[0] + (m[1] as number) * v[1] + (m[2] as number) * v[2],
  (m[3] as number) * v[0] + (m[4] as number) * v[1] + (m[5] as number) * v[2],
  (m[6] as number) * v[0] + (m[7] as number) * v[1] + (m[8] as number) * v[2],
]
const clamp01 = (v: Rgb): Rgb => v.map((x) => Math.min(1, Math.max(0, x))) as Rgb

/** Runs a colour through a chain as the engine does, clamping after each step. */
export function runChain(chain: FilterStep[], rgb: Rgb): Rgb {
  let v = rgb
  for (const s of chain) {
    const out = apply(s.m, v)
    v = clamp01([out[0] + s.t[0], out[1] + s.t[1], out[2] + s.t[2]])
  }
  return v
}

/** What CSS colour filters keep: luma on encoded sRGB (hue-rotate and saturate leave it alone). */
const luma = (v: Rgb) => 0.213 * v[0] + 0.715 * v[1] + 0.072 * v[2]

function hslRgb(h: number, s: number, l: number): Rgb {
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

const hueOf = (v: Rgb): number => {
  const [r, g, b] = v
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return h * 60
}
const spreadOf = (v: Rgb) => Math.max(...v) - Math.min(...v)
/** The signed difference of two hues, in (−180, 180]. */
const hueDelta = (to: number, from: number) => 180 - wrapHue(180 - (to - from))

/** A tint's filter values (BO-03), as `tintSteps` prints them. */
interface Tint {
  /** Darkens first, so sepia can't push white past full red. */
  k: number
  /** How much sepia: the tint's source. */
  p: number
  /** Turns sepia's hue to the wheel's. */
  rotate: number
  /** Gives the page's own colours back the colourfulness sepia took (1 / (1 − p)). */
  s: number
  /** Sets the tint's lightness. */
  light: number
}

function tintSteps(t: Tint, pre: number): FilterStep[] {
  const steps: FilterStep[] = []
  const turn = round(pre, 1)
  if (turn !== 0) steps.push(step(`hue-rotate(${turn}deg)`, hueM(turn)))
  // Darkening goes first, so turning the hue has room below white; brightening goes last.
  const first = t.light < 1 ? round(t.k * t.light) : t.k
  steps.push(step(`brightness(${first})`, scale(first)))
  steps.push(step(`sepia(${t.p})`, sepiaM(t.p)))
  steps.push(step(`hue-rotate(${t.rotate}deg)`, hueM(t.rotate)))
  steps.push(step(`saturate(${t.s})`, saturateM(t.s)))
  if (t.light > 1) steps.push(step(`brightness(${t.light})`, scale(t.light)))
  return steps
}

/** A tint for a sepia amount: its other values follow from the hue and lightness wanted. */
function tintFor(p: number, hue: number, lightness: number): Tint {
  const k = round(1 / (1 + 0.351 * p))
  const s = round(1 / (1 - p))
  // Hue-rotate and saturate keep luma, so the last brightness alone sets the tint's lightness.
  const sepiaWhite = runChain([step('', scale(k)), step('', sepiaM(p))], [1, 1, 1])
  const light = round(luma(hslRgb(hue, 1, lightness)) / luma(sepiaWhite))
  // Hue-rotate isn't an exact turn of HSL hue: correct the angle a few times.
  let rotate = round(wrapHue(hue - hueOf(sepiaWhite)), 1)
  for (let i = 0; i < 6; i++) {
    const white = runChain(tintSteps({ k, p, rotate, s, light }, 0), [1, 1, 1])
    const miss = hueDelta(hue, hueOf(white))
    if (Math.abs(miss) < 0.25) break
    rotate = round(wrapHue(rotate + miss), 1)
  }
  return { k, p, rotate, s, light }
}

const tints = new Map<string, Tint>()

/**
 * The tint for a wheel position (BO-03): white becomes a pastel of the hue, as light as intensity
 * says, black stays black, and the page's own colours keep their colourfulness. Found by bisecting
 * the sepia amount; cached by whole degree and hundredth of intensity, so a wheel drag mostly hits
 * the cache.
 */
function solveTint(hue: number, intensity: number): Tint {
  const h = Math.round(wrapHue(hue)) % 360
  const i = round(intensity, 2)
  const key = `${h}:${i}`
  const known = tints.get(key)
  if (known) return known
  const lightness = 1 - (1 - TINT_LIGHTNESS) * i
  const wanted = spreadOf(hslRgb(h, 1, lightness))
  let lo = 0
  let hi = SEPIA_LIMIT
  let best = tintFor(round(hi), h, lightness)
  for (let n = 0; n < 14; n++) {
    const p = (lo + hi) / 2
    const tint = tintFor(round(p), h, lightness)
    const spread = spreadOf(runChain(tintSteps(tint, 0), [1, 1, 1]))
    if (spread < wanted) lo = p
    else {
      hi = p
      best = tint
    }
  }
  if (tints.size > 4000) tints.clear()
  tints.set(key, best)
  return best
}

/**
 * The filter chain for a style's colours, applied to the page root (BO-03 to BO-05):
 * - "original saturation" first, on the page's own colours;
 * - the tint: darken a little, mix in sepia, turn it to the wheel's hue and saturate it, so white
 *   becomes a light tint, black stays black and text keeps its contrast. The rim handle turns the
 *   page's own colours by its distance from the main hue;
 * - invert lightness (BO-04): invert, then turn hues back, so the tint becomes a dark one;
 * - contrast and brightness.
 */
export function colorChain(style: TweakStyle): FilterStep[] {
  const chain: FilterStep[] = []
  if (style.saturation !== 100) {
    const s = round(style.saturation / 100)
    chain.push(step(`saturate(${s})`, saturateM(s)))
  }
  if (style.intensity > 0) {
    const tint = solveTint(style.hue, style.intensity)
    // Page colours turn by (accent − hue) in all: by `pre` here, then by the tint's own turn.
    chain.push(...tintSteps(tint, hueDelta(style.accent - style.hue, tint.rotate)))
  }
  if (style.invert) {
    chain.push(step('invert(1)', scale(-1), [1, 1, 1]))
    chain.push(step('hue-rotate(180deg)', hueM(180)))
  }
  if (style.contrast !== 100) {
    const c = round(style.contrast / 100)
    chain.push(step(`contrast(${c})`, scale(c), [0.5 - 0.5 * c, 0.5 - 0.5 * c, 0.5 - 0.5 * c]))
  }
  if (style.brightness !== 100) {
    const b = round(style.brightness / 100)
    chain.push(step(`brightness(${b})`, scale(b)))
  }
  return chain
}

/** A chain as one affine map (no clamping). */
export function composeChain(chain: FilterStep[]): { m: Mat; t: Rgb } {
  let m: Mat = scale(1)
  let t: Rgb = [0, 0, 0]
  for (const s of chain) {
    m = multiply(s.m, m)
    const st = apply(s.m, t)
    t = [st[0] + s.t[0], st[1] + s.t[1], st[2] + s.t[2]]
  }
  return { m, t }
}

/** The inverse of an affine colour map, or null when it has none. */
export function invertAffine({ m, t }: { m: Mat; t: Rgb }): { m: Mat; t: Rgb } | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number]
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-6) return null
  const inv: Mat = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ]
  const it = apply(inv, t)
  return { m: inv, t: [-it[0], -it[1], -it[2]] }
}

/**
 * The filter that undoes a chain on images and video (BO-03, BO-04: they keep their own colours):
 * an SVG colour matrix in a data URL. A page whose `img-src` policy blocks data URLs ignores it, and
 * its images take the tint too.
 */
export function mediaFilter(chain: FilterStep[]): string | null {
  const inverse = invertAffine(composeChain(chain))
  if (!inverse) return null
  const { m, t } = inverse
  const r = (n: number) => String(round(n, 4))
  const row = (k: number) =>
    `${r(m[k * 3] as number)} ${r(m[k * 3 + 1] as number)} ${r(m[k * 3 + 2] as number)} 0 ${r(t[k] as number)}`
  const values = `${row(0)} ${row(1)} ${row(2)} 0 0 0 1 0`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><filter id="m" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${values}"/></filter></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}#m")`
}

/**
 * What keeps its own colours under the page's filter (BO-03, BO-04): images, video, canvases,
 * plugins, and frames that may go full screen or picture in picture (video players). Not inside an
 * element in full screen, which the page's filter doesn't reach.
 */
const MEDIA =
  ':is(img, video, canvas, embed, object, svg image, iframe:is([allowfullscreen], [allow*="fullscreen" i], [allow*="picture-in-picture" i], [allow*="encrypted-media" i])):not(:fullscreen, :fullscreen *)'

/**
 * Elements the root's filter doesn't reach: the top layer (modal dialogs, open popovers) is drawn
 * outside the root, so it gets the filter of its own. Full screen keeps the original colours.
 */
const FILTERED = 'html, :modal, :popover-open'

/**
 * The colour part of a page's stylesheet, without its layer. A page that paints no background of
 * its own gets the default canvas colour on the root, where the filter reaches it (the canvas
 * behind the root isn't filtered); any background the page sets wins over it.
 */
export function colorCss(style: TweakStyle): string {
  if (!hasColor(style)) return ''
  const chain = colorChain(style)
  if (chain.length === 0) return ''
  const media = mediaFilter(chain)
  const rules = [
    'html { background-color: Canvas; }',
    `${FILTERED} { filter: ${chain.map((s) => s.css).join(' ')} !important; }`,
  ]
  if (media) rules.push(`${MEDIA} { filter: ${media} !important; }`)
  return rules.join('\n')
}

// ---- Fonts, size, case, hidden elements (BO-07 to BO-10) --------------------

/**
 * What a font preset leaves alone (BO-07): icon fonts (by the usual element and class names, and
 * glyphs hidden from screen readers), code, and math.
 */
const FONT_SKIP = [
  'i:empty',
  '[class*="icon" i]',
  '[class*="glyph" i]',
  '[class*="symbol" i]',
  '[class^="fa"]',
  '[class*=" fa"]',
  '[class*="material" i]',
  '[data-icon]',
  '[aria-hidden="true"]',
  'svg',
  'svg *',
  'code',
  'code *',
  'pre',
  'pre *',
  'kbd',
  'samp',
  'tt',
  'math',
  'math *',
].join(', ')

/** Fields and code keep their case (BO-09). */
const CASE_KEEP =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [contenteditable]:not([contenteditable="false"]) *, code, code *, pre, pre *, kbd, samp'

const CASE_VALUE: Record<TweakStyle['textCase'], string> = {
  none: 'none',
  lower: 'lowercase',
  upper: 'uppercase',
  capitalize: 'capitalize',
}

export function fontCss(font: string): string {
  const preset = FONT_PRESETS.find((f) => f.id === font)
  if (!preset) return ''
  return `body, body *:not(${FONT_SKIP}) { font-family: ${preset.stack} !important; }`
}

export function sizeCss(size: number): string {
  if (size === 100) return ''
  return `html { zoom: ${round(size / 100)} !important; }`
}

export function caseCss(textCase: TweakStyle['textCase']): string {
  if (textCase === 'none') return ''
  return `body, body * { text-transform: ${CASE_VALUE[textCase]} !important; }\nbody :is(${CASE_KEEP}) { text-transform: none !important; }`
}

/** One rule per hidden element: a selector that doesn't parse drops only its own rule. */
export function hiddenCss(hidden: readonly TweakHidden[], skip?: string): string {
  return hidden
    .filter((h) => h.id !== skip && isSafeSelector(h.selector))
    .map((h) => `${h.selector} { display: none !important; }`)
    .join('\n')
}

// ---- Custom CSS (BO-11) -----------------------------------------------------

/** At-rules whose blocks hold more rules. */
const GROUP_RULES = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'document',
  '-moz-document',
  'scope',
  'starting-style',
])
/** At-rules whose blocks hold keyframes: their declarations can't be important. */
const KEYFRAMES = /^(-webkit-|-moz-|-o-)?keyframes$/

type Block = 'rules' | 'decls' | 'raw' | 'keyframes'

/** The end of a string that starts at `i` (past its closing quote), and whether it was closed. */
function stringEnd(css: string, i: number): { end: number; closed: boolean } {
  const quote = css[i]
  let j = i + 1
  while (j < css.length) {
    const c = css[j]
    if (c === '\\') j += 2
    else if (c === quote) return { end: j + 1, closed: true }
    else if (c === '\n')
      return { end: j, closed: true } // CSS ends a string at a line break
    else j++
  }
  return { end: css.length, closed: false }
}

/** The end of a comment that starts at `i`, and whether it was closed. */
function commentEnd(css: string, i: number): { end: number; closed: boolean } {
  const stop = css.indexOf('*/', i + 2)
  return stop < 0 ? { end: css.length, closed: false } : { end: stop + 2, closed: true }
}

/**
 * A group in brackets from `i` (url(), :is(), attribute selectors, which may hold `;` and quotes):
 * its text, closed where it was left open (at a brace or the end), so it can't swallow what follows.
 */
function groupAt(css: string, i: number): { text: string; end: number } {
  const closers: string[] = []
  let j = i
  let text = ''
  while (j < css.length) {
    const c = css[j] as string
    if (c === '"' || c === "'") {
      const str = stringEnd(css, j)
      text += css.slice(j, str.end) + (str.closed ? '' : c)
      j = str.end
      continue
    }
    if (c === '/' && css[j + 1] === '*') {
      const comment = commentEnd(css, j)
      text += css.slice(j, comment.end) + (comment.closed ? '' : '*/')
      j = comment.end
      continue
    }
    if (c === '{' || c === '}') break
    text += c
    j++
    if (c === '(') closers.push(')')
    else if (c === '[') closers.push(']')
    else if ((c === ')' || c === ']') && closers[closers.length - 1] === c) {
      closers.pop()
      if (closers.length === 0) return { text, end: j }
    }
  }
  return { text: text + closers.reverse().join(''), end: j }
}

/**
 * A Tweak's own CSS with `!important` added to each declaration of a style rule (nested ones too),
 * so it wins over the page's like the rest of the Tweak. Descriptors (`@font-face`, `@property`…)
 * and keyframes are left as written, where `!important` isn't allowed. What was left open (blocks,
 * brackets, strings, comments) is closed, so half-typed CSS can't swallow the rules after it.
 */
export function withImportant(css: string): string {
  let out = ''
  let chunk = ''
  const stack: Block[] = ['rules']
  const top = () => stack[stack.length - 1] as Block
  /** The declaration gathered so far, made important if it is one. */
  const endDeclaration = () => {
    const bare = stripComments(chunk).trim()
    if (top() === 'decls' && /^[\w-]+\s*:/.test(bare) && !/!\s*important$/i.test(bare)) {
      const trailing = /\s*$/.exec(chunk)?.[0] ?? ''
      out += `${chunk.slice(0, chunk.length - trailing.length)} !important${trailing}`
    } else out += chunk
    chunk = ''
  }
  let i = 0
  const n = css.length
  while (i < n) {
    const ch = css[i] as string
    if (ch === '/' && css[i + 1] === '*') {
      const comment = commentEnd(css, i)
      chunk += css.slice(i, comment.end) + (comment.closed ? '' : '*/')
      i = comment.end
      continue
    }
    if (ch === '"' || ch === "'") {
      const str = stringEnd(css, i)
      chunk += css.slice(i, str.end) + (str.closed ? '' : ch)
      i = str.end
      continue
    }
    if (ch === '(' || ch === '[') {
      const group = groupAt(css, i)
      chunk += group.text
      i = group.end
      continue
    }
    if (ch === ';') {
      if (top() === 'decls') endDeclaration()
      else {
        out += chunk
        chunk = ''
      }
      out += ';'
      i++
      continue
    }
    if (ch === '{') {
      const prelude = stripComments(chunk).trim()
      const block = top()
      let next: Block
      if (block === 'raw' || block === 'keyframes') next = 'raw'
      else if (prelude.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? ''
        next = GROUP_RULES.has(name) ? 'rules' : KEYFRAMES.test(name) ? 'keyframes' : name === 'page' ? 'decls' : 'raw'
      } else next = 'decls'
      out += `${chunk}{`
      chunk = ''
      stack.push(next)
      i++
      continue
    }
    if (ch === '}') {
      i++
      // A closing brace with nothing open is dropped.
      if (stack.length === 1) continue
      if (top() === 'decls') endDeclaration()
      else {
        out += chunk
        chunk = ''
      }
      out += '}'
      stack.pop()
      continue
    }
    chunk += ch
    i++
  }
  if (top() === 'decls') endDeclaration()
  else out += chunk
  out += '}'.repeat(stack.length - 1)
  return out
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?(\*\/|$)/g, '')
}

/**
 * A selector Hide-element mode may save (BO-10): one that can't reach outside its own rule. No
 * braces, semicolons or comments, quotes and brackets closed, and no backslash at the end.
 */
export function isSafeSelector(selector: string): boolean {
  if (!selector || selector.length > TWEAK_LIMITS.selector || /[\n\r\f]/.test(selector)) return false
  const closers: string[] = []
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i] as string
    if (c === '\\') {
      // An escape takes the next character, and there must be one.
      if (++i >= selector.length) return false
      continue
    }
    if (c === '"' || c === "'") {
      const str = stringEnd(selector, i)
      if (!str.closed || selector[str.end - 1] !== c) return false
      i = str.end - 1
      continue
    }
    if (c === '{' || c === '}' || c === ';' || (c === '/' && selector[i + 1] === '*')) return false
    if (c === '(') closers.push(')')
    else if (c === '[') closers.push(']')
    else if (c === ')' || c === ']') {
      if (closers.pop() !== c) return false
    }
  }
  return closers.length === 0
}

// ---- Space colours (BO-19) ---------------------------------------------------

/** The Space colours a Tweak's CSS can use, by variable name (documented in the editor). */
export type ThemeVariables = Record<string, string>

/** `var(--orbit-…)` replaced by the colour (or its fallback), so the page never sees the variables. */
export function withThemeVariables(css: string, vars: ThemeVariables | undefined): string {
  if (!css.includes('--orbit-')) return css
  return css.replace(
    /var\(\s*(--orbit-[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (all, name: string, fallback?: string) => {
      const value = vars?.[name]
      if (value) return value
      return fallback !== undefined ? fallback.trim() : all
    },
  )
}

// ---- A page's stylesheets ---------------------------------------------------

/**
 * One of a page's Tweak stylesheets, its CSS inside the Tweak layer. A page gets several, each
 * inserted on its own, so a change replaces only its own sheet and a rule left broken in one Tweak's
 * CSS can't reach another's:
 * - `color`: the colour wheel, invert and sliders. It changes at drag rate, and it is small;
 * - `base`: fonts, size and case;
 * - `t:<id>`: each Tweak's hidden elements and own CSS.
 */
export interface SheetPart {
  key: string
  css: string
}

/** CSS in the Tweak layer. */
export function layered(css: string): string {
  return `@layer ${TWEAK_LAYER} {\n${css}\n}`
}

export interface SheetOptions {
  /** The Space colours for `var(--orbit-…)` (BO-19). */
  theme?: ThemeVariables
  /** A hidden element shown again for now (BO-10's restore marker, while hovered), by its id. */
  showHidden?: string
}

const ownCssCache = new WeakMap<Tweak, string>()

function ownCss(tweak: Tweak): string {
  let css = ownCssCache.get(tweak)
  if (css === undefined) {
    css = tweak.css.trim() ? withImportant(tweak.css) : ''
    ownCssCache.set(tweak, css)
  }
  return css
}

/**
 * The stylesheets for a page from the Tweaks that apply to it (on, oldest first). Colours, font,
 * size and case come from the newest Tweak that sets each; hidden elements and custom CSS from
 * every one, in order, so a later Tweak's rules come later (BO-14).
 */
export function tweakSheets(tweaks: readonly Tweak[], opts: SheetOptions = {}): SheetPart[] {
  if (tweaks.length === 0) return []
  let color: TweakStyle | undefined
  let font = ''
  let size = 100
  let textCase: TweakStyle['textCase'] = 'none'
  for (const tweak of tweaks) {
    const s = tweak.style
    if (hasColor(s)) color = s
    if (s.font) font = s.font
    if (s.size !== 100) size = s.size
    if (s.textCase !== 'none') textCase = s.textCase
  }
  const parts: SheetPart[] = []
  const colors = color ? colorCss(color) : ''
  if (colors) parts.push({ key: 'color', css: layered(colors) })
  const base = [fontCss(font), sizeCss(size), caseCss(textCase)].filter(Boolean).join('\n')
  if (base) parts.push({ key: 'base', css: layered(base) })
  for (const tweak of tweaks) {
    const own = ownCss(tweak)
    const css = [hiddenCss(tweak.style.hidden, opts.showHidden), own && withThemeVariables(own, opts.theme)]
      .filter(Boolean)
      .join('\n')
    if (css) parts.push({ key: `t:${tweak.id}`, css: layered(css) })
  }
  return parts
}

// ---- JavaScript (BO-11, BO-18) ------------------------------------------------

/**
 * The code main runs in the page for a Tweak: its JavaScript in a function of its own, called with
 * the window as `this`. An error it throws goes to the page's console under the Tweak's name; one it
 * can't even start with (a syntax error) the engine reports there itself.
 */
export function tweakScript(tweak: Pick<Tweak, 'name' | 'js'>): string {
  const label = JSON.stringify(`[Tweak “${tweak.name}”]`)
  return `void (function () {\ntry {\n${tweak.js}\n} catch (error) {\nconsole.error(${label}, error)\n}\n}).call(window)`
}

/** Colour helpers for the editor's wheel: a hue and intensity as a CSS colour. */
export function wheelColor(hue: number, intensity: number): string {
  return `hsl(${round(wrapHue(hue), 1)} ${round(30 + 60 * intensity, 1)}% ${round(70 - 20 * intensity, 1)}%)`
}

/** The hue of a hex colour, for seeding the wheel from a Space colour. */
export function hueOfHex(hex: string): number {
  return hexToHsl(hex).h
}
