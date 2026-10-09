import type { SpaceTheme } from './state'

/** Colour helpers and the Space theme palette (shared by main and renderer). */

export interface Rgb {
  r: number
  g: number
  b: number
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

export function mix(a: string, b: string, amountOfB: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  const t = Math.max(0, Math.min(1, amountOfB))
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

export interface Palette {
  dark: boolean
  /** Window frame/sidebar background, top and bottom of the gradient. */
  frameTop: string
  frameBottom: string
  /** Solid colour used for the native window background (avoids flashes). */
  windowBackground: string
  accent: string
  text: string
  textMuted: string
  hover: string
  active: string
  activeShadow: string
  divider: string
}

export function resolveDark(mode: SpaceTheme['mode'], systemDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && systemDark)
}

export function paletteFor(theme: SpaceTheme, systemDark: boolean): Palette {
  const dark = resolveDark(theme.mode, systemDark)
  const base = theme.color
  const second = theme.color2 ?? base
  if (dark) {
    const top = mix(base, '#141417', 0.8)
    const bottom = mix(second, '#101012', 0.86)
    return {
      dark,
      frameTop: top,
      frameBottom: bottom,
      windowBackground: top,
      accent: mix(base, '#ffffff', 0.25),
      text: '#f3f3f5',
      textMuted: 'rgba(243,243,245,0.58)',
      hover: 'rgba(255,255,255,0.07)',
      active: 'rgba(255,255,255,0.14)',
      activeShadow: '0 1px 2px rgba(0,0,0,0.35)',
      divider: 'rgba(255,255,255,0.09)',
    }
  }
  const top = mix(base, '#ffffff', 0.74)
  const bottom = mix(second, '#ffffff', 0.84)
  return {
    dark,
    frameTop: top,
    frameBottom: bottom,
    windowBackground: top,
    accent: mix(base, '#000000', 0.12),
    text: '#1c1c1f',
    textMuted: 'rgba(28,28,31,0.56)',
    hover: 'rgba(0,0,0,0.05)',
    active: 'rgba(255,255,255,0.78)',
    activeShadow: '0 1px 2px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.04)',
    divider: 'rgba(0,0,0,0.08)',
  }
}
