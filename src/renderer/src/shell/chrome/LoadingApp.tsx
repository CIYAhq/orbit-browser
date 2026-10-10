import { type CSSProperties, useEffect, useState } from 'react'
import { useWindow } from '../../store'
import { paletteVars, usePalette } from '../../theme'
import './loading.css'

type LoadingState = 'loading' | 'done'

/**
 * The page loading indicator (SB-28, FL-23): a small view main places at the top centre of the
 * shown page card while the page loads. A short theme-tinted sweep runs on a steady 1.2 s cycle;
 * when the load ends it fills the pill and fades out (main hides the view after that).
 */
export function LoadingApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  // The view only shows while a page loads: it starts out loading.
  const [state, setState] = useState<LoadingState>('loading')
  // A new load restarts the sweep from the left.
  const [run, setRun] = useState(0)
  useEffect(
    () =>
      window.orbit.on('loading:state', (payload) => {
        const next = (payload as { state?: LoadingState }).state === 'done' ? 'done' : 'loading'
        setState((current) => {
          if (next === 'loading' && current !== 'loading') setRun((n) => n + 1)
          return next
        })
      }),
    [],
  )
  return (
    <div
      className={`loading-view is-${state}`}
      style={paletteVars(palette) as CSSProperties}
      data-testid="loading-indicator"
      data-state={state}
    >
      <div className="loading-view__pill" role="progressbar" aria-label="Loading">
        <div key={run} className="loading-view__sweep" />
      </div>
    </div>
  )
}
