import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  frameStops,
  MATERIAL_VEIL,
  mixPalettes,
  NEUTRAL_THEME,
  paletteFor,
  systemMaterial,
  withAlpha,
} from '../../src/shared/theme'

/** The neutral theme lets the system's material through (SB-24, SP-15). */

const RED = { colors: ['#d4322c'], intensity: 1, grain: 0 }
const alphaOf = (colour: string) => Number(/rgba\(.*,\s*([\d.]+)\)/.exec(colour)?.[1] ?? 1)

describe('the window material (SB-24, SP-15)', () => {
  it('[SB-24][SP-15] macOS has vibrancy, Windows 11 22H2 and later Mica, older Windows and Linux none', () => {
    expect(systemMaterial('darwin', '24.1.0')).toBe('vibrancy')
    expect(systemMaterial('win32', '10.0.22621')).toBe('mica')
    expect(systemMaterial('win32', '10.0.26100')).toBe('mica')
    // Windows 11 21H2 and Windows 10 have no system backdrop for Electron.
    expect(systemMaterial('win32', '10.0.22000')).toBe('none')
    expect(systemMaterial('win32', '10.0.19045')).toBe('none')
    expect(systemMaterial('linux', '6.8.0-138-generic')).toBe('none')
  })

  it('[SB-24][SP-15] over a material the neutral theme is see-through under a veil; a coloured theme stays solid', () => {
    for (const dark of [false, true]) {
      const neutral = paletteFor(NEUTRAL_THEME, dark)
      const stops = frameStops(neutral, true)
      const veil = dark ? MATERIAL_VEIL.dark : MATERIAL_VEIL.light
      for (const stop of stops) expect(alphaOf(stop)).toBeCloseTo(veil)
      // The same grey, only see-through.
      expect(stops[0]).toBe(withAlpha(neutral.frameTop, veil))
      // Without a material (Linux) it is the solid grey it was.
      expect(frameStops(neutral, false)).toEqual([neutral.frameTop, neutral.frameMid, neutral.frameBottom])
      const red = paletteFor(RED, dark)
      expect(frameStops(red, true)).toEqual([red.frameTop, red.frameMid, red.frameBottom])
    }
  })

  it('[SB-24][FL-14] a blend between the neutral theme and a coloured one is partly see-through', () => {
    const neutral = paletteFor(NEUTRAL_THEME, false)
    const red = paletteFor(RED, false)
    const half = frameStops(mixPalettes(neutral, red, 0.5), true)
    expect(alphaOf(half[0])).toBeCloseTo(1 - 0.5 * (1 - MATERIAL_VEIL.light))
    expect(frameStops(mixPalettes(neutral, red, 1), true)[0]).toBe(red.frameTop)
  })

  it('[AP-05] a private window’s palette stays solid', async () => {
    const { PRIVATE_PALETTE } = await import('../../src/shared/private')
    expect(frameStops(PRIVATE_PALETTE, true)[0]).toBe(PRIVATE_PALETTE.frameTop)
  })
})

describe('the window’s material options (SB-24)', () => {
  const platform = process.platform
  const env = { ...process.env }
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
    process.env = { ...env }
    vi.resetModules()
  })

  it('[SB-24] a window is see-through over a material, and asks for the system’s own only on its system', async () => {
    const { materialWindowOptions } = await import('../../src/main/material')
    expect(materialWindowOptions('none')).toEqual({})
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(materialWindowOptions('vibrancy')).toEqual({
      backgroundColor: '#00000000',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(materialWindowOptions('mica')).toEqual({ backgroundColor: '#00000000', backgroundMaterial: 'mica' })
    // A material named for a test on another system: see-through only.
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(materialWindowOptions('vibrancy')).toEqual({ backgroundColor: '#00000000' })
  })

  it('[SB-24] a test run may name the material; otherwise the system decides', async () => {
    process.env.ORBIT_E2E = '1'
    process.env.ORBIT_MATERIAL = 'mica'
    expect((await import('../../src/main/material')).windowMaterial()).toBe('mica')
    vi.resetModules()
    // Outside a test run the variable is ignored.
    process.env.ORBIT_E2E = ''
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect((await import('../../src/main/material')).windowMaterial()).toBe('none')
  })
})
