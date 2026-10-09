import { Columns2, GripVertical, X } from 'lucide-react'
import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from 'react'
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
  const [leaving, setLeaving] = useState(false)
  const dragging = useRef(false)
  useEffect(() => {
    const off = window.orbit.on('strip:show', (payload) => {
      setTabId((payload as { tabId: string }).tabId)
      setNonce((n) => n + 1)
      setLeaving(false)
    })
    const offHide = window.orbit.on('strip:hide', () => setLeaving(true))
    // The first show can arrive before this page has loaded: ask which pane the strip is for.
    void invoke('split.stripTarget', {}).then(({ tabId: current }) => {
      if (current) setTabId((existing) => existing ?? current)
    })
    return () => {
      off()
      offHide()
    }
  }, [])
  if (!tabId) return null
  const drag = (phase: 'start' | 'move' | 'end' | 'cancel', e: PointerEvent) =>
    void invoke('split.paneDrag', { tabId, phase, x: e.clientX, y: e.clientY })
  return (
    <div
      key={nonce}
      className={`pane-strip${leaving ? ' is-leaving' : ''}`}
      style={paletteVars(palette) as CSSProperties}
      data-testid="pane-strip"
      onPointerEnter={() => void invoke('split.stripHover', { hovered: true })}
      onPointerLeave={() => void invoke('split.stripHover', { hovered: false })}
    >
      <span
        className="pane-strip__grip"
        title="Drag to move this pane"
        data-testid="pane-strip-grip"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          dragging.current = true
          drag('start', e)
        }}
        onPointerMove={(e) => {
          if (dragging.current) drag('move', e)
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return
          dragging.current = false
          drag('end', e)
        }}
        onPointerCancel={(e) => {
          if (!dragging.current) return
          dragging.current = false
          drag('cancel', e)
        }}
      >
        <GripVertical size={13} />
      </span>
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
