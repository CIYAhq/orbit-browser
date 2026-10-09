import { AnimatePresence, domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { type CSSProperties, useEffect, useState } from 'react'
import { invoke } from '../api'
import { isSpacePanel, SpacePanels } from '../shell/spaces/SpacePanels'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import { CommandBar } from './CommandBar'
import { PeekLayer } from './PeekLayer'

/**
 * Transparent full-window layer above the tab views. It is only visible while
 * something is open (command bar, Peek chrome, menus); clicking the backdrop closes it.
 * Children animate out (AnimatePresence) while main keeps the view up briefly.
 */
export function OverlayApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const overlay = win?.overlay
  const kind = overlay?.kind ?? 'none'
  // Pre-warm (CB-22): one hidden, inert command bar right after start-up.
  const [warm, setWarm] = useState(true)
  useEffect(() => {
    const id = setTimeout(() => setWarm(false), 600)
    return () => clearTimeout(id)
  }, [])
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <div
          className={`overlay overlay--${kind}`}
          style={paletteVars(palette) as CSSProperties}
          data-testid="overlay"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget || kind === 'none') return
            void invoke('overlay.close', {})
            // CB-20: the sidebar stays usable: a click over it closes the bar and is passed on.
            const sidebar = win?.sidebar
            // Left clicks only: a right or middle click just closes the bar (review M5).
            const overSidebar = sidebar && (sidebar.visible || sidebar.peeking) && e.clientX < sidebar.width
            if (kind === 'commandbar' && e.button === 0 && overSidebar) {
              void invoke('search.forwardClick', { x: e.clientX, y: e.clientY })
            }
          }}
        >
          {warm && kind === 'none' && (
            <div className="cmdbar-warm" aria-hidden>
              <CommandBar warm mode="new-tab" initialQuery="" />
            </div>
          )}
          <AnimatePresence>
            {overlay?.kind === 'commandbar' && (
              <CommandBar key={overlay.nonce} mode={overlay.mode} initialQuery={overlay.query} dark={palette?.dark} />
            )}
          </AnimatePresence>
          {overlay?.kind === 'panel' && isSpacePanel(overlay.panel) && (
            <SpacePanels key={overlay.nonce} overlay={overlay} />
          )}
          {overlay?.kind === 'peek' && <PeekLayer key={overlay.nonce} overlay={overlay} />}
        </div>
      </MotionConfig>
    </LazyMotion>
  )
}
