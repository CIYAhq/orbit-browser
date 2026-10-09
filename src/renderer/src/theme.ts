import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { isPrivateSpace, PRIVATE_PALETTE } from '../../shared/private'
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
  // Private windows are near-black whatever the theme or light/dark setting (AP-05).
  const isPrivate = useOrbit((s) => isPrivateSpace(s, spaceId))
  const dark = useDark()
  return useMemo(
    () => (isPrivate ? PRIVATE_PALETTE : theme ? cachedPalette(theme, dark) : undefined),
    [isPrivate, theme, dark],
  )
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
 * Paints the Space theme without React renders (SP-16, FL-14).
 *
 * Two targets keep the per-frame cost flat whatever the sidebar holds (review M5):
 * - the background layer (`.shell-bg`): the gradient stops are registered,
 *   non-inherited properties set only on that element, and grain is its child's
 *   opacity, so a frame of a Space swipe restyles one element, not every row;
 * - the shell root: the inherited variables (text, accent, surfaces…) change only
 *   at rest, or once at the midpoint of a transition (text never passes through
 *   an unreadable blend).
 * Resting changes (theme edits, presets) blend over ~200 ms; rapid ones (dragging
 * a colour handle) apply at drag rate; light/dark cross-fades the whole shell.
 */
export class ThemeDriver {
  private el: HTMLElement | null = null
  private bg: HTMLElement | null = null
  private grain: HTMLElement | null = null
  private written = new Map<string, string>()
  private bgWritten = new Map<string, string>()
  private shown: Palette | undefined
  private restShown: Palette | undefined
  private target: Palette | undefined
  private lastTargetAt = 0
  private driving = false
  private raf = 0

  attach(el: HTMLElement | null): void {
    this.el = el
    this.written.clear()
    if (!el) return
    el.style.setProperty('--grain-image', grainImage())
    if (this.restShown) this.writeRest(this.restShown)
  }

  /** The background layer (`.shell-bg`, with the grain as its first child). */
  attachBackground(el: HTMLElement | null): void {
    this.bg = el
    this.grain = (el?.firstElementChild as HTMLElement | null) ?? null
    this.bgWritten.clear()
    if (el && this.shown) this.writeFrame(this.shown)
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

  /**
   * The Space switcher paints this frame: `blend` on the background layer, and
   * `near` (the palette the frame is closer to) for everything that inherits.
   */
  drive(blend: Palette, near: Palette): void {
    this.stop()
    this.driving = true
    this.writeFrame(blend)
    this.writeRest(near)
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
    // Inherited colours take the destination at once (same light/dark mode); only the
    // background layer animates.
    this.writeRest(to)
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      this.writeFrame(t >= 1 ? to : mixPalettes(from, to, eased))
      this.raf = t < 1 ? requestAnimationFrame(tick) : 0
    }
    this.raf = requestAnimationFrame(tick)
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private write(p: Palette): void {
    this.writeFrame(p)
    this.writeRest(p)
  }

  /** Per-frame: the background layer only (no inherited properties change). */
  private writeFrame(p: Palette): void {
    this.shown = p
    const bg = this.bg
    if (!bg) return
    const set = (name: string, value: string) => {
      if (this.bgWritten.get(name) === value) return
      bg.style.setProperty(name, value)
      this.bgWritten.set(name, value)
    }
    set('--bg-top', p.frameTop)
    set('--bg-mid', p.frameMid)
    set('--bg-bottom', p.frameBottom)
    const grain = (p.grain * 0.6).toFixed(3)
    if (this.bgWritten.get('grain') !== grain) {
      if (this.grain) this.grain.style.opacity = grain
      if (p.grain > 0.001) bg.dataset.grain = ''
      else delete bg.dataset.grain
      this.bgWritten.set('grain', grain)
    }
  }

  /** At rest or at a transition's midpoint: every inherited theme variable on the shell. */
  private writeRest(p: Palette): void {
    this.restShown = p
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
      if (p.dark) el.dataset.dark = ''
      else delete el.dataset.dark
      this.written.set('color-scheme', scheme)
    }
  }
}

/** The shell's theme painter (one shell per renderer). */
export const themeDriver = new ThemeDriver()

/**
 * Keeps the shell painted with the active Space's theme (SP-16, SB-24).
 * Returns ref callbacks for the shell root (inherited variables) and for its
 * background layer (`.shell-bg`, gradient and grain).
 */
export function useShellTheme(spaceId: string | undefined): {
  shellRef: (el: HTMLElement | null) => void
  backgroundRef: (el: HTMLElement | null) => void
} {
  const palette = usePalette(spaceId)
  useLayoutEffect(() => {
    if (palette) themeDriver.setTarget(palette)
  }, [palette])
  const shellRef = useCallback((el: HTMLElement | null) => themeDriver.attach(el), [])
  const backgroundRef = useCallback((el: HTMLElement | null) => themeDriver.attachBackground(el), [])
  return useMemo(() => ({ shellRef, backgroundRef }), [shellRef, backgroundRef])
}
