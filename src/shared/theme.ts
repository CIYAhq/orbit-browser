import type { ColorMode, SpaceTheme } from './state'

/**
 * Colour helpers and the Space theme palette (shared by main and renderer).
 *
 * A Space theme is 0–3 colours plus intensity and grain (SP-15, SP-17). Light
 * or dark is the one global `settings.appearance` (SP-18, lead decision D12):
 * `resolveDark(appearance, systemDark)` turns it into a boolean and
 * `paletteFor(theme, dark)` derives that rendition. Mixing happens in OKLab so
 * blends between two Spaces never pass through grey (FL-14, SP-19).
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface Oklab {
  L: number
  a: number
  b: number
}

/** Default "how strongly the colours show" for new themes. */
export const DEFAULT_INTENSITY = 0.6

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value.trim())
}

/** Lower-case #rrggbb form of a 3- or 6-digit hex colour. */
export function normalizeHex(hex: string): string {
  return rgbToHex(hexToRgb(hex))
}

export function hexToRgb(hex: string): Rgb {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const n = Number.parseInt(h.slice(0, 6), 16)
  if (Number.isNaN(n)) return { r: 107, g: 124, b: 255 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** Plain sRGB mix (kept for callers that want it; theme blends use mixOklab). */
export function mix(a: string, b: string, amountOfB: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  const t = clamp01(amountOfB)
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t })
}

/** WCAG relative luminance (0..1). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---- OKLab (Björn Ottosson's matrices) ----

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

export function hexToOklab(hex: string): Oklab {
  const { r, g, b } = hexToRgb(hex)
  const lr = toLinear(r / 255)
  const lg = toLinear(g / 255)
  const lb = toLinear(b / 255)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

function oklabToLinear({ L, a, b }: Oklab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const inGamut = (rgb: [number, number, number]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)

/** OKLab → #rrggbb, reducing chroma (not clipping channels) when the colour is outside sRGB. */
export function oklabToHex(lab: Oklab): string {
  let rgb = oklabToLinear(lab)
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklabToLinear({ L: lab.L, a: lab.a * mid, b: lab.b * mid }))) lo = mid
      else hi = mid
    }
    rgb = oklabToLinear({ L: lab.L, a: lab.a * lo, b: lab.b * lo })
  }
  const [r, g, b] = rgb.map((v) => toGamma(clamp01(v)) * 255) as [number, number, number]
  return rgbToHex({ r, g, b })
}

export function lerpOklab(a: Oklab, b: Oklab, t: number): Oklab {
  return { L: a.L + (b.L - a.L) * t, a: a.a + (b.a - a.a) * t, b: a.b + (b.b - a.b) * t }
}

/** Perceptual mix of two hex colours (t = 0 → a, t = 1 → b). */
export function mixOklab(a: string, b: string, t: number): string {
  if (t <= 0) return normalizeHex(a)
  if (t >= 1) return normalizeHex(b)
  return oklabToHex(lerpOklab(hexToOklab(a), hexToOklab(b), t))
}

// ---- Themes ----

export const NEUTRAL_THEME: SpaceTheme = { colors: [], intensity: DEFAULT_INTENSITY, grain: 0 }

/** Coerces any stored theme (including the old `{ color, color2, mode }` shape) into a valid SpaceTheme. */
export function normalizeSpaceTheme(raw: unknown): SpaceTheme {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let colors: string[] = []
  if (Array.isArray(t.colors)) colors = t.colors.filter(isHexColor)
  else colors = [t.color, t.color2].filter(isHexColor)
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback)
  return {
    colors: colors.slice(0, 3).map(normalizeHex),
    intensity: num(t.intensity, DEFAULT_INTENSITY),
    grain: num(t.grain, 0),
  }
}

export function sameTheme(a: SpaceTheme, b: SpaceTheme): boolean {
  if (!a || !b || !Array.isArray(a.colors) || !Array.isArray(b.colors)) return false
  return (
    a.intensity === b.intensity &&
    a.grain === b.grain &&
    a.colors.length === b.colors.length &&
    a.colors.every((c, i) => c === b.colors[i])
  )
}

/** The colour that stands for a Space in small places (switcher dot, menus). */
export function primaryColor(theme: SpaceTheme): string {
  return theme.colors[0] ?? '#8a8f98'
}

