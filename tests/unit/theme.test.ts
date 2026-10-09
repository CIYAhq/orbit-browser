import { describe, expect, it } from 'vitest'
import { THEME_PRESETS } from '../../src/shared/defaults'
import {
  contrastRatio,
  fieldColor,
  fieldPosition,
  hexToOklab,
  hexToRgb,
  mix,
  mixOklab,
  mixPalettes,
  NEUTRAL_THEME,
  normalizeSpaceTheme,
  oklabToHex,
  paletteFor,
  resolveDark,
  rgbToHex,
  themeStops,
} from '../../src/shared/theme'

const chroma = (hex: string) => {
  const { a, b } = hexToOklab(hex)
  return Math.hypot(a, b)
}

describe('[SP-15][SP-16][SB-24] theme palettes', () => {
  it('round-trips colours through sRGB and OKLab', () => {
    expect(rgbToHex(hexToRgb('#6b7cff'))).toBe('#6b7cff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    for (const hex of ['#6b7cff', '#ff7a59', '#2fbf8f', '#000000', '#ffffff', '#123456']) {
      expect(oklabToHex(hexToOklab(hex))).toBe(hex)
    }
  })

  it('keeps sidebar text readable for every preset in light and dark, at any intensity', () => {
    for (const theme of [...THEME_PRESETS, NEUTRAL_THEME]) {
      for (const intensity of [0, 0.6, 1]) {
        for (const dark of [false, true]) {
          const p = paletteFor({ ...theme, intensity }, dark)
          for (const stop of [p.frameTop, p.frameMid, p.frameBottom]) {
            expect(contrastRatio(p.text, stop), `${theme.colors} dark=${dark}`).toBeGreaterThanOrEqual(7)
          }
        }
      }
    }
  })

  it('keeps text readable even for extreme user colours', () => {
    for (const color of ['#000000', '#ffffff', '#ffff00', '#0000ff', '#ff0000']) {
      for (const dark of [false, true]) {
        const p = paletteFor({ colors: [color], intensity: 1, grain: 0 }, dark)
        expect(contrastRatio(p.text, p.frameTop)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('dark renditions are genuinely dark and keep the hue family (AP-04)', () => {
    const light = paletteFor({ colors: ['#3f6bff', '#ff5fa2'], intensity: 0.6, grain: 0 }, false)
    const dark = paletteFor({ colors: ['#3f6bff', '#ff5fa2'], intensity: 0.6, grain: 0 }, true)
    expect(hexToOklab(dark.frameTop).L).toBeLessThan(0.32)
    expect(hexToOklab(light.frameTop).L).toBeGreaterThan(0.8)
    // Same hue direction (blue on top, pink at the bottom) in both renditions.
    expect(hexToOklab(dark.frameTop).b).toBeLessThan(0)
    expect(hexToOklab(light.frameTop).b).toBeLessThan(0)
    expect(hexToOklab(dark.frameBottom).a).toBeGreaterThan(0)
  })

  it('one colour is a flat tint, two or three make a top-to-bottom gradient padded to three stops', () => {
    expect(themeStops([])).toBeUndefined()
    expect(themeStops(['#6b7cff'])).toEqual(['#6b7cff', '#6b7cff', '#6b7cff'])
    const two = themeStops(['#0000ff', '#ff0000'])
    expect(two?.[0]).toBe('#0000ff')
    expect(two?.[2]).toBe('#ff0000')
    expect(two?.[1]).not.toBe(mix('#0000ff', '#ff0000', 0.5))
    expect(themeStops(['#111111', '#222222', '#333333'])).toEqual(['#111111', '#222222', '#333333'])
  })

  it('more intensity shows more colour', () => {
    const faint = paletteFor({ colors: ['#e85d9a'], intensity: 0, grain: 0 }, false)
    const full = paletteFor({ colors: ['#e85d9a'], intensity: 1, grain: 0 }, false)
    expect(chroma(full.frameTop)).toBeGreaterThan(chroma(faint.frameTop) * 2)
  })

  it('the neutral theme (no colours) is a soft grey in light and near-black in dark (AP-03)', () => {
    const light = paletteFor(NEUTRAL_THEME, false)
    const dark = paletteFor(NEUTRAL_THEME, true)
    expect(chroma(light.frameTop)).toBeLessThan(0.01)
    expect(hexToOklab(dark.frameTop).L).toBeLessThan(0.25)
  })
})

describe('[SP-18] global appearance', () => {
  it('resolves Automatic / Light / Dark from the one global setting', () => {
    expect(resolveDark('system', true)).toBe(true)
    expect(resolveDark('system', false)).toBe(false)
    expect(resolveDark('light', true)).toBe(false)
    expect(resolveDark('dark', false)).toBe(true)
  })
})

describe('[SP-19][FL-14] theme transitions', () => {
  it('mixes in OKLab so blue → orange never passes through grey', () => {
    const mid = mixOklab('#2f6bff', '#ff8a2f', 0.5)
    const greyish = mix('#2f6bff', '#ff8a2f', 0.5)
    expect(chroma(mid)).toBeGreaterThan(chroma(greyish))
    expect(chroma(mid)).toBeGreaterThan(0.04)
  })

  it('palette blends interpolate every stop and grain, and never show the neutral default', () => {
    const a = paletteFor({ colors: ['#2f6bff'], intensity: 0.6, grain: 0 }, false)
    const b = paletteFor({ colors: ['#ff8a2f', '#e85d9a'], intensity: 0.6, grain: 1 }, false)
    const neutral = paletteFor(NEUTRAL_THEME, false)
    for (let i = 1; i < 10; i++) {
      const t = i / 10
      const m = mixPalettes(a, b, t)
      expect(m.grain).toBeCloseTo(t)
      expect(m.frameTop).not.toBe(neutral.frameTop)
      expect(chroma(m.frameTop)).toBeGreaterThan(0.01)
      expect(contrastRatio(m.text, m.frameTop)).toBeGreaterThanOrEqual(4.5)
    }
    expect(mixPalettes(a, b, 0)).toBe(a)
    expect(mixPalettes(a, b, 1)).toBe(b)
  })
})

describe('[SP-15] stored themes', () => {
  it('normalizes the old { color, color2, mode } shape and drops the per-Space mode (D12)', () => {
    expect(normalizeSpaceTheme({ color: '#6B7CFF', color2: '#fff', mode: 'dark' })).toEqual({
      colors: ['#6b7cff', '#ffffff'],
      intensity: 0.6,
      grain: 0,
    })
    expect(normalizeSpaceTheme({ colors: ['#1', '#abcdef', 'red', '#000', '#111', '#222'], grain: 7 })).toEqual({
      colors: ['#abcdef', '#000000', '#111111'],
      intensity: 0.6,
      grain: 1,
    })
    expect(normalizeSpaceTheme(undefined)).toEqual(NEUTRAL_THEME)
  })
})

describe('[SP-14][SP-15] colour area', () => {
  it('maps positions to colours and back', () => {
    for (const [u, v] of [
      [0, 0],
      [0.25, 0.1],
      [0.5, 0.5],
      [0.8, 0.9],
    ] as const) {
      const pos = fieldPosition(fieldColor(u, v))
      expect(pos.u).toBeCloseTo(u, 1)
      expect(pos.v).toBeCloseTo(v, 1)
    }
    expect(fieldColor(0, 0)).toBe('#ff0000')
    expect(fieldColor(1 / 3, 0)).toBe('#00ff00')
  })
})
