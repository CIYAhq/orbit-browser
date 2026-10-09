import { Columns2, X } from 'lucide-react'
import { type CSSProperties, useEffect, useState } from 'react'
import { invoke } from '../../api'
import { useWindow } from '../../store'
import { paletteVars, usePalette } from '../../theme'

/**
 * The pane strip (SV-12): close this pane, or open its split controls (flip, add split
 * right/left/above/below, move pane, separate). Main shows it centred at the top of the
 * pane the pointer is near and tells it which pane that is.
 */
export function PaneStripApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [tabId, setTabId] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(
    () =>
      window.orbit.on('strip:show', (payload) => {
        setTabId((payload as { tabId: string }).tabId)
        setNonce((n) => n + 1)
      }),
    [],
  )
  if (!tabId) return null
  return (
    <div
      key={nonce}
      className="pane-strip"
      style={paletteVars(palette) as CSSProperties}
      data-testid="pane-strip"
      onPointerEnter={() => void invoke('split.stripHover', { hovered: true })}
      onPointerLeave={() => void invoke('split.stripHover', { hovered: false })}
    >
      <button
        type="button"
        className="pane-strip__button"
        aria-label="Close pane"
        title="Close pane"
        data-testid="pane-strip-close"
        onClick={() => void invoke('split.closePane', { tabId })}
      >
        <X size={14} strokeWidth={2.2} />
      </button>
      <button
        type="button"
        className="pane-strip__button"
        aria-label="Split controls"
        title="Split controls"
        data-testid="pane-strip-menu"
        onClick={() => void invoke('split.paneMenu', { tabId })}
      >
        <Columns2 size={14} strokeWidth={2} />
      </button>
    </div>
  )
}
