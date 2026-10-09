import type { CSSProperties } from 'react'
import { invoke } from '../api'
import { isSpacePanel, SpacePanels } from '../shell/spaces/SpacePanels'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import { CommandBar } from './CommandBar'
import { PeekLayer } from './PeekLayer'

/**
 * Transparent full-window layer above the tab views. It is only visible while
 * something is open (command bar, Peek chrome, menus); clicking the backdrop closes it.
 */
export function OverlayApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const overlay = win?.overlay
  if (!overlay || overlay.kind === 'none') return null
  return (
    <div
      className={`overlay overlay--${overlay.kind}`}
      style={paletteVars(palette) as CSSProperties}
      data-testid="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void invoke('overlay.close', {})
      }}
    >
      {overlay.kind === 'commandbar' && (
        <CommandBar key={overlay.nonce} mode={overlay.mode} initialQuery={overlay.query} />
      )}
      {overlay.kind === 'peek' && <PeekLayer key={overlay.nonce} overlay={overlay} />}
      {overlay.kind === 'panel' && isSpacePanel(overlay.panel) && <SpacePanels key={overlay.nonce} overlay={overlay} />}
    </div>
  )
}
