import { release } from 'node:os'
import type { BrowserWindowConstructorOptions } from 'electron'
import { systemMaterial, type WindowMaterial } from '../shared/theme'

let decided: WindowMaterial | undefined

/**
 * The see-through material behind the neutral theme in this run (SB-24, SP-15): macOS vibrancy,
 * Windows 11 Mica, none on Linux. Test runs (ORBIT_E2E=1) may name one with ORBIT_MATERIAL, to check
 * the rest of the way (a see-through window and frame) on a system without one.
 */
export function windowMaterial(): WindowMaterial {
  if (decided) return decided
  const forced = process.env.ORBIT_E2E === '1' ? process.env.ORBIT_MATERIAL : undefined
  decided =
    forced === 'vibrancy' || forced === 'mica' || forced === 'none'
      ? forced
      : systemMaterial(process.platform, release())
  return decided
}

/**
 * A window's options for its material. The window is see-through behind the shell, which paints
 * every theme but the neutral one solid; the material shows where the shell lets it (ThemeDriver).
 * The system's own material is asked for only on its own system.
 */
export function materialWindowOptions(material: WindowMaterial): Partial<BrowserWindowConstructorOptions> {
  if (material === 'none') return {}
  return {
    backgroundColor: '#00000000',
    ...(material === 'vibrancy' && process.platform === 'darwin'
      ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const }
      : {}),
    ...(material === 'mica' && process.platform === 'win32' ? { backgroundMaterial: 'mica' as const } : {}),
  }
}