/** Global appearance setting → dark or not. `systemDark` is the OS preference. */
export function resolveDark(appearance: ColorMode, systemDark: boolean): boolean {
  return appearance === 'dark' || (appearance === 'system' && systemDark)
}

export interface Palette {
  dark: boolean
  /** Sidebar/frame gradient: three stops so any two themes interpolate stop by stop (FL-14). */
  frameTop: string
  frameMid: string
  frameBottom: string
  /** Solid colour used for the native window background (avoids flashes). */
  windowBackground: string
  accent: string
  /** Theme-tinted text selection highlight inside the sidebar (SB-24). */
  selection: string
  /** Floating surfaces (menus, pickers, dialogs) tinted by the theme (SP-16). */
  surface: string
  text: string
  textMuted: string
  hover: string
  active: string
  activeShadow: string
  divider: string
  /** Grain overlay strength 0..1 (SP-17). */
  grain: number
  /**
   * How far the frame lets the system material through where there is one (SB-24, SP-15): 1 for
   * the neutral theme, 0 (or absent) for a coloured one, in between while one blends into the other.
   */
  translucent?: number
}

const LIGHT_BASE = '#f6f6f8'
const DARK_BASE = '#161619'
const NEUTRAL_LIGHT: [string, string, string] = ['#e7e7eb', '#eaeaee', '#ededf0']
const NEUTRAL_DARK: [string, string, string] = ['#1e1e22', '#1c1c20', '#1a1a1d']

/** Pads 1–2 colours to three stops (top, middle, bottom) so gradients line up. */
export function themeStops(colors: readonly string[]): [string, string, string] | undefined {
  const [a, b, c] = colors
  if (!a) return undefined
  if (!b) return [a, a, a]
  if (!c) return [a, mixOklab(a, b, 0.5), b]
  return [a, b, c]
}

function tint(color: string, intensity: number, dark: boolean): string {
  const base = hexToOklab(dark ? DARK_BASE : LIGHT_BASE)
  const amount = dark ? 0.08 + 0.22 * intensity : 0.08 + 0.3 * intensity
  const lab = lerpOklab(base, hexToOklab(color), amount)
  // Keep body text readable whatever colour was picked (≥ 4.5:1, in practice ≥ 7:1).
  lab.L = dark ? clamp(lab.L, 0.17, 0.31) : clamp(lab.L, 0.82, 0.975)
  return oklabToHex(lab)
}

function accentFor(color: string | undefined, dark: boolean): string {
  if (!color) return dark ? '#9aa3ff' : '#5865d8'
  const lab = hexToOklab(color)
  lab.L = dark ? clamp(lab.L, 0.72, 0.86) : clamp(lab.L, 0.45, 0.6)
  return oklabToHex(lab)
}

export function paletteFor(theme: SpaceTheme, dark: boolean): Palette {
  const stops = themeStops(theme.colors)
  const intensity = clamp01(theme.intensity)
  const [top, mid, bottom] = stops
    ? (stops.map((c) => tint(c, intensity, dark)) as [string, string, string])
    : dark
      ? NEUTRAL_DARK
      : NEUTRAL_LIGHT
  const accent = accentFor(theme.colors[0], dark)
  const shared = {
    dark,
    frameTop: top,
    frameMid: mid,
    frameBottom: bottom,
    windowBackground: top,
    accent,
    selection: `${accent}55`,
    grain: clamp01(theme.grain),
    translucent: stops ? 0 : 1,
  }
  if (dark) {
    return {
      ...shared,
      surface: mixOklab('#232327', top, 0.45),
      text: '#f3f3f5',
      textMuted: 'rgba(243,243,245,0.6)',
      hover: 'rgba(255,255,255,0.07)',
      active: 'rgba(255,255,255,0.14)',
      activeShadow: '0 1px 2px rgba(0,0,0,0.35)',
      divider: 'rgba(255,255,255,0.09)',
    }
  }
  return {
    ...shared,
    surface: mixOklab('#ffffff', top, 0.35),
    text: '#1c1c1f',
    textMuted: 'rgba(28,28,31,0.58)',
    hover: 'rgba(0,0,0,0.05)',
    active: 'rgba(255,255,255,0.78)',
    activeShadow: '0 1px 2px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.04)',
    divider: 'rgba(0,0,0,0.08)',
  }
}

