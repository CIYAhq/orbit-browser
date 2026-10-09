import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import type { ColorMode, SpaceTheme } from '../../shared/state'
import { type Palette, paletteFor } from '../../shared/theme'
import { useOrbit } from './store'

const media = window.matchMedia('(prefers-color-scheme: dark)')

export function useSystemDark(): boolean {
  const [dark, setDark] = useState(media.matches)
  useEffect(() => {
    const onChange = () => setDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return dark
}

/** A Space theme's "system" mode follows the app appearance setting, which may itself follow the OS. */
export function effectiveMode(theme: SpaceTheme, appearance: ColorMode): ColorMode {
  return theme.mode === 'system' ? appearance : theme.mode
}

export function usePalette(spaceId: string | undefined): Palette | undefined {
  const theme = useOrbit((s) => (spaceId ? s.spaces[spaceId]?.theme : undefined))
  const appearance = useOrbit((s) => s.settings.appearance)
  const systemDark = useSystemDark()
  return useMemo(
    () => (theme ? paletteFor({ ...theme, mode: effectiveMode(theme, appearance) }, systemDark) : undefined),
    [theme, appearance, systemDark],
  )
}

export function paletteVars(p: Palette | undefined): CSSProperties {
  if (!p) return {}
  return {
    '--frame-top': p.frameTop,
    '--frame-bottom': p.frameBottom,
    '--accent': p.accent,
    '--text': p.text,
    '--text-muted': p.textMuted,
    '--hover': p.hover,
    '--active': p.active,
    '--active-shadow': p.activeShadow,
    '--divider': p.divider,
    colorScheme: p.dark ? 'dark' : 'light',
  } as CSSProperties
}
