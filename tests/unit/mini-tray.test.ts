import { describe, expect, it } from 'vitest'
import { drawGlyph } from '../../src/main/miniwindow/tray-icon'
import { normalizeState } from '../../src/main/persist'
import { applySettingsPatch } from '../../src/main/settings/validate'
import { createInitialState, DEFAULT_SETTINGS } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'

/** Coverage (0–1) of a pixel of a drawn glyph. */
function alphaAt(pixels: Buffer, size: number, x: number, y: number): number {
  return (pixels[(Math.floor(y) * size + Math.floor(x)) * 4 + 3] ?? 0) / 255
}

describe('the Mini Window button (MW-13)', () => {
  it('[MW-13] is off until Settings turns it on, and a stored value that is not on or off reads as off', () => {
    expect(DEFAULT_SETTINGS.miniWindowTrayButton).toBe(false)
    const load = (value: unknown) => {
      const base = createInitialState(0)
      const file = { ...base, settings: { ...base.settings, miniWindowTrayButton: value } }
      return normalizeState(file as unknown as Partial<OrbitState>).settings.miniWindowTrayButton
    }
    expect(load(true)).toBe(true)
    expect(load('yes')).toBe(false)
    expect(load(undefined)).toBe(false)
    const state = createInitialState(0)
    const draft = structuredClone(state.settings)
    expect(applySettingsPatch(draft, { miniWindowTrayButton: true }, state)).toEqual([])
    expect(draft.miniWindowTrayButton).toBe(true)
    expect(applySettingsPatch(draft, { miniWindowTrayButton: 1 }, state)).toEqual(['miniWindowTrayButton'])
    expect(draft.miniWindowTrayButton).toBe(true)
  })

  it("[MW-13] its glyph is Orbit's mark: a planet, the ring in front of it and a moon clear of the ring", () => {
    for (const size of [16, 32]) {
      const pixels = drawGlyph(size, [0, 0, 0])
      expect(pixels).toHaveLength(size * size * 4)
      const at = (x: number, y: number) => alphaAt(pixels, size, (x / 16) * size, (y / 16) * size)
      // The planet above the ring, the ring's far end, the moon at its near end; the corners are clear.
      expect(at(8, 7)).toBe(1)
      expect(at(2.2, 11.1)).toBeGreaterThan(0.5)
      expect(at(13.8, 4.9)).toBe(1)
      for (const [x, y] of [
        [0.5, 0.5],
        [15.5, 0.5],
        [0.5, 15.5],
        [15.5, 15.5],
      ] as const)
        expect(at(x, y)).toBe(0)
      // A gap between the ring passing in front and the planet behind it.
      const column = Array.from({ length: size }, (_, y) => alphaAt(pixels, size, size / 2, y))
      const inked = column.map((a) => a > 0.5)
      const runs = inked.filter((on, y) => on && !inked[y - 1]).length
      expect(runs).toBeGreaterThanOrEqual(2)
      // Black for a template: every colour channel is zero, only coverage varies.
      expect(pixels.filter((_, i) => i % 4 !== 3).every((channel) => channel === 0)).toBe(true)
    }
    // A colour is premultiplied by coverage (BGRA).
    const tinted = drawGlyph(16, [106, 92, 240])
    for (let i = 0; i < tinted.length; i += 4) {
      const alpha = (tinted[i + 3] ?? 0) / 255
      expect(tinted[i]).toBe(Math.round(240 * alpha))
      expect(tinted[i + 1]).toBe(Math.round(92 * alpha))
      expect(tinted[i + 2]).toBe(Math.round(106 * alpha))
    }
  })
})