/**
 * Blend of two palettes for a theme transition (FL-14): background colours mix
 * in OKLab, grain mixes linearly, and the text/hover set swaps at the midpoint
 * (both sides of a Space switch share the global mode, so they normally match).
 */
export function mixPalettes(a: Palette, b: Palette, t: number): Palette {
  if (t <= 0) return a
  if (t >= 1) return b
  const near = t < 0.5 ? a : b
  const accent = mixOklab(a.accent, b.accent, t)
  return {
    ...near,
    frameTop: mixOklab(a.frameTop, b.frameTop, t),
    frameMid: mixOklab(a.frameMid, b.frameMid, t),
    frameBottom: mixOklab(a.frameBottom, b.frameBottom, t),
    windowBackground: mixOklab(a.windowBackground, b.windowBackground, t),
    accent,
    selection: `${accent}55`,
    surface: mixOklab(a.surface, b.surface, t),
    grain: a.grain + (b.grain - a.grain) * t,
    translucent: (a.translucent ?? 0) + ((b.translucent ?? 0) - (a.translucent ?? 0)) * t,
  }
}

// ---- The neutral theme over the system's material (SB-24, SP-15) ----

/**
 * The see-through material a window can have behind the neutral theme: macOS vibrancy, or Mica on
 * Windows 11 22H2 and later (Electron's `setBackgroundMaterial` needs that). Electron offers none on
 * Linux, so there the neutral theme stays a solid grey.
 */
export type WindowMaterial = 'vibrancy' | 'mica' | 'none'

/** Windows 11 22H2: the first build with a system backdrop. */
const MICA_BUILD = 22621

/** The material this OS offers: `platform` is Node's, `release` the OS version ('10.0.22631' on Windows). */
export function systemMaterial(platform: string, release: string): WindowMaterial {
  if (platform === 'darwin') return 'vibrancy'
  if (platform === 'win32') return Number(release.split('.')[2] ?? 0) >= MICA_BUILD ? 'mica' : 'none'
  return 'none'
}

/**
 * How much of the neutral grey stays over the material: a veil that keeps text and icons readable
 * however busy the desktop behind is.
 */
export const MATERIAL_VEIL = { light: 0.5, dark: 0.6 } as const

/** A #rrggbb colour at `alpha` (opaque colours stay hex). */
export function withAlpha(hex: string, alpha: number): string {
  if (alpha >= 1) return hex
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(clamp01(alpha) * 1000) / 1000})`
}

/**
 * The sidebar and frame's three stops (SB-24): over a material (`material` true), the neutral theme
 * lets it through under a light veil; a coloured theme stays solid; a blend between them is partly
 * see-through.
 */
export function frameStops(p: Palette, material: boolean): [string, string, string] {
  const stops: [string, string, string] = [p.frameTop, p.frameMid, p.frameBottom]
  const through = material ? clamp01(p.translucent ?? 0) : 0
  if (through <= 0) return stops
  const alpha = 1 - through * (1 - (p.dark ? MATERIAL_VEIL.dark : MATERIAL_VEIL.light))
  return stops.map((c) => withAlpha(c, alpha)) as [string, string, string]
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// ---- Theme picker colour field (SP-15) ----

export function hslToHex(h: number, s: number, l: number): string {
  const hue = (((h % 360) + 360) % 360) / 60
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((hue % 2) - 1))
  const [r, g, b] =
    hue < 1
      ? [c, x, 0]
      : hue < 2
        ? [x, c, 0]
        : hue < 3
          ? [0, c, x]
          : hue < 4
            ? [0, x, c]
            : hue < 5
              ? [x, 0, c]
              : [c, 0, x]
  const m = l - c / 2
  return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 })
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex)
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/**
 * The picker's 2-D colour area: hue runs left to right, and from top to bottom
 * colours go from vivid to soft (less saturation, a little lighter).
 */
export function fieldColor(u: number, v: number): string {
  const x = clamp01(u)
  const y = clamp01(v)
  return hslToHex(x * 360, 1 - 0.8 * y, 0.5 + 0.22 * y)
}

/** Where a colour sits in the colour area (inverse of fieldColor, approximately). */
export function fieldPosition(hex: string): { u: number; v: number } {
  const { h, s } = hexToHsl(hex)
  return { u: clamp01(h / 360), v: clamp01((1 - s) / 0.8) }
}
