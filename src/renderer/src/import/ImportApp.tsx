import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ImportSession } from '../../../shared/commands/import'
import { NEUTRAL_THEME } from '../../../shared/theme'
import { invoke, isMac } from '../api'
import { useOrbit } from '../store'
import { cachedPalette, paletteVars, prefersReducedMotion, useDark } from '../theme'
import { ImportFlow } from './ImportFlow'

/**
 * The import window (IM-01): the import flow in the colours of the Space it was opened from. Main
 * sends a new session when it is asked again with a start (a dropped file, a paste in the sidebar).
 */
export function ImportApp() {
  const [session, setSession] = useState<ImportSession>()
  useEffect(() => {
    let latest = -1
    const apply = (s: ImportSession) => {
      if (s.nonce < latest) return
      latest = s.nonce
      setSession(s)
    }
    void invoke('import.session', {}).then(apply)
    return window.orbit.on('import.session', (payload) => apply(payload as ImportSession))
  }, [])
  const spaceId = useOrbit((s) => session?.spaceId ?? s.spaceOrder[0])
  const theme = useOrbit((s) => (spaceId ? s.spaces[spaceId]?.theme : undefined)) ?? NEUTRAL_THEME
  const dark = useDark()
  const palette = cachedPalette(theme, dark)
  const style = useMemo(() => paletteVars(palette), [palette])
  useThemeFade(dark)
  return (
    <div className="im" data-testid="import" data-dark={dark ? '' : undefined} style={style}>
      {isMac && <div className="im__drag" />}
      {session && <ImportFlow key={session.nonce} session={session} onClose={() => void invoke('import.close', {})} />}
    </div>
  )
}

function useThemeFade(dark: boolean): void {
  const last = useRef(dark)
  useLayoutEffect(() => {
    if (last.current === dark) return
    last.current = dark
    if (prefersReducedMotion()) return
    const root = document.documentElement
    root.dataset.themeFade = ''
    const t = setTimeout(() => delete root.dataset.themeFade, 260)
    return () => clearTimeout(t)
  }, [dark])
}
