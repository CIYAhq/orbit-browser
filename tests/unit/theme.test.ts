import { describe, expect, it } from 'vitest'
import { THEME_PRESETS } from '../../src/shared/defaults'
import { contrastRatio, hexToRgb, mix, paletteFor, rgbToHex } from '../../src/shared/theme'

describe('theme', () => {
  it('round-trips colours', () => {
    expect(rgbToHex(hexToRgb('#6b7cff'))).toBe('#6b7cff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('keeps sidebar text readable for every preset in light and dark', () => {
    for (const theme of THEME_PRESETS) {
      for (const dark of [false, true]) {
        const p = paletteFor({ ...theme, mode: dark ? 'dark' : 'light' }, false)
        expect(contrastRatio(p.text, p.frameTop), `${theme.color} dark=${dark}`).toBeGreaterThanOrEqual(7)
        expect(contrastRatio(p.text, p.frameBottom)).toBeGreaterThanOrEqual(7)
      }
    }
  })
})
