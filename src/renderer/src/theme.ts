import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { SpaceTheme } from '../../shared/state'
import { mixPalettes, type Palette, paletteFor, resolveDark } from '../../shared/theme'
import { getOrbitState, useOrbit } from './store'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

export function prefersReducedMotion(): boolean {
  return reducedMotionQuery.matches
}

export function useSystemDark(): boolean {
  const [dark, setDark] = useState(darkQuery.matches)
  useEffect(() => {
    const onChange = () => setDark(darkQuery.matches)
    darkQuery.addEventListener('change', onChange)
    return () => darkQuery.removeEventListener('change', onChange)
  }, [])
  return dark
}

/** The one global light/dark choice (SP-18, D12), resolved against the OS. */
export function useDark(): boolean {
  const appearance = useOrbit((s) => s.settings.appearance)
  const systemDark = useSystemDark()
  return resolveDark(appearance, systemDark)
}

/** Same as useDark, read once (for imperative code). */
export function isDarkNow(): boolean {
  return resolveDark(getOrbitState().settings.appearance, darkQuery.matches)
}

const cache = new WeakMap<SpaceTheme, [Palette | undefined, Palette | undefined]>()

/** paletteFor with a per-theme-object cache (themes are immutable state objects). */
export function cachedPalette(theme: SpaceTheme, dark: boolean): Palette {
  let entry = cache.get(theme)
  if (!entry) {
    entry = [undefined, undefined]
    cache.set(theme, entry)
  }
  const i = dark ? 1 : 0
  const hit = entry[i]
  if (hit) return hit
  const p = paletteFor(theme, dark)
  entry[i] = p
  return p
}

export function usePalette(spaceId: string | undefined): Palette | undefined {
  const theme = useOrbit((s) => (spaceId ? s.spaces[spaceId]?.theme : undefined))
  const dark = useDark()
  return useMemo(() => (theme ? cachedPalette(theme, dark) : undefined), [theme, dark])
}

/** CSS custom properties for a palette (shared by the shell driver and the overlay). */
export function paletteEntries(p: Palette): [string, string][] {
  return [
    ['--frame-top', p.frameTop],
    ['--frame-mid', p.frameMid],
    ['--frame-bottom', p.frameBottom],
    ['--accent', p.accent],
    ['--selection', p.selection],
    ['--surface', p.surface],
    ['--text', p.text],
    ['--text-muted', p.textMuted],
    ['--hover', p.hover],
    ['--active', p.active],
    ['--active-shadow', p.activeShadow],
    ['--divider', p.divider],
    ['--grain-opacity', (p.grain * 0.6).toFixed(3)],
  ]
}

export function paletteVars(p: Palette | undefined): CSSProperties {
  if (!p) return {}
  return { ...Object.fromEntries(paletteEntries(p)), colorScheme: p.dark ? 'dark' : 'light' } as CSSProperties
}

let grainUrl: string | undefined

/** A small static noise tile (drawn once) for theme grain (SP-17). */
function grainImage(): string {
  if (grainUrl) return grainUrl
  const scale = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)))
  const size = 96 * scale
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return 'none'
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 18 + Math.random() * 60
  }
  ctx.putImageData(img, 0, 0)
  grainUrl = `url(${canvas.toDataURL('image/png')})`
  return grainUrl
}

/**
 * Paints the Space theme on the shell as CSS variables, without React renders.
 * - Resting changes (theme edits, presets) blend over ~200 ms in OKLab; rapid
 *   changes (dragging a colour handle) apply at drag rate (FL-14).
 * - A light/dark change cross-fades the whole shell (AP-01).
 * - During a Space swipe or switch the switcher drives every frame (`drive`).
 */
export class ThemeDriver {
  private el: HTMLElement | null = null
  private written = new Map<string, string>()
  private shown: Palette | undefined
  private target: Palette | undefined
  private lastTargetAt = 0
  private driving = false
  private raf = 0

  attach(el: HTMLElement | null): void {
    this.el = el
    this.written.clear()
    if (!el) return
    el.style.setProperty('--grain-image', grainImage())
    if (this.shown) this.write(this.shown)
  }

  /** The current colours (possibly mid-transition). */
  get current(): Palette | undefined {
    return this.shown
  }

  /** The resting palette of the window's active Space changed. */
  setTarget(p: Palette): void {
    const prev = this.target
    this.target = p
    if (this.driving) return
    const now = performance.now()
    const rapid = now - this.lastTargetAt < 150
    this.lastTargetAt = now
    const from = this.shown
    if (!prev || !from || from === p || rapid || prefersReducedMotion()) this.jump(p)
    else if (from.dark !== p.dark) this.crossFade(p)
    else this.blend(from, p, 200)
  }

  /** The Space switcher paints this frame's blend. */
  drive(p: Palette): void {
    this.stop()
    this.driving = true
    this.write(p)
  }

  /** The switcher is done; settle on the resting palette. */
  release(fadeMs = 0): void {
    if (!this.driving) return
    this.driving = false
    if (!this.target || this.shown === this.target) return
    if (fadeMs > 0 && this.shown) this.blend(this.shown, this.target, fadeMs)
    else this.write(this.target)
  }

  /** Blends from the current colours to `to` over `ms` (reduced-motion Space switches). */
  fadeTo(to: Palette, ms: number): void {
    this.target = to
    this.driving = false
    if (this.shown) this.blend(this.shown, to, ms)
    else this.write(to)
  }

  private jump(p: Palette): void {
    this.stop()
    this.write(p)
  }

  private crossFade(p: Palette): void {
    this.stop()
    const doc = document as Document & { startViewTransition?: (update: () => void) => unknown }
    if (doc.startViewTransition && !prefersReducedMotion() && this.el) {
      try {
        doc.startViewTransition(() => this.write(p))
        return
      } catch {
        // fall through
      }
    }
    this.write(p)
  }

  private blend(from: Palette, to: Palette, ms: number): void {
    this.stop()
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      this.write(t >= 1 ? to : mixPalettes(from, to, eased))
      this.raf = t < 1 ? requestAnimationFrame(tick) : 0
    }
    this.raf = requestAnimationFrame(tick)
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private write(p: Palette): void {
    this.shown = p
    const el = this.el
    if (!el) return
    for (const [name, value] of paletteEntries(p)) {
      if (this.written.get(name) === value) continue
      el.style.setProperty(name, value)
      this.written.set(name, value)
    }
    const scheme = p.dark ? 'dark' : 'light'
    if (this.written.get('color-scheme') !== scheme) {
      el.style.colorScheme = scheme
      this.written.set('color-scheme', scheme)
    }
    if (this.written.get('dark') !== scheme) {
      if (p.dark) el.dataset.dark = ''
      else delete el.dataset.dark
      this.written.set('dark', scheme)
    }
    // The grain layer (a blended full-window texture) only exists while there is grain.
    const grain = p.grain > 0.001 ? 'on' : ''
    if (this.written.get('grain') !== grain) {
      if (grain) el.dataset.grain = grain
      else delete el.dataset.grain
      this.written.set('grain', grain)
    }
  }
}

/** The shell's theme painter (one shell per renderer). */
export const themeDriver = new ThemeDriver()

/**
 * Keeps the shell element painted with the active Space's theme (SP-16, SB-24).
 * Returns the ref callback for the element that carries the theme variables.
 */
export function useShellTheme(spaceId: string | undefined): (el: HTMLElement | null) => void {
  const palette = usePalette(spaceId)
  useLayoutEffect(() => {
    if (palette) themeDriver.setTarget(palette)
  }, [palette])
  return useCallback((el: HTMLElement | null) => themeDriver.attach(el), [])
}
